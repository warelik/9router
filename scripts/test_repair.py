from datetime import datetime, timedelta, timezone
import ast
import io
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import release


REPO = "warelik/9router"
CONFIG = "a" * 40
SEED = "b" * 40
HEAD = "c" * 40
UPSTREAM = "d" * 40
PUBLISHED = "2026-10-19T09:00:00Z"
STATE = {"schema": 1, "config": CONFIG, "upstream": UPSTREAM, "seed": SEED,
         "head": HEAD, "number": 2, "branch": "repair/example",
         "cycle": "e" * 64, "window": "run-prior",
         "created_at": "2026-10-16T10:00:00Z"}
ENV = {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG, "GITHUB_RUN_ID": "42",
       "REPAIR_PR": "2", "REPAIR_HEAD": HEAD, "CANDIDATE_PR": "1", "CANDIDATE_SHA": HEAD}


def request(head=SEED, attempt=1, age=0):
    return {
        "created_at": (datetime.now(timezone.utc) - timedelta(seconds=age)).isoformat(),
        "body": f"<!-- 9router-fix:{head}:{attempt} -->",
    }


class RepairBoundaryTests(unittest.TestCase):
    def test_only_patch_changes_or_policy_changes_are_eligible(self):
        for changed, policy in (
            ("patches/0009-fix.patch", False), ("scripts/release.py", True),
            ("README.md", True),
            ("scripts/test_new_case.py", True), (".github/workflows/release.yml", True),
        ):
            with (self.subTest(changed=changed),
                  patch.object(release, "run", side_effect=["", "", "", CONFIG, changed,
                                                          "100644 blob " + HEAD + "\t" + changed])):
                self.assertEqual(release.repair_changes(STATE), ([changed], policy))

    def test_context_manifest_instructions_and_mixed_changes_cannot_land(self):
        for changed in (
            ".repair/context.json", ".repair/upstream.tar.gz", "patches/source.json",
            "AGENTS.md", ".gitignore", "CONTRIBUTING.md",
            "patches/0009-fix.patch\nscripts/release.py",
        ):
            with (self.subTest(changed=changed),
                  patch.object(release, "run", side_effect=["", "", "", CONFIG, changed]),
                  self.assertRaises(ValueError)):
                release.repair_changes(STATE)

    def test_symlinks_and_policy_deletion_are_rejected(self):
        for entry in ("", "120000 blob " + HEAD + "\tscripts/release.py"):
            with (self.subTest(entry=entry), patch.object(release, "run",
                  side_effect=["", "", "", CONFIG, "scripts/release.py", entry]),
                  self.assertRaises(ValueError)):
                release.repair_changes(STATE)

    def test_seed_must_directly_extend_the_trusted_configuration(self):
        with (patch.object(release, "run", side_effect=["", "", "", UPSTREAM]),
              self.assertRaisesRegex(ValueError, "trusted configuration")):
            release.repair_changes(STATE)

    def test_renames_are_examined_as_delete_and_add(self):
        with patch.object(release, "run", side_effect=["", "", "", CONFIG, ""]) as run:
            release.repair_changes(STATE)
        self.assertIn("--no-renames", run.call_args.args)

    def test_copied_patches_keep_the_exact_reviewed_bytes(self):
        content = b"From test\r\n\r\n---\r\n\r\n"
        with (tempfile.TemporaryDirectory() as directory,
              patch.object(release, "run", return_value="patches/0009-fix.patch\npatches/source.json"),
              patch.object(release.subprocess, "check_output", return_value=content)):
            root = release.copy_patch_series(HEAD, Path(directory) / "patches")
            self.assertEqual((root / "0009-fix.patch").read_bytes(), content)
            self.assertFalse((root / "source.json").exists())

    def test_a_task_report_without_an_actual_push_is_only_pending(self):
        state = {**STATE, "head": SEED}
        with (patch.object(release, "repair_pull", return_value=state),
              patch.object(release, "repair_comments", return_value=[request()]),
              patch.object(release, "repair_states", return_value=[state]),
              patch.object(release, "output") as output,
              patch.object(release, "repair_changes", side_effect=AssertionError("No new head"))):
            result = release.proposal(REPO, CONFIG, Path("/unused"))
        self.assertTrue(result["waiting"])
        self.assertEqual(output.call_args.kwargs["mode"], "waiting")
        self.assertFalse(output.call_args.kwargs["ready"])

    def test_review_timeout_fails_instead_of_remaining_green(self):
        fresh = request()
        release.pending_review(fresh["created_at"])
        with self.assertRaisesRegex(ValueError, "two-hour"):
            release.pending_review(request(age=release.REVIEW_WAIT_SECONDS + 1)["created_at"])

    def test_a_new_head_is_processed_instead_of_trusting_an_old_task_request(self):
        with (tempfile.TemporaryDirectory() as directory,
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_comments", return_value=[request()]),
              patch.object(release, "repair_states", return_value=[STATE]),
              patch.object(release, "repair_changes", return_value=(["patches/0009-fix.patch"], False)),
              patch.object(release, "copy_patch_series", return_value=Path(directory)) as copy,
              patch.object(release, "output")):
            result = release.proposal(REPO, CONFIG, Path(directory))
        self.assertFalse(result["waiting"])
        copy.assert_called_once_with(HEAD, Path(directory) / "proposal")

    def test_elapsed_repair_window_fails_even_when_the_pr_is_waiting_for_a_push(self):
        with (patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_comments",
                           return_value=[request(age=release.REVIEW_WAIT_SECONDS + 1)]),
              patch.object(release, "repair_states", return_value=[STATE]),
              patch.object(release, "output") as output,
              self.assertRaisesRegex(ValueError, "two-hour")):
            release.proposal(REPO, CONFIG, Path("/unused"))
        self.assertIn("two-hour", output.call_args.kwargs["reason"])

    def test_policy_findings_block_adoption_and_enter_normal_repair(self):
        review = {"body": f"<!-- 9router-policy:{HEAD} -->", "created_at": request()["created_at"]}
        with (patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_comments", return_value=[review]),
              patch.object(release, "repair_states", return_value=[STATE]),
              patch.object(release, "repair_changes", return_value=(["scripts/release.py"], True)),
              patch.object(release, "policy_review", return_value=(False, "Codex reported an unresolved finding on this commit")),
              patch.object(release, "output") as output,
              self.assertRaisesRegex(ValueError, "unresolved finding")):
            release.proposal(REPO, CONFIG, Path("/unused"))
        self.assertFalse(output.call_args.kwargs["ready"])

    def test_recovered_candidate_closes_only_the_unchanged_blocking_repair(self):
        with (patch.object(release, "api", side_effect=[
                  {"sha": CONFIG}, {"state": "open", "head": {"sha": HEAD}}, {}, {}]) as api):
            release.close_recovered_repair(REPO, CONFIG, state=STATE)
        self.assertEqual(api.call_args.kwargs, {"method": "PATCH", "data": {"state": "closed"}})

    def test_late_lookup_closes_the_captured_unchanged_blocking_repair(self):
        with (patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "api", side_effect=[
                  {"sha": CONFIG}, {"state": "open", "head": {"sha": HEAD}}, {}, {}]) as api):
            release.close_recovered_repair(REPO, CONFIG, expected_head=HEAD)
        self.assertEqual(api.call_args.kwargs, {"method": "PATCH", "data": {"state": "closed"}})

    def test_late_lookup_does_not_close_a_repair_advanced_after_preparation(self):
        with (patch.object(release, "repair_pull", return_value={**STATE, "head": SEED}),
              patch.object(release, "api", return_value={"sha": CONFIG}) as api):
            release.close_recovered_repair(REPO, CONFIG, expected_head=HEAD)
        self.assertFalse(any(c.kwargs.get("method") in {"POST", "PATCH"} for c in api.call_args_list))

    def test_late_lookup_without_a_captured_head_does_not_discover_a_new_repair(self):
        with (patch.object(release, "repair_pull", side_effect=AssertionError("must not look up repair")),
              patch.object(release, "api", return_value={"sha": CONFIG}) as api):
            release.close_recovered_repair(REPO, CONFIG)
        self.assertFalse(any(c.kwargs.get("method") in {"POST", "PATCH"} for c in api.call_args_list))

    def test_changed_repair_is_not_closed_by_default_candidate_recovery(self):
        with patch.object(release, "api", side_effect=[
                {"sha": CONFIG}, {"state": "open", "head": {"sha": SEED}}]) as api:
            release.close_recovered_repair(REPO, CONFIG, state=STATE)
        self.assertFalse(any(c.kwargs.get("method") in {"POST", "PATCH"} for c in api.call_args_list))

    def test_clean_policy_is_adopted_and_dispatched_without_a_second_repair_queue(self):
        adopted = "e" * 40
        review = {"body": f"<!-- 9router-policy:{HEAD} -->", "created_at": request()["created_at"]}
        def api(path, **kwargs):
            if path.endswith("/commits/downstream"):
                return {"sha": CONFIG}
            return {"state": "open", "head": {"sha": HEAD}}
        def run(*args, **kwargs):
            return adopted if args == ("git", "rev-parse", "HEAD") else ""
        with (tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV),
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_changes", return_value=(["scripts/release.py"], True)),
              patch.object(release, "repair_comments", return_value=[review]),
              patch.object(release, "policy_review", return_value=(True, "Accepted")),
              patch.object(release, "api", side_effect=api) as calls,
              patch.object(release, "pages", return_value=[]),
              patch.object(release, "run", side_effect=run),
              patch.object(release.subprocess, "check_output", return_value=b"verified diff"),
              patch.object(release.subprocess, "run", return_value=SimpleNamespace(stdout="", returncode=1)),
              patch.object(release, "request_repair") as followup):
            release.land_repair(Path(directory))
        followup.assert_not_called()
        self.assertEqual(calls.call_args.args, (f"repos/{REPO}/actions/workflows/release.yml/dispatches",))
        self.assertEqual(calls.call_args.kwargs, {"method": "POST", "data": {"ref": "downstream"}})


class NativeTaskTests(unittest.TestCase):
    def invoke(self, requests):
        context = (
            patch.dict(os.environ, ENV),
            patch.object(release, "api", return_value={"sha": CONFIG}),
            patch.object(release, "repair_pull", return_value=STATE),
            patch.object(release, "failure_evidence", return_value="Actual failed assertion"),
            patch.object(release, "owner_token", return_value="test-only"),
            patch.object(release, "repair_comments", return_value=requests),
            patch.object(release, "repair_states", return_value=[STATE]),
        )
        return context

    def test_first_fix_is_a_native_owner_request_not_a_review_or_a_report(self):
        contexts = self.invoke([])
        with contexts[0], contexts[1] as api, contexts[2], contexts[3], contexts[4], contexts[5], contexts[6]:
            release.request_repair(Path("/unused"))
        sent = api.call_args
        self.assertEqual(sent.args[0], f"repos/{REPO}/issues/2/comments")
        self.assertEqual(sent.kwargs["token"], "test-only")
        body = sent.kwargs["data"]["body"]
        self.assertTrue(body.startswith("@codex fix "))
        self.assertIn(f"<!-- 9router-fix:{HEAD}:1 -->", body)
        self.assertIn("push the actual fix", body)
        self.assertIn("Actual failed assertion", body)

    def test_same_head_is_not_requested_twice(self):
        contexts = self.invoke([request(HEAD)])
        with contexts[0], contexts[1] as api, contexts[2], contexts[3], contexts[4], contexts[5], contexts[6]:
            release.request_repair(Path("/unused"))
        self.assertEqual(api.call_count, 1)

    def test_fix_count_does_not_stop_work_within_the_time_budget(self):
        for count in (3, 12):
            requests = [request(f"{index + 1:040x}", index + 1) for index in range(count)]
            contexts = self.invoke(requests)
            with (self.subTest(count=count), contexts[0], contexts[1] as api,
                  contexts[2], contexts[3], contexts[4], contexts[5], contexts[6],
                  patch.object(release, "escalation", side_effect=AssertionError("Count is not a budget"))):
                release.request_repair(Path("/unused"))
            body = api.call_args.kwargs["data"]["body"]
            self.assertIn(f"<!-- 9router-fix:{HEAD}:{count + 1} -->", body)
            self.assertIn("elapsed-time deadline:", body)
            self.assertIn("number of fixes is not a stop condition", body)

    def test_only_the_final_task_marker_identifies_a_request(self):
        body = release.repair_text(STATE, 13, f"log contains <!-- 9router-fix:{SEED}:1 -->")
        marker = release.FIX_REQUEST.search(body)
        self.assertEqual(marker.groups(), (HEAD, "13"))

    def test_cycle_identity_does_not_depend_on_configuration_or_patch_edits(self):
        with patch.object(release, "patch_identity", side_effect=AssertionError("Fixes are not new cycles")):
            cycle = release.repair_cycle(UPSTREAM, 42)
        self.assertEqual(cycle, release.repair_cycle(UPSTREAM, 42))
        self.assertNotEqual(cycle, release.repair_cycle(UPSTREAM, 43))
        self.assertNotEqual(cycle, release.repair_cycle(HEAD, 42))

    def test_new_review_does_not_restart_the_first_fix_deadline(self):
        first = request(age=release.REVIEW_WAIT_SECONDS + 1)
        with (patch.object(release, "repair_requests", return_value=[first]),
              self.assertRaisesRegex(ValueError, "two-hour")):
            release.pending_repair_review(REPO, STATE, request()["created_at"])

    def test_fix_prompt_retains_the_original_elapsed_deadline(self):
        start = request(age=3600)["created_at"]
        deadline = (datetime.fromisoformat(start) + timedelta(seconds=release.REVIEW_WAIT_SECONDS)).isoformat()
        self.assertIn(f"deadline: {deadline}", release.repair_text(STATE, 42, "failure", start))
        self.assertIn("change the approach", release.repair_text(STATE, 42, "failure", start))

    def test_timeout_alone_closes_the_window_without_escalation_or_new_task(self):
        contexts = self.invoke([request(HEAD, age=release.REVIEW_WAIT_SECONDS + 1)])
        with (contexts[0], contexts[1] as api, contexts[2], contexts[3], contexts[4], contexts[5], contexts[6],
              patch.dict(os.environ, {**ENV, "GITHUB_EVENT_NAME": "issue_comment"}),
              patch.object(release, "expire_repair_window") as expire,
              patch.object(release, "escalation", side_effect=AssertionError("Elapsed time is not an owner decision")),
              patch("builtins.print") as emit):
            release.request_repair(Path("/unused"))
        self.assertEqual(api.call_count, 1)
        expire.assert_called_once()
        self.assertIn("next scheduled run", emit.call_args.args[0])

    def test_expiry_is_recorded_and_closes_only_the_matching_window(self):
        pull = {"state": "open", "head": {"sha": HEAD, "repo": {"full_name": REPO},
                                             "ref": "repair/window"},
                "base": {"ref": "downstream"},
                "body": "<!-- 9router-repair:v1 " + json.dumps(STATE) + " -->"}
        with (patch.object(release, "repair_comments", return_value=[]),
              patch.object(release, "api", side_effect=[pull, None, pull, None]) as api):
            release.expire_repair_window(REPO, STATE, "deadline and evidence", "test-only")
        self.assertEqual(api.call_args_list[1].args,
                         (f"repos/{REPO}/issues/{STATE['number']}/comments",))
        timeout = api.call_args_list[1].kwargs["data"]["body"]
        self.assertIn("next scheduled run", timeout)
        self.assertIn("does not request an owner decision", timeout)
        self.assertIn("deadline and evidence", timeout)
        self.assertEqual(api.call_args_list[0].args, (f"repos/{REPO}/pulls/{STATE['number']}",))
        self.assertEqual(api.call_args_list[3].kwargs["data"], {"state": "closed"})

        moved = {**STATE, "head": SEED}
        advanced = {**pull, "head": {**pull["head"], "sha": SEED}}
        with (patch.object(release, "repair_comments", return_value=[]),
              patch.object(release, "api", side_effect=[advanced, None, advanced, None]) as api):
            release.expire_repair_window(REPO, moved, "deadline", "test-only")
        self.assertEqual(api.call_count, 4)

        wrong_window = {**pull, "body": "<!-- 9router-repair:v1 " + json.dumps(
            {**STATE, "window": "run-other"}) + " -->"}
        with (patch.object(release, "repair_comments", return_value=[]),
              patch.object(release, "api", return_value=wrong_window) as api,
              self.assertRaisesRegex(ValueError, "identity changed")):
            release.expire_repair_window(REPO, STATE, "deadline", "test-only")
        self.assertEqual(api.call_count, 1)

    def test_next_schedule_starts_a_fresh_window_and_keeps_old_attempt_history(self):
        old = request(HEAD, 7, age=release.REVIEW_WAIT_SECONDS + 1)
        new_seed = "f" * 40
        calls = []

        def api(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            if path.endswith("/commits/downstream"):
                return {"sha": CONFIG}
            if path.endswith("/pulls") and method == "POST":
                return {"number": 3, "created_at": datetime.now(timezone.utc).isoformat()}
            return None

        def run(*args, cwd=None, **kwargs):
            if args[:2] == ("git", "init"):
                Path(args[2]).mkdir(parents=True, exist_ok=True)
            if args[:3] == ("git", "worktree", "add"):
                Path(args[4]).mkdir(parents=True, exist_ok=True)
            if args[:3] == ("git", "rev-parse", "HEAD"):
                return new_seed
            return ""

        def process(command, **kwargs):
            return SimpleNamespace(returncode=1 if "--quiet" in command else 0, stdout="")

        with (tempfile.TemporaryDirectory() as directory,
              patch.dict(os.environ, {**ENV, "GITHUB_EVENT_NAME": "schedule"}),
              patch.object(release, "api", side_effect=api),
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "failure_evidence", return_value="deadline evidence"),
              patch.object(release, "owner_token", return_value="test-only"),
              patch.object(release, "repair_states", return_value=[STATE]),
              patch.object(release, "repair_requests", side_effect=[[old], []]),
              patch.object(release, "repair_history", side_effect=[[old], [old]]),
              patch.object(release, "repair_comments", return_value=[]),
              patch.object(release, "expire_repair_window") as expire,
              patch.object(release, "run", side_effect=run),
              patch.object(release.subprocess, "run", side_effect=process)):
            release.request_repair(Path(directory) / "repair")

        expire.assert_called_once()
        created = next(call for call in calls if call[0].endswith("/pulls") and call[1] == "POST")
        identity = release.REPAIR_STATE.search(created[2]["body"])
        self.assertEqual(json.loads(identity.group(1))["window"], "run-42")
        self.assertEqual(json.loads(identity.group(1))["cycle"], STATE["cycle"])
        task = next(call for call in calls if call[0].endswith("/issues/3/comments"))
        body = task[2]["body"]
        self.assertIn(f"<!-- 9router-fix:{new_seed}:2 -->", body)
        self.assertIn("Earlier attempts across this upstream/release campaign", body)
        self.assertIn(old["created_at"], body)
        self.assertIn("change the approach", body)

    def test_deadline_is_scoped_to_window_but_all_campaign_attempts_remain_history(self):
        cycle = STATE["cycle"]
        old_state = {**STATE, "number": 1, "window": "run-old"}
        new_state = {**STATE, "number": 3, "window": "run-new"}
        old_pull = {
            "number": 1, "user": {"login": "github-actions[bot]"},
            "head": {"sha": SEED, "repo": {"full_name": REPO}, "ref": "repair/old"},
            "state": "closed", "created_at": "2026-10-15T10:00:00Z",
            "body": "<!-- 9router-repair:v1 " + json.dumps(old_state) + " -->",
        }
        new_pull = {
            "number": 3, "user": {"login": "github-actions[bot]"},
            "head": {"sha": HEAD, "repo": {"full_name": REPO}, "ref": "repair/new"},
            "state": "open", "created_at": "2026-10-16T10:00:00Z",
            "body": "<!-- 9router-repair:v1 " + json.dumps(new_state) + " -->",
        }
        old_request = request(SEED, 1, age=release.REVIEW_WAIT_SECONDS + 10)
        new_request = request(HEAD, 2, age=5)
        comments = {1: [old_request], 3: [new_request]}
        with (patch.object(release, "pages", return_value=[old_pull, new_pull]),
              patch.object(release, "repair_comments", side_effect=lambda _repo, number: comments[number])):
            self.assertEqual(release.repair_requests(REPO, new_state), [new_request])
            self.assertEqual(release.repair_history(REPO, new_state), [old_request, new_request])
        self.assertEqual(release.repair_window(new_state), "run-new")
        self.assertEqual(new_state["cycle"], cycle)

    def test_superseded_configuration_does_not_close_or_repair_newer_work(self):
        with (patch.dict(os.environ, ENV), patch.object(release, "api", return_value={"sha": HEAD}),
              patch.object(release, "repair_pull", side_effect=AssertionError("Newer work is not stale"))):
            release.request_repair(Path("/unused"))

    def test_a_concurrent_new_push_gets_verified_not_repaired_again(self):
        with (patch.dict(os.environ, ENV), patch.object(release, "api", return_value={"sha": CONFIG}),
              patch.object(release, "repair_pull", return_value={**STATE, "head": SEED}),
              patch.object(release, "failure_evidence", side_effect=AssertionError("A new run owns this head"))):
            release.request_repair(Path("/unused"))

    def test_failure_evidence_reads_the_jobs_object_and_exact_review_findings(self):
        finding = {"user": {"login": release.BOT, "type": "Bot"}, "commit_id": HEAD,
                   "path": "open-sse/utils/example.js", "line": 3, "body": "[P2] Restore custom call type"}
        jobs = {"total_count": 1, "jobs": [{"id": 9, "conclusion": "failure",
                "name": "Regression", "html_url": "https://github.com/example"}]}
        with (patch.dict(os.environ, ENV), patch.object(release, "api", return_value=jobs),
              patch.object(release, "pages", return_value=[finding]),
              patch.object(release, "run", return_value="Actual assertion failed")):
            evidence = release.failure_evidence(REPO)
        self.assertIn("Actual assertion failed", evidence)
        self.assertIn("[P2] Restore custom call type", evidence)

    def test_legacy_nonblocking_metadata_cannot_reenable_publication_exception(self):
        contexts = self.invoke([])
        with (contexts[0], contexts[1] as api, contexts[3], contexts[4], contexts[5], contexts[6],
              patch.dict(os.environ, {"NONBLOCKING_FOLLOWUP": "true"}),
              patch.object(release, "repair_pull", return_value={**STATE, "nonblocking": True})):
            release.request_repair(Path("/unused"))
        self.assertIn("push the actual fix", api.call_args.kwargs["data"]["body"])
        self.assertNotIn("nonblocking", api.call_args.kwargs["data"]["body"])

    def test_policy_configuration_changes_do_not_reset_the_repair_budget(self):
        cycle = "e" * 64
        state = {**STATE, "cycle": cycle, "window": "run-42"}
        previous = {
            "number": 1, "user": {"login": "github-actions[bot]", "type": "Bot"},
            "head": {"sha": SEED, "repo": {"full_name": REPO}, "ref": "repair/previous"},
            "state": "closed", "created_at": "2026-10-15T10:00:00Z",
            "body": "<!-- 9router-repair:v1 " + json.dumps({**state, "config": SEED}) + " -->",
        }
        first, second = request(SEED, 1, age=2), request(UPSTREAM, 2, age=1)
        with (patch.object(release, "pages", return_value=[previous]),
              patch.object(release, "repair_comments", side_effect=[[first, second], []])):
            self.assertEqual(release.repair_requests(REPO, state), [first, second])


class ReviewContextCommitTests(unittest.TestCase):
    def test_review_context_uses_local_application_metadata_before_any_push(self):
        app = Path("/local/application")
        application_sha, tree_sha, context_sha = "a" * 40, "b" * 40, "c" * 40
        author_date, candidate_id = "2026-10-17T00:00:00+00:00", "f" * 64
        commands = [
            ("git", "rev-parse", f"{application_sha}^{{commit}}"),
            ("git", "rev-parse", f"{application_sha}^{{tree}}"),
            ("git", "show", "-s", "--format=%aI", application_sha),
            ("git", "rev-parse", f"{context_sha}^{{tree}}"),
            ("git", "show", "-s", "--format=%P", context_sha),
            ("git", "show", "-s", "--format=%B", context_sha),
            ("git", "show", "-s", "--format=%aI", context_sha),
            ("git", "show", "-s", "--format=%cI", context_sha),
        ]
        with (patch.object(release, "api", side_effect=AssertionError(
                  "context construction must not require a native commit lookup")),
              patch.object(release, "run", side_effect=[
                  application_sha, tree_sha, author_date, tree_sha, application_sha,
                  "fork-review-context:v1 " + candidate_id, author_date, author_date]) as run,
              patch.object(release.subprocess, "run",
                           return_value=SimpleNamespace(stdout=context_sha)) as commit_tree):
            created, returned_application = release._create_review_context_commit(
                app, application_sha, candidate_id)

        self.assertEqual((created, returned_application), (context_sha, application_sha))
        self.assertEqual([item.args for item in run.call_args_list], commands)
        self.assertEqual(commit_tree.call_args.args[0], ["git", "commit-tree", tree_sha,
                                                         "-p", application_sha])
        self.assertEqual(commit_tree.call_args.kwargs["input"],
                         "fork-review-context:v1 " + candidate_id + "\n")
        self.assertEqual(commit_tree.call_args.kwargs["env"]["GIT_AUTHOR_DATE"], author_date)
        self.assertEqual(commit_tree.call_args.kwargs["env"]["GIT_COMMITTER_DATE"], author_date)


class RegressionSelectionTests(unittest.TestCase):
    def test_historical_new_modified_and_upstream_absorbed_regressions_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trusted, app, upstream = (root / name for name in ("trusted", "app", "upstream"))
            (trusted / "patches").mkdir(parents=True)
            historical = "tests/unit/historical.test.js"
            absorbed = "tests/unit/absorbed.test.js"
            (trusted / "patches/source.json").write_text(json.dumps({
                "test_files": [historical], "regression_files": [absorbed]}))
            files = [historical, absorbed, "tests/unit/new.test.js",
                     "tests/translator/changed.test.js", "tests/unit/unchanged.test.js"]
            for relative in files:
                path = app / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("patched" if "changed" in relative and "unchanged" not in relative else "same")
                if "new." not in relative:
                    baseline = upstream / relative
                    baseline.parent.mkdir(parents=True, exist_ok=True)
                    baseline.write_text("same")
            with (patch.object(release, "ROOT", trusted),
                  patch.dict(os.environ, {"UPSTREAM_DIR": str(upstream), "UPSTREAM_SHA": UPSTREAM}),
                  patch.object(release, "prepare_golden_baseline"),
                  patch.object(release, "run_vitest") as execute):
                release.test_patches(app)
            self.assertEqual(set(execute.call_args.args[1]), {
                "unit/historical.test.js", "unit/absorbed.test.js",
                "unit/new.test.js", "translator/changed.test.js",
            })

    def test_missing_persistent_regression_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "patches").mkdir()
            (root / "tests/unit").mkdir(parents=True)
            (root / "tests/unit/historical.test.js").write_text("test")
            (root / "patches/source.json").write_text(json.dumps({
                "test_files": ["tests/unit/historical.test.js"],
                "regression_files": ["tests/unit/missing.test.js"]}))
            with patch.object(release, "ROOT", root), self.assertRaisesRegex(ValueError, "missing"):
                release.test_patches(root)

    def test_vitest_keeps_one_complete_batch_and_has_an_outer_time_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / "tests").mkdir()
            selected = ["unit/a.test.js", "translator/b.test.js"]
            with (patch.dict(os.environ, {"GH_TOKEN": "must-not-reach-tests",
                                          "GITHUB_TOKEN": "must-not-reach-tests",
                                          "CODEX_REQUEST_TOKEN": "must-not-reach-tests"}),
                  patch.object(release.subprocess, "run", return_value=SimpleNamespace()) as execute):
                release.run_vitest(app, selected)
            execute.assert_called_once()
            command = execute.call_args.args[0]
            self.assertEqual(command[:5], ["timeout", "--signal=TERM", "--kill-after=10s",
                                           "1500s", "node"])
            self.assertEqual(command[5:], ["node_modules/vitest/vitest.mjs", "run", *selected])
            options = execute.call_args.kwargs
            self.assertEqual(options["timeout"], 1550)
            self.assertTrue(options["check"])
            self.assertNotIn("stdout", options)
            self.assertNotIn("stderr", options)
            self.assertNotIn("GH_TOKEN", options["env"])
            self.assertNotIn("GITHUB_TOKEN", options["env"])
            self.assertNotIn("CODEX_REQUEST_TOKEN", options["env"])


class PolicyBundleTests(unittest.TestCase):
    def test_closed_review_pair_reuse_requires_policy_only_and_exact_bundle_proof(self):
        candidate = {"schema": 1, "application_sha": HEAD}
        candidate_id = "f" * 64
        baseline = {"release_id": 5}
        full = {"number": 3, "state": "closed"}
        delta = {"number": 4, "state": "closed"}
        proof = {"decision": "reuse-policy-validation", "candidate_id": candidate_id,
                 "manifest_sha256": "a" * 64}

        class Lifecycle:
            decision = "policy-only"

            def authorize_final(self, _candidate, _history):
                return {"decision": self.decision}

        lifecycle = Lifecycle()
        with (patch.object(release, "_final_history", return_value={"exact": True}) as history,
              patch.object(release, "_validated_policy_bundle", return_value=proof) as validate):
            self.assertTrue(release._closed_policy_pair_has_verified_bundle(
                REPO, lifecycle, candidate, candidate_id, baseline, full, delta))
        history.assert_called_once_with(REPO, {"repository": REPO, "baseline": baseline}, lifecycle)
        validate.assert_called_once_with(REPO, candidate, full)

        lifecycle.decision = "allow"
        with (patch.object(release, "_final_history", return_value={"exact": True}),
              patch.object(release, "_validated_policy_bundle") as validate):
            self.assertFalse(release._closed_policy_pair_has_verified_bundle(
                REPO, lifecycle, candidate, candidate_id, baseline, full, delta))
        validate.assert_not_called()
        lifecycle.decision = "policy-only"
        with (patch.object(release, "_final_history", return_value={"exact": True}),
              patch.object(release, "_validated_policy_bundle", return_value=proof),
              self.assertRaisesRegex(ValueError, "exact policy candidate")):
            release._closed_policy_pair_has_verified_bundle(
                REPO, lifecycle, candidate, "0" * 64, baseline, full, delta)
        with patch.object(release, "_final_history") as history:
            self.assertFalse(release._closed_policy_pair_has_verified_bundle(
                REPO, lifecycle, candidate, candidate_id, baseline,
                {**full, "state": "open"}, delta))
        history.assert_not_called()

    def test_shared_policy_suite_suppresses_candidate_output_and_docker_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trusted = root / "trusted"
            (trusted / "scripts").mkdir(parents=True)
            (trusted / "patches").mkdir()
            (trusted / ".github/workflows").mkdir(parents=True)
            (trusted / "scripts/release.py").write_text("pass\n")
            (trusted / "scripts/test_baseline.py").write_text("pass\n")
            (trusted / "patches/source.json").write_text("{}\n")
            (trusted / ".github/workflows/release.yml").write_text("jobs: {}\n")

            candidate = root / "candidate"
            candidate_scripts = candidate / "scripts"
            candidate_scripts.mkdir(parents=True)
            (candidate_scripts / "release.py").write_text("pass\n")
            (candidate_scripts / "test_baseline.py").write_text("pass\n")
            (candidate_scripts / "test_candidate.py").write_text("raise RuntimeError('private source')\n")
            (candidate_scripts / "maintenance.lock.json").write_text(json.dumps({
                "schema": 1, "repository": "warelik/machine-maintenance",
                "revision": "a" * 40, "module_sha256": "b" * 64, "api_version": 1,
            }))
            workflow = candidate / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("jobs: {}\n")
            parser = root / "parser"
            parser.mkdir()

            yaml = SimpleNamespace(safe_load=lambda _source: {
                "jobs": {"policy": {"steps": [
                    {"uses": "actions/checkout@" + "c" * 40},
                ]}},
            })
            calls = []

            def execute(args, **kwargs):
                calls.append((args, kwargs))
                return SimpleNamespace(returncode=1 if "run" in args else 0, stdout="")

            env = {
                "NINEROUTER_POLICY_PARSER": str(parser),
                "FORK_MAINTENANCE_ROOT": str(root / "private-maintenance"),
            }
            with (patch.object(release, "ROOT", trusted), patch.dict(os.environ, env),
                  patch.object(release, "yaml_module", return_value=yaml),
                  patch.object(release, "_candidate_private_lifecycle",
                               return_value=(b"private module", b"private receipt")),
                  patch.object(release, "policy_container_engine", return_value=(['docker'], "docker")),
                  patch.object(release.subprocess, "run", side_effect=execute),
                  self.assertRaisesRegex(ValueError, "private test output was suppressed") as failure):
                release.check_policy_shared(candidate)

        self.assertIn("status 1", str(failure.exception))
        self.assertNotIn("private source", str(failure.exception))
        self.assertEqual(len(calls), 3)
        args, kwargs = calls[0]
        self.assertIn("-I", args)
        self.assertIn("--log-driver", args)
        self.assertEqual(args[args.index("--log-driver") + 1], "none")
        self.assertIs(kwargs["stdout"], subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
        launcher = args[args.index("-c") + 1]
        self.assertIn("oracle_tests=sorted(oracle.glob('test_*.py'))", launcher)
        self.assertIn("candidate_tests=[pathlib.Path(p) for p in sys.argv[4:-1]]", launcher)
        self.assertIn("result.testsRun", launcher)
        self.assertIn("completion.write_text", launcher)
        self.assertLess(launcher.index("result=runner.run(suite)"),
                        launcher.index("completion.write_text"))
        self.assertEqual(Path(args[-2]).name, "test_candidate.py")
        self.assertEqual(Path(args[-1]).name, "policy-suite-completion.json")

    def test_shared_policy_suite_requires_trusted_full_completion_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "completion.json"
            with self.assertRaisesRegex(ValueError, "did not record complete"):
                release._verify_policy_test_completion(marker, 0)
            marker.write_text(json.dumps({
                "schema": 1, "expected_count": 9, "executed_count": 9, "successful": True,
            }))
            release._verify_policy_test_completion(marker, 0)
            marker.write_text(json.dumps({
                "schema": 1, "expected_count": 9, "executed_count": 0, "successful": True,
            }))
            with self.assertRaisesRegex(ValueError, "complete every required test"):
                release._verify_policy_test_completion(marker, 0)
            with self.assertRaisesRegex(ValueError, "status 7"):
                release._verify_policy_test_completion(marker, 7)

    def test_shared_actionlint_runs_without_host_authority_or_candidate_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / "release.yml"
            workflow.write_text("name: candidate\n")
            archive_buffer = io.BytesIO()
            payload = b"pinned actionlint executable"
            with tarfile.open(fileobj=archive_buffer, mode="w:gz") as archive:
                entry = tarfile.TarInfo("actionlint")
                entry.size = len(payload)
                archive.addfile(entry, io.BytesIO(payload))
            archive_bytes = archive_buffer.getvalue()

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self, _limit=-1):
                    return archive_bytes

            calls = []

            def execute(command, **kwargs):
                calls.append((command, kwargs))
                return SimpleNamespace(returncode=0, stdout="")

            class Digest:
                @staticmethod
                def hexdigest():
                    return "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"

            with (patch.object(release, "urlopen", return_value=Response()),
                  patch.object(release.hashlib, "sha256", return_value=Digest()),
                  patch.object(release.subprocess, "run", side_effect=execute)):
                release._run_actionlint_sandbox(
                    workflow, container_engine=["docker"], engine_kind="docker", temp_root=root)

            self.assertEqual(len(calls), 3)
            command, options = calls[0]
            for flag in ("--read-only", "--network=none", "--log-driver", "--cap-drop=ALL",
                         "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m"):
                self.assertIn(flag, command)
            self.assertEqual(command[command.index("--log-driver") + 1], "none")
            self.assertIn("readonly", next(item for item in command if item.startswith("type=bind,")))
            self.assertFalse(any("TOKEN" in item or str(workflow) in item for item in command))
            self.assertEqual(options["timeout"], 150)
            self.assertIs(options["stdout"], subprocess.DEVNULL)
            self.assertIs(options["stderr"], subprocess.DEVNULL)

    def test_verified_native_bundle_requires_owner_reads_in_the_two_repositories(self):
        native = {"repository": REPO}
        with (patch.dict(os.environ, {"CODEX_REQUEST_TOKEN": "owner-token"}),
              patch.object(release, "api", side_effect=[
                  {"login": "warelik", "type": "User"}, native]) as read):
            reader = release._owner_native_reader(REPO)
            self.assertEqual(reader("repos/warelik/machine-maintenance/actions/runs/7"), native)
            self.assertEqual(read.call_args.args[0], "repos/warelik/machine-maintenance/actions/runs/7")
            self.assertEqual(read.call_args.kwargs["token"], "owner-token")
            for route in ("repos/other/private/contents/x", "https://api.github.com/repos/warelik/9router"):
                with self.subTest(route=route), self.assertRaises(ValueError):
                    reader(route)

    def test_bundle_helper_uses_the_full_review_pr_comment_list_and_fails_closed(self):
        full_pull = {"number": 3}
        comments = [{"id": 11}]
        reader = lambda route: {"route": route}
        invocations = []

        def validated_bundle(candidate, current_comments, read_native):
            invocations.append((candidate, current_comments, read_native))
            return {"verified": True}

        with (patch.object(release, "_shared_review_comments", return_value=comments) as fetch,
              patch.object(release, "_owner_native_reader", return_value=reader),
              patch.dict("sys.modules", {"maintenance": SimpleNamespace(validated_bundle=validated_bundle)})):
            self.assertTrue(release._validated_policy_bundle(REPO, {"sha": HEAD}, full_pull))
        fetch.assert_called_once_with(REPO, [full_pull])
        self.assertEqual(invocations[0][:2], ({"sha": HEAD}, comments))
        self.assertIs(invocations[0][2], reader)

        def missing_bundle(candidate, current_comments, read_native):
            return None

        with (patch.object(release, "_shared_review_comments", return_value=comments),
              patch.object(release, "_owner_native_reader", return_value=reader),
              patch.dict("sys.modules", {"maintenance": SimpleNamespace(validated_bundle=missing_bundle)})):
            self.assertFalse(release._validated_policy_bundle(REPO, {}, full_pull))

        def malformed_bundle(candidate, current_comments, read_native):
            return "not a proof object"

        with (patch.object(release, "_shared_review_comments", return_value=comments),
              patch.object(release, "_owner_native_reader", return_value=reader),
              patch.dict("sys.modules", {"maintenance": SimpleNamespace(validated_bundle=malformed_bundle)}),
              self.assertRaisesRegex(ValueError, "proof is malformed")):
            release._validated_policy_bundle(REPO, {}, full_pull)

    def test_public_bundle_wrapper_rejects_wrong_private_revision_or_module_hash(self):
        import importlib

        maintenance = importlib.import_module("maintenance")
        lock = json.loads((Path(release.__file__).with_name("maintenance.lock.json")).read_text())

        class Core:
            API_VERSION = 1

            def __init__(self, shared_source):
                self.shared_source = shared_source
                self._maintenance_lock_identity = {
                    "repository": lock["repository"], "revision": lock["revision"],
                    "module_sha256": lock["module_sha256"], "api_version": lock["api_version"],
                }

            def validated_bundle(self, candidate, comments, read_native):
                return {"shared_source": self.shared_source, "decision": "reuse-policy-validation"}

        for field in ("revision", "module_sha256"):
            shared_source = {
                "repository": lock["repository"], "revision": lock["revision"],
                "module_sha256": lock["module_sha256"], "api_version": lock["api_version"],
            }
            shared_source[field] = ("0" * 40 if field == "revision" else "0" * 64)
            with (self.subTest(field=field),
                  patch.object(maintenance, "load", return_value=Core(shared_source)),
                  self.assertRaises(ValueError)):
                maintenance.validated_bundle({"schema": 1}, [], lambda route: {})


class SharedHistoryAdapterTests(unittest.TestCase):
    def test_known_findings_requires_immutable_native_bot_comment_identity(self):
        older_findings = [{"finding_id": "review:7:12", "body": "older batch"}]
        latest_findings = [
            {"finding_id": "review:7:13", "body": "first preserved finding"},
            {"finding_id": "inline:6:14", "body": "second preserved finding"},
        ]

        def stored_comment(comment_id, findings, *, created_at="2026-10-19T10:00:00Z",
                           updated_at="2026-10-19T10:00:00Z", user=None):
            marker = "<!-- fork-findings:v1 " + json.dumps({
                "schema": 1, "candidate_id": "a" * 64, "findings": findings,
            }, sort_keys=True, separators=(",", ":")) + " -->"
            return {
                "id": comment_id, "created_at": created_at, "updated_at": updated_at,
                "user": user or {"login": "github-actions[bot]", "type": "Bot"},
                "body": "Trusted lifecycle snapshot.\n\n" + marker,
            }

        older = stored_comment(11, older_findings)
        latest = stored_comment(12, latest_findings)
        for rows in ([latest, older], [older, latest]):
            with self.subTest(row_ids=[item["id"] for item in rows]), \
                    patch.object(release, "pages", return_value=rows):
                self.assertEqual(release._known_findings(
                    REPO, [7], published_at=PUBLISHED), latest_findings)

        owner_copy = stored_comment(
            13, latest_findings, user={"login": "warelik", "type": "User"})
        with patch.object(release, "pages", return_value=[owner_copy]):
            self.assertEqual(release._known_findings(REPO, [7], published_at=PUBLISHED), [])

        invalid = []
        for native_id in (0, -1, True, False, None, "12"):
            comment = dict(latest)
            comment["id"] = native_id
            invalid.append((comment, "positive native comment ID"))
        missing_id = dict(latest)
        missing_id.pop("id")
        invalid.append((missing_id, "positive native comment ID"))
        for field in ("created_at", "updated_at"):
            comment = dict(latest)
            comment.pop(field)
            invalid.append((comment, "timestamps are missing"))
        for field, value, message in (("created_at", "not-a-time", "timestamps"),
                                      ("updated_at", "2026-10-19T10:01:00Z", "edited"),
                                      ("created_at", "2026-10-19T10:00:00", "timestamps")):
            comment = dict(latest)
            comment[field] = value
            invalid.append((comment, message))

        for comment, message in invalid:
            with self.subTest(comment_id=comment.get("id"),
                              created_at=comment.get("created_at"),
                              updated_at=comment.get("updated_at")):
                with (patch.object(release, "pages", return_value=[comment]),
                      self.assertRaisesRegex(ValueError, message)):
                    release._known_findings(REPO, [7], published_at=PUBLISHED)

    def test_known_findings_requires_an_exact_envelope_and_integer_schema(self):
        prefix = "<!-- fork-findings:v1"
        suffix = " -->"
        payload = {"schema": 1, "candidate_id": "a" * 64, "findings": []}

        def comment(body):
            return {
                "id": 15, "created_at": "2026-10-19T10:00:00Z",
                "updated_at": "2026-10-19T10:00:00Z",
                "user": {"login": "github-actions[bot]", "type": "Bot"}, "body": body,
            }

        for schema in (False, True, 1.0, 2):
            with self.subTest(schema=schema):
                value = {**payload, "schema": schema}
                note = comment(prefix + " " + json.dumps(value, sort_keys=True) + suffix)
                with (patch.object(release, "pages", return_value=[note]),
                      self.assertRaisesRegex(ValueError, "invalid identity")):
                    release._known_findings(REPO, [7], published_at=PUBLISHED)

        extra = comment(prefix + " " + json.dumps(
            {**payload, "extra": "not part of the marker ABI"}, sort_keys=True) + suffix)
        with (patch.object(release, "pages", return_value=[extra]),
              self.assertRaisesRegex(ValueError, "invalid identity")):
            release._known_findings(REPO, [7], published_at=PUBLISHED)

        duplicate_json = (
            '{"schema":1,"schema":1,"candidate_id":"' + "a" * 64
            + '","findings":[]}')
        duplicate = comment(prefix + " " + duplicate_json + suffix)
        with (patch.object(release, "pages", return_value=[duplicate]),
              self.assertRaisesRegex(ValueError, "malformed")):
            release._known_findings(REPO, [7], published_at=PUBLISHED)

        valid = prefix + " " + json.dumps(payload, sort_keys=True) + suffix
        for body, message in (
                (prefix + " {truncated", "marker is malformed"),
                (valid + "\n" + prefix + " {truncated", "marker is malformed"),
                (valid + "\n" + valid, "marker is ambiguous")):
            with self.subTest(body=body), \
                    patch.object(release, "pages", return_value=[comment(body)]), \
                    self.assertRaisesRegex(ValueError, message):
                release._known_findings(REPO, [7], published_at=PUBLISHED)

    def test_known_findings_writer_roundtrips_nested_marker_text(self):
        finding = {
            "finding_id": "review:7:12",
            "body": 'Quoted <!-- fork-findings:v1 {"schema":1} --> and --> text.',
        }
        posted = []
        with (patch.object(release, "pages", return_value=[]),
              patch.object(release, "api", side_effect=lambda _path, **kwargs:
                             posted.append(kwargs["data"]["body"]))):
            release._store_findings(REPO, 7, "a" * 64, [finding])
        self.assertEqual(len(posted), 1)
        self.assertNotIn('<!-- fork-findings:v1 {"schema":1} -->', posted[0])
        self.assertIn("\\u003c!-- fork-findings:v1", posted[0])

        native_comment = {
            "id": 16, "created_at": "2026-10-19T10:00:00Z",
            "updated_at": "2026-10-19T10:00:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"}, "body": posted[0],
        }
        with patch.object(release, "pages", return_value=[native_comment]):
            self.assertEqual(release._known_findings(
                REPO, [7], published_at=PUBLISHED), [finding])

    def test_known_findings_reads_legacy_unescaped_nested_marker_text(self):
        finding = {
            "finding_id": "review:7:13",
            "body": 'Legacy quoted <!-- fork-findings:v1 {"schema":1} --> and --> text.',
        }
        payload = json.dumps({
            "schema": 1, "candidate_id": "a" * 64, "findings": [finding],
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        body = "Trusted lifecycle snapshot.\n\n<!-- fork-findings:v1 " + payload + " -->"
        native_comment = {
            "id": 17, "created_at": "2026-10-19T10:00:00Z",
            "updated_at": "2026-10-19T10:00:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"}, "body": body,
        }
        with patch.object(release, "pages", return_value=[native_comment]):
            self.assertEqual(release._known_findings(
                REPO, [7], published_at=PUBLISHED), [finding])

    def test_known_findings_skips_retired_history_but_rejects_post_cutoff_edits(self):
        retired = {
            "id": 17, "created_at": "2026-10-19T08:00:00Z",
            "updated_at": "2026-10-19T08:30:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"},
            "body": "Trusted lifecycle snapshot whose marker is no longer present.",
        }
        ordinary = {
            "id": 18, "created_at": "2026-10-19T10:00:00Z",
            "updated_at": "2026-10-19T10:00:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"},
            "body": "An unchanged ordinary workflow comment.",
        }
        with patch.object(release, "pages", return_value=[retired, ordinary]):
            self.assertEqual(release._known_findings(
                REPO, [7], published_at=PUBLISHED), [])

        edited_after_cutoff = {**retired, "updated_at": "2026-10-19T09:01:00Z"}
        with (patch.object(release, "pages", return_value=[edited_after_cutoff]),
              self.assertRaisesRegex(ValueError, "comment was edited")):
            release._known_findings(REPO, [7], published_at=PUBLISHED)

    def test_exact_dismissed_review_collects_its_native_event_timestamp(self):
        candidate = {"application_sha": "b" * 40, "configuration_sha": CONFIG}
        head_ref, base_ref = f"review/{HEAD}", f"review-base/{UPSTREAM}"
        pull = {"number": 7, "head": {"sha": HEAD, "ref": head_ref},
                "base": {"sha": UPSTREAM, "ref": base_ref}}
        event = {"id": 72, "event": "review_dismissed", "dismissed_review": {"review_id": 44},
                 "created_at": "2026-10-19T10:02:00Z",
                 "url": f"https://api.github.com/repos/{REPO}/issues/events/72"}
        for state in ("APPROVED", "DISMISSED"):
            with self.subTest(native_review_state=state):
                reviews = [{"id": 44, "state": state, "commit_id": HEAD,
                            "submitted_at": "2026-10-19T10:00:00Z"}]

                def native_pages(route):
                    if route == f"repos/{REPO}/pulls/7/reviews":
                        return reviews
                    if route in {f"repos/{REPO}/issues/7/comments", f"repos/{REPO}/pulls/7/comments"}:
                        return []
                    if state == "DISMISSED" and route == f"repos/{REPO}/issues/7/events":
                        return [event]
                    self.fail(f"Unexpected native event read: {route}")

                def native_api(route):
                    if route == f"repos/{REPO}/pulls/7":
                        return pull
                    if route.startswith(f"repos/{REPO}/git/commits/"):
                        return {"sha": route.rsplit("/", 1)[1], "tree": {"sha": "e" * 40}}
                    self.fail(f"Unexpected native source read: {route}")

                lifecycle = Mock()
                with (patch.object(release, "api", side_effect=native_api),
                      patch.object(release, "pages", side_effect=native_pages),
                      patch.object(release, "_native_review_request", return_value={"id": 71}),
                      patch.object(release, "_resolve_native_review_commits", return_value={})):
                    release.evaluate_shared_review(REPO, lifecycle, candidate, "full", 7,
                                                   HEAD, UPSTREAM, head_ref, base_ref)
                target = lifecycle.evaluate_review.call_args.args[0]
                self.assertEqual(target["review_dismissals"], [event] if state == "DISMISSED" else [])

    def test_native_history_fetches_complete_pr_records_and_calls_the_common_api(self):
        pull = {
            "number": 7, "state": "open", "updated_at": "2026-10-19T12:30:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"},
            "head": {"repo": {"full_name": REPO}, "ref": "review/example", "sha": HEAD},
            "base": {"repo": {"full_name": REPO}, "ref": "review-base/example", "sha": UPSTREAM},
        }
        comments = [{"id": 11, "body": "Reviewed commit: " + HEAD[:10]}]
        reviews = [{"id": 12, "body": "Reviewed commit: " + HEAD[:10]}]
        inline = [{"id": 13, "body": "Reviewed commit: " + HEAD[:10]}]
        normalized = {"findings": [], "dispositions": []}
        captured = []

        class Lifecycle:
            def review_history(self, candidate, records, published_at, *, read_native=None):
                captured.append((candidate, records, published_at, read_native))
                return normalized

        with (patch.object(release, "pages", side_effect=[comments, reviews, inline]) as fetch,
              patch.object(release, "_resolve_native_review_commits", return_value={"c" * 7: HEAD}) as resolve):
            result = release._native_shared_history(
                REPO, {"schema": 1}, Lifecycle(), "2026-10-19T12:00:00Z", pulls=[pull])

        self.assertIs(result, normalized)
        self.assertIs(captured[0][3], release.api)
        self.assertEqual(fetch.call_args_list[0].args[0], f"repos/{REPO}/issues/7/comments")
        self.assertEqual(fetch.call_args_list[1].args[0], f"repos/{REPO}/pulls/7/reviews")
        self.assertEqual(fetch.call_args_list[2].args[0], f"repos/{REPO}/pulls/7/comments")
        self.assertEqual(resolve.call_args.args[1], reviews + inline + comments)
        self.assertEqual(captured[0][1], [{
            "pull": pull, "comments": comments, "reviews": reviews, "inline": inline,
            "resolved_commits": {"c" * 7: HEAD},
        }])
        self.assertEqual(captured[0][2], "2026-10-19T12:00:00Z")

    def test_abbreviated_codex_sources_must_resolve_to_an_exact_native_commit(self):
        record = {"user": {"login": release.BOT, "type": "Bot"},
                  "body": "Reviewed commit: " + HEAD[:10]}
        with patch.object(release, "api", return_value={"sha": HEAD}) as native:
            self.assertEqual(release._resolve_native_review_commits(REPO, [record]), {HEAD[:10]: HEAD})
        native.assert_called_once_with(f"repos/{REPO}/commits/{HEAD[:10]}")
        with (patch.object(release, "api", side_effect=subprocess.CalledProcessError(1, "gh api")),
              self.assertRaises(subprocess.CalledProcessError)):
            release._resolve_native_review_commits(REPO, [record])

    def test_common_history_findings_join_persisted_markers_before_the_pair_gate(self):
        pull = {"number": 7}
        marker_finding = {"finding_id": "review:7:12", "candidate_id": "a" * 64,
                          "scope": "full", "source": "review", "source_sha": HEAD,
                          "native_id": 12, "body": "A carried native finding", "path": None,
                          "line": None, "severity": "unlabelled"}
        native_finding = {**marker_finding, "finding_id": "inline:6:13", "native_id": 13,
                          "source": "inline", "body": "A finding from an older native PR"}
        disposition = {"finding_id": "inline:6:13", "candidate_id": "b" * 64,
                       "source_sha": CONFIG, "status": "fixed", "evidence": "Current regression"}
        with (patch.object(release, "_shared_history_pull_inventory", return_value=[pull]),
              patch.object(release, "_known_findings", return_value=[marker_finding]),
              patch.object(release, "_native_shared_history", return_value={
                  "findings": [native_finding], "dispositions": [disposition]})):
            pulls, findings, dispositions = release._carried_shared_findings(
                REPO, {"schema": 1}, object(), "2026-10-19T12:00:00Z")
        self.assertEqual(pulls, [pull])
        self.assertEqual([item["finding_id"] for item in findings], ["inline:6:13", "review:7:12"])
        self.assertEqual(dispositions, [disposition])

    def test_native_history_enrichment_supersedes_a_legacy_copy_of_the_same_finding(self):
        pull = {"number": 7}
        snapshot = {"finding_id": "review:7:12", "candidate_id": "a" * 64,
                    "scope": "full", "source": "review", "source_sha": HEAD,
                    "native_id": 12, "body": "The original native finding", "path": None,
                    "line": None, "severity": "unlabelled"}
        native = {**snapshot, "source_tree_sha": "f" * 40}
        with (patch.object(release, "_shared_history_pull_inventory", return_value=[pull]),
              patch.object(release, "_known_findings", return_value=[snapshot]),
              patch.object(release, "_native_shared_history", return_value={
                  "findings": [native], "dispositions": []})):
            _, findings, _ = release._carried_shared_findings(
                REPO, {"schema": 1}, object(), "2026-10-19T12:00:00Z",
                additional=[snapshot])
        self.assertEqual(findings, [native])
        changed_copy = {**snapshot, "body": "An owner snapshot cannot replace native prose"}
        self.assertEqual(release._merge_findings(
            [changed_copy], native_findings=[native]), [native])
        with self.assertRaisesRegex(ValueError, "Conflicting native evidence"):
            release._merge_findings([], native_findings=[native, {**native, "body": "conflict"}])
        first = {"finding_id": native["finding_id"], "status": "fixed", "evidence": "first"}
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            release._merge_dispositions([first], [{**first, "evidence": "different"}])

    def test_workflow_source_proof_is_native_exact_and_reused_only_for_immutable_keys(self):
        head, base = "a" * 40, "b" * 40
        current = {"id": 90, "run_attempt": 1, "head_sha": head,
                   "node_id": "WFR_fixture",
                   "path": ".github/workflows/release.yml", "event": "pull_request_target",
                   "head_branch": "repair/example"}
        files = {sha: {"sha": "f" * 40, "source_fixture": sha} for sha in (head, base)}
        graph = {"data": {"node": {"id": current["node_id"], "databaseId": current["id"]}}}

        def read_native(route, **kwargs):
            if route == "graphql":
                self.assertEqual(kwargs["method"], "POST")
                self.assertEqual(kwargs["data"]["variables"], {"id": current["node_id"]})
                return graph
            return files[route.rsplit("=", 1)[1]]

        lifecycle, cache = Mock(), {}
        lifecycle.validate_workflow_source.return_value = True
        with (patch.object(release, "shared_lifecycle", return_value=lifecycle),
              patch.object(release, "api", side_effect=read_native) as native):
            proof = release._native_workflow_source(REPO, current, base, cache=cache)
            self.assertEqual(proof, {"run_file": files[head], "reserved_file": files[base],
                                     "workflow_run": graph})
            self.assertEqual(release._native_workflow_source(REPO, current, base, cache=cache), proof)
            self.assertEqual(native.call_count, 3)
            lifecycle.validate_workflow_source.assert_called_with(
                REPO, current, base, ".github/workflows/release.yml", proof)
            self.assertIsNone(release._native_workflow_source(REPO, current, head))
            self.assertEqual(native.call_count, 3)
            lifecycle.validate_workflow_source.side_effect = ValueError("workflow blobs differ")
            with self.assertRaisesRegex(ValueError, "workflow blobs differ"):
                release._native_workflow_source(REPO, current, base, cache=cache)
            lifecycle.validate_workflow_source.side_effect = None
            lifecycle.validate_workflow_source.return_value = False
            with self.assertRaisesRegex(ValueError, "did not verify"):
                release._native_workflow_source(REPO, current, base, cache=cache)

    def test_unproved_workflow_is_rejected_before_final_reservation_write(self):
        sha = "a" * 40
        current = {"id": 90, "run_attempt": 1, "head_sha": "b" * 40}
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1",
                                     "GITHUB_SHA": sha}, clear=True),
              patch.object(release, "api", return_value=current) as native,
              patch.object(release, "_native_workflow_source", side_effect=ValueError("unproved workflow")),
              self.assertRaisesRegex(ValueError, "unproved workflow")):
            release._reserve_final_attempt(REPO, {"candidate": {}, "candidate_id": "f" * 64}, {})
        native.assert_called_once_with(f"repos/{REPO}/actions/runs/90/attempts/1")

    def test_expired_run_reservations_retire_only_before_the_verified_publication(self):
        marker = {"schema": 1, "candidate_id": "f" * 64, "run_id": 7,
                  "run_attempt": 1, "workflow_sha": HEAD}
        body = "<!-- fork-final:v1 " + json.dumps(marker) + " -->"
        baseline = {"candidate": {}, "release_id": 8,
                    "published_at": "2026-10-19T12:00:00Z", "metadata_sha256": "e" * 64}
        for when, complete in (("2026-10-18T12:00:00Z", True),
                               ("2026-10-19T12:00:00Z", False),
                               ("2026-10-20T12:00:00Z", False)):
            with self.subTest(native_comment_time=when):
                comment = {"id": 9, "created_at": when, "updated_at": when,
                           "user": {"login": "github-actions[bot]", "type": "Bot"}, "body": body}
                with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1"}, clear=True),
                      patch.object(release, "_all_shared_review_pulls", return_value=[]),
                      patch.object(release, "pages", return_value=[comment]),
                      patch.object(release, "_workflow_run_records", return_value=([], True))):
                    history = release._final_history(REPO, {"baseline": baseline}, object())
                self.assertIs(history["complete"], complete)
                self.assertEqual(history["attempts"], [])

    def test_history_inventory_includes_repair_prs_but_excludes_unrelated_branches(self):
        def pull(number, user, head_ref, base_ref, *, head_repo=REPO):
            return {
                "number": number, "state": "closed", "updated_at": "2026-10-19T12:30:00Z",
                "user": user,
                "head": {"repo": {"full_name": head_repo}, "ref": head_ref, "sha": HEAD},
                "base": {"repo": {"full_name": REPO}, "ref": base_ref, "sha": UPSTREAM},
            }

        inventory = [
            pull(7, {"login": "github-actions[bot]", "type": "Bot"},
                 "review/example", "review-base/example"),
            pull(8, {"login": "warelik", "type": "User"}, "repair/example", "downstream"),
            pull(9, {"login": "warelik", "type": "User"}, "feature/example", "downstream"),
            pull(10, {"login": "contributor", "type": "User"},
                 "review/example", "review-base/example", head_repo="elsewhere/9router"),
        ]
        with patch.object(release, "api", return_value=inventory) as native:
            result = release._shared_history_pull_inventory(
                REPO, "2026-10-19T12:00:00Z")

        self.assertEqual([item["number"] for item in result], [7, 8])
        native.assert_called_once_with(
            f"repos/{REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1")

    def test_native_history_fails_if_the_paginated_inventory_changes_during_collection(self):
        original = {
            "number": 7, "state": "open", "updated_at": "2026-10-19T12:30:00Z",
            "user": {"login": "github-actions[bot]", "type": "Bot"},
            "head": {"repo": {"full_name": REPO}, "ref": "review/example", "sha": HEAD},
            "base": {"repo": {"full_name": REPO}, "ref": "review-base/example", "sha": UPSTREAM},
        }
        changed = {**original, "updated_at": "2026-10-19T12:31:00Z"}
        inventory_reads = 0

        def native(route):
            nonlocal inventory_reads
            if "pulls?state=all&sort=updated&direction=desc" in route:
                inventory_reads += 1
                return [original if inventory_reads == 1 else changed]
            if route == f"repos/{REPO}/pulls/7":
                return original
            raise AssertionError(f"Unexpected native route: {route}")

        class Lifecycle:
            def review_history(self, candidate, records, published_at, *, read_native=None):
                raise AssertionError("Unstable inventory must not reach the common evaluator")

        with (patch.object(release, "api", side_effect=native),
              patch.object(release, "pages", return_value=[]),
              self.assertRaisesRegex(ValueError, "inventory changed")):
            release._native_shared_history(
                REPO, {"schema": 1}, Lifecycle(), "2026-10-19T12:00:00Z")

    def test_only_machine_verified_code_and_regression_changes_create_owner_dispositions(self):
        current_id, old_id = "f" * 64, "e" * 64
        current_context_sha, old_context_sha = "a" * 40, "b" * 40
        current_app = {
            "sha": HEAD, "tree": {"sha": "1" * 40},
        }
        current_context = {
            "sha": current_context_sha,
            "message": f"fork-review-context:v1 {current_id}\n",
            "parents": [{"sha": HEAD}], "tree": {"sha": "1" * 40},
        }
        old_context = {
            "sha": old_context_sha,
            "message": f"fork-review-context:v1 {old_id}\n",
            "parents": [{"sha": UPSTREAM}], "tree": {"sha": "2" * 40},
        }
        finding = {
            "finding_id": "inline:6:13", "candidate_id": old_id, "scope": "full",
            "source": "inline", "source_sha": old_context_sha, "native_id": 13,
            "body": "A carried code finding", "path": "src/fix.js", "line": 4,
            "severity": "unlabelled",
        }
        current_candidate = {"_candidate_id": current_id, "application_sha": HEAD}
        evidence = {"target": {
            "review_commit": current_context, "application_commit": current_app,
            "review_sha": current_context_sha,
        }}
        old_blobs = {"src/fix.js": "3" * 40, "tests/unit/fix.test.js": "4" * 40}
        new_blobs = {"src/fix.js": "5" * 40, "tests/unit/fix.test.js": "6" * 40}

        with tempfile.TemporaryDirectory() as temporary:
            patch_path = Path(temporary) / "0001-fix.patch"
            patch_path.write_text(
                "--- a/src/fix.js\n+++ b/src/fix.js\n@@ -1 +1 @@\n"
                "--- a/tests/unit/fix.test.js\n+++ b/tests/unit/fix.test.js\n@@ -1 +1 @@\n",
                encoding="utf-8")
            with (patch.object(release, "_native_commit", return_value=old_context),
                  patch.object(release, "_native_tree_blobs",
                               side_effect=lambda repo, commit, cache:
                               old_blobs if commit["sha"] == old_context_sha else new_blobs),
                  patch.object(release, "patch_regressions",
                               return_value={"tests/unit/fix.test.js"})):
                result = release._verified_disposition_proposals(
                    REPO, current_candidate, evidence, [finding], set(), set(), temporary)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source_sha"], HEAD)
        self.assertIn("code path `src/fix.js`", result[0]["evidence"])
        self.assertIn("regression path `tests/unit/fix.test.js`", result[0]["evidence"])
        self.assertIn("ordered patch `0001-fix.patch`", result[0]["evidence"])

    def test_owner_disposition_is_immutable_read_back_with_owner_credentials(self):
        candidate = {"_candidate_id": "f" * 64, "application_sha": HEAD}
        disposition = {"finding_id": "inline:6:13", "candidate_id": "f" * 64,
                       "source_sha": HEAD, "status": "fixed", "evidence": "verified blobs"}
        marker = release._owner_disposition_marker(candidate, [disposition])
        created = {
            "id": 19, "body": "Machine-verified disposition of carried native findings.\n\n" + marker,
            "created_at": "2026-10-19T12:30:00Z", "updated_at": "2026-10-19T12:30:00Z",
            "user": {"login": "warelik", "type": "User"},
        }
        with (patch.object(release, "owner_token", return_value="owner-token"),
              patch.object(release, "pages", side_effect=[[], [created]]),
              patch.object(release, "api", return_value=created) as native):
            release._post_owner_dispositions(REPO, 7, candidate, [disposition])

        native.assert_called_once()
        self.assertEqual(native.call_args.kwargs["token"], "owner-token")
        self.assertEqual(native.call_args.args[0], f"repos/{REPO}/issues/7/comments")

    def test_owner_disposition_requires_both_complete_native_scopes(self):
        with self.assertRaisesRegex(ValueError, "both complete exact-candidate reviews"):
            release._authorize_shared_dispositions(
                REPO, {}, object(), "2026-10-19T12:00:00Z",
                {"result": {"complete": False}}, {"result": {"complete": True}},
                [], set(), [], Path("/unused"))

    def test_codex_prompt_does_not_authorize_disposition_markers(self):
        body = release.shared_review_text(
            {"upstream_sha": UPSTREAM, "application_sha": HEAD, "configuration_sha": CONFIG,
             "patchset_sha256": "a" * 64, "recipe_sha256": "b" * 64, "platform": "linux/amd64"},
            "full", HEAD, UPSTREAM, "c" * 64, known_findings=())
        self.assertNotIn("<!-- fork-review-disposition:", body)
        self.assertIn("trusted controller", body)
        self.assertIn("Do not emit fork-review-disposition markers", body)

    def test_history_is_consumed_at_prepare_recheck_and_published_recovery(self):
        module = ast.parse(Path(release.__file__).read_text(encoding="utf-8"))
        functions = {node.name: node for node in module.body if isinstance(node, ast.FunctionDef)}
        for name in ("prepare_shared", "_recheck_shared_reviews", "_published_release_recovery"):
            calls = [node for node in ast.walk(functions[name]) if isinstance(node, ast.Call)]
            self.assertTrue(any(isinstance(call.func, ast.Name)
                                and call.func.id == "_carried_shared_findings" for call in calls),
                            f"{name} must pass complete native history into the shared pair gate")


class NativeAttemptEvidenceTests(unittest.TestCase):
    def test_step_bearing_unreserved_heavy_job_without_start_time_fails_closed(self):
        job = {"name": "Build And Smoke Test One Container", "steps": [
            {"name": "Build From The Immutable Remote Git Context", "status": "completed"},
        ]}
        with self.assertRaisesRegex(ValueError, "steps have no start timestamp"):
            release._has_started_heavy_job_after_baseline(
                [job], [job["name"]], "2026-10-19T12:00:00Z")

    def test_empty_skipped_heavy_placeholder_remains_unspent(self):
        job = {"name": "Build And Smoke Test One Container", "steps": [],
               "started_at": "2026-10-19T13:00:00Z", "conclusion": "skipped"}
        self.assertFalse(release._has_started_heavy_job_after_baseline(
            [job], [job["name"]], "2026-10-19T12:00:00Z"))

    def test_empty_completed_non_skipped_heavy_job_without_start_time_fails_closed(self):
        job = {"name": "Build And Smoke Test One Container", "steps": [],
               "status": "completed", "conclusion": "success"}
        with self.assertRaisesRegex(ValueError, "Completed native heavy job has no start timestamp"):
            release._has_started_heavy_job_after_baseline(
                [job], [job["name"]], "2026-10-19T12:00:00Z")

    def test_empty_skipped_heavy_placeholder_without_start_time_is_unspent(self):
        job = {"name": "Build And Smoke Test One Container", "steps": [],
               "status": "completed", "conclusion": "skipped"}
        self.assertFalse(release._has_started_heavy_job_after_baseline(
            [job], [job["name"]], "2026-10-19T12:00:00Z"))


class RecipeIdentityTests(unittest.TestCase):
    def test_buildx_action_and_effective_configuration_are_in_recipe_identity(self):
        class Lifecycle:
            @staticmethod
            def patch_digest(files):
                digest = hashlib.sha256()
                for name, content in sorted(files):
                    digest.update(name.encode() + b"\0" + content + b"\0")
                return digest.hexdigest()

        prepare_pin = "a" * 40
        build_pin = "b" * 40
        push_pin = "c" * 40
        workflow = (
            "jobs:\n"
            "  prepare:\n"
            "    steps:\n"
            f"      - uses: docker/setup-buildx-action@{prepare_pin}\n"
            "  build:\n"
            "    steps:\n"
            f"      - uses: docker/setup-buildx-action@{build_pin}\n"
            "      - name: Build\n"
            f"        uses: docker/build-push-action@{push_pin}\n"
            "        with:\n"
            "          platforms: linux/amd64\n"
            "          build-args: APP_VERSION=${{ env.APP_VERSION }}\n"
            "          outputs: type=docker,dest=/tmp/image.tar\n"
        )
        original = release._recipe_sha256(b"FROM node", workflow, Lifecycle)
        prepare_change = workflow.replace(prepare_pin, "d" * 40)
        self.assertEqual(release._recipe_sha256(b"FROM node", prepare_change, Lifecycle), original)
        action_change = workflow.replace(build_pin, "e" * 40)
        self.assertNotEqual(release._recipe_sha256(b"FROM node", action_change, Lifecycle), original)
        config_change = workflow.replace("docker/setup-buildx-action@" + build_pin,
                                         "docker/setup-buildx-action@" + build_pin + "\n        with:\n          driver: docker")
        self.assertNotEqual(release._recipe_sha256(b"FROM node", config_change, Lifecycle), original)

    def test_legacy_recipe_is_accepted_only_when_derived_from_exact_published_source(self):
        class Lifecycle:
            @staticmethod
            def patch_digest(files):
                digest = hashlib.sha256()
                for name, content in sorted(files):
                    digest.update(name.encode() + b"\0" + content + b"\0")
                return digest.hexdigest()

        workflow = (
            "jobs:\n  build:\n    steps:\n"
            f"      - uses: docker/setup-buildx-action@{'a' * 40}\n"
            "      - name: Build\n"
            f"        uses: docker/build-push-action@{'b' * 40}\n"
            "        with:\n          platforms: linux/amd64\n"
            "          build-args: APP_VERSION=${{ env.APP_VERSION }}\n"
            "          outputs: type=docker,dest=/tmp/image.tar\n"
        )
        modern = release._recipe_sha256(b"FROM node", workflow, Lifecycle)
        legacy = release._legacy_recipe_sha256(b"FROM node", workflow, Lifecycle)
        metadata = {"candidate_sha": HEAD, "config_sha": CONFIG, "recipe_sha256": legacy}
        with patch.object(release, "_shared_file", side_effect=[b"FROM node", workflow.encode()]):
            self.assertTrue(release._published_recipe_matches(REPO, metadata, modern, Lifecycle))
        with patch.object(release, "_shared_file", side_effect=[b"FROM node", workflow.encode()]):
            self.assertFalse(release._published_recipe_matches(REPO, metadata, "f" * 64, Lifecycle))


class AdoptionTests(unittest.TestCase):
    def test_recovery_accepts_only_the_exact_transitioned_candidate_configuration(self):
        previous = {
            "schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
            "application_sha": HEAD, "configuration_sha": CONFIG,
            "patchset_sha256": "e" * 64, "recipe_sha256": "f" * 64,
            "platform": "linux/amd64",
        }
        candidate = {**previous, "configuration_sha": SEED}
        release_record = {"id": 8, "published_at": "2026-10-19T12:00:00Z"}
        publication = {"kind": "github-release", **release_record, "metadata_sha256": "1" * 64}
        variable = {
            "name": "FORK_ACCEPTED_BASELINE",
            "value": json.dumps({"schema": 1, "repository": REPO,
                                 "candidate": previous, "publication": publication}),
            "created_at": "2026-10-19T12:00:01Z",
            "updated_at": "2026-10-19T12:00:01Z",
        }

        def native(route, **_kwargs):
            if route.endswith("/variables/FORK_ACCEPTED_BASELINE"):
                return variable
            if route.endswith("/commits/downstream"):
                return {"sha": SEED}
            self.fail(f"Unexpected native read: {route}")

        with (patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native)):
            with self.assertRaisesRegex(ValueError, "does not match"):
                release._accepted_baseline(REPO, release_record, "1" * 64, candidate)
            proof = release._accepted_baseline(
                REPO, release_record, "1" * 64, candidate,
                allow_default_configurations={SEED})
        self.assertEqual(proof["variable"], variable)

    def test_selective_adoption_checks_the_exact_candidate_configuration(self):
        product = {"mode": "100644", "blob_sha": HEAD}
        regression = {"mode": "100644", "blob_sha": UPSTREAM}
        tree = {"Dockerfile": product, "patches/0001-fix.patch": product,
                "patches/source.json": regression}
        policy_id = "f" * 64
        trusted_pin = "9" * 40
        pin = {"name": "ZED_TRUSTED_POLICY", "value": trusted_pin}
        calls = []
        events = []

        def native(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG if method == "GET" and calls.count(
                    (path, method, data, token)) == 1 else HEAD}
            if path == f"repos/{REPO}/git/commits/{HEAD}":
                return {"sha": HEAD, "parents": [{"sha": CONFIG}],
                        "message": "Review sanitized 9router repair #2"}
            if path == f"repos/{REPO}/git/refs/heads/downstream":
                if method == "PATCH":
                    events.append("adopt")
                    return {"ref": "refs/heads/downstream", "object": {"type": "commit", "sha": HEAD}}
                return {"ref": "refs/heads/downstream", "object": {"type": "commit", "sha": HEAD}}
            if path == f"repos/{REPO}/actions/variables/ZED_TRUSTED_POLICY":
                if method == "PATCH":
                    events.append("pin")
                    pin["value"] = data["value"]
                    return {}
                return dict(pin)
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            self.fail(f"Unexpected native API request: {method} {path}")

        class Lifecycle:
            def validate_adoption(self, reviewed, adopted, product_paths, regression_paths):
                events.append("validate")
                self.args = (reviewed, adopted, product_paths, regression_paths)

        lifecycle = Lifecycle()
        context = {"candidate": {"configuration_sha": HEAD}, "base_config_sha": CONFIG,
                   "candidate_id": policy_id,
                   "policy_validation": {"candidate_id": policy_id, "source": "native-run",
                                         "verified": True}}
        with (patch.dict(os.environ, {"TRUSTED_POLICY": trusted_pin}),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "_native_full_tree", return_value=tree)):
            self.assertEqual(release._validate_and_adopt_config(REPO, context, lifecycle), HEAD)
        self.assertEqual(lifecycle.args, (
            tree, tree, ["Dockerfile", "patches/0001-fix.patch"], ["patches/source.json"]))
        self.assertEqual(events, ["adopt", "validate", "pin"])
        pin_patch = next(call for call in calls
                         if call[0].endswith("/actions/variables/ZED_TRUSTED_POLICY")
                         and call[1] == "PATCH")
        self.assertEqual(pin_patch[2], {"name": "ZED_TRUSTED_POLICY", "value": HEAD})
        self.assertEqual(pin_patch[3], "fixture-owner")

    def test_trusted_policy_pin_is_not_advanced_before_adoption_validation(self):
        product = {"mode": "100644", "blob_sha": HEAD}
        tree = {"Dockerfile": product, "patches/0001-fix.patch": product,
                "patches/source.json": {"mode": "100644", "blob_sha": UPSTREAM}}
        policy_id, trusted_pin = "f" * 64, "9" * 40
        calls = []

        def native(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data))
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG}
            if path == f"repos/{REPO}/git/commits/{HEAD}":
                return {"sha": HEAD, "parents": [{"sha": CONFIG}],
                        "message": "Review sanitized 9router repair #2"}
            if path == f"repos/{REPO}/git/refs/heads/downstream" and method == "PATCH":
                return {"ref": "refs/heads/downstream", "object": {"type": "commit", "sha": HEAD}}
            self.fail(f"Unexpected native API request: {method} {path}")

        class Lifecycle:
            def validate_adoption(self, *_args):
                raise ValueError("adoption validation failed")

        context = {"candidate": {"configuration_sha": HEAD}, "base_config_sha": CONFIG,
                   "candidate_id": policy_id,
                   "policy_validation": {"candidate_id": policy_id, "source": "native-run",
                                         "verified": True}}
        with (patch.dict(os.environ, {"TRUSTED_POLICY": trusted_pin}),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "_native_full_tree", return_value=tree),
              self.assertRaisesRegex(ValueError, "adoption validation failed")):
            release._validate_and_adopt_config(REPO, context, Lifecycle())
        self.assertFalse(any("ZED_TRUSTED_POLICY" in path and method == "PATCH"
                             for path, method, _data in calls))

    def test_unverified_policy_proof_cannot_reach_config_adoption_or_pin_update(self):
        context = {"candidate": {"configuration_sha": HEAD}, "base_config_sha": CONFIG,
                   "candidate_id": "f" * 64,
                   "policy_validation": {"candidate_id": "f" * 64, "source": "reservation",
                                         "verified": False}}

        def forbidden(*_args, **_kwargs):
            self.fail("unverified policy must stop before any native mutation or read")

        with (patch.dict(os.environ, {"TRUSTED_POLICY": "9" * 40}),
              patch.object(release, "owner_token", side_effect=forbidden),
              patch.object(release, "api", side_effect=forbidden),
              self.assertRaisesRegex(ValueError, "verified policy proof")):
            release._validate_and_adopt_config(REPO, context, Mock())

    def test_trusted_policy_pin_failed_readback_blocks_completion(self):
        trusted_pin, reviewed = "9" * 40, HEAD
        calls = []

        def native(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            if path == f"repos/{REPO}/git/refs/heads/downstream":
                return {"ref": "refs/heads/downstream", "object": {"type": "commit", "sha": reviewed}}
            if path == f"repos/{REPO}/actions/variables/ZED_TRUSTED_POLICY":
                if method == "PATCH":
                    return {}
                return {"name": "ZED_TRUSTED_POLICY", "value": trusted_pin}
            self.fail(f"Unexpected native API request: {method} {path}")

        with (patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native),
              self.assertRaisesRegex(ValueError, "did not retain")):
            release._advance_trusted_policy_pin(REPO, reviewed, trusted_pin)
        self.assertTrue(any(path.endswith("/actions/variables/ZED_TRUSTED_POLICY")
                            and method == "PATCH" and token == "fixture-owner"
                            for path, method, _data, token in calls))

    def test_trusted_policy_pin_rejects_a_concurrent_pin_or_default_move(self):
        expected_pin, reviewed = "9" * 40, HEAD
        for conflict in ("pin", "downstream"):
            with self.subTest(conflict=conflict):
                calls = []

                def native(path, *, method="GET", data=None, token=None):
                    calls.append((path, method, data, token))
                    if path == f"repos/{REPO}":
                        return {"default_branch": "downstream"}
                    if path == f"repos/{REPO}/git/refs/heads/downstream":
                        sha = SEED if conflict == "downstream" else reviewed
                        return {"ref": "refs/heads/downstream",
                                "object": {"type": "commit", "sha": sha}}
                    if path == f"repos/{REPO}/actions/variables/ZED_TRUSTED_POLICY":
                        value = SEED if conflict == "pin" else expected_pin
                        return {"name": "ZED_TRUSTED_POLICY", "value": value}
                    self.fail(f"Unexpected native API request: {method} {path}")

                with (patch.object(release, "owner_token", return_value="fixture-owner"),
                      patch.object(release, "api", side_effect=native),
                      self.assertRaisesRegex(ValueError, "changed during|moved away")):
                    release._advance_trusted_policy_pin(REPO, reviewed, expected_pin)
                self.assertFalse(any(path.endswith("/actions/variables/ZED_TRUSTED_POLICY")
                                     and method == "PATCH" for path, method, _data, _token in calls))

    def test_published_recovery_reads_accepted_baseline_as_owner(self):
        releases = [
            {"id": 7, "published_at": "2026-10-18T12:00:00Z", "draft": False,
             "prerelease": False},
            {"id": 8, "published_at": "2026-10-19T12:00:00Z", "draft": False,
             "prerelease": False},
        ]
        endpoint = f"repos/{REPO}/actions/variables/FORK_ACCEPTED_BASELINE"
        variable = {"name": "FORK_ACCEPTED_BASELINE", "value": json.dumps({
            "publication": {"id": 8, "published_at": "2026-10-19T12:00:00Z"}})}
        with (patch.object(release, "pages", return_value=releases),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", return_value=variable) as native):
            self.assertIsNone(release._published_release_recovery(REPO, CONFIG, Mock()))
        native.assert_called_once_with(endpoint, token="fixture-owner")

    def test_accepted_baseline_write_and_readback_use_the_verified_owner_token(self):
        candidate = {"schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
                     "application_sha": HEAD, "configuration_sha": CONFIG,
                     "patchset_sha256": "e" * 64, "recipe_sha256": "f" * 64,
                     "platform": "linux/amd64"}
        publication = {"kind": "github-release", "id": 77,
                       "published_at": "2026-10-19T12:00:00Z",
                       "metadata_sha256": "d" * 64}
        endpoint = f"repos/{REPO}/actions/variables/FORK_ACCEPTED_BASELINE"
        context = {"candidate": candidate,
                   "baseline": {"accepted_baseline": {"endpoint": endpoint}}}
        current = {}
        calls = []

        def native(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            if path == endpoint and method == "PATCH":
                current.update({"name": data["name"], "value": data["value"],
                                "updated_at": "2026-10-19T12:00:01Z"})
                return {}
            if path == endpoint and method == "GET":
                return dict(current)
            self.fail(f"Unexpected native API request: {method} {path}")

        with (patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native)):
            readback = release._update_accepted_baseline(REPO, context, publication)
        self.assertEqual(readback["value"], release._accepted_baseline_value(REPO, candidate, publication))
        self.assertEqual([call[1] for call in calls], ["PATCH", "GET"])
        self.assertTrue(all(call[3] == "fixture-owner" for call in calls))

    def test_cleanup_rechecks_open_refs_without_corrupting_the_ref_set(self):
        base_ref = f"review-base/{UPSTREAM}"
        closed = {
            "number": 2, "state": "closed",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "review/full", "sha": HEAD, "repo": {"full_name": REPO}},
            "base": {"ref": base_ref, "sha": UPSTREAM, "repo": {"full_name": REPO}},
        }
        opened = {
            "number": 3, "state": "open",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "unrelated", "sha": SEED, "repo": {"full_name": REPO}},
            "base": {"ref": "downstream", "sha": CONFIG, "repo": {"full_name": REPO}},
        }
        ref = {"ref": f"refs/heads/{base_ref}", "object": {"type": "commit", "sha": UPSTREAM}}

        def native(path, *, method="GET", data=None, token=None):
            if path.endswith("/git/matching-refs/heads/review"):
                return [ref]
            if path.endswith("/git/matching-refs/heads/repair"):
                return []
            if path == f"repos/{REPO}/pulls/2":
                return closed
            if path == f"repos/{REPO}/pulls/3":
                return opened
            if path == f"repos/{REPO}/git/ref/pull/2/head":
                return {"ref": "refs/pull/2/head", "object": {"sha": HEAD}}
            if path == f"repos/{REPO}/compare/{UPSTREAM}...{HEAD}":
                return {"status": "ahead"}
            if path == f"repos/{REPO}/git/ref/heads/{base_ref}":
                return ref
            self.fail(f"Unexpected native API request: {method} {path}")

        cleanup_item = {"name": base_ref, "expected_oid": UPSTREAM}

        class Lifecycle:
            def __init__(self):
                self.plans = 0

            def cleanup_plan(self, records, *, active_refs, protected_refs):
                self.plans += 1
                if self.plans == 1:
                    return [cleanup_item]
                self.asserted_active_refs = active_refs
                return []

        lifecycle = Lifecycle()

        def command(*args, **kwargs):
            if args == ("gh", "auth", "setup-git"):
                return ""
            self.fail(f"Unexpected ref mutation: {args}")

        with (patch.object(release, "pages", side_effect=[[closed, opened], [closed, opened]]),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "run", side_effect=command)):
            self.assertEqual(release._cleanup_shared_refs(REPO, lifecycle), [])
        self.assertEqual(lifecycle.plans, 2)
        self.assertEqual(lifecycle.asserted_active_refs, {"unrelated", "downstream"})

    def test_readme_is_the_only_documentation_path_in_a_policy_repair(self):
        with patch.object(release, "run", side_effect=["", "", "", CONFIG, "README.md",
                              "100644 blob " + HEAD + "\tREADME.md"]):
            self.assertEqual(release.repair_changes(STATE), (["README.md"], True))
        for changed in ("CONTRIBUTING.md", "docs/release.md",
                        "README.md\npatches/0009-fix.patch"):
            with (self.subTest(changed=changed),
                  patch.object(release, "run", side_effect=["", "", "", CONFIG, changed]),
                  self.assertRaises(ValueError)):
                release.repair_changes(STATE)

    def test_changed_proposal_head_cannot_land(self):
        with (patch.dict(os.environ, ENV),
              patch.object(release, "repair_pull", return_value={**STATE, "head": SEED}),
              patch.object(release, "run", side_effect=AssertionError("No Git writes")),
              self.assertRaisesRegex(ValueError, "changed after verification")):
            release.land_repair(Path("/unused"))

    def test_new_default_configuration_cannot_be_overwritten(self):
        with (patch.dict(os.environ, ENV),
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_changes", return_value=(["patches/0009-fix.patch"], False)),
              patch.object(release, "check_review", return_value=(True, "reviewed")),
              patch.object(release, "api", return_value={"sha": HEAD}),
              patch.object(release, "run", side_effect=AssertionError("No Git writes")),
              self.assertRaisesRegex(ValueError, "stale repairs")):
            release.land_repair(Path("/unused"))

    def test_unreviewed_repair_cannot_land_even_if_tests_succeeded(self):
        with (patch.dict(os.environ, ENV),
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_changes", return_value=(["patches/0009-fix.patch"], False)),
              patch.object(release, "check_review", return_value=(False, "Review head changed")),
              patch.object(release, "api", side_effect=AssertionError("No API writes")),
              self.assertRaisesRegex(ValueError, "Review head changed")):
            release.land_repair(Path("/unused"))

    def test_ignored_repair_paths_cannot_be_added_through_git_apply(self):
        commands = []

        def execute(args, **kwargs):
            commands.append(args)
            if args[:2] == ["git", "apply"]:
                self.fail("Ignored source must not reach the index")
            return SimpleNamespace(stdout="ignored by fixture\n", returncode=0)

        with (tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ENV),
              patch.object(release, "repair_pull", return_value=STATE),
              patch.object(release, "repair_changes", return_value=(["patches/0009-fix.patch"], False)),
              patch.object(release, "check_review", return_value=(True, "reviewed")),
              patch.object(release, "api", return_value={"sha": CONFIG}),
              patch.object(release, "run", return_value=""),
              patch.object(release.subprocess, "check_output", return_value=b"delta"),
              patch.object(release.subprocess, "run", side_effect=execute),
              self.assertRaisesRegex(ValueError, "ignored path")):
            release.land_repair(Path(directory))
        self.assertTrue(commands)

    def test_policy_checks_use_only_disposable_paths_and_no_inherited_credentials(self):
        paths = []
        suites = []
        candidate_copies = []
        trusted_test_files = []

        def execute(args, **kwargs):
            env = kwargs["env"]
            self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "CODEX_REQUEST_TOKEN",
                              "NINEROUTER_KEY", "GITHUB_ENV", "GITHUB_PATH"} & env.keys())
            self.assertEqual(env["CI"], "true")
            self.assertEqual(args[:4], ["docker", "run", "--rm", "--read-only"])
            self.assertIn("--network=none", args)
            self.assertIn("--cap-drop=ALL", args)
            self.assertIn("--security-opt=no-new-privileges", args)
            self.assertEqual(args[args.index(release.POLICY_IMAGE) + 1:
                                  args.index(release.POLICY_IMAGE) + 4],
                             ["python3", "-I", "-B"])
            launcher = args[-4]
            self.assertLess(launcher.index("import yaml"), launcher.index("import release"))
            self.assertIn("NINEROUTER_POLICY_PARSER", env)
            self.assertEqual(Path(env["NINEROUTER_POLICY_PARSER"]), Path(args[-1]))
            mounts = [args[i + 1] for i, value in enumerate(args) if value == "--mount"]
            self.assertEqual(sum(m.endswith(",readonly") for m in mounts), 1)
            self.assertTrue(any(str(Path(args[-1]).parents[1]) in mount and mount.endswith(",readonly")
                                for mount in mounts))
            self.assertNotIn(str(candidate_root), " ".join(args))
            proposed = Path(env["NINEROUTER_POLICY_CANDIDATE_RELEASE"])
            self.assertTrue(proposed.is_file())
            self.assertEqual(proposed.read_text(), candidate_release.read_text())
            self.assertEqual(proposed.stat().st_mode & 0o777, 0o444)
            self.assertTrue(any(str(proposed.parents[2]) in mount for mount in mounts))
            candidate_copies.append(proposed)
            suite = Path(args[-2])
            trusted_test_files.append(sorted(path.name for path in suite.glob("test_*.py")))
            self.assertIn("test_policy_cli.py", trusted_test_files[-1])
            self.assertNotIn("test_candidate.py", trusted_test_files[-1])
            self.assertTrue((suite.parent / ".github/workflows/release.yml").is_file())
            for name in ("HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                         "XDG_STATE_HOME", "XDG_CACHE_HOME", "DATA_DIR"):
                path = Path(env[name])
                self.assertTrue(path.is_dir())
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                paths.append(path)
            suites.append(args[-2])
            return SimpleNamespace(returncode=0)

        with (tempfile.TemporaryDirectory() as directory,
              patch.dict(os.environ, {"GH_TOKEN": "fake", "GITHUB_TOKEN": "fake",
                  "CODEX_REQUEST_TOKEN": "fake", "NINEROUTER_KEY": "fake", "GITHUB_ENV": "/not-allowed"}),
              patch.object(release.subprocess, "run", side_effect=execute),
              patch.object(release, "urlopen") as fetch,
              self.assertRaisesRegex(ValueError, "actionlint archive integrity")):
            candidate_root = Path(directory).resolve()
            candidate_scripts = candidate_root / "scripts"
            candidate_scripts.mkdir()
            candidate_release = candidate_scripts / "release.py"
            marker = candidate_root / "candidate-python-executed"
            candidate_release.write_text(
                "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('executed')\n")
            (candidate_scripts / "test_candidate.py").write_text("assert True\n")
            workflow = candidate_root / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                "name: policy fixture\non: workflow_dispatch\njobs:\n"
                "  check:\n    runs-on: ubuntu-latest\n    steps:\n"
                "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n")
            fetch.return_value.read.return_value = b"not an authenticated release"
            with patch.object(release, "policy_container_engine", return_value=(["docker"], "docker")):
                release.check_policy(candidate_root)
        trusted_suite = Path(suites[0])
        self.assertEqual(trusted_suite.name, "scripts")
        self.assertEqual(trusted_suite.parent.name, "trusted")
        self.assertIn("test_policy_cli.py", trusted_test_files[0])
        self.assertNotEqual(trusted_suite, release.ROOT / "scripts")
        self.assertEqual(len(suites), 1)
        self.assertFalse(marker.exists(), "candidate Python must not execute before trusted adoption")
        self.assertEqual(len(candidate_copies), 1)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_invalid_candidate_python_is_rejected_before_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate_scripts = Path(directory) / "scripts"
            candidate_scripts.mkdir()
            (candidate_scripts / "release.py").write_text("def invalid(:\n")
            workflow = Path(directory) / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                "name: policy fixture\non: workflow_dispatch\njobs:\n"
                "  check:\n    runs-on: ubuntu-latest\n    steps:\n"
                "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n")
            with (patch.object(release.subprocess, "run") as run,
                  self.assertRaisesRegex(ValueError, "invalid syntax in release.py")):
                release.check_policy(Path(directory))
            run.assert_not_called()

    def test_failed_policy_tests_cannot_reach_linting_or_write_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate_scripts = Path(directory) / "scripts"
            candidate_scripts.mkdir()
            (candidate_scripts / "release.py").write_text("pass\n")
            workflow = Path(directory) / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                "name: policy fixture\non: workflow_dispatch\njobs:\n"
                "  check:\n    runs-on: ubuntu-latest\n    steps:\n"
                "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n")
            with (patch.object(release, "policy_container_engine", return_value=(["docker"], "docker")),
                  patch.object(release.subprocess, "run",
                              side_effect=subprocess.CalledProcessError(1, "trusted policy tests")),
                  patch.object(release, "urlopen", side_effect=AssertionError("Stop at failed tests")),
                  self.assertRaises(subprocess.CalledProcessError)):
                release.check_policy(Path(directory))

    def test_action_workflows_require_officially_pinned_commit_refs(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = Path(directory) / "release.yml"
            workflow.write_text("jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n")
            with self.assertRaisesRegex(ValueError, "exact commit SHA"):
                release.validate_action_pins(workflow)
            workflow.write_text(
                "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n")
            release.validate_action_pins(workflow)
            workflow.write_text("jobs:\n  test:\n    steps:\n      - uses: actions/checkout@main\n")
            with self.assertRaisesRegex(ValueError, "exact commit SHA"):
                release.validate_action_pins(workflow)
            workflow.write_text(
                'jobs:\n  test:\n    steps:\n      - "uses": "actions/checkout@main"\n')
            with self.assertRaisesRegex(ValueError, "exact commit SHA"):
                release.validate_action_pins(workflow)
            workflow.write_text(
                'jobs:\n  test:\n    steps:\n      - {uses: "actions/checkout@main"}\n')
            with self.assertRaisesRegex(ValueError, "exact commit SHA"):
                release.validate_action_pins(workflow)
            workflow.write_text(
                "jobs:\n  test:\n    steps:\n      - uses: >-\n          actions/checkout@main\n")
            with self.assertRaisesRegex(ValueError, "exact commit SHA"):
                release.validate_action_pins(workflow)

    def test_action_workflows_keep_reusable_and_subdirectory_commit_refs(self):
        commit = "c" * 40
        with tempfile.TemporaryDirectory() as directory:
            workflow = Path(directory) / "release.yml"
            workflow.write_text(
                "jobs:\n"
                "  reusable:\n"
                f"    uses: owner/repository/.github/workflows/child.yml@{commit}\n"
                "  steps:\n"
                "    steps:\n"
                f"      - uses: owner/repository/actions/check/action.yml@{commit}\n"
                f"      - &pinned {{uses: owner/repository/shared@{commit}}}\n"
                "      - *pinned\n"
                "      - uses: ./local-action\n"
                "      - run: |\n"
                "          echo 'uses: actions/checkout@main'\n")
            release.validate_action_pins(workflow)

    def test_policy_workflow_keeps_review_and_final_validation_gates(self):
        workflow = Path(os.environ.get("NINEROUTER_POLICY_CANDIDATE_WORKFLOW") or
                        release.ROOT / ".github/workflows/release.yml")
        document = release.yaml_module().safe_load(workflow.read_text(encoding="utf-8"))
        baseline_workflow = Path(os.environ.get("NINEROUTER_POLICY_BASELINE_WORKFLOW") or
                                 release.ROOT / ".github/workflows/release.yml")
        trusted = release.yaml_module().safe_load(
            baseline_workflow.read_text(encoding="utf-8"))
        jobs = document["jobs"]
        required_jobs = {"prepare", "policy-check", "finalize", "policy-only", "test", "build", "publish", "repair"}
        self.assertEqual(set(jobs), required_jobs, "Policy workflow must retain the complete lifecycle job graph")
        expected_permissions = {
            "prepare": {"contents": "write", "pull-requests": "write", "issues": "write", "actions": "read"},
            "policy-check": {"contents": "read"},
            "finalize": {"contents": "read", "issues": "write", "pull-requests": "read", "actions": "read"},
            "policy-only": {"contents": "write", "pull-requests": "write", "actions": "write"},
            "test": {"contents": "read"},
            "build": {"contents": "read"},
            "publish": {"contents": "write", "pull-requests": "write", "actions": "write"},
            "repair": {"contents": "write", "pull-requests": "write", "issues": "write", "actions": "read"},
        }
        self.assertEqual({name: job.get("permissions") for name, job in jobs.items()}, expected_permissions,
                         "Every job must retain its exact native permission values")
        expected_job_fields = {
            "prepare": {"name", "if", "runs-on", "timeout-minutes", "permissions", "outputs", "steps"},
            "policy-check": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "steps"},
            "finalize": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "outputs", "steps"},
            "policy-only": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "steps"},
            "test": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "env", "steps"},
            "build": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "env", "steps"},
            "publish": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "steps"},
            "repair": {"name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "steps"},
        }
        for job_name, job in jobs.items():
            self.assertEqual(set(job), expected_job_fields[job_name],
                             f"{job_name} must not introduce unreviewed job controls")
            self.assertEqual(job.get("runs-on"), "ubuntu-24.04")
        self.assertEqual({name: job.get("timeout-minutes") for name, job in jobs.items()}, {
            "prepare": 15, "policy-check": 15, "finalize": 15, "policy-only": 15,
            "test": 30, "build": 45, "publish": 20, "repair": 10,
        })
        expected_job_conditions = {
            "prepare": """(github.event_name != 'issue_comment' &&
                github.event_name != 'pull_request_target') ||
                (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
                ((github.event.comment.user.login == 'chatgpt-codex-connector[bot]' &&
                github.event.comment.user.type == 'Bot') ||
                (github.event.comment.user.login == github.repository_owner &&
                github.event.comment.user.type == 'User' &&
                contains(github.event.comment.body, 'fork-final-retry:v1')))) ||
                (github.event_name == 'pull_request_target' &&
                github.event.pull_request.base.ref == 'downstream' &&
                github.event.pull_request.head.repo.full_name == github.repository &&
                startsWith(github.event.pull_request.head.ref, 'repair/'))""",
            "policy-check": """needs.prepare.outputs.review_ready == 'true' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.prepare.outputs.policy_verified != 'true'""",
            "finalize": """always() && needs.prepare.result == 'success' &&
                needs.prepare.outputs.review_ready == 'true' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                (needs.prepare.outputs.policy_verified == 'true' || needs.policy-check.result == 'success')""",
            "policy-only": """always() && needs.prepare.result == 'success' &&
                (needs.policy-check.result == 'success' ||
                (needs.prepare.outputs.mode == 'policy-current' && needs.prepare.outputs.policy_verified == 'true')) &&
                needs.finalize.result == 'success' && needs.finalize.outputs.ready == 'true' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.finalize.outputs.mode == 'policy-only'""",
            "test": """needs.prepare.outputs.review_ready == 'true' &&
                needs.finalize.outputs.ready == 'true' && needs.finalize.outputs.mode == 'application' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.finalize.outputs.validated_run_id == github.run_id""",
            "build": """needs.prepare.outputs.review_ready == 'true' && needs.finalize.outputs.ready == 'true' &&
                needs.finalize.outputs.mode == 'application' && needs.test.result == 'success' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.finalize.outputs.validated_run_id == github.run_id""",
            "publish": """always() && needs.prepare.outputs.review_ready == 'true' &&
                needs.finalize.result == 'success' && needs.finalize.outputs.ready == 'true' &&
                (needs.finalize.outputs.mode == 'already-validated' || needs.build.result == 'success')""",
            "repair": """always() && contains(needs.*.result, 'failure') &&
                (needs.prepare.outputs.prepared_run_attempt == '' ||
                needs.prepare.outputs.prepared_run_attempt == github.run_attempt)""",
        }
        for job_name, expected in expected_job_conditions.items():
            self.assertEqual(" ".join(jobs[job_name]["if"].split()), " ".join(expected.split()),
                             f"{job_name} gate must retain its exact reviewed lifecycle condition")
        self.assertEqual(jobs["test"].get("env"), {
            "UPSTREAM_SHA": "${{ needs.prepare.outputs.upstream }}",
            "UPSTREAM_DIR": "${{ github.workspace }}/upstream",
            "NINEROUTER_SOURCE_ROOT": "${{ github.workspace }}/candidate-config",
        })
        self.assertEqual(jobs["build"].get("env"), {
            "IMAGE_TAG": "9router-reviewed:${{ needs.prepare.outputs.sha }}",
            "APP_VERSION": "${{ needs.prepare.outputs.version }}",
            "CANDIDATE_SHA": "${{ needs.prepare.outputs.sha }}",
            "UPSTREAM_SHA": "${{ needs.prepare.outputs.upstream }}",
            "PATCHSET_SHA256": "${{ needs.prepare.outputs.patchset }}",
            "CONFIG_SHA": "${{ needs.prepare.outputs.config_sha }}",
            "RECIPE_SHA256": "${{ needs.prepare.outputs.recipe }}",
            "CANDIDATE_ID": "${{ needs.prepare.outputs.candidate_id }}",
            "FULL_REVIEW_PR": "${{ needs.prepare.outputs.full_pr }}",
            "DELTA_REVIEW_PR": "${{ needs.prepare.outputs.delta_pr }}",
        })
        self.assertEqual(document.get("permissions"), {"contents": "read"},
                         "Workflow-wide token permissions must remain read-only")
        self.assertIs(document.get("concurrency", {}).get("cancel-in-progress"), False,
                      "Candidate runs must not cancel a live final attempt")

        def named_steps(job_name, step_name):
            matches = [(index, step) for index, step in enumerate(jobs[job_name].get("steps", []))
                       if step.get("name") == step_name]
            self.assertEqual(len(matches), 1, f"Missing or duplicate {step_name} in {job_name}")
            return matches[0]

        for job_name, job in jobs.items():
            self.assertIsInstance(job.get("if"), str, f"Policy job must retain a conditional gate: {job_name}")
            self.assertTrue(job.get("runs-on"), f"Policy job must retain a runner: {job_name}")
            self.assertIsInstance(job.get("steps"), list, f"Policy job must retain executable steps: {job_name}")
            self.assertNotIn("defaults", job,
                             f"Policy job must retain trusted default execution settings: {job_name}")
            self.assertTrue(all(step.get("name") or step.get("uses") for step in job["steps"]),
                            f"Policy job contains an unnamed execution step: {job_name}")

        def need_set(job_name):
            value = jobs[job_name].get("needs", [])
            return {value} if isinstance(value, str) else set(value)

        expected_steps = {
            "prepare": [
                ("run", "Require The Trusted Controller Pin", ""),
                ("uses", "", "actions/checkout"), ("uses", "", "actions/checkout"),
                ("run", "Read The Trusted Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("uses", "", "docker/setup-buildx-action"),
                ("run", "Select Source And Request The Native Review Pair", ""),
                ("uses", "", "actions/upload-artifact"),
                ("run", "Report The Actual State", ""),
            ],
            "policy-check": [
                ("run", "Reject A Job-Only Rerun Before Policy Tests", ""),
                ("uses", "", "actions/checkout"), ("uses", "", "actions/checkout"),
                ("run", "Read The Candidate Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("run", "Install The Pinned Policy YAML Parser", ""),
                ("run", "Enforce Trusted Tests And Validate Proposed YAML", ""),
            ],
            "finalize": [
                ("run", "Reject A Job-Only Rerun Before Final Authorization", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Read The Trusted Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("uses", "", "actions/download-artifact"),
                ("run", "Recheck Native Pair And Final Attempt History", ""),
            ],
            "policy-only": [
                ("run", "Reject A Job-Only Rerun Before Policy Adoption", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Read The Trusted Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("uses", "", "actions/download-artifact"),
                ("run", "Recheck And Adopt The Policy-Only Candidate", ""),
            ],
            "test": [
                ("run", "Reject A Job-Only Rerun Before Application Tests", ""),
                ("uses", "", "actions/checkout"), ("uses", "", "actions/checkout"),
                ("uses", "", "actions/checkout"), ("uses", "", "actions/checkout"),
                ("uses", "", "actions/setup-node"),
                ("run", "Install Application And Test Dependencies", ""),
                ("run", "Run Every Preserved Regression File", ""),
            ],
            "build": [
                ("run", "Reject A Job-Only Rerun Before Container Build", ""),
                ("uses", "", "actions/checkout"), ("uses", "", "docker/setup-buildx-action"),
                ("uses", "Build From The Immutable Remote Git Context", "docker/build-push-action"),
                ("run", "Load And Check Runtime Health And Version", ""),
                ("run", "Show Smoke Logs And Remove Only The Test Container", ""),
                ("run", "Package The Verified Image", ""),
                ("uses", "", "actions/upload-artifact"),
            ],
            "publish": [
                ("uses", "", "actions/checkout"),
                ("run", "Read The Trusted Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("uses", "", "actions/download-artifact"),
                ("uses", "", "actions/download-artifact"), ("uses", "", "actions/download-artifact"),
                ("run", "Publish Only This Verified Candidate", ""),
            ],
            "repair": [
                ("uses", "", "actions/checkout"),
                ("run", "Request The Exact Repair Without Republishing", ""),
            ],
        }

        trusted_checkout = {"ref": "${{ vars.ZED_TRUSTED_POLICY }}", "path": "trusted",
                            "persist-credentials": False}
        private_checkout = {
            "repository": "warelik/machine-maintenance",
            "ref": "${{ steps.private-pin.outputs.revision }}",
            "path": "private-maintenance",
            "ssh-key": "${{ secrets.MAINTENANCE_READ_KEY }}",
            "persist-credentials": False,
        }
        expected_checkouts = {
            "prepare": [
                {"ref": "${{ github.sha }}", "path": "candidate", "persist-credentials": False},
                trusted_checkout,
                private_checkout,
            ],
            "policy-check": [
                trusted_checkout,
                {"ref": "${{ needs.prepare.outputs.config_sha }}", "path": "candidate",
                 "persist-credentials": False},
                {**private_checkout, "ref": "${{ steps.private-pin.outputs.revision }}"},
            ],
            "finalize": [trusted_checkout, private_checkout],
            "policy-only": [trusted_checkout, private_checkout],
            "test": [
                {"ref": "${{ needs.prepare.outputs.sha }}", "path": "app", "persist-credentials": False},
                trusted_checkout,
                {"ref": "${{ needs.prepare.outputs.config_sha }}", "path": "candidate-config",
                 "persist-credentials": False},
                {"repository": "decolua/9router", "ref": "${{ needs.prepare.outputs.upstream }}",
                 "path": "upstream", "persist-credentials": False},
            ],
            "build": [trusted_checkout],
            "publish": [trusted_checkout, private_checkout],
            "repair": [trusted_checkout],
        }
        for job_name, expected in expected_checkouts.items():
            actual = [step.get("with") for step in jobs[job_name]["steps"]
                      if step.get("uses", "").startswith("actions/checkout@")]
            self.assertEqual(actual, expected,
                             f"{job_name} checkout sources and credential settings must be exact")

        buildx_steps = [(job_name, step) for job_name, job in jobs.items() for step in job["steps"]
                        if step.get("uses", "").startswith("docker/setup-buildx-action@")]
        self.assertEqual(len(buildx_steps), 2, "Registry inspection and final build use the pinned Buildx action")
        self.assertTrue(all(step.get("with") is None for _, step in buildx_steps),
                        "Buildx must retain the upstream action's default driver and configuration")
        node_steps = [step for job in jobs.values() for step in job["steps"]
                      if step.get("uses", "").startswith("actions/setup-node@")]
        self.assertEqual(len(node_steps), 1)
        self.assertEqual(node_steps[0].get("with"), {"node-version": "22"})
        build_push = [step for step in jobs["build"]["steps"]
                      if step.get("uses", "").startswith("docker/build-push-action@")]
        self.assertEqual(len(build_push), 1)
        self.assertEqual(set(build_push[0].get("with", {})), {
            "context", "platforms", "tags", "build-args", "labels", "outputs", "cache-from", "cache-to"})
        self.assertEqual(build_push[0]["with"]["context"],
                         "https://github.com/${{ github.repository }}.git#${{ needs.prepare.outputs.sha }}")
        self.assertEqual(build_push[0]["with"]["platforms"], "linux/amd64")
        self.assertEqual(build_push[0]["with"]["build-args"], "APP_VERSION=${{ env.APP_VERSION }}")
        self.assertEqual(build_push[0]["with"]["outputs"], "type=docker,dest=${{ runner.temp }}/9router-image.tar")
        self.assertEqual(build_push[0]["with"]["cache-from"], "type=gha")
        self.assertEqual(build_push[0]["with"]["cache-to"], "type=gha,mode=max,ignore-error=true")
        self.assertEqual(build_push[0]["with"]["tags"], "${{ env.IMAGE_TAG }}")
        self.assertEqual(build_push[0]["with"]["labels"].splitlines(), [
            "org.opencontainers.image.source=https://github.com/${{ github.repository }}",
            "org.opencontainers.image.revision=${{ env.CANDIDATE_SHA }}",
            "org.opencontainers.image.version=${{ env.APP_VERSION }}",
            "io.9router.upstream.revision=${{ env.UPSTREAM_SHA }}",
            "io.9router.patches.sha256=${{ env.PATCHSET_SHA256 }}",
        ])

        expected_artifacts = {
            "prepare": [("actions/upload-artifact", {
                "name": "lifecycle-${{ steps.snapshot.outputs.candidate_id }}",
                "path": "${{ steps.snapshot.outputs.context }}",
                "if-no-files-found": "error", "retention-days": 7,
            })],
            "finalize": [("actions/download-artifact", {
                "name": "lifecycle-${{ needs.prepare.outputs.candidate_id }}", "path": "lifecycle",
            })],
            "policy-only": [("actions/download-artifact", {
                "name": "lifecycle-${{ needs.prepare.outputs.candidate_id }}", "path": "lifecycle",
            })],
            "build": [("actions/upload-artifact", {
                "name": "reviewed-${{ needs.prepare.outputs.candidate_id }}",
                "path": "${{ runner.temp }}/release/", "if-no-files-found": "error", "retention-days": 7,
            })],
            "publish": [
                ("actions/download-artifact", {
                    "name": "lifecycle-${{ needs.prepare.outputs.candidate_id }}", "path": "lifecycle",
                }),
                ("actions/download-artifact", {
                    "name": "reviewed-${{ needs.prepare.outputs.candidate_id }}", "path": "release",
                    "run-id": "${{ needs.finalize.outputs.validated_run_id }}",
                    "github-token": "${{ github.token }}",
                }),
                ("actions/download-artifact", {
                    "name": "reviewed-${{ needs.prepare.outputs.candidate_id }}", "path": "release",
                    "run-id": "${{ needs.finalize.outputs.validated_run_id }}",
                    "github-token": "${{ github.token }}",
                }),
            ],
        }
        for job_name, expected in expected_artifacts.items():
            actual = [(step["uses"].split("@", 1)[0], step.get("with"))
                      for step in jobs[job_name]["steps"]
                      if step.get("uses", "").startswith(("actions/upload-artifact@", "actions/download-artifact@"))]
            self.assertEqual(actual, expected,
                             f"{job_name} artifact inputs must retain the exact same-run candidate identity")

        def signature(step):
            if "run" in step:
                self.assertNotIn("uses", step, "A workflow step cannot run and invoke an Action")
                kind, action = "run", ""
            else:
                self.assertIn("uses", step, "Each workflow step must have one explicit command or Action")
                kind, action = "uses", step["uses"].split("@", 1)[0]
            allowed = ({"name", "run", "env", "if", "id", "working-directory"} if kind == "run"
                       else {"name", "uses", "with", "if", "id"})
            self.assertLessEqual(set(step), allowed, "Workflow step contains an unreviewed execution control")
            self.assertNotIn("continue-on-error", step)
            return kind, step.get("name", ""), action

        for job_name, expected in expected_steps.items():
            actual = [signature(step) for step in jobs[job_name]["steps"]]
            self.assertEqual(actual, expected,
                             f"{job_name} must use the complete ordered command/action allowlist")
        conditional_steps = [
            (job_name, step.get("name", ""), step["if"])
            for job_name, job in jobs.items() for step in job["steps"] if "if" in step
        ]
        self.assertCountEqual(conditional_steps, [
            ("prepare", "", "steps.snapshot.outputs.context != ''"),
            ("prepare", "Report The Actual State", "always()"),
            ("build", "Show Smoke Logs And Remove Only The Test Container", "always()"),
            ("publish", "", "needs.finalize.outputs.mode == 'application'"),
            ("publish", "", "needs.finalize.outputs.mode == 'already-validated' && needs.prepare.outputs.mode != 'published-recovery'"),
        ], "Only the reviewed artifact/diagnostic steps may be conditionally skipped")
        working_directories = [
            (job_name, step.get("name", ""), step["working-directory"])
            for job_name, job in jobs.items() for step in job["steps"] if "working-directory" in step
        ]
        self.assertEqual(working_directories,
                         [("test", "Install Application And Test Dependencies", "app")])

        def run_step(job_name, step_name):
            matches = [step for step in jobs[job_name]["steps"] if step.get("name") == step_name]
            self.assertEqual(len(matches), 1, f"Missing or duplicated command {job_name}/{step_name}")
            return matches[0]["run"].splitlines()

        expected_commands = {
            ("prepare", "Require The Trusted Controller Pin"):
                ['[[ "$TRUSTED_POLICY" =~ ^[0-9a-f]{40}$ ]]'],
            ("prepare", "Read The Trusted Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("trusted/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("prepare", "Record The Exact Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance"); lock=json.loads(pathlib.Path("trusted/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
            ("prepare", "Select Source And Request The Native Review Pair"):
                ['python3 trusted/scripts/release.py prepare-shared "$RUNNER_TEMP/9router-source"'],
            ("prepare", "Report The Actual State"):
                ["{",
                 'echo "### Upstream plus patches"',
                 'printf \'%s\\n\' "- State: ${MODE:-stopped before a decision}"',
                 'printf \'%s\\n\' "- Review accepted: ${READY:-false}"',
                 'if [ -n "$SOURCE_SHA" ]; then printf \'%s\\n\' "- Application: $VERSION at $SOURCE_SHA"; fi',
                 'if [ -n "$FULL_PR" ]; then printf \'%s\\n\' "- Full review PR: #$FULL_PR"; fi',
                 'if [ -n "$DELTA_PR" ]; then printf \'%s\\n\' "- Delta review PR: #$DELTA_PR"; fi',
                 'if [ -n "$REASON" ]; then printf \'%s\\n\' "- Detail: $REASON"; fi',
                 'echo "- GitHub never deploys; the VPS recipe consumes verified releases"',
                 '} >> "$GITHUB_STEP_SUMMARY"'],
            ("policy-check", "Reject A Job-Only Rerun Before Policy Tests"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
                 '[[ "$POLICY_RESERVATION_ID" =~ ^[1-9][0-9]*$ ]]'],
            ("policy-check", "Read The Candidate Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("candidate/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("policy-check", "Record The Exact Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance"); lock=json.loads(pathlib.Path("candidate/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
            ("policy-check", "Enforce Trusted Tests And Validate Proposed YAML"):
                ['python3 trusted/scripts/release.py check-policy-shared "$GITHUB_WORKSPACE/candidate"'],
            ("finalize", "Reject A Job-Only Rerun Before Final Authorization"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"'],
            ("finalize", "Recheck Native Pair And Final Attempt History"):
                ['python3 trusted/scripts/release.py finalize-shared "$GITHUB_WORKSPACE/lifecycle"'],
            ("policy-only", "Reject A Job-Only Rerun Before Policy Adoption"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"'],
            ("policy-only", "Recheck And Adopt The Policy-Only Candidate"):
                ['python3 trusted/scripts/release.py policy-only-shared "$GITHUB_WORKSPACE/lifecycle"'],
            ("test", "Reject A Job-Only Rerun Before Application Tests"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
                 'test "$AUTHORIZED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$AUTHORIZED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"'],
            ("build", "Reject A Job-Only Rerun Before Container Build"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
                 'test "$AUTHORIZED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$AUTHORIZED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"'],
            ("publish", "Read The Trusted Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("trusted/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("publish", "Record The Exact Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance"); lock=json.loads(pathlib.Path("trusted/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
            ("publish", "Publish Only This Verified Candidate"):
                ['mkdir -p "$GITHUB_WORKSPACE/release"',
                 'cp "$GITHUB_WORKSPACE/lifecycle/shared-context.json" "$GITHUB_WORKSPACE/release/shared-context.json"',
                 'python3 trusted/scripts/release.py publish-shared "$GITHUB_WORKSPACE/release"'],
        }
        for (job_name, step_name), expected in expected_commands.items():
            self.assertEqual(run_step(job_name, step_name), expected,
                             f"{job_name}/{step_name} command must remain on its explicit allowlist")

        expected_step_envs = {
            ("prepare", "Require The Trusted Controller Pin"): {
                "TRUSTED_POLICY": "${{ vars.ZED_TRUSTED_POLICY }}",
            },
            ("prepare", "Select Source And Request The Native Review Pair"): {
                "GH_TOKEN": "${{ github.token }}",
                "CODEX_REQUEST_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}",
                "FORK_MAINTENANCE_ROOT": "${{ github.workspace }}/private-maintenance",
                "TRUSTED_POLICY": "${{ vars.ZED_TRUSTED_POLICY }}",
                "NINEROUTER_SOURCE_ROOT": "${{ github.workspace }}/candidate",
            },
            ("prepare", "Report The Actual State"): {
                "READY": "${{ steps.snapshot.outputs.ready }}",
                "MODE": "${{ steps.snapshot.outputs.mode }}",
                "REASON": "${{ steps.snapshot.outputs.reason }}",
                "SOURCE_SHA": "${{ steps.snapshot.outputs.sha }}",
                "VERSION": "${{ steps.snapshot.outputs.version }}",
                "FULL_PR": "${{ steps.snapshot.outputs.full_pr }}",
                "DELTA_PR": "${{ steps.snapshot.outputs.delta_pr }}",
            },
            ("policy-check", "Reject A Job-Only Rerun Before Policy Tests"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
                "POLICY_RESERVATION_ID": "${{ needs.prepare.outputs.policy_reservation_id }}",
            },
            ("policy-check", "Enforce Trusted Tests And Validate Proposed YAML"): {
                "FORK_MAINTENANCE_ROOT": "${{ github.workspace }}/private-maintenance",
            },
            ("finalize", "Reject A Job-Only Rerun Before Final Authorization"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
            },
            ("finalize", "Recheck Native Pair And Final Attempt History"): {
                "GH_TOKEN": "${{ github.token }}",
                "CODEX_REQUEST_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}",
                "FORK_MAINTENANCE_ROOT": "${{ github.workspace }}/private-maintenance",
                "TRUSTED_POLICY": "${{ vars.ZED_TRUSTED_POLICY }}",
            },
            ("policy-only", "Reject A Job-Only Rerun Before Policy Adoption"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
            },
            ("policy-only", "Recheck And Adopt The Policy-Only Candidate"): {
                "GH_TOKEN": "${{ github.token }}",
                "CODEX_REQUEST_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}",
                "FORK_MAINTENANCE_ROOT": "${{ github.workspace }}/private-maintenance",
                "TRUSTED_POLICY": "${{ vars.ZED_TRUSTED_POLICY }}",
            },
            ("test", "Reject A Job-Only Rerun Before Application Tests"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
                "AUTHORIZED_RUN_ID": "${{ needs.finalize.outputs.validated_run_id }}",
                "AUTHORIZED_RUN_ATTEMPT": "${{ needs.finalize.outputs.validated_run_attempt }}",
            },
            ("build", "Reject A Job-Only Rerun Before Container Build"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
                "AUTHORIZED_RUN_ID": "${{ needs.finalize.outputs.validated_run_id }}",
                "AUTHORIZED_RUN_ATTEMPT": "${{ needs.finalize.outputs.validated_run_attempt }}",
            },
            ("publish", "Publish Only This Verified Candidate"): {
                "GH_TOKEN": "${{ github.token }}",
                "CODEX_REQUEST_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}",
                "FORK_MAINTENANCE_ROOT": "${{ github.workspace }}/private-maintenance",
                "TRUSTED_POLICY": "${{ vars.ZED_TRUSTED_POLICY }}",
                "CANDIDATE_SHA": "${{ needs.prepare.outputs.sha }}",
                "UPSTREAM_SHA": "${{ needs.prepare.outputs.upstream }}",
                "PATCHSET_SHA256": "${{ needs.prepare.outputs.patchset }}",
                "CONFIG_SHA": "${{ needs.prepare.outputs.config_sha }}",
                "RECIPE_SHA256": "${{ needs.prepare.outputs.recipe }}",
                "APP_VERSION": "${{ needs.prepare.outputs.version }}",
                "CANDIDATE_ID": "${{ needs.prepare.outputs.candidate_id }}",
                "REPAIR_HEAD": "${{ needs.prepare.outputs.repair_head }}",
                "VALIDATED_RUN_ID": "${{ needs.finalize.outputs.validated_run_id }}",
                "VALIDATED_RUN_ATTEMPT": "${{ needs.finalize.outputs.validated_run_attempt }}",
            },
            ("repair", "Request The Exact Repair Without Republishing"): {
                "GH_TOKEN": "${{ github.token }}",
                "CODEX_REQUEST_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}",
                "UPSTREAM_SHA": "${{ needs.prepare.outputs.upstream }}",
                "CANDIDATE_PR": "${{ needs.prepare.outputs.full_pr }}",
                "CANDIDATE_SHA": "${{ needs.prepare.outputs.sha }}",
                "REPAIR_HEAD": "${{ needs.prepare.outputs.repair_head }}",
            },
        }
        for (job_name, step_name), expected in expected_step_envs.items():
            env_step = next(step for step in jobs[job_name]["steps"] if step.get("name") == step_name)
            self.assertEqual(env_step.get("env"), expected,
                             f"{job_name}/{step_name} credential and identity environment changed")
        for job_name, job in jobs.items():
            for step in job["steps"]:
                if "env" in step:
                    self.assertIn((job_name, step.get("name", "")), expected_step_envs,
                                  "Only explicitly reviewed steps may receive environment values")
        actual_ids = [(job_name, step.get("name", ""), step.get("id"))
                      for job_name, job in jobs.items() for step in job["steps"] if "id" in step]
        self.assertEqual(actual_ids, [
            ("prepare", "Read The Trusted Private Module Pin", "private-pin"),
            ("prepare", "Select Source And Request The Native Review Pair", "snapshot"),
            ("policy-check", "Read The Candidate Private Module Pin", "private-pin"),
            ("finalize", "Read The Trusted Private Module Pin", "private-pin"),
            ("finalize", "Recheck Native Pair And Final Attempt History", "final"),
            ("policy-only", "Read The Trusted Private Module Pin", "private-pin"),
            ("publish", "Read The Trusted Private Module Pin", "private-pin"),
        ])

        baseline_run = {}
        for job_name in trusted["jobs"]:
            for step in trusted["jobs"].get(job_name, {}).get("steps", []):
                if "run" in step and step.get("name"):
                    baseline_run[(job_name, step["name"])] = step["run"]
        for job_name in jobs:
            for step in jobs[job_name]["steps"]:
                key = (job_name, step.get("name"))
                if "run" in step and key in baseline_run and key not in expected_commands:
                    self.assertEqual(step["run"], baseline_run[key],
                                     f"Preserved {job_name}/{key[1]} command changed from immutable baseline")

        self.assertFalse(need_set("prepare"), "Prepare must remain the single lifecycle producer")
        self.assertNotIn("needs", jobs["prepare"], "Prepare must not depend on another lifecycle stage")
        self.assertEqual(need_set("policy-check"), {"prepare"},
                         "Policy job must retain the source-review prerequisite")
        self.assertEqual(need_set("finalize"), {"prepare", "policy-check"})
        self.assertEqual(need_set("policy-only"), {"prepare", "policy-check", "finalize"})
        self.assertEqual(need_set("test"), {"prepare", "finalize"})
        self.assertEqual(need_set("build"), {"prepare", "finalize", "test"})
        self.assertEqual(need_set("publish"), {"prepare", "finalize", "build"})
        self.assertEqual(need_set("repair"),
                         {"prepare", "policy-check", "finalize", "policy-only", "test", "build", "publish"})
        self.assertEqual(jobs["prepare"].get("outputs"), {
            "ready": "${{ steps.snapshot.outputs.ready }}",
            "review_ready": "${{ steps.snapshot.outputs.review_ready }}",
            "sha": "${{ steps.snapshot.outputs.sha }}",
            "upstream": "${{ steps.snapshot.outputs.upstream }}",
            "patchset": "${{ steps.snapshot.outputs.patchset }}",
            "recipe": "${{ steps.snapshot.outputs.recipe }}",
            "config_sha": "${{ steps.snapshot.outputs.config_sha }}",
            "version": "${{ steps.snapshot.outputs.version }}",
            "release": "${{ steps.snapshot.outputs.release }}",
            "full_pr": "${{ steps.snapshot.outputs.full_pr }}",
            "delta_pr": "${{ steps.snapshot.outputs.delta_pr }}",
            "candidate_id": "${{ steps.snapshot.outputs.candidate_id }}",
            "context": "${{ steps.snapshot.outputs.context }}",
            "mode": "${{ steps.snapshot.outputs.mode }}",
            "policy_verified": "${{ steps.snapshot.outputs.policy_verified }}",
            "policy_reservation_id": "${{ steps.snapshot.outputs.policy_reservation_id }}",
            "initial_decision": "${{ steps.snapshot.outputs.initial_decision }}",
            "reuse_run_id": "${{ steps.snapshot.outputs.reuse_run_id }}",
            "reuse_run_attempt": "${{ steps.snapshot.outputs.reuse_run_attempt }}",
            "repair_pr": "${{ steps.snapshot.outputs.repair_pr }}",
            "repair_head": "${{ steps.snapshot.outputs.repair_head }}",
            "prepared_run_id": "${{ steps.snapshot.outputs.prepared_run_id }}",
            "prepared_run_attempt": "${{ steps.snapshot.outputs.prepared_run_attempt }}",
        }, "Only the trusted prepare result may authorize the policy-unit reuse path")
        self.assertEqual(jobs["finalize"].get("outputs"), {
            "ready": "${{ steps.final.outputs.final_ready }}",
            "mode": "${{ steps.final.outputs.mode }}",
            "reason": "${{ steps.final.outputs.reason }}",
            "reuse_run_id": "${{ steps.final.outputs.reuse_run_id }}",
            "reuse_run_attempt": "${{ steps.final.outputs.reuse_run_attempt }}",
            "validated_run_id": "${{ steps.final.outputs.validated_run_id }}",
            "validated_run_attempt": "${{ steps.final.outputs.validated_run_attempt }}",
        })

        # The owner-authenticated producer runs the pinned controller, while the
        # candidate checkout is only input data. No parser, tests, image build or app
        # dependencies may run before both native reviews complete.
        prepare = jobs["prepare"]
        self.assertEqual(prepare.get("permissions"), {
            "contents": "write", "pull-requests": "write", "issues": "write", "actions": "read"})
        self.assertIn("prepare-shared", named_steps(
            "prepare", "Select Source And Request The Native Review Pair")[1].get("run", ""))
        prep_call = named_steps("prepare", "Select Source And Request The Native Review Pair")[1]
        self.assertEqual(set(prep_call), {"name", "env", "run"},
                         "Policy consumer must retain its strict trusted execution context")
        self.assertEqual(prep_call.get("run"),
                         "python3 trusted/scripts/release.py prepare-shared \"$RUNNER_TEMP/9router-source\"",
                         "Policy consumer must retain the trusted prepare CLI")
        self.assertNotIn("Install The Pinned Policy YAML Parser", "\n".join(
            str(step.get("name", "")) for step in prepare["steps"]))
        self.assertNotIn("unittest", "\n".join(str(step.get("run", "")) for step in prepare["steps"]))
        buildx_steps = [(index, step) for index, step in enumerate(prepare["steps"])
                        if step.get("uses", "").startswith("docker/setup-buildx-action@")]
        self.assertEqual(len(buildx_steps), 1,
                         "Preparation needs the pinned registry-inspection tool, not an image build")
        self.assertLess(buildx_steps[0][0], prepare["steps"].index(prep_call))
        self.assertEqual(named_steps("prepare", "Require The Trusted Controller Pin")[1].get("with"), None,
                         "Trusted controller pin check cannot be replaced by an untrusted checkout")
        controller = next((step for step in prepare["steps"]
                           if step.get("name") == "Require The Trusted Controller Pin"), {})
        self.assertIn("ZED_TRUSTED_POLICY", controller.get("env", {}))
        self.assertEqual(prep_call.get("env", {}).get("NINEROUTER_SOURCE_ROOT"),
                         "${{ github.workspace }}/candidate")
        self.assertEqual(prep_call.get("env", {}).get("CODEX_REQUEST_TOKEN"),
                         "${{ secrets.CODEX_REQUEST_TOKEN }}")
        self.assertEqual(prep_call.get("env", {}).get("TRUSTED_POLICY"), "${{ vars.ZED_TRUSTED_POLICY }}")
        self.assertIn("github.event_name", prepare.get("if", ""),
                      "Prepare must retain its event boundary")
        for job_name, job in jobs.items():
            self.assertNotIn("continue-on-error", job,
                             f"Policy job must retain fail-closed execution: {job_name}")
            for checkout in (step for step in job["steps"]
                             if step.get("uses", "").startswith("actions/checkout@")):
                self.assertNotEqual(checkout.get("with", {}).get("ref"),
                                    "${{ needs.prepare.outputs.repair_head }}",
                                    f"Trusted checkout must not use untrusted repair code: {job_name}")
            trusted_checkouts = [step for step in job["steps"]
                                 if step.get("uses", "").startswith("actions/checkout@")
                                 and step.get("with", {}).get("path") == "trusted"]
            self.assertEqual(len(trusted_checkouts), 1,
                             f"{job_name} must use one pinned trusted controller")
            self.assertEqual(trusted_checkouts[0].get("with", {}).get("ref"),
                             "${{ vars.ZED_TRUSTED_POLICY }}")
        uploads = [step for step in prepare["steps"]
                   if step.get("uses", "").startswith("actions/upload-artifact@")]
        self.assertEqual(len(uploads), 1, "Only the frozen lifecycle context may leave preparation")
        self.assertEqual(uploads[0].get("with", {}).get("path"), "${{ steps.snapshot.outputs.context }}")

        # The pinned parser and trusted policy oracle run only after prepare has
        # completed the two-review gate; candidate code remains a separate input.
        policy = jobs["policy-check"]
        self.assertEqual(policy.get("needs"), "prepare")
        policy_gate = policy.get("if", "")
        self.assertIn("review_ready == 'true'", policy_gate, "Policy job must retain the native review gate")
        self.assertEqual(policy_gate.splitlines()[-1].strip(), "needs.prepare.outputs.policy_verified != 'true'")
        self.assertIn("policy_verified != 'true'", policy_gate,
                      "Policy tests may be skipped only for a verified native bundle")
        policy_guard = named_steps("policy-check", "Reject A Job-Only Rerun Before Policy Tests")[1]
        self.assertEqual(set(policy_guard), {"name", "env", "run"})
        self.assertIn("PREPARED_RUN_ATTEMPT", policy_guard["env"])
        self.assertIn("POLICY_RESERVATION_ID", policy_guard["env"])
        self.assertIn("GITHUB_RUN_ATTEMPT", policy_guard["run"])
        self.assertEqual(policy["steps"][0], policy_guard,
                         "Job-only rerun guard must run before parser or tests")
        installers = [(index, step) for index, step in enumerate(policy["steps"])
                      if step.get("name") == "Install The Pinned Policy YAML Parser"]
        self.assertEqual(len(installers), 1, "Missing parser bootstrap in policy-check")
        parser_index, parser = installers[0]
        trusted_parser = next(step for step in trusted["jobs"]["policy-check"]["steps"]
                              if step.get("name") == "Install The Pinned Policy YAML Parser")
        self.assertEqual(parser, trusted_parser, "Parser bootstrap must retain the trusted executable body")
        consumer_index, consumer = named_steps(
            "policy-check", "Enforce Trusted Tests And Validate Proposed YAML")
        self.assertEqual(consumer.get("run"),
                         "python3 trusted/scripts/release.py check-policy-shared \"$GITHUB_WORKSPACE/candidate\"",
                         "Policy consumer must retain the trusted CLI")
        self.assertNotIn("if", consumer, "Policy consumer must retain strict execution")
        self.assertNotIn("continue-on-error", consumer, "Policy consumer must retain strict execution")
        self.assertEqual(set(consumer), {"name", "run"},
                         "Policy consumer must retain strict execution settings")
        self.assertLess(parser_index, consumer_index)
        self.assertEqual(set(policy.get("permissions", {})), {"contents"})

        # Finalize rechecks the exact review pair and attempt receipt. Both
        # heavy application jobs compare the original run+attempt outputs, so a
        # single-job rerun cannot repeat tests or compilation.
        finalize = jobs["finalize"]
        self.assertEqual(set(finalize.get("needs", [])), {"prepare", "policy-check"})
        self.assertIn("review_ready == 'true'", finalize.get("if", ""))
        self.assertIn("policy_verified == 'true'", finalize.get("if", ""))
        finalize_guard = named_steps("finalize", "Reject A Job-Only Rerun Before Final Authorization")[1]
        self.assertEqual(set(finalize_guard), {"name", "env", "run"})
        self.assertEqual(finalize["steps"][0], finalize_guard)
        self.assertIn("GITHUB_RUN_ATTEMPT", finalize_guard.get("run", ""))
        self.assertIn("finalize-shared", named_steps(
            "finalize", "Recheck Native Pair And Final Attempt History")[1].get("run", ""))
        self.assertIn("policy-check.result == 'success'", jobs["policy-only"].get("if", ""))
        self.assertIn("policy_verified == 'true'", jobs["policy-only"].get("if", ""))
        self.assertIn("mode == 'policy-only'", jobs["policy-only"].get("if", ""))
        policy_adoption_guard = named_steps("policy-only", "Reject A Job-Only Rerun Before Policy Adoption")[1]
        self.assertEqual(set(policy_adoption_guard), {"name", "env", "run"})
        self.assertEqual(jobs["policy-only"]["steps"][0], policy_adoption_guard)
        self.assertIn("GITHUB_RUN_ATTEMPT", policy_adoption_guard.get("run", ""))
        for job_name in ("test", "build"):
            gate = jobs[job_name].get("if", "")
            self.assertIn("finalize.outputs.mode == 'application'", gate)
            guard_name = ("Reject A Job-Only Rerun Before Application Tests" if job_name == "test"
                          else "Reject A Job-Only Rerun Before Container Build")
            guard = named_steps(job_name, guard_name)[1]
            self.assertEqual(set(guard), {"name", "env", "run"})
            self.assertEqual(jobs[job_name]["steps"][0], guard)
            self.assertIn("PREPARED_RUN_ATTEMPT", guard.get("env", {}))
            self.assertIn("AUTHORIZED_RUN_ATTEMPT", guard.get("env", {}))
            self.assertIn("GITHUB_RUN_ATTEMPT", guard.get("run", ""))
            self.assertNotIn("CODEX_REQUEST_TOKEN", str(jobs[job_name]))
            self.assertNotIn("MAINTENANCE_READ_KEY", str(jobs[job_name]))
        self.assertIn("needs.test.result == 'success'", jobs["build"].get("if", ""))
        self.assertIn("mode == 'already-validated'", jobs["publish"].get("if", ""))
        self.assertIn("build.result == 'success'", jobs["publish"].get("if", ""))
        self.assertIn("policy-check.result == 'success'", jobs["policy-only"].get("if", ""))
        self.assertIn("run-id:", "\n".join(str(step.get("with", {})) for step in jobs["publish"]["steps"]))
        self.assertNotIn("CODEX_REQUEST_TOKEN", str(jobs["policy-check"]))
        owner_secret_steps = [
            (job_name, step.get("name", ""))
            for job_name, job in jobs.items() for step in job["steps"]
            if "CODEX_REQUEST_TOKEN" in (step.get("env") or {})
        ]
        self.assertCountEqual(owner_secret_steps, [
            ("prepare", "Select Source And Request The Native Review Pair"),
            ("finalize", "Recheck Native Pair And Final Attempt History"),
            ("policy-only", "Recheck And Adopt The Policy-Only Candidate"),
            ("publish", "Publish Only This Verified Candidate"),
            ("repair", "Request The Exact Repair Without Republishing"),
        ], "Owner credentials are confined to the five trusted orchestration steps")
        self.assertEqual(jobs["publish"].get("permissions", {}).get("actions"), "write",
                         "Publication must have only its scoped native checkpoint permission")
        self.assertIn("contains(needs.*.result, 'failure')", jobs["repair"].get("if", ""))
        self.assertIn("prepared_run_attempt == github.run_attempt", jobs["repair"].get("if", ""),
                      "Repair must not turn an intentional job-only rerun guard into new work")

        private_jobs = {"prepare", "policy-check", "finalize", "policy-only", "publish"}
        for job_name, job in jobs.items():
            checkouts = [step for step in job["steps"]
                         if step.get("uses", "").startswith("actions/checkout@")
                         and (step.get("with", {}).get("repository") == "warelik/machine-maintenance"
                              or "MAINTENANCE_READ_KEY" in str(step.get("with", {})))]
            if job_name in private_jobs:
                self.assertEqual(len(checkouts), 1, f"{job_name} must acquire one exact private source checkout")
                checkout = checkouts[0]
                self.assertEqual(checkout.get("with", {}).get("repository"), "warelik/machine-maintenance")
                self.assertEqual(checkout.get("with", {}).get("ssh-key"), "${{ secrets.MAINTENANCE_READ_KEY }}")
                if job_name == "policy-check":
                    self.assertEqual(checkout.get("with", {}).get("ref"), "${{ steps.private-pin.outputs.revision }}")
                else:
                    self.assertEqual(checkout.get("with", {}).get("ref"), "${{ steps.private-pin.outputs.revision }}")
                self.assertIs(checkout.get("with", {}).get("persist-credentials"), False)
            else:
                self.assertFalse(checkouts, f"{job_name} must not receive private-source credentials")
        self.assertNotIn("CODEX_REQUEST_TOKEN", str(policy))
        self.assertIn("FORK_MAINTENANCE_ROOT", named_steps(
            "policy-check", "Enforce Trusted Tests And Validate Proposed YAML")[1].get("env", {}))
        release.validate_action_pins(workflow)

    def test_parser_bootstrap_assertions_read_the_proposed_workflow(self):
        workflow = Path(os.environ.get("NINEROUTER_POLICY_CANDIDATE_WORKFLOW") or
                        release.ROOT / ".github/workflows/release.yml")
        yaml = release.yaml_module()
        for job in ("policy-check",):
            with self.subTest(job=job), tempfile.TemporaryDirectory() as directory:
                document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                document["jobs"][job]["steps"] = [step for step in document["jobs"][job]["steps"]
                    if step.get("name") != "Install The Pinned Policy YAML Parser"]
                candidate = Path(directory) / "proposed.yml"
                candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                    with self.assertRaises(AssertionError):
                        self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_parser_bootstrap_rejects_commented_and_ignored_commands(self):
        workflow = release.ROOT / ".github/workflows/release.yml"
        yaml = release.yaml_module()
        for job in ("policy-check",):
            for mutation in ("comments", "ignore-failure"):
                with self.subTest(job=job, mutation=mutation), tempfile.TemporaryDirectory() as directory:
                    document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                    step = next(item for item in document["jobs"][job]["steps"]
                                if item.get("name") == "Install The Pinned Policy YAML Parser")
                    body = step["run"]
                    step["run"] = ("true\n" + "\n".join("# " + line for line in body.splitlines())
                                   if mutation == "comments" else "{\n" + body + "\n} || true\n")
                    candidate = Path(directory) / "proposed.yml"
                    candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                    with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                        with self.assertRaises(AssertionError):
                            self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_policy_consumers_reject_disabled_and_replaced_checks(self):
        yaml = release.yaml_module()
        workflow = release.ROOT / ".github/workflows/release.yml"
        mutations = ({"if": False}, {"continue-on-error": True}, {"run": "true"},
                     {"shell": "bash {0} || true"}, {"working-directory": "/tmp"},
                     {"env": {"PYTHONPATH": "/tmp/untrusted"}})
        for job, name in (("prepare", "Select Source And Request The Native Review Pair"),
                          ("policy-check", "Enforce Trusted Tests And Validate Proposed YAML")):
            for mutation in mutations:
                with self.subTest(job=job, mutation=mutation), tempfile.TemporaryDirectory() as directory:
                    document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                    step = next(item for item in document["jobs"][job]["steps"] if item.get("name") == name)
                    step.update(mutation)
                    candidate = Path(directory) / "proposed.yml"
                    candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                    with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                        with self.assertRaises(AssertionError):
                            self.test_policy_workflow_keeps_review_and_final_validation_gates()
            for mutation in ({"if": False}, {"continue-on-error": True},
                             {"defaults": {"run": {"shell": "bash {0} || true"}}}):
                with self.subTest(job=job, scope="job", mutation=mutation), tempfile.TemporaryDirectory() as directory:
                    document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                    document["jobs"][job].update(mutation)
                    candidate = Path(directory) / "proposed.yml"
                    candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                    with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                        with self.assertRaisesRegex(AssertionError, "Policy job must retain"):
                            self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_policy_sequence_and_adoption_gate_cannot_bypass_the_oracle(self):
        yaml = release.yaml_module()
        workflow = release.ROOT / ".github/workflows/release.yml"
        for job in yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]:
            for mutation in ("insert-step", "append-step", "replace-checkout", "drop-needs", "unconditional", "no-op"):
                with self.subTest(job=job, mutation=mutation), tempfile.TemporaryDirectory() as directory:
                    document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                    target = document["jobs"][job]
                    if mutation == "insert-step":
                        target["steps"].insert(1, {"run": "rm -rf trusted/scripts; cp -r candidate/scripts trusted/scripts"})
                    elif mutation == "append-step":
                        target["steps"].append({"run": "echo ready=true >> $GITHUB_OUTPUT"})
                    elif mutation == "replace-checkout":
                        target["steps"][0].setdefault("with", {})["ref"] = "${{ needs.prepare.outputs.repair_head }}"
                    elif mutation == "drop-needs":
                        target["needs"] = []
                    elif mutation == "no-op":
                        target["steps"] = [{"run": "true"}]
                    else:
                        target["if"] = "always()"
                    candidate = Path(directory) / "proposed.yml"
                    candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                    with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                        with self.assertRaises((AssertionError, KeyError, StopIteration)):
                            self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_oracle_rejects_extra_write_steps_permission_escalation_and_guard_edits(self):
        yaml = release.yaml_module()
        workflow = release.ROOT / ".github/workflows/release.yml"
        mutations = ("extra-write-step", "permission-value", "missing-guard",
                     "disabled-guard", "replaced-guard")
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                if mutation == "extra-write-step":
                    document["jobs"]["policy-only"]["steps"].append({
                        "name": "Write with an owner token",
                        "env": {"GH_TOKEN": "${{ secrets.CODEX_REQUEST_TOKEN }}"},
                        "run": "gh api --method POST repos/warelik/9router/issues/1/comments",
                    })
                elif mutation == "permission-value":
                    document["jobs"]["policy-check"]["permissions"] = {
                        "contents": "write", "issues": "write"}
                else:
                    guard = next(step for step in document["jobs"]["build"]["steps"]
                                 if step.get("name") == "Reject A Job-Only Rerun Before Container Build")
                    if mutation == "missing-guard":
                        document["jobs"]["build"]["steps"].remove(guard)
                    elif mutation == "disabled-guard":
                        guard["if"] = False
                    else:
                        guard["run"] = "echo authorized"
                candidate = Path(directory) / "proposed.yml"
                candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                    with self.assertRaises(AssertionError):
                        self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_policy_workflow_allows_exact_action_pin_refresh_only(self):
        workflow = release.ROOT / ".github/workflows/release.yml"
        with tempfile.TemporaryDirectory() as directory:
            source = workflow.read_text(encoding="utf-8")
            source = re.sub(r"(?<=@)[0-9a-f]{40}", "c" * 40, source)
            candidate = Path(directory) / "proposed.yml"
            candidate.write_text(source, encoding="utf-8")
            with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                self.test_policy_workflow_keeps_review_and_final_validation_gates()

    def test_action_workflows_reject_unsafe_yaml_tags_without_construction(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = Path(directory) / "release.yml"
            marker = Path(directory) / "yaml-tag-executed"
            workflow.write_text(
                "jobs:\n  check:\n    steps:\n"
                f"      - !!python/object/apply:os.system [\"touch {marker}\"]\n")
            with self.assertRaisesRegex(ValueError, "invalid or unsafe"):
                release.validate_action_pins(workflow)
            self.assertFalse(marker.exists())

    def test_action_workflows_allow_docker_actions_only_by_exact_image_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = Path(directory) / "release.yml"
            workflow.write_text(
                "jobs:\n  test:\n    steps:\n"
                f"      - uses: docker://registry.example:5000/acme/action:v1@sha256:{'a' * 64}\n")
            release.validate_action_pins(workflow)
            workflow.write_text(
                "jobs:\n  test:\n    steps:\n"
                "      - uses: docker://ghcr.io/acme/action:stable\n")
            with self.assertRaisesRegex(ValueError, "Docker Action must use an exact image@sha256 digest"):
                release.validate_action_pins(workflow)
            workflow.write_text(
                "jobs:\n  test:\n    steps:\n"
                f"      - uses: docker://ghcr.io/acme/action@sha256:{'a' * 63}\n")
            with self.assertRaisesRegex(ValueError, "Docker Action must use an exact image@sha256 digest"):
                release.validate_action_pins(workflow)


class SharedReviewCheckpointCredentialTests(unittest.TestCase):
    def context(self, endpoint):
        variable = {"name": "FORK_ACCEPTED_BASELINE", "value": "baseline-json"}
        reviews = {
            scope: {
                "pr": number, "review_sha": HEAD, "base_sha": CONFIG,
                "head_ref": f"refs/pull/{number}/head", "base_ref": "refs/heads/main",
                "request_id": number + 100,
            }
            for scope, number in (("full", 1), ("delta", 2))
        }
        return {
            "candidate": {"configuration_sha": HEAD},
            "baseline": {
                "published_at": "2026-10-18T12:00:00Z",
                "accepted_baseline": {"endpoint": endpoint, "variable": variable},
            },
            "reviews": reviews,
            "known_findings": [],
        }, variable

    def test_checkpoint_recheck_uses_owner_token_for_exact_native_variable(self):
        endpoint = f"repos/{REPO}/actions/variables/FORK_ACCEPTED_BASELINE"
        context, variable = self.context(endpoint)
        lifecycle = SimpleNamespace(evaluate_pair=Mock(return_value={
            "state": "ready", "complete": True, "findings": [],
        }))
        clean = [({"state": "clean", "complete": True,
                   "context": {"request_id": request_id}}, {})
                 for request_id in (101, 102)]

        with (patch.object(release, "owner_token", return_value="owner-token") as owner,
              patch.object(release, "api", return_value=variable) as native,
              patch.object(release, "shared_lifecycle", return_value=lifecycle),
              patch.object(release, "evaluate_shared_review", side_effect=clean),
              patch.object(release, "_carried_shared_findings", return_value=([], [], []))):
            release._recheck_shared_reviews(REPO, context)

        owner.assert_called_once_with(REPO)
        native.assert_called_once_with(endpoint, token="owner-token")

    def test_mismatched_checkpoint_endpoint_fails_before_owner_auth_or_native_get(self):
        context, _variable = self.context(
            f"repos/another/repo/actions/variables/FORK_ACCEPTED_BASELINE")

        with (patch.object(release, "owner_token") as owner,
              patch.object(release, "api") as native,
              self.assertRaisesRegex(ValueError, "different native repository variable")):
            release._recheck_shared_reviews(REPO, context)

        owner.assert_not_called()
        native.assert_not_called()

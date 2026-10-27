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
            ("scripts/maintenance.py", True), ("scripts/maintenance.lock.json", True),
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
            "patches/0009-fix.patch\nscripts/maintenance.py",
            "patches/0009-fix.patch\nscripts/maintenance.lock.json",
        ):
            with (self.subTest(changed=changed),
                  patch.object(release, "run", side_effect=["", "", "", CONFIG, changed]),
                  self.assertRaises(ValueError)):
                release.repair_changes(STATE)

    def test_symlinks_and_policy_deletion_are_rejected(self):
        for path in ("scripts/release.py", "scripts/maintenance.py", "scripts/maintenance.lock.json"):
            for entry in ("", "120000 blob " + HEAD + "\t" + path):
                with (self.subTest(path=path, entry=entry), patch.object(release, "run",
                      side_effect=["", "", "", CONFIG, path, entry]),
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

    def test_policy_repair_prompt_allows_the_public_loader_and_its_lock(self):
        prompt = release.repair_text(STATE, 43, "policy validation failure")
        self.assertIn("`README.md`", prompt)
        self.assertIn("`scripts/maintenance.py`", prompt)
        self.assertIn("`scripts/maintenance.lock.json`", prompt)
        self.assertIn("Do not mix release-policy and application repairs", prompt)

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

    def test_patch_tests_count_preserved_historical_files_without_weakening_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate_root = root / "candidate"
            patch_root = root / "patches"
            (candidate_root / "patches").mkdir(parents=True)
            patch_root.mkdir()
            (patch_root / "0001-fix.patch").write_text("fixture patch", encoding="utf-8")
            manifest_path = candidate_root / "patches/source.json"
            historical = "tests/unit/historical.test.js"
            added = "tests/unit/new-patch.test.js"
            touched = {historical, added}

            def validate(baseline, candidate):
                manifest_path.write_text(json.dumps(candidate), encoding="utf-8")
                with (patch.object(release, "_shared_file",
                                   return_value=json.dumps(baseline).encode("utf-8")),
                      patch.object(release, "patch_regressions", return_value=touched)):
                    release._validate_regression_manifest(REPO, CONFIG, candidate_root, patch_root)

            preserved = {
                "schema": 1,
                "test_files": [historical],
                "regression_files": [added],
            }
            validate(preserved, preserved)

            no_added_regression = {
                "schema": 1,
                "test_files": [historical],
                "regression_files": [],
            }
            with self.assertRaisesRegex(ValueError, "omits tests added by its ordered patches"):
                validate(no_added_regression, no_added_regression)

            overlapping = {**preserved, "regression_files": [historical, added]}
            with self.assertRaisesRegex(ValueError, "must remain disjoint"):
                validate(no_added_regression, overlapping)

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
    def test_policy_bundle_reuse_is_bound_for_allowed_final_decisions(self):
        candidate = {"schema": 1, "application_sha": HEAD}
        candidate_id = "f" * 64
        full = {"number": 3}
        proof = {"decision": "reuse-policy-validation", "candidate_id": candidate_id,
                 "manifest_sha256": "a" * 64}

        for decision in ("allow", "policy-only", "already-validated"):
            with self.subTest(decision=decision), \
                    patch.object(release, "_validated_policy_bundle", return_value=proof) as validate:
                self.assertEqual(release._policy_bundle_for_final_decision(
                    REPO, candidate, candidate_id, full, decision), proof)
                validate.assert_called_once_with(REPO, candidate, full)

        for wrong_proof in (
                {**proof, "candidate_id": "0" * 64},
                {**proof, "manifest_sha256": "invalid"},
        ):
            with self.subTest(wrong_proof=wrong_proof), \
                    patch.object(release, "_validated_policy_bundle", return_value=wrong_proof), \
                    self.assertRaisesRegex(ValueError, "exact policy candidate"):
                release._policy_bundle_for_final_decision(
                    REPO, candidate, candidate_id, full, "allow")

        with patch.object(release, "_validated_policy_bundle") as validate:
            self.assertIsNone(release._policy_bundle_for_final_decision(
                REPO, candidate, candidate_id, full, "blocked"))
        validate.assert_not_called()

    def test_closed_review_pair_reuse_requires_an_allowed_decision_and_exact_bundle_proof(self):
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
        for decision in ("policy-only", "allow", "already-validated"):
            lifecycle.decision = decision
            with (self.subTest(decision=decision),
                  patch.object(release, "_final_history", return_value={"exact": True}) as history,
                  patch.object(release, "_validated_policy_bundle", return_value=proof) as validate):
                self.assertTrue(release._closed_policy_pair_has_verified_bundle(
                    REPO, lifecycle, candidate, candidate_id, baseline, full, delta))
            history.assert_called_once_with(REPO, {"repository": REPO, "baseline": baseline}, lifecycle)
            validate.assert_called_once_with(REPO, candidate, full)

        lifecycle.decision = "blocked"
        with (patch.object(release, "_final_history", return_value={"exact": True}),
              patch.object(release, "_validated_policy_bundle") as validate):
            self.assertFalse(release._closed_policy_pair_has_verified_bundle(
                REPO, lifecycle, candidate, candidate_id, baseline, full, delta))
        validate.assert_not_called()
        lifecycle.decision = "allow"
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
            (trusted / "scripts/maintenance.py").write_text("pass\n")
            trusted_private_module = b"trusted baseline private module"
            maintenance_lock = {
                "schema": 1, "repository": "warelik/machine-maintenance",
                "revision": "a" * 40,
                "module_sha256": hashlib.sha256(trusted_private_module).hexdigest(),
                "api_version": 1,
            }
            (trusted / "scripts/maintenance.lock.json").write_text(
                json.dumps(maintenance_lock))
            (trusted / "patches/source.json").write_text("{}\n")
            (trusted / ".github/workflows/release.yml").write_text("jobs: {}\n")

            candidate = root / "candidate"
            candidate_scripts = candidate / "scripts"
            candidate_scripts.mkdir(parents=True)
            (candidate_scripts / "release.py").write_text("pass\n")
            (candidate_scripts / "test_baseline.py").write_text("pass\n")
            (candidate_scripts / "test_candidate.py").write_text("raise RuntimeError('private source')\n")
            candidate_lock = {**maintenance_lock, "revision": "c" * 40,
                              "module_sha256": "d" * 64}
            (candidate_scripts / "maintenance.lock.json").write_text(json.dumps(candidate_lock))
            baseline_private = root / "private-maintenance-baseline"
            baseline_private.mkdir()
            baseline_module = baseline_private / "fork_lifecycle.py"
            baseline_module.write_bytes(trusted_private_module)
            (baseline_private / ".maintenance-source.json").write_text(json.dumps({
                "repository": maintenance_lock["repository"],
                "revision": maintenance_lock["revision"],
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
                "NINEROUTER_POLICY_BASELINE_MAINTENANCE": str(baseline_private),
                "FORK_MAINTENANCE_ROOT": str(root / "private-maintenance"),
                "GITHUB_ACTIONS": "true",
                "TMPDIR": str(root),
            }
            baseline_module.write_bytes(b"wrong baseline private module")
            with (patch.object(release, "ROOT", trusted), patch.dict(os.environ, env, clear=True),
                  patch.object(release, "yaml_module", return_value=yaml),
                  patch.object(release, "_candidate_private_lifecycle",
                               return_value=(b"private module", b"private receipt")),
                  self.assertRaisesRegex(ValueError, "baseline private checkout source differs")):
                release.check_policy_shared(candidate)
            baseline_module.write_bytes(trusted_private_module)

            with (patch.object(release, "ROOT", trusted), patch.dict(os.environ, env, clear=True),
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
        self.assertNotIn("baseline_launcher=", launcher)
        self.assertNotIn("baseline=subprocess.run(", launcher)
        self.assertIn("sys.path[:0]=[str(candidate),str(oracle)]", launcher)
        self.assertIn("import release", launcher)
        candidate_import = launcher.index("import release")
        self.assertLess(launcher.index("sys.path[:0]=[str(candidate),str(oracle)]"), candidate_import)
        self.assertIn("oracle_tests=sorted(oracle.glob('test_*.py'))", launcher)
        self.assertIn("candidate_tests=[pathlib.Path(p) for p in sys.argv[4:-1]]", launcher)
        self.assertLess(candidate_import, launcher.index("oracle_tests=sorted(oracle.glob('test_*.py'))"))
        self.assertLess(candidate_import, launcher.index("candidate_tests=[pathlib.Path(p)"))
        self.assertIn("unittest.TestSuite([load(oracle_tests,'immutable_a'),load(candidate_tests,'candidate_b')])",
                      launcher)
        self.assertIn("result.testsRun", launcher)
        self.assertIn("completion.write_text", launcher)
        self.assertLess(launcher.index("result=runner.run(suite)"),
                        launcher.index("completion.write_text"))
        self.assertEqual(Path(args[-2]).name, "test_candidate.py")
        self.assertEqual(Path(args[-1]).name, "policy-suite-completion.json")

    def test_shared_hosted_policy_requires_baseline_pin(self):
        with (patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=True),
              self.assertRaisesRegex(ValueError, "exact trusted baseline pin")):
            release.check_policy_shared(Path("unused-candidate"))

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


class NativeMarkerAuthorizationTests(unittest.TestCase):
    timestamp = "2026-10-19T10:00:00Z"

    def comment(self, native_id, body, user):
        return {"id": native_id, "created_at": self.timestamp, "updated_at": self.timestamp,
                "user": user, "body": body}

    def test_policy_history_filters_foreign_markers_before_json_parsing(self):
        candidate = {
            "schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
            "application_sha": HEAD, "configuration_sha": CONFIG,
            "patchset_sha256": "e" * 64, "recipe_sha256": "f" * 64,
            "platform": "linux/amd64",
        }
        candidate_id, workflow_sha, trusted_policy = "a" * 64, HEAD, CONFIG
        payload = {
            "schema": 1, "candidate_id": candidate_id, "run_id": 90,
            "run_attempt": 2, "workflow_sha": workflow_sha,
            "trusted_policy_sha": trusted_policy,
        }
        candidate_marker = "<!-- fork-candidate:v1 " + release._candidate_json(candidate) + " -->"
        policy_marker = "<!-- fork-policy-validation:v1 " + json.dumps(
            payload, separators=(",", ":")) + " -->"
        valid_body = candidate_marker + "\n" + policy_marker
        contributor = {"login": "contributor", "type": "User", "id": 1001}
        owner = {"login": "warelik", "type": "User", "id": 1002}
        workflow_bot = {"login": "github-actions[bot]", "type": "Bot", "id": 41898282}
        foreign_markers = [
            self.comment(101, "<!-- fork-policy-validation:v1 {malformed} -->", contributor),
            self.comment(102, valid_body, contributor),
            self.comment(103, valid_body, owner),
        ]
        trusted = self.comment(104, valid_body, workflow_bot)
        native_run = {"id": 90, "run_attempt": 2, "path": ".github/workflows/release.yml"}
        job = {"id": 901, "name": release.SHARED_POLICY_JOB, "status": "completed",
               "conclusion": "success", "started_at": self.timestamp,
               "steps": [{"name": "complete", "status": "completed", "conclusion": "success"}]}
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: candidate_id)

        for foreign in foreign_markers:
            with self.subTest(foreign_id=foreign["id"]), \
                    patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]), \
                    patch.object(release, "_shared_review_comments", return_value=[foreign, trusted]), \
                    patch.object(release, "api", return_value=native_run) as native, \
                    patch.object(release, "_native_workflow_source") as source, \
                    patch.object(release, "_native_attempt_jobs", return_value=([job], "jobs-endpoint")):
                history = release._policy_validation_history(
                    REPO, candidate, lifecycle, trusted_policy_sha=trusted_policy,
                    workflow_sha=workflow_sha)
            self.assertEqual(history["state"], "verified")
            self.assertEqual(history["record"]["reservation"]["id"], trusted["id"])
            native.assert_called_once_with(f"repos/{REPO}/actions/runs/90/attempts/2")
            source.assert_called_once_with(REPO, native_run, workflow_sha)

    def test_malformed_trusted_policy_marker_still_fails_closed(self):
        candidate = {"schema": 1, "repository": REPO}
        bot = {"login": "github-actions[bot]", "type": "Bot", "id": 41898282}
        malformed = self.comment(110, "<!-- fork-policy-validation:v1 {malformed} -->", bot)
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: "a" * 64)
        with (patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
              patch.object(release, "_shared_review_comments", return_value=[malformed]),
              patch.object(release, "api", side_effect=AssertionError("must fail before run lookup")),
              self.assertRaises(ValueError)):
            release._policy_validation_history(
                REPO, candidate, lifecycle, trusted_policy_sha=CONFIG, workflow_sha=HEAD)

    def test_authorized_final_marker_comments_keep_owner_bot_and_native_metadata(self):
        body = '<!-- fork-final:v1 {"run_id":1,"run_attempt":1} -->'
        owner = self.comment(120, body, {"login": "warelik", "type": "User", "id": 1002})
        bot = self.comment(121, body, {"login": "github-actions[bot]", "type": "Bot", "id": 41898282})
        foreign = self.comment(122, "<!-- fork-final:v1 {malformed} -->",
                               {"login": "contributor", "type": "User", "id": 1001})
        accepted = release._authorized_final_marker_comments(
            [foreign, owner, bot], REPO, "fork-final:v1", allow_workflow_bot=True)
        self.assertEqual([item["id"] for item in accepted], [owner["id"], bot["id"]])
        policy_only = release._authorized_final_marker_comments(
            [owner, bot], REPO, "fork-final:v1", allow_workflow_bot=True, allow_owner=False)
        self.assertEqual(policy_only, [bot])

        for invalid in (
                {"id": True}, {"id": False}, {"id": None}, {"id": "120"},
                {"id": 0}, {"id": -1},
                {"created_at": "not-a-timestamp", "updated_at": "not-a-timestamp"},
                {"created_at": "2026-10-19T10:00:00", "updated_at": "2026-10-19T10:00:00"},
                {"created_at": self.timestamp, "updated_at": "2026-10-19T10:01:00Z"}):
            bad = {**bot, **invalid}
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                release._authorized_final_marker_comments(
                    [bad], REPO, "fork-final:v1", allow_workflow_bot=True)


class WorkflowTransitionEvidenceTests(unittest.TestCase):
    timestamp = "2026-10-20T06:00:00Z"

    @staticmethod
    def _candidate_identity(candidate):
        canonical = json.dumps(candidate, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    @staticmethod
    def _comment_pull_number(path):
        route = path.split("?", 1)[0]
        parts = route.split("/")
        if len(parts) < 2 or parts[-1] != "comments":
            raise AssertionError(f"Unexpected issue-comment route: {path}")
        return int(parts[-2])

    def comment(self, native_id, body, user):
        return {"id": native_id, "created_at": self.timestamp,
                "updated_at": self.timestamp, "user": user, "body": body}

    def setUp(self):
        self.candidate_id = "a" * 64
        self.candidate = {
            "schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
            "application_sha": HEAD, "configuration_sha": CONFIG,
            "patchset_sha256": "e" * 64, "recipe_sha256": "f" * 64,
            "platform": "linux/amd64",
        }
        self.parent = "9" * 40
        self.payload = {
            "schema": 1, "candidate_id": self.candidate_id, "run_id": 90,
            "run_attempt": 2, "workflow_sha": self.parent,
            "trusted_policy_sha": self.parent,
        }
        body = (
            "<!-- fork-candidate:v1 " + release._candidate_json(self.candidate) + " -->\n"
            "<!-- fork-policy-validation:v1 " + json.dumps(self.payload, separators=(",", ":")) + " -->")
        self.comment_record = {
            "id": 901, "created_at": self.timestamp, "updated_at": self.timestamp,
            "user": {"login": "github-actions[bot]", "type": "Bot"}, "body": body,
        }
        self.run = {
            "id": 90, "run_attempt": 2, "head_sha": self.parent,
            "path": ".github/workflows/release.yml", "status": "completed",
            "conclusion": "failure",
        }
        self.private_lock = {
            "schema": 1, "repository": "warelik/machine-maintenance",
            "revision": "c" * 40, "module_sha256": "d" * 64, "api_version": 1,
        }
        self.private_lock_bytes = json.dumps(
            self.private_lock, sort_keys=True, separators=(",", ":")).encode()
        self.policy_job = {
            "id": 9010, "name": release.SHARED_POLICY_JOB, "status": "completed",
            "conclusion": "success", "started_at": self.timestamp,
            "steps": [
                {"name": "Read The Candidate Private Module Pin", "status": "completed",
                 "conclusion": "success"},
                {"name": "Read The Trusted Baseline Private Module Pin", "status": "completed",
                 "conclusion": "success"},
                {"name": "Checkout The Trusted Baseline Private Module", "status": "completed",
                 "conclusion": "skipped", "started_at": self.timestamp,
                 "completed_at": self.timestamp},
                {"name": "Record The Exact Trusted Baseline Private Checkout Receipt",
                 "status": "completed", "conclusion": "skipped",
                 "started_at": self.timestamp, "completed_at": self.timestamp},
                {"name": "Enforce Trusted Tests And Validate Proposed YAML",
                 "status": "completed", "conclusion": "success"},
            ],
        }
        self.jobs = [
            self.policy_job,
            {"name": "Test The Historical Application Contracts", "status": "completed",
             "conclusion": "skipped", "started_at": "2026-10-20T06:00:02Z",
             "completed_at": "2026-10-20T06:00:01Z", "steps": []},
            {"name": "Build And Smoke Test One Container", "status": "completed",
             "conclusion": "skipped", "started_at": "2026-10-20T06:00:02Z",
             "completed_at": "2026-10-20T06:00:01Z", "steps": []},
        ]
        self.record = {
            "run": self.run, "marker": self.payload, "reservation": self.comment_record,
        }
        self.lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: self.candidate_id)

    def test_transition_replays_parent_policy_pass_after_late_publish_failure(self):
        history = {"state": "verified", "record": self.record}
        baseline_lock = {**self.private_lock, "revision": self.parent,
                         "module_sha256": "e" * 64}
        for same_private_revision in (True, False):
            with self.subTest(same_private_revision=same_private_revision):
                baseline_lock_for_case = (self.private_lock if same_private_revision
                                          else baseline_lock)
                steps = [dict(step) for step in self.policy_job["steps"]]
                for step in steps:
                    if step["name"] in {
                            "Checkout The Trusted Baseline Private Module",
                            "Record The Exact Trusted Baseline Private Checkout Receipt"}:
                        step["conclusion"] = "skipped" if same_private_revision else "success"
                        if not same_private_revision:
                            step["started_at"] = self.timestamp
                jobs = [{**self.policy_job, "steps": steps}, *self.jobs[1:]]
                with (patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
                      patch.object(release, "_shared_review_comments", return_value=[self.comment_record]),
                      patch.object(release, "_policy_validation_history", return_value=history) as proof,
                      patch.object(release, "_native_attempt_jobs", return_value=(jobs, "jobs-endpoint")),
                      patch.object(release, "_shared_file", side_effect=[
                          self.private_lock_bytes,
                          json.dumps(baseline_lock_for_case, sort_keys=True,
                                     separators=(",", ":")).encode()])):
                    receipt = release._transition_policy_receipt(
                        REPO, self.candidate, self.parent, self.lifecycle)
                proof.assert_called_once_with(
                    REPO, self.candidate, self.lifecycle,
                    trusted_policy_sha=self.parent, workflow_sha=self.parent)
                self.assertEqual(receipt, {
                    "candidate_id": self.candidate_id, "source": "native-run", "verified": True,
                    "run_id": 90, "run_attempt": 2, "reservation_id": 901,
                    "workflow_sha": self.parent, "trusted_policy_sha": self.parent,
                })
        mismatched_pin = {**self.private_lock, "revision": self.parent,
                          "module_sha256": "e" * 64}
        with (patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
              patch.object(release, "_shared_review_comments", return_value=[self.comment_record]),
              patch.object(release, "_policy_validation_history",
                           return_value={"state": "verified", "record": self.record}),
              patch.object(release, "_native_attempt_jobs", return_value=(self.jobs, "jobs-endpoint")),
              patch.object(release, "_shared_file", side_effect=[
                  self.private_lock_bytes,
                  json.dumps(mismatched_pin, sort_keys=True, separators=(",", ":")).encode()]),
              self.assertRaisesRegex(ValueError, "wrong baseline-private checkout path")):
            release._transition_policy_receipt(
                REPO, self.candidate, self.parent, self.lifecycle)

    def test_transition_receipt_refuses_a_failed_policy_step_or_started_heavy_job(self):
        history = {"state": "verified", "record": self.record}
        failed_steps = [dict(step) for step in self.policy_job["steps"]]
        failed_policy_step = next(
            step for step in failed_steps
            if step["name"] == "Enforce Trusted Tests And Validate Proposed YAML")
        failed_policy_step["conclusion"] = "failure"
        failed_policy_job = {**self.policy_job, "steps": failed_steps}
        for jobs in (
                [failed_policy_job, *self.jobs[1:]],
                [self.policy_job, {**self.jobs[1], "started_at": self.timestamp,
                                   "steps": [{"name": "test", "status": "completed",
                                              "conclusion": "success"}]}, self.jobs[2]],
        ):
            with (patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
                  patch.object(release, "_shared_review_comments", return_value=[self.comment_record]),
                  patch.object(release, "_policy_validation_history", return_value=history),
                  patch.object(release, "_native_attempt_jobs", return_value=(jobs, "jobs-endpoint")),
                  patch.object(release, "_shared_file", return_value=self.private_lock_bytes),
                  self.assertRaisesRegex(ValueError, "mandatory step|heavy application job")):
                release._transition_policy_receipt(
                    REPO, self.candidate, self.parent, self.lifecycle)

    def test_transition_receipt_requires_each_exact_conditional_baseline_private_step(self):
        history = {"state": "verified", "record": self.record}
        for missing in ("Checkout The Trusted Baseline Private Module",
                        "Record The Exact Trusted Baseline Private Checkout Receipt"):
            with self.subTest(missing=missing):
                steps = [step for step in self.policy_job["steps"] if step["name"] != missing]
                jobs = [{**self.policy_job, "steps": steps}, *self.jobs[1:]]
                with (patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
                      patch.object(release, "_shared_review_comments", return_value=[self.comment_record]),
                      patch.object(release, "_policy_validation_history", return_value=history),
                      patch.object(release, "_native_attempt_jobs", return_value=(jobs, "jobs-endpoint")),
                      patch.object(release, "_shared_file", return_value=self.private_lock_bytes),
                      self.assertRaisesRegex(
                          ValueError, "omitted an exact conditional baseline-private step")):
                    release._transition_policy_receipt(
                        REPO, self.candidate, self.parent, self.lifecycle)

    def test_transition_retry_uses_only_post_pin_h_runs_and_excludes_current_run(self):
        pin_updated_at = "2026-10-20T06:00:00Z"
        current_stale = {
            "id": 90, "head_sha": HEAD, "head_branch": "downstream",
            "event": "workflow_dispatch", "path": ".github/workflows/release.yml",
            "created_at": "2026-10-20T06:00:02Z", "run_attempt": 1,
        }
        safe_next = {
            "id": 91, "head_sha": HEAD, "head_branch": "downstream",
            "event": "push", "path": ".github/workflows/release.yml",
            "created_at": "2026-10-20T06:00:01Z", "run_attempt": 1,
            "status": "queued",
        }
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90"}),
              patch.object(release, "_workflow_run_records",
                           return_value=([current_stale, safe_next], True)),
              patch.object(release, "_native_workflow_source") as source,
              patch.object(release, "api", side_effect=AssertionError("fresh H run already exists"))):
            selected = release._ensure_native_workflow_transition_run(
                REPO, HEAD, trusted_pin_updated_at=pin_updated_at)
        self.assertEqual(selected, safe_next)
        source.assert_called_once_with(REPO, safe_next, HEAD)

    def test_transition_retry_dispatches_after_stale_self_run_but_refuses_consumed_attempts(self):
        pin_updated_at = "2026-10-20T06:00:00Z"
        stale = {
            "id": 91, "head_sha": HEAD, "head_branch": "downstream",
            "event": "push", "path": ".github/workflows/release.yml",
            "created_at": "2026-10-20T05:59:59Z", "run_attempt": 1,
            "status": "completed", "conclusion": "failure",
        }
        calls = []

        def dispatch(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            return None

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90"}),
              patch.object(release, "_workflow_run_records", return_value=([stale], True)),
              patch.object(release, "_native_workflow_source"),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=dispatch)):
            self.assertIsNone(release._ensure_native_workflow_transition_run(
                REPO, HEAD, trusted_pin_updated_at=pin_updated_at))
        self.assertEqual(calls, [(
            f"repos/{REPO}/actions/workflows/release.yml/dispatches", "POST",
            {"ref": "downstream"}, "fixture-owner")])

        for evidence in ("heavy", "final"):
            safe_shape = {**stale, "id": 92,
                          "created_at": "2026-10-20T06:00:01Z"}
            calls.clear()
            jobs = [{"name": "Test The Historical Application Contracts",
                     "started_at": "2026-10-20T06:00:02Z", "steps": [{"name": "test"}]}]
            comments = []
            if evidence == "final":
                jobs = [{"name": release.SHARED_POLICY_JOB, "status": "completed",
                         "conclusion": "skipped", "steps": []}]
                marker = {"run_id": 92, "run_attempt": 1}
                comments = [{"id": 902, "created_at": self.timestamp,
                             "updated_at": self.timestamp,
                             "user": {"login": "github-actions[bot]", "type": "Bot"},
                             "body": "<!-- fork-final:v1 " + json.dumps(marker) + " -->"}]
            with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90"}),
                  patch.object(release, "_workflow_run_records", return_value=([safe_shape], True)),
                  patch.object(release, "_native_workflow_source"),
                  patch.object(release, "_native_attempt_jobs", return_value=(jobs, "jobs")),
                  patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
                  patch.object(release, "_shared_review_comments", return_value=comments),
                  patch.object(release, "api", side_effect=dispatch)):
                selected = release._ensure_native_workflow_transition_run(
                    REPO, HEAD, trusted_pin_updated_at=pin_updated_at)
            self.assertEqual(selected, safe_shape)
            self.assertEqual(calls, [], evidence)

    def test_transition_retry_treats_timestamped_skipped_heavy_jobs_as_unstarted(self):
        pin_updated_at = "2026-10-20T06:00:00Z"
        safe_run = {
            "id": 92, "head_sha": HEAD, "head_branch": "downstream",
            "event": "push", "path": ".github/workflows/release.yml",
            "created_at": "2026-10-20T06:00:01Z", "run_attempt": 1,
            "status": "completed", "conclusion": "failure",
        }
        jobs = [
            {"name": release.SHARED_POLICY_JOB, "status": "completed",
             "conclusion": "success", "started_at": "2026-10-20T06:00:01Z", "steps": []},
            {"name": "Test The Historical Application Contracts", "status": "completed",
             "conclusion": "skipped", "started_at": "2026-10-20T06:00:02Z",
             "completed_at": "2026-10-20T06:00:01Z", "steps": []},
            {"name": "Build And Smoke Test One Container", "status": "completed",
             "conclusion": "skipped", "started_at": "2026-10-20T06:00:02Z",
             "completed_at": "2026-10-20T06:00:01Z", "steps": []},
        ]
        calls = []

        def dispatch(path, *, method="GET", data=None, token=None):
            calls.append((path, method, data, token))
            return None

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90"}),
              patch.object(release, "_workflow_run_records", return_value=([safe_run], True)),
              patch.object(release, "_native_workflow_source"),
              patch.object(release, "_native_attempt_jobs", return_value=(jobs, "jobs")),
              patch.object(release, "_all_shared_review_pulls", return_value=[{"number": 7}]),
              patch.object(release, "_shared_review_comments", return_value=[]),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=dispatch)):
            selected = release._ensure_native_workflow_transition_run(
                REPO, HEAD, trusted_pin_updated_at=pin_updated_at)
        self.assertIsNone(selected)
        self.assertEqual(calls, [(
            f"repos/{REPO}/actions/workflows/release.yml/dispatches", "POST",
            {"ref": "downstream"}, "fixture-owner")])

    def test_transition_candidate_scan_ignores_unrelated_historical_review_prose(self):
        candidate_id = self.candidate_id
        full_sha, delta_base = "1" * 40, SEED
        marker = lambda scope, review_sha, base_sha: (
            "<!-- fork-review:v1 " + json.dumps({
                "schema": 1, "candidate_id": candidate_id, "scope": scope,
                "review_sha": review_sha, "base_sha": base_sha,
            }, separators=(",", ":")) + " -->")

        def request(scope, review_sha, base_sha):
            body = (
                f"Exact candidate `{candidate_id}`; scope `{scope}`; "
                f"source `{review_sha}`; base `{base_sha}`.\n"
                f"Upstream: `{release.UPSTREAM}@{UPSTREAM}`. Application: `{HEAD}`. "
                f"Configuration: `{CONFIG}`. Patches: `{'e' * 64}`. "
                f"Container recipe: `{'f' * 64}`; platform: `linux/amd64`\n\n"
                + marker(scope, review_sha, base_sha))
            return {"id": 100 if scope == "delta" else 101, "created_at": self.timestamp,
                    "updated_at": self.timestamp,
                    "user": {"login": "warelik", "type": "User"}, "body": body}

        delta_pull = {
            "number": 12, "state": "open",
            "head": {"ref": f"review/changes-{CONFIG}", "sha": CONFIG,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{delta_base}", "sha": delta_base,
                     "repo": {"full_name": REPO}},
        }
        full_pull = {
            "number": 13, "state": "open",
            "head": {"ref": f"review/{UPSTREAM}-{candidate_id}", "sha": full_sha,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{UPSTREAM}", "sha": UPSTREAM,
                     "repo": {"full_name": REPO}},
        }
        historical_delta = {
            "number": 14, "state": "closed",
            "head": {"ref": f"review/changes-{'2' * 40}", "sha": "2" * 40,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{'3' * 40}", "sha": "3" * 40,
                     "repo": {"full_name": REPO}},
        }
        historical_full = {
            "number": 15, "state": "closed",
            "head": {"ref": f"review/{'4' * 40}-{'5' * 64}", "sha": "6" * 40,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{'4' * 40}", "sha": "4" * 40,
                     "repo": {"full_name": REPO}},
        }
        comments = {
            12: [request("delta", CONFIG, delta_base)],
            13: [request("full", full_sha, UPSTREAM)],
            14: [{"id": 114, "created_at": self.timestamp, "updated_at": self.timestamp,
                  "user": {"login": "warelik", "type": "User"},
                  "body": marker("delta", "2" * 40, "3" * 40)
                  + " Old bootstrap review prompt with a different native format."}],
            15: [{"id": 115, "created_at": self.timestamp, "updated_at": self.timestamp,
                  "user": {"login": "warelik", "type": "User"},
                  "body": marker("full", "6" * 40, "4" * 40)
                  + " Old bootstrap review prompt with a different native format."}],
        }
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: candidate_id)
        calls = []

        def native_pages(path):
            number = self._comment_pull_number(path)
            calls.append(number)
            return comments[number]

        with (patch.object(release, "_all_shared_review_pulls",
                           return_value=[historical_full, historical_delta, full_pull, delta_pull]),
              patch.object(release, "pages", side_effect=native_pages)):
            result = release._transition_review_candidates(REPO, CONFIG, lifecycle)
        self.assertEqual([item["pull"]["number"] for item in (result[0]["full"], result[0]["delta"])],
                         [13, 12])
        self.assertEqual(sorted(calls), [12, 13])

    def _open_candidate_pair(self, *, application_only=False, delta_head_sha=None):
        candidate = dict(self.candidate)
        accepted_config = CONFIG if application_only else SEED
        accepted_application = SEED if application_only else HEAD
        if application_only:
            candidate["configuration_sha"] = accepted_config
        candidate_id = self._candidate_identity(candidate)
        full_sha = "1" * 40
        if candidate["configuration_sha"] == accepted_config:
            delta_sha = candidate["application_sha"]
            delta_base = accepted_application
        else:
            delta_sha = candidate["configuration_sha"]
            delta_base = accepted_config

        def owner_request(number, scope, review_sha, base_sha):
            return {
                "id": number, "created_at": self.timestamp, "updated_at": self.timestamp,
                "user": {"login": "warelik", "type": "User"},
                "body": release.shared_review_text(
                    candidate, scope, review_sha, base_sha, candidate_id),
            }

        full_pull = {
            "number": 13, "state": "open",
            "head": {"ref": f"review/{UPSTREAM}-{candidate_id}", "sha": full_sha,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{UPSTREAM}", "sha": UPSTREAM,
                     "repo": {"full_name": REPO}},
        }
        delta_pull = {
            "number": 12, "state": "open",
            "head": {"ref": f"review/changes-{delta_sha}",
                     "sha": delta_sha if delta_head_sha is None else delta_head_sha,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{delta_base}", "sha": delta_base,
                     "repo": {"full_name": REPO}},
        }
        comments = {
            13: [owner_request(101, "full", full_sha, UPSTREAM)],
            12: [owner_request(100, "delta", delta_sha, delta_base)],
        }
        baseline = {
            "schema": 1, "repository": REPO,
            "configuration_sha": accepted_config, "application_sha": accepted_application,
        }
        return candidate, baseline, [full_pull, delta_pull], comments

    def test_pending_pair_retains_config_and_application_delta_candidates(self):
        for application_only in (False, True):
            with self.subTest(application_only=application_only):
                candidate, baseline, pulls, comments = self._open_candidate_pair(
                    application_only=application_only)
                lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)

                def native_pages(path):
                    number = self._comment_pull_number(path)
                    return comments[number]

                with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                      patch.object(release, "pages", side_effect=native_pages)):
                    result = release._transition_review_candidates(
                        REPO, CONFIG, lifecycle, accepted_baseline=baseline)
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["candidate"], candidate)
                self.assertEqual(result[0]["full"]["request_id"], 101)
                self.assertEqual(result[0]["delta"]["request_id"], 100)

                stale_baseline = {**baseline, "configuration_sha": "f" * 40}
                with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                      patch.object(release, "pages", side_effect=native_pages)):
                    if application_only:
                        with self.assertRaisesRegex(
                                ValueError, "Transition review request no longer identifies its exact native PR"):
                            release._transition_review_candidates(
                                REPO, CONFIG, lifecycle, accepted_baseline=stale_baseline)
                    else:
                        stale = release._transition_review_candidates(
                            REPO, CONFIG, lifecycle, accepted_baseline=stale_baseline)
                        self.assertEqual(
                            stale, [], "A pair for an obsolete accepted baseline must not be retained")
                if application_only:
                    stale_application = {**baseline, "application_sha": "f" * 40}
                    with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                          patch.object(release, "pages", side_effect=native_pages)):
                        stale_source = release._transition_review_candidates(
                            REPO, CONFIG, lifecycle, accepted_baseline=stale_application)
                    self.assertEqual(stale_source, [],
                                     "An application-only pair must be invalidated by an accepted-source advance")

                with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                      patch.object(release, "pages", side_effect=native_pages)):
                    stale_config = release._transition_review_candidates(
                        REPO, "f" * 40, lifecycle, accepted_baseline=baseline)
                self.assertEqual(stale_config, [], "A pair for an obsolete downstream config must not be retained")

                if application_only:
                    with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                          patch.object(release, "pages", side_effect=native_pages)):
                        published = release._transition_review_candidates(
                            REPO, CONFIG, lifecycle, accepted_baseline=candidate)
                    self.assertEqual(published, [], "An already published exact candidate must not be retained")

                moved = [pulls[0], {**pulls[1], "head": {**pulls[1]["head"], "sha": "2" * 40}}]
                with (patch.object(release, "_open_shared_review_pulls", return_value=moved),
                      patch.object(release, "pages", side_effect=native_pages),
                      self.assertRaisesRegex(ValueError, "no longer identifies its exact native PR")):
                    release._transition_review_candidates(
                        REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_full_only_pending_candidate_is_retained_after_delta_request_interruption(self):
        candidate, baseline, pulls, comments = self._open_candidate_pair()
        other = {**candidate, "upstream_sha": "8" * 40}
        comments[12] = [{
            "id": 99, "created_at": "2026-10-20T05:00:00Z",
            "updated_at": "2026-10-20T05:00:00Z",
            "user": {"login": "warelik", "type": "User"},
            "body": release.shared_review_text(
                other, "delta", candidate["configuration_sha"],
                baseline["configuration_sha"], self._candidate_identity(other)),
        }]
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)

        def native_pages(path):
            return comments[self._comment_pull_number(path)]

        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=native_pages),
              patch.object(release, "_exact_review_pull", return_value=pulls[1]) as exact):
            retained = release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0]["candidate"], candidate)
        self.assertEqual(retained[0]["full"]["request_id"], 101)
        self.assertIsNone(retained[0]["delta"])
        self.assertEqual(retained[0]["delta_pull"], pulls[1])
        exact.assert_called_once_with(
            REPO, head_ref=pulls[1]["head"]["ref"], head_sha=pulls[1]["head"]["sha"],
            base_ref=pulls[1]["base"]["ref"], base_sha=pulls[1]["base"]["sha"])

        closed = {**pulls[1], "state": "closed"}
        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=native_pages),
              patch.object(release, "_exact_review_pull", return_value=closed),
              self.assertRaisesRegex(ValueError, "closed exact delta review PR")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

        with (patch.object(release, "_open_shared_review_pulls", return_value=[pulls[0]]),
              patch.object(release, "pages", side_effect=native_pages),
              patch.object(release, "_exact_review_pull", return_value=None)):
            absent = release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)
        self.assertEqual(len(absent), 1)
        self.assertIsNone(absent[0]["delta_pull"])

    def test_pending_pair_fails_closed_on_duplicate_or_mismatched_active_source(self):
        candidate, baseline, pulls, comments = self._open_candidate_pair()
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)
        duplicate_full = {**pulls[0], "number": 14}
        duplicate_comments = {
            **comments,
            14: [{**comments[13][0], "id": 102}],
        }

        def duplicate_pages(path):
            return duplicate_comments[self._comment_pull_number(path)]

        with (patch.object(release, "_open_shared_review_pulls",
                           return_value=[*pulls, duplicate_full]),
              patch.object(release, "pages", side_effect=duplicate_pages),
              self.assertRaisesRegex(ValueError, "Multiple open full PRs")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_ordinary_candidate_discovery_fetches_open_review_heads_only(self):
        common = {
            "number": 13, "head": {"ref": "moved-head", "repo": {"full_name": REPO}},
            "base": {"ref": "review-base/moved", "repo": {"full_name": REPO}},
            "user": {"login": "warelik", "type": "User"},
        }
        open_pull = {**common, "state": "open"}
        closed_pull = {**common, "number": 14, "state": "closed"}
        with patch.object(release, "pages", return_value=[closed_pull, open_pull]) as pages:
            result = release._open_shared_review_pulls(REPO)
        pages.assert_called_once_with(f"repos/{REPO}/pulls?state=open")
        self.assertEqual(result, [open_pull])

    def test_exact_review_pull_fails_closed_when_existing_refs_moved(self):
        pull = {
            "number": 13, "state": "open",
            "head": {"ref": "review/head", "sha": "1" * 40,
                     "repo": {"full_name": REPO}},
            "base": {"ref": "review-base/base", "sha": "2" * 40,
                     "repo": {"full_name": REPO}},
        }
        with (patch.object(release, "pages", return_value=[pull]),
              self.assertRaisesRegex(ValueError, "refs changed")):
            release._exact_review_pull(
                REPO, head_ref="review/head", head_sha="3" * 40,
                base_ref="review-base/base", base_sha="2" * 40)

    def test_transition_refuses_canonical_request_without_candidate_text(self):
        candidate, _baseline, pulls, comments = self._open_candidate_pair()
        candidate_id = self._candidate_identity(candidate)
        full_sha = pulls[0]["head"]["sha"]
        comments[13][0]["body"] = release._review_marker(
            candidate_id, "full", full_sha, UPSTREAM)
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)

        def native_pages(path):
            return comments[self._comment_pull_number(path)]

        with (patch.object(release, "_all_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=native_pages),
              self.assertRaisesRegex(ValueError, "omits its exact canonical candidate identity")):
            release._transition_review_candidates(REPO, CONFIG, lifecycle)

        candidate, baseline, pulls, comments = self._open_candidate_pair()
        wrong_body = comments[12][0]["body"].replace(
            f"Exact candidate `{self._candidate_identity(candidate)}`",
            f"Exact candidate `{'0' * 64}`")
        mismatched_comments = {
            **comments,
            12: [{**comments[12][0],
                  "body": wrong_body}],
        }

        def mismatched_pages(path):
            return mismatched_comments[self._comment_pull_number(path)]

        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=mismatched_pages),
              self.assertRaisesRegex(ValueError, "review text differs from the exact candidate identity")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_open_abi_requests_recover_identity_from_the_exact_native_git_context(self):
        candidate, baseline, pulls, comments = self._open_candidate_pair()
        baseline["upstream_sha"] = UPSTREAM
        candidate_id = self._candidate_identity(candidate)
        for pull, scope in zip(pulls, ("full", "delta")):
            comment = comments[pull["number"]][0]
            comment["body"] = release._review_marker(
                candidate_id, scope, pull["head"]["sha"], pull["base"]["sha"])
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)
        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=lambda route:
                           comments[self._comment_pull_number(route)]),
              patch.object(release, "_pending_shared_ref_candidate",
                           return_value=candidate) as native_context):
            result = release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["candidate"], candidate)
        self.assertEqual(result[0]["full"]["request_id"], 101)
        self.assertEqual(result[0]["delta"]["request_id"], 100)
        self.assertEqual(native_context.call_count, 1)
        self.assertEqual(native_context.call_args.kwargs["review_ref"],
                         pulls[0]["head"]["ref"])
        self.assertEqual(native_context.call_args.kwargs["accepted_upstream"], UPSTREAM)
        for reconstructed in (None, {**candidate, "configuration_sha": "f" * 40}):
            with (self.subTest(reconstructed=reconstructed),
                  patch.object(release, "_open_shared_review_pulls", return_value=pulls),
                  patch.object(release, "pages", side_effect=lambda route:
                               comments[self._comment_pull_number(route)]),
                  patch.object(release, "_pending_shared_ref_candidate",
                               return_value=reconstructed),
                  self.assertRaisesRegex(ValueError, "omits its exact canonical candidate identity")):
                release._transition_review_candidates(
                    REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_open_selector_rejects_malformed_full_and_moved_delta_refs(self):
        candidate, baseline, pulls, comments = self._open_candidate_pair()
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)
        malformed_comments = {**comments, 13: [{**comments[13][0],
            "body": release._review_marker(self._candidate_identity(candidate),
                                           "full", pulls[0]["head"]["sha"], UPSTREAM)}]}

        def malformed_pages(path):
            return malformed_comments[self._comment_pull_number(path)]

        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=malformed_pages),
              self.assertRaisesRegex(ValueError, "omits its exact canonical candidate identity")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

        moved_delta = {**pulls[1], "head": {
            **pulls[1]["head"], "ref": f"review/changes-{'2' * 40}"}}
        with (patch.object(release, "_open_shared_review_pulls",
                           return_value=[pulls[0], moved_delta]),
              patch.object(release, "pages", side_effect=lambda path:
                           comments[self._comment_pull_number(path)]),
              self.assertRaisesRegex(ValueError, "no longer identifies its exact native PR")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

        moved_full = {**pulls[0], "head": {
            **pulls[0]["head"], "ref": "review/moved-full"}}
        with (patch.object(release, "_open_shared_review_pulls",
                           return_value=[moved_full, pulls[1]]),
              patch.object(release, "pages", side_effect=lambda path:
                           comments[self._comment_pull_number(path)]),
              self.assertRaisesRegex(ValueError, "no longer identifies its exact native PR")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_delta_history_skips_other_candidate_but_not_a_newer_exact_request(self):
        candidate, baseline, pulls, comments = self._open_candidate_pair()
        lifecycle = SimpleNamespace(candidate_identity=self._candidate_identity)
        other = {**candidate, "upstream_sha": "8" * 40}
        other_id = self._candidate_identity(other)
        delta_sha = candidate["configuration_sha"]
        delta_base = baseline["configuration_sha"]
        older_other = {
            **comments[12][0], "id": 99, "created_at": "2026-10-20T05:00:00Z",
            "updated_at": "2026-10-20T05:00:00Z",
            "body": release.shared_review_text(other, "delta", delta_sha, delta_base, other_id),
        }
        comments[12].insert(0, older_other)

        def native_pages(path):
            return comments[self._comment_pull_number(path)]

        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=native_pages)):
            retained = release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0]["delta"]["request_id"], 100)

        newer_other = {
            **older_other, "id": 102, "created_at": "2026-10-20T07:00:00Z",
            "updated_at": "2026-10-20T07:00:00Z",
        }
        comments[12].append(newer_other)
        with (patch.object(release, "_open_shared_review_pulls", return_value=pulls),
              patch.object(release, "pages", side_effect=native_pages),
              self.assertRaisesRegex(ValueError, "superseded by a newer exact delta")):
            release._transition_review_candidates(
                REPO, CONFIG, lifecycle, accepted_baseline=baseline)

    def test_prepare_shared_reuses_pending_upstream_before_live_latest(self):
        class SourceSelectionReached(Exception):
            pass

        pinned_upstream = "8" * 40
        latest_upstream = "9" * 40
        accepted = {**self.candidate, "configuration_sha": SEED}
        baseline = {"accepted_candidate": accepted}
        retained = {
            "candidate": {**self.candidate, "upstream_sha": pinned_upstream},
            "full": {"request_id": 101, "pull": {"number": 13}},
            "delta": {"request_id": 100, "pull": {"number": 12}},
        }
        selected = []
        api_calls = []

        def native_api(path, **_kwargs):
            api_calls.append(path)
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG}
            if path == f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}":
                return {"sha": latest_upstream}
            raise AssertionError(f"Unexpected native preparation request: {path}")

        def stop_at_source(_app, upstream, _patch_root):
            selected.append(upstream)
            raise SourceSelectionReached()

        def run_prepare(pending, ref_candidate=None):
            selected.clear()
            api_calls.clear()
            outputs = {}
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                workflow = root / ".github/workflows/release.yml"
                workflow.parent.mkdir(parents=True)
                workflow.write_text("name: Source selection fixture\n", encoding="utf-8")
                repair = {"waiting": False, "state": None, "config_sha": CONFIG,
                          "config_root": root, "patch_root": root / "patches"}
                with (patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG,
                                              "GITHUB_EVENT_NAME": "workflow_dispatch"}),
                      patch.object(release, "shared_lifecycle",
                                   return_value=SimpleNamespace(
                                       candidate_identity=lambda _candidate: self.candidate_id)),
                      patch.object(release, "api", side_effect=native_api),
                      patch.object(release, "_published_release_recovery", return_value=None),
                      patch.object(release, "_shared_repair_candidate", return_value=repair),
                      patch.object(release, "_adopted_workflow_candidate", return_value=None),
                      patch.object(release, "_shared_prepare_baseline", return_value=baseline),
                      patch.object(release, "_transition_review_candidates",
                                   return_value=[retained] if pending else []),
                      patch.object(release, "_pending_shared_ref_candidate",
                                   return_value=ref_candidate),
                      patch.object(release, "_prepare_source", side_effect=stop_at_source),
                      patch.object(release, "output", side_effect=lambda **values: outputs.update(values)),
                      self.assertRaises(SourceSelectionReached)):
                    release.prepare_shared(root)
                self.assertEqual(outputs["upstream"], selected[0],
                                 "Failure recovery must retain the selected source even before assembly succeeds")

        run_prepare(True)
        self.assertEqual(selected, [pinned_upstream])
        self.assertNotIn(f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}", api_calls)

        run_prepare(False)
        self.assertEqual(selected, [latest_upstream])
        self.assertIn(f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}", api_calls)

        api_calls.clear()
        run_prepare(False, {"upstream_sha": pinned_upstream})
        self.assertEqual(selected, [pinned_upstream])
        self.assertNotIn(f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}", api_calls)

    def test_archived_review_threads_are_not_inputs_to_current_work(self):
        candidate, _baseline, pulls, _comments = self._open_candidate_pair()
        active = {**pulls[0], "number": 1, "state": "open",
                  "user": {"login": "warelik", "type": "User"},
                  "updated_at": "2026-10-21T12:00:00Z"}
        archived = {**active, "number": 99, "state": "closed",
                    "head": {**active["head"], "sha": "9" * 40, "ref": "review/" + "9" * 40}}
        with patch.object(release, "api", return_value=[archived, active]):
            result = release._shared_history_pull_inventory(
                REPO, "2026-10-19T10:00:00Z", candidate=candidate)
        self.assertEqual([pull["number"] for pull in result], [1])
        current_closed = {**active, "number": 100, "state": "closed",
                          "head": {**active["head"], "sha": candidate["configuration_sha"]}}
        with patch.object(release, "api", return_value=[archived, current_closed, active]):
            result = release._shared_history_pull_inventory(
                REPO, "2026-10-19T10:00:00Z", candidate=candidate)
        self.assertEqual([pull["number"] for pull in result], [1, 100])

    def test_history_inventory_reads_past_cutoff_inversions_and_preserves_all_recent_rows(self):
        _candidate, _baseline, pulls, _comments = self._open_candidate_pair()
        template = {**pulls[0], "user": {"login": "warelik", "type": "User"},
                    "updated_at": "2026-10-20T11:00:00Z"}
        page = [{**template, "number": n} for n in range(1, 101)]
        page[0] = {**page[0], "updated_at": "2026-10-18T09:00:00Z"}
        later = {**template, "number": 101, "updated_at": "2026-10-21T12:00:00Z"}
        with patch.object(release, "api", side_effect=[page, [later]]) as read:
            result = release._shared_history_pull_inventory(REPO, "2026-10-19T10:00:00Z")
        self.assertEqual([x["number"] for x in result], list(range(2, 102)))
        self.assertEqual(read.call_count, 2)
        with patch.object(release, "api", return_value=[{**template, "number": 1}, {**template, "number": 1}]):
            with self.assertRaisesRegex(ValueError, "repeated a pull request"):
                release._shared_history_pull_inventory(REPO, "2026-10-19T10:00:00Z")

    def test_prepare_shared_resumes_full_only_pair_without_recreating_full_request(self):
        candidate, baseline_candidate, pulls, _comments = self._open_candidate_pair()
        candidate_id = self._candidate_identity(candidate)
        full_pull, delta_pull = pulls
        full_sha = full_pull["head"]["sha"]
        delta_sha = delta_pull["head"]["sha"]
        delta_base_sha = delta_pull["base"]["sha"]
        request_time = self.timestamp
        retained = {
            "candidate": candidate,
            "full": {"request_id": 101, "review_sha": full_sha,
                     "base_sha": UPSTREAM, "requested_at": request_time, "pull": full_pull},
            "delta": None,
            "delta_pull": delta_pull,
        }
        accepted_candidate = {
            "schema": 1, "repository": REPO,
            "configuration_sha": baseline_candidate["configuration_sha"],
            "application_sha": baseline_candidate["application_sha"],
            "upstream_sha": "7" * 40, "patchset_sha256": "e" * 64,
            "recipe_sha256": "f" * 64, "platform": "linux/amd64",
        }
        accepted_baseline = {"endpoint": "fixture", "variable": {
            "value": json.dumps({"candidate": accepted_candidate})}}
        baseline_data = {
            "release": {"id": 77, "published_at": PUBLISHED, "tag_name": "build-fixture"},
            "metadata": {}, "metadata_sha256": "a" * 64,
            "candidate": accepted_candidate, "accepted_candidate": accepted_candidate,
            "accepted_baseline": accepted_baseline,
        }
        latest_path = f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}"
        api_calls = []
        selected_upstreams = []
        review_calls = []
        evaluation_calls = []

        def identity(value):
            return candidate_id if value == candidate else self._candidate_identity(value)

        def native_api(path, **_kwargs):
            api_calls.append(path)
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG}
            if path == latest_path:
                return {"sha": "8" * 40}
            raise AssertionError(f"Unexpected native preparation request: {path}")

        def prepare_source(_app, upstream, _patch_root):
            selected_upstreams.append(upstream)
            application_root = Path(_app)
            application_root.mkdir(parents=True, exist_ok=True)
            (application_root / "Dockerfile").write_text("FROM node:fixture\n", encoding="utf-8")
            return candidate["application_sha"], candidate["patchset_sha256"], "1.0.0"

        def review(*args, **kwargs):
            review_calls.append((args, kwargs))
            return full_pull if kwargs["head_ref"] == full_pull["head"]["ref"] else delta_pull

        def evaluate(*args, **kwargs):
            evaluation_calls.append((args, kwargs))
            scope = args[3]
            pr = full_pull if scope == "full" else delta_pull
            request_id = 101 if scope == "full" else 102
            created_at = request_time if scope == "full" else "2026-10-20T06:30:00Z"
            if scope == "delta" and retained["delta"] is None:
                retained["delta"] = {
                    "request_id": request_id, "review_sha": delta_sha,
                    "base_sha": delta_base_sha, "requested_at": created_at,
                    "pull": delta_pull,
                }
            result = {"findings": []}
            evidence = {"request": {"id": request_id, "created_at": created_at},
                        "target": {"pr": pr}}
            return result, evidence

        lifecycle = SimpleNamespace(
            candidate_identity=identity,
            evaluate_pair=lambda *_args, **_kwargs: {"state": "waiting", "complete": False},
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: full-only resume fixture\n", encoding="utf-8")
            repair = {"waiting": False, "state": None, "config_sha": CONFIG,
                      "config_root": root, "patch_root": root / "patches"}
            with (patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG}),
                  patch.object(release, "shared_lifecycle", return_value=lifecycle),
                  patch.object(release, "api", side_effect=native_api),
                  patch.object(release, "_published_release_recovery", return_value=None),
                  patch.object(release, "_shared_repair_candidate", return_value=repair),
                  patch.object(release, "_adopted_workflow_candidate", return_value=None),
                  patch.object(release, "_shared_prepare_baseline", return_value=baseline_data),
                  patch.object(release, "_transition_review_candidates", return_value=[retained]),
                  patch.object(release, "_prepare_source", side_effect=prepare_source),
                  patch.object(release, "_recipe_sha256", return_value=candidate["recipe_sha256"]),
                  patch.object(release, "_candidate_record", return_value=candidate),
                  patch.object(release, "_create_review_context_commit", return_value=(full_sha, "")),
                  patch.object(release, "_exact_review_pull",
                               side_effect=[full_pull, delta_pull, full_pull, delta_pull,
                                            full_pull, delta_pull]),
                  patch.object(release, "_closed_policy_pair_has_verified_bundle", return_value=False),
                  patch.object(release, "_review_pr", side_effect=review),
                  patch.object(release, "_carried_shared_findings", return_value=(None, [], {})),
                  patch.object(release, "evaluate_shared_review", side_effect=evaluate),
                  patch.object(release, "pending_review") as pending_review,
                  patch.object(release, "output") as output):
                release.prepare_shared(root)
                release.prepare_shared(root)

        self.assertEqual(selected_upstreams, [candidate["upstream_sha"], candidate["upstream_sha"]])
        self.assertNotIn(latest_path, api_calls)
        self.assertEqual([kwargs["expected_request_id"] for _args, kwargs in evaluation_calls],
                         [101, None, 101, 102])
        self.assertEqual([kwargs["create_request"] for _args, kwargs in evaluation_calls],
                         [False, True, False, False])
        self.assertEqual([kwargs.get("resume_after") for _args, kwargs in evaluation_calls],
                         [None, (request_time, 101), None, None])
        self.assertEqual([kwargs["head_ref"] for _args, kwargs in review_calls],
                         [full_pull["head"]["ref"], delta_pull["head"]["ref"],
                          full_pull["head"]["ref"], delta_pull["head"]["ref"]])
        self.assertEqual(pending_review.call_args_list,
                         [((request_time,), {}), ((request_time,), {}),
                          ((request_time,), {}), ((request_time,), {})])
        emitted = [call.kwargs for call in output.call_args_list]
        self.assertEqual([values for values in emitted if set(values) == {"upstream"}],
                         [{"upstream": candidate["upstream_sha"]}] * 2)
        self.assertEqual(len([values for values in emitted if "mode" in values]), 2)
        self.assertEqual(len(emitted), 4)
        self.assertEqual(output.call_args.kwargs["mode"], "waiting")

    def test_retained_request_id_is_not_replaced_or_duplicated(self):
        review_sha = "1" * 40
        body = release.shared_review_text(
            self.candidate, "full", review_sha, UPSTREAM, self.candidate_id)
        comment = {"id": 101, "created_at": self.timestamp, "updated_at": self.timestamp,
                   "user": {"login": "warelik", "type": "User"}, "body": body}
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: self.candidate_id)
        request = release._native_review_request(
            REPO, [comment], 13, self.candidate, "full", review_sha, UPSTREAM,
            lifecycle, create=False, expected_request_id=101)
        self.assertIs(request, comment)
        with self.assertRaisesRegex(ValueError, "identity changed or became duplicated"):
            release._native_review_request(
                REPO, [comment, {**comment, "id": 102}], 13, self.candidate,
                "full", review_sha, UPSTREAM, lifecycle,
                create=False, expected_request_id=101)

        delta_sha, delta_base = CONFIG, SEED
        delta_candidate = {**self.candidate, "configuration_sha": CONFIG}
        other_candidate = {**delta_candidate, "upstream_sha": "8" * 40}
        other_id = "b" * 64
        delta_request = {
            **comment, "created_at": self.timestamp, "updated_at": self.timestamp,
            "body": release.shared_review_text(
                delta_candidate, "delta", delta_sha, delta_base, self.candidate_id),
        }
        newer_other = {
            **comment, "id": 102, "created_at": "2026-10-20T07:00:00Z",
            "updated_at": "2026-10-20T07:00:00Z",
            "body": release.shared_review_text(
                other_candidate, "delta", delta_sha, delta_base, other_id),
        }
        delta_lifecycle = SimpleNamespace(
            candidate_identity=lambda value: (self.candidate_id if value == delta_candidate else other_id))
        with self.assertRaisesRegex(ValueError, "superseded by a newer candidate request"):
            release._native_review_request(
                REPO, [delta_request, newer_other], 12, delta_candidate, "delta",
                delta_sha, delta_base, delta_lifecycle,
                create=False, expected_request_id=101)

    def test_full_only_resume_posts_only_missing_delta_request_with_original_deadline(self):
        delta_candidate = {**self.candidate, "configuration_sha": CONFIG}
        delta_sha, delta_base = CONFIG, SEED
        other_candidate = {**delta_candidate, "upstream_sha": "8" * 40}
        other_id = "b" * 64
        older_other = {
            "id": 100, "created_at": "2026-10-20T05:00:00Z",
            "updated_at": "2026-10-20T05:00:00Z",
            "user": {"login": "warelik", "type": "User"},
            "body": release.shared_review_text(
                other_candidate, "delta", delta_sha, delta_base, other_id),
        }
        newer_other = {
            **older_other, "id": 103, "created_at": "2026-10-20T08:00:00Z",
            "updated_at": "2026-10-20T08:00:00Z",
        }
        created = {
            "id": 102, "created_at": "2026-10-20T07:00:00Z",
            "updated_at": "2026-10-20T07:00:00Z",
            "user": {"login": "warelik", "type": "User"},
            "body": release.shared_review_text(
                delta_candidate, "delta", delta_sha, delta_base, self.candidate_id),
        }
        lifecycle = SimpleNamespace(
            candidate_identity=lambda value: (self.candidate_id if value == delta_candidate else other_id))
        with (patch.object(release, "owner_token", return_value="fixture-token"),
              patch.object(release, "api") as blocked_api,
              self.assertRaisesRegex(ValueError, "superseded by a newer exact delta request")):
            release._native_review_request(
                REPO, [newer_other], 12, delta_candidate, "delta", delta_sha, delta_base,
                lifecycle, create=True, resume_after=(self.timestamp, 101))
        blocked_api.assert_not_called()

        with (patch.object(release, "owner_token", return_value="fixture-token"),
              patch.object(release, "api", return_value=created) as native_api):
            request = release._native_review_request(
                REPO, [older_other], 12, delta_candidate, "delta", delta_sha, delta_base,
                lifecycle, create=True, resume_after=(self.timestamp, 101))
        self.assertIs(request, created)
        native_api.assert_called_once()
        self.assertEqual(native_api.call_args.args[0], f"repos/{REPO}/issues/12/comments")
        self.assertEqual(native_api.call_args.kwargs["data"]["body"].count("fork-review:v1"), 1)

        comments = [older_other, created]
        self.assertIs(release._native_review_request(
            REPO, comments, 12, delta_candidate, "delta", delta_sha, delta_base,
            lifecycle, create=False, expected_request_id=102), created)

        with self.assertRaisesRegex(ValueError, "superseded by a newer candidate request"):
            release._native_review_request(
                REPO, [older_other, created, newer_other], 12, delta_candidate,
                "delta", delta_sha, delta_base, lifecycle,
                create=False, expected_request_id=102)

    def test_workflow_test_job_change_transitions_even_when_container_recipe_is_unchanged(self):
        candidate = {**self.candidate, "configuration_sha": HEAD}
        context = {"candidate": candidate, "base_config_sha": CONFIG,
                   "reviews": {"full": {"review_sha": UPSTREAM}}}
        parent_identity = {"parent_sha": CONFIG, "repair_pr": 2}
        active_workflow = b"jobs:\n  test:\n    steps:\n      - run: npm test\n"
        candidate_workflow = (
            b"jobs:\n  test:\n    timeout-minutes: 30\n    steps:\n      - run: npm test\n")
        native_run = {"id": 90, "run_attempt": 1, "path": ".github/workflows/release.yml"}
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: self.candidate_id)
        with (patch.dict(os.environ, {"GITHUB_SHA": CONFIG, "GITHUB_RUN_ID": "90",
                                     "GITHUB_RUN_ATTEMPT": "1"}),
              patch.object(release, "_sanitized_repair_identity", return_value=parent_identity),
              patch.object(release, "_shared_file", side_effect=[
                  b"Dockerfile\n", candidate_workflow, active_workflow]),
              patch.object(release, "_recipe_sha256", return_value=candidate["recipe_sha256"]),
              patch.object(release, "api", return_value=native_run),
              patch.object(release, "_native_workflow_source") as source):
            transition = release._workflow_recipe_transition(REPO, context, lifecycle)
        self.assertTrue(transition["transition"])
        self.assertEqual(transition["kind"], "adopt")
        self.assertFalse(transition["recipe_changed"])
        source.assert_called_once_with(REPO, native_run, CONFIG)

    def test_unchanged_release_workflow_does_not_start_a_transition(self):
        candidate = {**self.candidate, "configuration_sha": CONFIG}
        context = {"candidate": candidate, "base_config_sha": CONFIG,
                   "reviews": {"full": {"review_sha": UPSTREAM}}}
        identity = {"parent_sha": self.parent, "repair_pr": 2}
        workflow = b"jobs:\n  build:\n    steps:\n      - run: docker build\n"
        lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: self.candidate_id)
        with (patch.dict(os.environ, {"GITHUB_SHA": CONFIG}),
              patch.object(release, "_sanitized_repair_identity", return_value=identity),
              patch.object(release, "_shared_file", side_effect=[b"Dockerfile\n", workflow, workflow]),
              patch.object(release, "_recipe_sha256", return_value=candidate["recipe_sha256"]),
              patch.object(release, "api", side_effect=AssertionError("unchanged workflow must not hand off"))):
            transition = release._workflow_recipe_transition(REPO, context, lifecycle)
        self.assertFalse(transition["transition"])

    def _final_reservation_inputs(self):
        candidate = {
            "schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
            "application_sha": HEAD, "configuration_sha": CONFIG,
            "patchset_sha256": "e" * 64, "recipe_sha256": "f" * 64,
            "platform": "linux/amd64",
        }
        candidate_id = "a" * 64
        context = {
            "candidate": candidate, "candidate_id": candidate_id,
            "policy_validation": {"candidate_id": candidate_id,
                                  "source": "maintenance-bundle", "verified": True,
                                  "manifest_sha256": "b" * 64},
            "reviews": {"full": {"pr": 10}, "delta": {"pr": 11}},
        }
        return context, {"candidate_id": candidate_id, "grant_id": None}

    def test_final_reservation_ignores_foreign_malformed_and_valid_markers(self):
        context, decision = self._final_reservation_inputs()
        bot = {"login": "github-actions[bot]", "type": "Bot", "id": 41898282}
        contributor = {"login": "contributor", "type": "User", "id": 1001}
        foreign_valid = "<!-- fork-final:v1 " + json.dumps({
            "schema": 1, "candidate_id": "c" * 64, "run_id": 90,
            "run_attempt": 1, "workflow_sha": HEAD,
        }, separators=(",", ":")) + " -->"
        comments_by_pr = {
            10: [self.comment(130, "<!-- fork-final:v1 {malformed} -->", contributor)],
            11: [self.comment(131, foreign_valid, contributor)],
        }
        posts = []

        def pages(path):
            number = int(path.split("/issues/", 1)[1].split("/", 1)[0])
            return comments_by_pr[number]

        def api(path, *, method="GET", data=None):
            if path == f"repos/{REPO}/actions/runs/90/attempts/1" and method == "GET":
                return {"id": 90, "run_attempt": 1}
            if path == f"repos/{REPO}/issues/11/comments" and method == "POST":
                posts.append(data["body"])
                return {"id": 132, "created_at": self.timestamp, "updated_at": self.timestamp,
                        "user": bot, "body": data["body"]}
            self.fail(f"Unexpected native API request: {method} {path}")

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1",
                                     "GITHUB_SHA": HEAD}, clear=True),
              patch.object(release, "pages", side_effect=pages),
              patch.object(release, "api", side_effect=api),
              patch.object(release, "_native_workflow_source")):
            reservation = release._reserve_final_attempt(REPO, context, decision)
        self.assertEqual(reservation["id"], 132)
        self.assertEqual(len(posts), 1)

    def test_final_reservation_rejects_malformed_trusted_marker_before_post(self):
        context, decision = self._final_reservation_inputs()
        bot = {"login": "github-actions[bot]", "type": "Bot", "id": 41898282}
        malformed = self.comment(135, "<!-- fork-final:v1 {malformed} -->", bot)
        comments_by_pr = {10: [malformed], 11: []}

        def pages(path):
            number = int(path.split("/issues/", 1)[1].split("/", 1)[0])
            return comments_by_pr[number]

        def api(path, *, method="GET", data=None):
            if path == f"repos/{REPO}/actions/runs/90/attempts/1" and method == "GET":
                return {"id": 90, "run_attempt": 1}
            self.fail(f"Unexpected native API request: {method} {path}")

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1",
                                     "GITHUB_SHA": HEAD}, clear=True),
              patch.object(release, "pages", side_effect=pages),
              patch.object(release, "api", side_effect=api),
              patch.object(release, "_native_workflow_source"),
              self.assertRaises(ValueError)):
            release._reserve_final_attempt(REPO, context, decision)

    def test_duplicate_native_reservations_for_the_current_attempt_fail(self):
        context, decision = self._final_reservation_inputs()
        bot = {"login": "github-actions[bot]", "type": "Bot", "id": 41898282}
        comments_by_pr = {10: [], 11: []}
        posts = []

        def pages(path):
            number = int(path.split("/issues/", 1)[1].split("/", 1)[0])
            return comments_by_pr[number]

        def api(path, *, method="GET", data=None):
            if path == f"repos/{REPO}/actions/runs/90/attempts/1" and method == "GET":
                return {"id": 90, "run_attempt": 1}
            if path == f"repos/{REPO}/issues/11/comments" and method == "POST":
                posts.append(data["body"])
                return {"id": 140, "created_at": self.timestamp, "updated_at": self.timestamp,
                        "user": bot, "body": data["body"]}
            self.fail(f"Unexpected native API request: {method} {path}")

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1",
                                     "GITHUB_SHA": HEAD}, clear=True),
              patch.object(release, "pages", side_effect=pages),
              patch.object(release, "api", side_effect=api),
              patch.object(release, "_native_workflow_source")):
            first = release._reserve_final_attempt(REPO, context, decision)
            comments_by_pr[10] = [self.comment(141, first["body"], bot)]
            comments_by_pr[11] = [self.comment(142, first["body"], bot)]
            with self.assertRaisesRegex(ValueError, "duplicate final reservations"):
                release._reserve_final_attempt(REPO, context, decision)
        self.assertEqual(len(posts), 1)


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

    def test_untrusted_final_and_retry_markers_do_not_poison_native_history(self):
        marker = {"schema": 1, "candidate_id": "f" * 64, "run_id": 7,
                  "run_attempt": 1, "workflow_sha": HEAD}
        final_body = "<!-- fork-final:v1 " + json.dumps(marker) + " -->"
        comments = [
            {"id": 101, "created_at": "2026-10-19T13:00:00Z",
             "updated_at": "2026-10-19T13:00:00Z",
             "user": {"login": "contributor", "type": "User"}, "body": final_body},
            {"id": 102, "created_at": "2026-10-19T13:01:00Z",
             "updated_at": "2026-10-19T13:01:00Z",
             "user": {"login": "contributor", "type": "User"}, "body": final_body},
            {"id": 103, "created_at": "2026-10-19T13:02:00Z",
             "updated_at": "2026-10-19T13:02:00Z",
             "user": {"login": "contributor", "type": "User"},
             "body": "<!-- fork-final-retry:v1 malformed -->"},
        ]
        baseline = {"candidate": {}, "release_id": 8,
                    "published_at": "2026-10-19T12:00:00Z", "metadata_sha256": "e" * 64}
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1"}, clear=True),
              patch.object(release, "_all_shared_review_pulls", return_value=[]),
              patch.object(release, "pages", return_value=comments),
              patch.object(release, "_workflow_run_records", return_value=([], True))):
            history = release._final_history(REPO, {"baseline": baseline}, object())
        self.assertTrue(history["complete"])
        self.assertEqual(history["attempts"], [])
        self.assertEqual(history["grants"], [])

    def test_trusted_final_marker_requires_positive_id_and_immutable_comment(self):
        marker = {"schema": 1, "candidate_id": "f" * 64, "run_id": 7,
                  "run_attempt": 1, "workflow_sha": HEAD}
        baseline = {"candidate": {}, "release_id": 8,
                    "published_at": "2026-10-19T12:00:00Z", "metadata_sha256": "e" * 64}
        for comment in (
                {"id": True, "created_at": "2026-10-19T13:00:00Z",
                 "updated_at": "2026-10-19T13:00:00Z"},
                {"id": 9, "created_at": "2026-10-19T13:00:00Z",
                 "updated_at": "2026-10-19T13:01:00Z"}):
            comment = {
                **comment,
                "user": {"login": "github-actions[bot]", "type": "Bot"},
                "body": "<!-- fork-final:v1 " + json.dumps(marker) + " -->",
            }
            with self.subTest(comment=comment):
                with (patch.dict(os.environ, {"GITHUB_RUN_ID": "90", "GITHUB_RUN_ATTEMPT": "1"},
                                 clear=True),
                      patch.object(release, "_all_shared_review_pulls", return_value=[]),
                      patch.object(release, "pages", return_value=[comment]),
                      self.assertRaisesRegex(ValueError, "positive immutable ID|edited")):
                    release._final_history(REPO, {"baseline": baseline}, object())

    def test_history_inventory_includes_repair_prs_but_excludes_unrelated_branches(self):
        def pull(number, user, head_ref, base_ref, *, head_repo=REPO):
            return {
                "number": number, "state": "open", "updated_at": "2026-10-19T12:30:00Z",
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
                REPO, {"schema": 1, "repository": REPO, "configuration_sha": CONFIG,
                       "application_sha": HEAD, "upstream_sha": UPSTREAM,
                       "patchset_sha256": "d" * 64, "recipe_sha256": "e" * 64,
                       "platform": "linux/amd64"}, Lifecycle(), "2026-10-19T12:00:00Z")

    def _disposition_proposal_fixture(self, temporary, *, existing_carrier=False,
                                      changed_carrier=False, policy_repair=False,
                                      carrier_metadata_only=False,
                                      policy_disproved_unchanged=False,
                                      policy_application_disproof=False,
                                      status="fixed", source_sha=None,
                                      comment_user=None, comment_updated=None):
        if changed_carrier and (not existing_carrier or status != "disproved" or policy_repair):
            raise ValueError("Changed-carrier disproof fixture requires an existing accepted patch")
        if policy_repair and existing_carrier:
            raise ValueError("Policy fixture uses the single accepted application patch")
        if policy_disproved_unchanged and (not policy_repair or status != "disproved"):
            raise ValueError("Unchanged policy evidence fixture requires a policy disproof")
        if policy_application_disproof and (not policy_repair or status != "disproved"):
            raise ValueError("Application evidence fixture requires a policy disproof")
        temporary = Path(temporary)
        config_root, app_root = temporary / "config", temporary / "application"
        fixed_time = "2026-10-20T00:00:00Z"

        def git(root, *args):
            return subprocess.run(["git", *args], cwd=root, check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, timeout=30).stdout.strip()

        def init(root):
            root.mkdir(parents=True)
            git(root.parent, "init", "-b", "main", str(root))
            git(root, "config", "user.name", "Fixture")
            git(root, "config", "user.email", "fixture@example.invalid")

        def commit(root, message):
            git(root, "add", "--", ".")
            env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture",
                   "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                   "GIT_COMMITTER_NAME": "Fixture",
                   "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
                   "GIT_AUTHOR_DATE": fixed_time, "GIT_COMMITTER_DATE": fixed_time}
            subprocess.run(["git", "commit", "-m", message], cwd=root, env=env,
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=30)
            return git(root, "rev-parse", "HEAD")

        def app_diff(before, after):
            return subprocess.run(
                ["git", "diff", "--no-ext-diff", "--no-renames", "--binary", before, after],
                cwd=app_root, check=True, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=30).stdout

        init(app_root)
        (app_root / "src").mkdir()
        (app_root / "open-sse").mkdir()
        (app_root / "tests/unit").mkdir(parents=True)
        (app_root / "src/fix.js").write_text('export function run(value) { return "old"; }\n')
        (app_root / "open-sse/other.js").write_text(
            'export const other = "old";\nexport const unrelated = "old";\n')
        (app_root / "tests/unit/fix.test.js").write_text('test("legacy", () => {});\n')
        (app_root / "tests/unit/other.test.js").write_text(
            'test("legacy other", () => {});\n'
            'test("followup regression", () => {\n'
            '  expect(other).toBe("old");\n});\n')
        (app_root / "tests/unit/legacy.test.js").write_text('test("historical", () => {});\n')
        git(app_root, "add", "--", ".")
        app_base = commit(app_root, "upstream base")
        (app_root / "src/fix.js").write_text(
            'export function run(value) {\n  if (value === "stale") return "fixed";\n'
            '  return "fixed";\n}\n')
        regression_case = "fix rejects stale input"
        regression_source = 'expect(run("stale")).toBe("fixed");'
        (app_root / "tests/unit/fix.test.js").write_text(
            'test("legacy", () => {});\n'
            f'test("{regression_case}", () => {{\n  {regression_source}\n}});\n')
        app_fixed = commit(app_root, "fix carried application finding")
        fixed_patch = app_diff(app_base, app_fixed)
        app_final, patch_contents = app_fixed, {"patches/0001-fix.patch": fixed_patch}
        if existing_carrier:
            (app_root / "open-sse/other.js").write_text(
                'export const other = "old";\nexport const unrelated = "fixed";\n')
            (app_root / "tests/unit/other.test.js").write_text(
                'test("legacy other", () => {});\n'
                'test("followup regression", () => {\n'
                '  expect(other).toBe("old");\n'
                '  expect(unrelated).toBe("fixed");\n});\n')
            app_final = commit(app_root, "unrelated followup source repair")
            patch_contents["patches/0002-followup.patch"] = app_diff(app_fixed, app_final)

        init(config_root)
        (config_root / "patches").mkdir()
        (config_root / "scripts").mkdir()
        baseline_manifest = {
            "schema": 1,
            "test_files": ["tests/unit/legacy.test.js"],
            "regression_files": (["tests/unit/fix.test.js"]
                                  if existing_carrier or policy_repair else []),
        }
        if existing_carrier or policy_repair:
            (config_root / "patches/0001-fix.patch").write_bytes(fixed_patch)
        if policy_repair:
            (config_root / "scripts/release.py").write_text(
                'def repair_target():\n    return "old"\n', encoding="utf-8")
            (config_root / "scripts/test_repair.py").write_text(
                'def test_policy_source_fix():\n    assert repair_target() == "old"\n',
                encoding="utf-8")
        if policy_repair:
            (config_root / "scripts/maintenance.py").write_text(
                'def policy_marker(): return "stable"\n', encoding="utf-8")
            (config_root / "scripts/test_maintenance.py").write_text(
                'def test_policy_marker_is_stable():\n'
                '    assert policy_marker() == "stable"\n', encoding="utf-8")
        (config_root / "patches/source.json").write_text(
            json.dumps(baseline_manifest, sort_keys=True) + "\n", encoding="utf-8")
        config_sha = commit(config_root, "trusted config")
        (config_root / ".repair").mkdir()
        (config_root / ".repair/context.json").write_text("{}\n", encoding="utf-8")
        seed_sha = commit(config_root, "repair seed")
        if policy_repair:
            (config_root / "scripts/release.py").write_text(
                'def repair_target():\n    return "fixed"\n', encoding="utf-8")
            (config_root / "scripts/test_repair.py").write_text(
                'def test_policy_source_fix():\n    assert repair_target() == "fixed"\n',
                encoding="utf-8")
            changed_path = "scripts/release.py"
        elif existing_carrier:
            (config_root / "patches/0002-followup.patch").write_bytes(
                patch_contents["patches/0002-followup.patch"])
            if carrier_metadata_only:
                patch_contents["patches/0001-fix.patch"] += b"\n"
                (config_root / "patches/0001-fix.patch").write_bytes(patch_contents["patches/0001-fix.patch"])
            changed_path = "patches/0002-followup.patch"
        else:
            (config_root / "patches/0001-fix.patch").write_bytes(fixed_patch)
            changed_path = "patches/0001-fix.patch"
        head_sha = commit(config_root, "Codex application repair")

        sanitized_root = temporary / "sanitized"
        git(config_root, "worktree", "add", "--detach", str(sanitized_root), config_sha)
        for path, content in patch_contents.items():
            destination = sanitized_root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        if policy_repair:
            for path in ("scripts/release.py", "scripts/test_repair.py"):
                destination = sanitized_root / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((config_root / path).read_bytes())
        candidate_manifest = {
            **baseline_manifest,
            "regression_files": sorted(set(baseline_manifest["regression_files"])
                                        | {"tests/unit/fix.test.js"}
                                        | ({"tests/unit/other.test.js"} if existing_carrier else set())),
        }
        (sanitized_root / "patches/source.json").write_text(
            json.dumps(candidate_manifest, sort_keys=True) + "\n", encoding="utf-8")
        git(sanitized_root, "add", "--", "patches",
            *( ["scripts"] if policy_repair else []))
        candidate_config = commit(sanitized_root, "sanitized candidate config")
        git(config_root, "worktree", "remove", "--force", str(sanitized_root))

        patchset_digest = hashlib.sha256()
        for path, content in sorted(patch_contents.items()):
            patchset_digest.update(Path(path).name.encode() + b"\0" + content + b"\0")
        patchset = patchset_digest.hexdigest()
        candidate_id = "f" * 64
        candidate = {"schema": 1, "repository": REPO, "upstream_sha": app_base,
                     "application_sha": app_final, "configuration_sha": candidate_config,
                     "patchset_sha256": patchset, "recipe_sha256": "a" * 64,
                     "platform": "linux/amd64", "_candidate_id": candidate_id}
        tree_sha = git(app_root, "rev-parse", f"{app_final}^{{tree}}")
        review_sha = "9" * 40
        full_evidence = {"target": {
            "review_commit": {"sha": review_sha,
                              "message": f"fork-review-context:v1 {candidate_id}\n",
                              "parents": [{"sha": app_final}], "tree": {"sha": tree_sha}},
            "application_commit": {"sha": app_final, "tree": {"sha": tree_sha}},
            "review_sha": review_sha,
        }}
        repair_state = {
            "schema": 1, "config": config_sha, "upstream": app_base, "seed": seed_sha,
            "head": head_sha, "number": 17, "branch": "repair/example",
            "cycle": "e" * 64, "window": "run-42",
        }
        repair_identity = {key: repair_state[key] for key in
                           ("schema", "config", "upstream", "seed", "cycle", "window")}
        pull = {
            "number": 17, "state": "open",
            "head": {"sha": head_sha, "ref": repair_state["branch"],
                     "repo": {"full_name": REPO}},
            "base": {"sha": config_sha, "ref": "downstream", "repo": {"full_name": REPO}},
            "user": {"login": "github-actions[bot]", "type": "Bot"},
            "body": "<!-- 9router-repair:v1 " + json.dumps(repair_identity, sort_keys=True) + " -->",
        }
        finding_path = (None if policy_disproved_unchanged else
                        "src/fix.js" if policy_application_disproof else
                        "scripts/release.py" if policy_repair else
                        "open-sse/other.js" if changed_carrier else "src/fix.js")
        finding = {"finding_id": "review:6:13" if policy_disproved_unchanged else "inline:6:13",
                   "candidate_id": "e" * 64,
                   "scope": "full" if policy_disproved_unchanged or not policy_repair else "delta",
                   "source": "review" if policy_disproved_unchanged else "inline",
                   "source_sha": app_base if policy_disproved_unchanged else
                                 config_sha if policy_repair else app_base,
                   "native_id": 13, "body": "A carried code finding",
                   "path": finding_path, "line": None if policy_disproved_unchanged else 4,
                   "severity": "unlabelled"}
        code_source = ('if (value === "stale") return "fixed";' if policy_application_disproof else
                       'def policy_marker(): return "stable"' if policy_disproved_unchanged else
                       'return "fixed"' if policy_repair else
                       'export const other = "old";' if changed_carrier
                       else 'if (value === "stale") return "fixed";')
        carrier = ("patches/0001-fix.patch" if policy_application_disproof else
                   "scripts/maintenance.py" if policy_disproved_unchanged else
                   "scripts/release.py" if policy_repair else
                   "patches/0002-followup.patch" if changed_carrier else "patches/0001-fix.patch")
        test_carrier = ("patches/0001-fix.patch" if policy_application_disproof else
                        "scripts/test_maintenance.py" if policy_disproved_unchanged else
                        "scripts/test_repair.py" if policy_repair else carrier)
        def diff_sha(path):
            diff = subprocess.run(
                ["git", "diff", "--no-ext-diff", "--no-renames", "--binary",
                 seed_sha, head_sha, "--", path], cwd=config_root,
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=30).stdout
            return hashlib.sha256(diff).hexdigest()

        code_diff_sha, test_diff_sha = diff_sha(carrier), diff_sha(test_carrier)
        explanation = ("The old implementation returned old for stale input; this named regression "
                       "fails before the source patch and passes with the repair." if status == "fixed"
                       else "The exact current source already handles stale input and its named "
                            "existing regression covers the behavior; this repair changes no source hunk.")
        if policy_repair:
            if policy_application_disproof:
                regression_case = "fix rejects stale input"
                regression_source = 'expect(run("stale")).toBe("fixed");'
                explanation = ("The exact unchanged application branch and its named regression already "
                               "cover stale input; the policy-only repair does not alter that app source.")
            else:
                regression_case = ("test_policy_marker_is_stable" if policy_disproved_unchanged
                                   else "test_policy_source_fix")
                regression_source = ('assert policy_marker() == "stable"' if policy_disproved_unchanged
                                     else 'assert repair_target() == "fixed"')
                explanation = ("The unchanged policy helper returns the exact stable value asserted by this "
                               "named Python test; both source and regression remain present in configuration C."
                               if policy_disproved_unchanged else
                               "The policy source previously returned old; this exact Python test function "
                               "asserts the repaired behavior and the changed files match sanitized policy C.")
        elif changed_carrier:
            regression_case = "followup regression"
            regression_source = 'expect(other).toBe("old");'
            explanation = ("The exact other output remains the prior correct value; the named assertion "
                           "covers it while the changed hunk is limited to the unrelated export.")
        regression_path = ("tests/unit/fix.test.js" if policy_application_disproof else
                           test_carrier if policy_repair else
                           "tests/unit/other.test.js" if changed_carrier else "tests/unit/fix.test.js")
        evidence = (
            f"code location `{carrier if policy_disproved_unchanged else finding_path}` at `{code_source}`; code diff SHA-256 `{code_diff_sha}`; "
            f"regression path `{regression_path}`; "
            f"regression diff SHA-256 `{test_diff_sha}`; regression case `{regression_case}`; "
            f"regression location `{regression_source}`; explanation `{explanation}`")
        proposal = {"schema": 1, "source_sha": source_sha or head_sha,
                    "findings": [{"finding_id": finding["finding_id"],
                                  "status": status, "evidence": evidence}]}
        request_comment = {
            "id": 18, "created_at": "2026-10-20T01:00:00Z",
            "updated_at": "2026-10-20T01:00:00Z",
            "user": {"login": "warelik", "type": "User"},
            "body": f"@codex fix failure\n<!-- 9router-fix:{config_sha}:1 -->",
        }
        proposal_comment = {
            "id": 19, "created_at": "2026-10-20T02:00:00Z",
            "updated_at": comment_updated or "2026-10-20T02:00:00Z",
            "user": comment_user or {"login": release.BOT, "type": "Bot"},
            "performed_via_github_app": {"id": 321, "slug": release.APP},
            "body": "Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(proposal, sort_keys=True, separators=(",", ":")) + " -->",
        }
        changed = git(config_root, "diff", "--no-renames", "--name-only",
                      seed_sha, head_sha).splitlines()
        repair = {"state": repair_state, "config_sha": candidate_config,
                  "config_root": sanitized_root, "patch_root": sanitized_root / "patches",
                  "repair_policy": policy_repair, "changed": changed,
                  "baseline_config_sha": config_sha}
        return {
            "config_root": config_root, "app_root": app_root, "candidate": candidate,
            "full_evidence": full_evidence, "repair": repair, "finding": finding,
            "proposal": proposal, "proposal_comment": proposal_comment,
            "comments": [request_comment, proposal_comment], "pull": pull,
            "baseline_manifest": json.dumps(baseline_manifest).encode(),
            "patch_root": Path("/unused"), "existing_carrier": existing_carrier,
        }

    def _read_disposition_batch(self, fixture, *, known=None, fresh_ids=(), already_disposed=(),
                                fresh_findings=()):
        def native(route, **_kwargs):
            if route == f"repos/{REPO}/pulls/17":
                return fixture["pull"]
            if route == f"repos/{REPO}/commits/downstream":
                return {"sha": fixture["repair"]["state"]["config"]}
            raise AssertionError(f"Unexpected native route: {route}")

        with (patch.object(release, "ROOT", fixture["config_root"]),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "pages", return_value=fixture["comments"]),
              patch.object(release, "_shared_file", return_value=fixture["baseline_manifest"])):
            return release._verified_disposition_proposals(
                REPO, fixture["candidate"], fixture["full_evidence"],
                [fixture["finding"]] if known is None else known,
                set(fresh_ids), already_disposed, fixture["patch_root"],
                repair=fixture["repair"], app_root=fixture["app_root"],
                fresh_findings=fresh_findings)

    def _read_disposition_fixture(self, fixture, *, known=None, fresh_ids=(), already_disposed=(),
                                   fresh_findings=()):
        return self._read_disposition_batch(
            fixture, known=known, fresh_ids=fresh_ids,
            already_disposed=already_disposed, fresh_findings=fresh_findings)[0]

    def _read_native_proposal(self, fixture, comments):
        def native(route, **_kwargs):
            if route == f"repos/{REPO}/pulls/17":
                return fixture["pull"]
            if route == f"repos/{REPO}/commits/downstream":
                return {"sha": fixture["repair"]["state"]["config"]}
            raise AssertionError(f"Unexpected native route: {route}")

        with (patch.object(release, "ROOT", fixture["config_root"]),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "pages", return_value=comments),
              patch.object(release.subprocess, "run", return_value=SimpleNamespace(returncode=0))):
            return release._native_repair_proposal(REPO, fixture["repair"]["state"])

    def test_latest_owner_request_retires_old_malformed_and_edited_proposals_first(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            old = fixture["proposal_comment"]
            old["body"] = "Completed repair. <!-- fork-review-disposition:v1 { broken -->"
            old["updated_at"] = "2026-10-20T02:30:00Z"
            newer_request = {
                "id": 20, "created_at": "2026-10-20T03:00:00Z",
                "updated_at": "2026-10-20T03:00:00Z",
                "user": {"login": "warelik", "type": "User"},
                "body": f"@codex fix again\n<!-- 9router-fix:{fixture['repair']['state']['config']}:2 -->",
            }
            proposal, comment = self._read_native_proposal(
                fixture, [fixture["comments"][0], old, newer_request])
        self.assertIsNone(proposal)
        self.assertIsNone(comment)

    def test_proposal_order_breaks_timestamp_ties_by_positive_native_comment_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            owner_request = {
                "id": 20, "created_at": "2026-10-20T02:00:00Z",
                "updated_at": "2026-10-20T02:00:00Z",
                "user": {"login": "warelik", "type": "User"},
                "body": f"@codex fix again\n<!-- 9router-fix:{fixture['repair']['state']['config']}:2 -->",
            }
            proposal, comment = self._read_native_proposal(
                fixture, [fixture["comments"][0], fixture["proposal_comment"], owner_request])
            self.assertIsNone(proposal)
            self.assertIsNone(comment)

            newer = {**fixture["proposal_comment"], "id": 21}
            proposal, comment = self._read_native_proposal(
                fixture, [fixture["comments"][0], owner_request, newer])
        self.assertEqual(proposal, fixture["proposal"])
        self.assertEqual(comment["id"], 21)

    def test_current_malformed_proposal_after_latest_request_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            newer_request = {
                "id": 20, "created_at": "2026-10-20T02:00:00Z",
                "updated_at": "2026-10-20T02:00:00Z",
                "user": {"login": "warelik", "type": "User"},
                "body": f"@codex fix again\n<!-- 9router-fix:{fixture['repair']['state']['config']}:2 -->",
            }
            current = {**fixture["proposal_comment"], "id": 21,
                       "created_at": "2026-10-20T03:00:00Z",
                       "updated_at": "2026-10-20T03:00:00Z",
                       "body": "Completed repair. <!-- fork-review-disposition:v1 { broken -->"}
            with self.assertRaisesRegex(ValueError, "malformed or duplicate proposal"):
                self._read_native_proposal(
                    fixture, [fixture["comments"][0], newer_request, current])

    def test_fixed_application_rejects_split_source_and_regression_carriers(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            with patch.object(release, "_proposal_carrier", side_effect=["patches/code.patch", "patches/test.patch"]):
                with self.assertRaisesRegex(ValueError, "share one ordered patch carrier"):
                    self._read_disposition_fixture(fixture)

    def test_explicit_codex_proposal_binds_fixed_source_patch_and_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["finding_id"], "inline:6:13")
        self.assertEqual(result[0]["candidate_id"], fixture["candidate"]["_candidate_id"])
        self.assertEqual(result[0]["source_sha"], fixture["candidate"]["application_sha"])
        self.assertEqual(result[0]["status"], "fixed")
        self.assertIn("code location `src/fix.js`", result[0]["evidence"])

    def test_changed_patch_metadata_cannot_claim_an_unchanged_application_fix(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, existing_carrier=True, carrier_metadata_only=True)
            with self.assertRaisesRegex(ValueError, "actual seed-to-candidate"):
                self._read_disposition_fixture(fixture)

    def test_disproved_proposal_accepts_exact_unchanged_patch_carrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, existing_carrier=True, status="disproved")
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["status"], "disproved")
        self.assertIn(f"code diff SHA-256 `{hashlib.sha256(b'').hexdigest()}`",
                      result[0]["evidence"])

    def test_disproved_proposal_accepts_relevant_changed_patch_carrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, existing_carrier=True, changed_carrier=True, status="disproved")
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["status"], "disproved")
        self.assertIn("code location `open-sse/other.js`", result[0]["evidence"])
        match = release.DISPOSITION_PROPOSAL_EVIDENCE.fullmatch(result[0]["evidence"])
        self.assertNotEqual(match.group("code_sha"), hashlib.sha256(b"").hexdigest())

    def test_policy_proposal_binds_sanitized_configuration_and_python_test_function(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary, policy_repair=True)
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source_sha"], fixture["candidate"]["configuration_sha"])
        self.assertIn("code location `scripts/release.py`", result[0]["evidence"])
        self.assertIn("regression path `scripts/test_repair.py`", result[0]["evidence"])
        self.assertIn("regression case `test_policy_source_fix`", result[0]["evidence"])
        marker = release._owner_disposition_marker(fixture["candidate"], result)
        payload = json.loads(marker.split(" ", 2)[2][:-4])
        self.assertEqual(payload["source_sha"], fixture["candidate"]["configuration_sha"])

    def test_policy_proposal_refuses_a_python_test_outside_the_exact_repair_diff(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary, policy_repair=True)
            item = fixture["proposal"]["findings"][0]
            # Use a real, unchanged baseline test: failure must be the delta
            # requirement, not a missing file or a fabricated source excerpt.
            item["evidence"] = (item["evidence"].replace(
                "regression path `scripts/test_repair.py`",
                "regression path `scripts/test_maintenance.py`").replace(
                "regression case `test_policy_source_fix`",
                "regression case `test_policy_marker_is_stable`").replace(
                'regression location `assert repair_target() == "fixed"`',
                'regression location `assert policy_marker() == "stable"`'))
            item["evidence"] = re.sub(
                r"(regression diff SHA-256 `)[0-9a-f]{64}(`)",
                lambda match: match[1] + hashlib.sha256(b"").hexdigest() + match[2],
                item["evidence"])
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            with self.assertRaisesRegex(ValueError, "changed source and Python test"):
                self._read_disposition_fixture(fixture)

    def test_full_formal_policy_disproof_accepts_exact_unchanged_code_and_python_test(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, policy_repair=True, policy_disproved_unchanged=True,
                status="disproved")
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["status"], "disproved")
        self.assertEqual(result[0]["source_sha"], fixture["candidate"]["configuration_sha"])
        self.assertIn("code location `scripts/maintenance.py`", result[0]["evidence"])
        self.assertIn("regression diff SHA-256 `" + hashlib.sha256(b"").hexdigest() + "`",
                      result[0]["evidence"])

    def test_policy_disproof_can_use_unchanged_application_patch_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, policy_repair=True, policy_application_disproof=True,
                status="disproved")
            result = self._read_disposition_fixture(fixture)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source_sha"], fixture["candidate"]["configuration_sha"])
        self.assertIn("code location `src/fix.js`", result[0]["evidence"])
        self.assertIn("code diff SHA-256 `" + hashlib.sha256(b"").hexdigest() + "`",
                      result[0]["evidence"])

    def test_fresh_full_policy_disproof_posts_only_after_both_native_scopes_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, policy_repair=True, policy_disproved_unchanged=True,
                status="disproved")
            fresh_id = "inline:6:97"
            fresh = {**fixture["finding"], "finding_id": fresh_id,
                     "candidate_id": fixture["candidate"]["_candidate_id"],
                     "native_id": 97,
                     "source_sha": fixture["full_evidence"]["target"]["review_sha"],
                     "source_tree_sha": fixture["full_evidence"]["target"]["review_commit"]["tree"]["sha"]}
            fixture["proposal"]["findings"].append(
                {**fixture["proposal"]["findings"][0], "finding_id": fresh_id})
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            full_completed = "2026-10-20T02:00:00Z"
            delta_completed = "2026-10-20T02:10:00Z"
            full = {**fixture["full_evidence"],
                    "result": {"complete": True, "candidate_id": fixture["candidate"]["_candidate_id"],
                               "completed_at": full_completed},
                    "target": {**fixture["full_evidence"]["target"], "pr": {"number": 1}}}
            delta = {"result": {"complete": True,
                                "candidate_id": fixture["candidate"]["_candidate_id"],
                                "completed_at": delta_completed},
                     "target": {"pr": {"number": 2}}}
            posted_rows = []

            def native(route, **_kwargs):
                if route == f"repos/{REPO}/pulls/17":
                    return fixture["pull"]
                if route == f"repos/{REPO}/commits/downstream":
                    return {"sha": fixture["repair"]["state"]["config"]}
                raise AssertionError(f"Unexpected native route: {route}")

            def post(_repo, _pr, _candidate, dispositions):
                for index, item in enumerate(dispositions):
                    posted_rows.append({**item, "native_comment": {
                        "id": 40 + index, "created_at": "2026-10-20T02:30:00Z",
                        "updated_at": "2026-10-20T02:30:00Z",
                        "user": {"login": "warelik", "type": "User"},
                    }})

            lifecycle = SimpleNamespace(
                candidate_identity=lambda candidate: candidate["_candidate_id"])
            with (patch.object(release, "ROOT", fixture["config_root"]),
                  patch.object(release, "api", side_effect=native),
                  patch.object(release, "pages", return_value=fixture["comments"]),
                  patch.object(release, "_shared_file", return_value=fixture["baseline_manifest"]),
                  patch.object(release, "_verify_disposition_review_pull"),
                  patch.object(release, "_post_owner_dispositions", side_effect=post) as owner_post,
                  patch.object(release, "_carried_shared_findings",
                               return_value=(None, [fixture["finding"], fresh], posted_rows))):
                _, dispositions = release._authorize_shared_dispositions(
                    REPO, fixture["candidate"], lifecycle, PUBLISHED, full, delta,
                    [fixture["finding"]], {fresh_id}, [], fixture["patch_root"],
                    repair=fixture["repair"], app_root=fixture["app_root"],
                    fresh_findings=[fresh])
        owner_post.assert_called_once()
        self.assertEqual({item["finding_id"] for item in owner_post.call_args.args[3]},
                         {fixture["finding"]["finding_id"], fresh_id})
        fresh_row = next(item for item in dispositions if item["finding_id"] == fresh_id)
        self.assertEqual(fresh_row["source_sha"], fixture["candidate"]["configuration_sha"])
        self.assertGreater(fresh_row["native_comment"]["created_at"], full_completed)
        self.assertGreater(fresh_row["native_comment"]["created_at"], delta_completed)

    def test_existing_owner_post_makes_exact_callback_retry_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            finding = fixture["finding"]
            owner_row = {
                "finding_id": finding["finding_id"],
                "candidate_id": fixture["candidate"]["_candidate_id"],
                "source_sha": fixture["candidate"]["application_sha"],
                "status": fixture["proposal"]["findings"][0]["status"],
                "evidence": fixture["proposal"]["findings"][0]["evidence"],
                "native_comment": {
                    "id": 31, "created_at": "2026-10-20T02:30:00Z",
                    "updated_at": "2026-10-20T02:30:00Z",
                    "user": {"login": "warelik", "type": "User"},
                },
            }
            def native(route, **_kwargs):
                if route == f"repos/{REPO}/pulls/17":
                    return fixture["pull"]
                if route == f"repos/{REPO}/commits/downstream":
                    return {"sha": fixture["repair"]["state"]["config"]}
                raise AssertionError(f"Unexpected native route: {route}")

            full = {**fixture["full_evidence"],
                    "result": {"complete": True,
                               "candidate_id": fixture["candidate"]["_candidate_id"]},
                    "target": {**fixture["full_evidence"]["target"], "pr": {"number": 1}}}
            delta = {"result": {"complete": True,
                                "candidate_id": fixture["candidate"]["_candidate_id"]},
                     "target": {"pr": {"number": 2}}}
            lifecycle = SimpleNamespace(
                candidate_identity=lambda candidate: candidate["_candidate_id"])
            with (patch.object(release, "ROOT", fixture["config_root"]),
                  patch.object(release, "api", side_effect=native),
                  patch.object(release, "pages", return_value=fixture["comments"]),
                  patch.object(release, "_shared_file", return_value=fixture["baseline_manifest"]),
                  patch.object(release, "_verify_disposition_review_pull"),
                  patch.object(release, "_post_owner_dispositions") as post):
                result, dispositions = release._authorize_shared_dispositions(
                    REPO, fixture["candidate"], lifecycle, PUBLISHED, full, delta,
                    [finding], set(), [owner_row], fixture["patch_root"],
                    repair=fixture["repair"], app_root=fixture["app_root"])
        self.assertEqual(result, [finding])
        self.assertEqual(dispositions, [owner_row])
        post.assert_not_called()

    def test_proposal_must_match_existing_native_owner_status_and_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            owner_row = {
                "finding_id": fixture["finding"]["finding_id"],
                "candidate_id": fixture["candidate"]["_candidate_id"],
                "source_sha": fixture["candidate"]["application_sha"],
                "status": "disproved",
                "evidence": fixture["proposal"]["findings"][0]["evidence"],
                "native_comment": {
                    "id": 32, "created_at": "2026-10-20T02:30:00Z",
                    "updated_at": "2026-10-20T02:30:00Z",
                    "user": {"login": "warelik", "type": "User"},
                },
            }
            with self.assertRaisesRegex(ValueError, "conflicts with the immutable current owner"):
                self._read_disposition_fixture(fixture, already_disposed=[owner_row])

    def test_partial_retry_posts_only_the_still_unresolved_carried_finding(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            first = fixture["finding"]
            second_id = "inline:6:14"
            second = {**first, "finding_id": second_id}
            second_entry = {**fixture["proposal"]["findings"][0], "finding_id": second_id}
            fixture["proposal"]["findings"].append(second_entry)
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            closed = {
                "finding_id": first["finding_id"],
                "candidate_id": fixture["candidate"]["_candidate_id"],
                "source_sha": fixture["candidate"]["application_sha"],
                "status": fixture["proposal"]["findings"][0]["status"],
                "evidence": fixture["proposal"]["findings"][0]["evidence"],
                "native_comment": {
                    "id": 33, "created_at": "2026-10-20T02:30:00Z",
                    "updated_at": "2026-10-20T02:30:00Z",
                    "user": {"login": "warelik", "type": "User"},
                },
            }
            dispositions, proposal, _ = self._read_disposition_batch(
                fixture, known=[first, second], already_disposed=[closed])
        self.assertEqual([item["finding_id"] for item in dispositions], [second_id])
        self.assertEqual({item["finding_id"] for item in proposal["findings"]},
                         {first["finding_id"], second_id})

    def test_proposal_assertion_must_belong_to_its_named_javascript_test(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            item = fixture["proposal"]["findings"][0]
            item["evidence"] = item["evidence"].replace(
                "regression case `fix rejects stale input`",
                "regression case `legacy`")
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            with self.assertRaisesRegex(ValueError, "not unique inside its named test"):
                self._read_disposition_fixture(fixture)

    def test_mixed_fresh_and_carried_batch_preserves_full_report_but_posts_only_carried(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            fresh_id = "inline:6:14"
            fresh = {**fixture["proposal"]["findings"][0],
                     "finding_id": fresh_id, "status": "fixed"}
            fixture["proposal"]["findings"].append(fresh)
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            carried = fixture["finding"]
            fresh_finding = {**carried, "finding_id": fresh_id}
            dispositions, original_proposal, original_comment = self._read_disposition_batch(
                fixture, known=[carried, fresh_finding], fresh_ids={fresh_id})
        self.assertEqual([item["finding_id"] for item in dispositions], [carried["finding_id"]])
        self.assertEqual({item["finding_id"] for item in original_proposal["findings"]},
                         {carried["finding_id"], fresh_id})
        self.assertEqual(original_comment["id"], fixture["proposal_comment"]["id"])

    def test_mixed_batch_rechecks_full_proposal_before_posting_carried_subset(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            fresh_id = "inline:6:14"
            fresh_entry = {**fixture["proposal"]["findings"][0],
                           "finding_id": fresh_id, "status": "fixed"}
            fixture["proposal"]["findings"].append(fresh_entry)
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            known = [fixture["finding"], {**fixture["finding"], "finding_id": fresh_id}]
            fresh_ids = {fresh_id}
            batch = self._read_disposition_batch(fixture, known=known, fresh_ids=fresh_ids)
            full = {"result": {"complete": True, "candidate_id": "f" * 64},
                    "target": {"pr": {"number": 1}}}
            delta = {"result": {"complete": True, "candidate_id": "f" * 64},
                     "target": {"pr": {"number": 2}}}
            lifecycle = SimpleNamespace(candidate_identity=lambda _candidate: "f" * 64)
            with (patch.object(release, "_verify_disposition_review_pull"),
                  patch.object(release, "_verified_disposition_proposals", return_value=batch),
                  patch.object(release, "_native_repair_proposal",
                               return_value=(fixture["proposal"], fixture["proposal_comment"])),
                  patch.object(release, "_recheck_native_repair_proposal"),
                  patch.object(release, "_post_owner_dispositions") as post,
                  patch.object(release, "_carried_shared_findings", return_value=(None, known, []))):
                release._authorize_shared_dispositions(
                    REPO, fixture["candidate"], lifecycle, PUBLISHED, full, delta,
                    known, fresh_ids, [], Path("/unused"), repair=fixture["repair"],
                    app_root=fixture["app_root"])
        posted = post.call_args.args[3]
        self.assertEqual([item["finding_id"] for item in posted], [fixture["finding"]["finding_id"]])

    def test_codex_proposal_requires_every_carried_id_and_exact_pushed_head(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            second = {**fixture["finding"], "finding_id": "inline:6:14",
                      "path": "src/other.js"}
            with self.assertRaisesRegex(ValueError, "cover every carried finding"):
                self._read_disposition_fixture(fixture, known=[fixture["finding"], second])

            stale = {**fixture["proposal"], "source_sha": fixture["repair"]["state"]["config"]}
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(stale, sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            with self.assertRaisesRegex(ValueError, "source head"):
                self._read_disposition_fixture(fixture)

        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            entry = fixture["proposal"]["findings"][0]
            fixture["proposal"]["findings"] = [entry, entry]
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            with self.assertRaisesRegex(ValueError, "cover every carried finding"):
                self._read_disposition_fixture(fixture)

    def test_codex_proposal_diff_hash_must_match_exact_patch_carrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            entry = fixture["proposal"]["findings"][0]
            match = release.DISPOSITION_PROPOSAL_EVIDENCE.fullmatch(entry["evidence"])
            changed_hash = "0" * 64 if match.group("code_sha") != "0" * 64 else "1" * 64
            entry["evidence"] = entry["evidence"].replace(
                f"code diff SHA-256 `{match.group('code_sha')}`",
                f"code diff SHA-256 `{changed_hash}`")
            body = ("Completed repair.\n<!-- fork-review-disposition:v1 "
                    + json.dumps(fixture["proposal"], sort_keys=True, separators=(",", ":")) + " -->")
            fixture["proposal_comment"]["body"] = body
            fixture["comments"][1]["body"] = body
            with self.assertRaisesRegex(ValueError, "diff hashes differ"):
                self._read_disposition_fixture(fixture)

    def test_untrusted_or_edited_proposal_comment_cannot_create_dispositions(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, comment_user={"login": "contributor", "type": "User"})
            self.assertEqual(self._read_disposition_fixture(fixture), [])

        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(
                temporary, comment_updated="2026-10-20T02:01:00Z")
            with self.assertRaisesRegex(ValueError, "edited|native comment identity"):
                self._read_disposition_fixture(fixture)

        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            fixture["proposal_comment"]["performed_via_github_app"]["id"] = 0
            with self.assertRaisesRegex(ValueError, "native app identity"):
                self._read_disposition_fixture(fixture)

    def test_fresh_pair_finding_remains_unresolved_even_with_carried_proposal(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self._disposition_proposal_fixture(temporary)
            result = self._read_disposition_fixture(
                fixture, fresh_ids={fixture["finding"]["finding_id"]})
        self.assertEqual(result, [])

    def test_owner_disposition_is_immutable_read_back_with_owner_credentials(self):
        candidate = {"_candidate_id": "f" * 64, "application_sha": HEAD,
                     "configuration_sha": CONFIG}
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

    def test_codex_fix_prompt_requests_proposal_after_push_and_defers_tests_until_final_ci(self):
        prompt = release.repair_text(STATE, 1, "failure evidence", "2026-10-20T01:00:00Z")
        self.assertIn("Do not run application imports, tests", prompt)
        self.assertIn("both fresh exact-source reviews", prompt)
        self.assertIn("fork-review-disposition:v1", prompt)
        self.assertIn('"source_sha":"<exact pushed repair PR head>"', prompt)
        self.assertIn("every unresolved carried finding ID exactly once", prompt)
        self.assertIn("or a changed carrier", prompt)
        self.assertIn("both fresh reviews", prompt)
        self.assertIn("unique Python `test_*` function", prompt)
        self.assertIn("candidate configuration SHA for policy repairs", prompt)
        self.assertIn("authoritative", prompt)

    def test_history_is_consumed_at_prepare_recheck_and_published_recovery(self):
        module = ast.parse(Path(release.__file__).read_text(encoding="utf-8"))
        functions = {node.name: node for node in module.body if isinstance(node, ast.FunctionDef)}
        for name in ("prepare_shared", "_recheck_shared_reviews", "_published_release_recovery"):
            calls = [node for node in ast.walk(functions[name]) if isinstance(node, ast.Call)]
            self.assertTrue(any(isinstance(call.func, ast.Name)
                                and call.func.id == "_carried_shared_findings" for call in calls),
                            f"{name} must pass complete native history into the shared pair gate")


class NativeAttemptEvidenceTests(unittest.TestCase):
    baseline_context = {
        "repository": REPO,
        "baseline": {"candidate": {}, "release_id": 8,
                     "published_at": PUBLISHED, "metadata_sha256": "e" * 64},
    }

    def workflow_run(self, run_id, *, run_attempt=1, status="completed",
                     created_at="2026-10-01T00:00:00Z", updated_at="2026-10-19T10:00:00Z"):
        record = {
            "id": run_id, "run_attempt": run_attempt,
            "path": ".github/workflows/release.yml", "status": status,
            "created_at": created_at,
        }
        if updated_at is not None:
            record["updated_at"] = updated_at
        return record

    def test_completed_history_before_publication_is_filtered_before_attempt_reads(self):
        runs = [self.workflow_run(run_id, run_attempt=4, updated_at="2026-10-19T08:59:59Z")
                for run_id in range(1, 501)]
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                         clear=True),
              patch.object(release, "_all_shared_review_pulls", return_value=[]),
              patch.object(release, "pages", return_value=[]),
              patch.object(release, "_workflow_run_records", return_value=(runs, True)),
              patch.object(release, "api") as native,
              patch.object(release, "_native_attempt_jobs") as jobs):
            history = release._final_history(REPO, self.baseline_context, object())
        self.assertTrue(history["complete"])
        self.assertEqual(history["attempts"], [])
        native.assert_not_called()
        jobs.assert_not_called()

    def test_old_created_run_completed_after_baseline_still_blocks_unreserved_heavy_attempt(self):
        listed = self.workflow_run(
            71, created_at="2026-10-01T00:00:00Z", updated_at="2026-10-19T10:00:00Z")
        attempt = {"id": 71, "run_attempt": 1, "status": "completed",
                   "updated_at": "2026-10-19T10:00:00Z"}
        job = {"name": "Build And Smoke Test One Container", "status": "completed",
               "conclusion": "success", "started_at": "2026-10-19T09:30:00Z",
               "steps": [{"name": "Build", "status": "completed", "conclusion": "success"}]}
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                         clear=True),
              patch.object(release, "_all_shared_review_pulls", return_value=[]),
              patch.object(release, "pages", return_value=[]),
              patch.object(release, "_workflow_run_records", return_value=([listed], True)),
              patch.object(release, "api", return_value=attempt) as native,
              patch.object(release, "_native_attempt_jobs", return_value=([job], "jobs/71")) as jobs,
              self.assertRaisesRegex(ValueError, "without its exact reservation")):
            release._final_history(REPO, self.baseline_context, object())
        native.assert_called_once_with(f"repos/{REPO}/actions/runs/71/attempts/1")
        jobs.assert_called_once()

    def test_active_old_run_is_not_filtered_by_its_old_creation_or_update_time(self):
        listed = self.workflow_run(
            72, status="in_progress", created_at="2026-10-01T00:00:00Z",
            updated_at="2026-10-19T08:00:00Z")
        attempt = {"id": 72, "run_attempt": 1, "status": "in_progress",
                   "updated_at": "2026-10-19T08:00:00Z"}
        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                         clear=True),
              patch.object(release, "_all_shared_review_pulls", return_value=[]),
              patch.object(release, "pages", return_value=[]),
              patch.object(release, "_workflow_run_records", return_value=([listed], True)),
              patch.object(release, "api", return_value=attempt) as native,
              patch.object(release, "_native_attempt_jobs", return_value=([], "jobs/72")) as jobs):
            history = release._final_history(REPO, self.baseline_context, object())
        self.assertTrue(history["complete"])
        self.assertEqual(history["attempts"], [])
        native.assert_called_once_with(f"repos/{REPO}/actions/runs/72/attempts/1")
        jobs.assert_called_once()

    def test_completed_old_attempt_skips_jobs_but_later_attempt_is_still_examined(self):
        listed = self.workflow_run(73, run_attempt=2, updated_at="2026-10-19T10:00:00Z")
        attempts = {
            f"repos/{REPO}/actions/runs/73/attempts/1": {
                "id": 73, "run_attempt": 1, "status": "completed",
                "updated_at": "2026-10-19T08:30:00Z",
            },
            f"repos/{REPO}/actions/runs/73/attempts/2": {
                "id": 73, "run_attempt": 2, "status": "completed",
                "updated_at": "2026-10-19T10:00:00Z",
            },
        }

        def native(route):
            return attempts[route]

        with (patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                         clear=True),
              patch.object(release, "_all_shared_review_pulls", return_value=[]),
              patch.object(release, "pages", return_value=[]),
              patch.object(release, "_workflow_run_records", return_value=([listed], True)),
              patch.object(release, "api", side_effect=native) as api,
              patch.object(release, "_native_attempt_jobs", return_value=([], "jobs/73/2")) as jobs):
            history = release._final_history(REPO, self.baseline_context, object())
        self.assertTrue(history["complete"])
        self.assertEqual(api.call_count, 2)
        jobs.assert_called_once_with(REPO, 73, 2)

    def test_completed_run_and_attempt_timestamps_fail_closed_when_missing_or_malformed(self):
        for updated_at in (None, "not-a-timestamp"):
            listed = self.workflow_run(74, updated_at=updated_at)
            with self.subTest(run_updated_at=updated_at), \
                    patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                               clear=True), \
                    patch.object(release, "_all_shared_review_pulls", return_value=[]), \
                    patch.object(release, "pages", return_value=[]), \
                    patch.object(release, "_workflow_run_records", return_value=([listed], True)), \
                    patch.object(release, "api") as native, \
                    self.assertRaisesRegex(ValueError, "Completed native workflow run"):
                release._final_history(REPO, self.baseline_context, object())
            native.assert_not_called()

        listed = self.workflow_run(75, updated_at="2026-10-19T10:00:00Z")
        for updated_at in (None, "not-a-timestamp"):
            attempt = {"id": 75, "run_attempt": 1, "status": "completed"}
            if updated_at is not None:
                attempt["updated_at"] = updated_at
            with self.subTest(attempt_updated_at=updated_at), \
                    patch.dict(os.environ, {"GITHUB_RUN_ID": "9000", "GITHUB_RUN_ATTEMPT": "1"},
                               clear=True), \
                    patch.object(release, "_all_shared_review_pulls", return_value=[]), \
                    patch.object(release, "pages", return_value=[]), \
                    patch.object(release, "_workflow_run_records", return_value=([listed], True)), \
                    patch.object(release, "api", return_value=attempt), \
                    patch.object(release, "_native_attempt_jobs") as jobs, \
                    self.assertRaisesRegex(ValueError, "Completed native workflow attempt"):
                release._final_history(REPO, self.baseline_context, object())
            jobs.assert_not_called()

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
    def test_release_tags_bind_recipe_and_keep_legacy_tags_readable(self):
        version = "1.2.3"
        upstream = "a" * 40
        patchset = "b" * 64
        recipe = "c" * 64
        changed_recipe = "d" * 64

        tag = release._release_tag(version, upstream, patchset, recipe)
        self.assertEqual(tag, f"build-{version}-{'a' * 12}-{'b' * 12}-r{'c' * 12}")
        self.assertNotEqual(tag, release._release_tag(version, upstream, patchset, changed_recipe))

        legacy_tag = release._legacy_release_tag(version, upstream, patchset)
        legacy = release._parse_release_tag(legacy_tag)
        current = release._parse_release_tag(tag)
        self.assertIsNotNone(legacy)
        self.assertIsNotNone(current)
        self.assertIsNone(legacy.group("recipe"))
        self.assertEqual(current.group("recipe"), recipe[:12])
        release._validate_recipe_tag(legacy, {})
        release._validate_recipe_tag(current, {"recipe_sha256": recipe})
        with self.assertRaisesRegex(ValueError, "does not match its provenance recipe"):
            release._validate_recipe_tag(current, {"recipe_sha256": changed_recipe})
        with self.assertRaisesRegex(ValueError, "does not match its provenance recipe"):
            release._validate_recipe_tag(current, {})

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
            "    runs-on: ubuntu-24.04\n"
            "    env:\n"
            "      IMAGE_TAG: 9router-reviewed:${{ needs.prepare.outputs.sha }}\n"
            "      APP_VERSION: ${{ needs.prepare.outputs.version }}\n"
            "    steps:\n"
            f"      - uses: docker/setup-buildx-action@{build_pin}\n"
            "      - name: Build\n"
            f"        uses: docker/build-push-action@{push_pin}\n"
            "        with:\n"
            "          context: https://github.com/example/repo.git#${{ github.sha }}\n"
            "          platforms: linux/amd64\n"
            "          target: runtime\n"
            "          build-args: APP_VERSION=${{ env.APP_VERSION }}\n"
            "          labels: |\n"
            "            org.opencontainers.image.source=https://github.com/example/repo\n"
            "          outputs: type=docker,dest=/tmp/image.tar\n"
        )
        original = release._recipe_sha256(b"FROM node", workflow, Lifecycle)
        prepare_change = workflow.replace(prepare_pin, "d" * 40)
        self.assertEqual(release._recipe_sha256(b"FROM node", prepare_change, Lifecycle), original)
        action_change = workflow.replace(build_pin, "e" * 40)
        self.assertNotEqual(release._recipe_sha256(b"FROM node", action_change, Lifecycle), original)
        env_change = workflow.replace(
            "APP_VERSION: ${{ needs.prepare.outputs.version }}",
            "APP_VERSION: ${{ needs.prepare.outputs.config_sha }}")
        self.assertNotEqual(release._recipe_sha256(b"FROM node", env_change, Lifecycle), original)
        config_change = workflow.replace("docker/setup-buildx-action@" + build_pin,
                                         "docker/setup-buildx-action@" + build_pin + "\n        with:\n          driver: docker")
        self.assertNotEqual(release._recipe_sha256(b"FROM node", config_change, Lifecycle), original)
        for changed_input in (
                workflow.replace("github.com/example/repo.git", "github.com/other/repo.git"),
                workflow.replace("target: runtime", "target: debug"),
                workflow.replace("image.source=https://github.com/example/repo",
                                 "image.source=https://github.com/other/repo")):
            with self.subTest(build_input=changed_input):
                self.assertNotEqual(release._recipe_sha256(b"FROM node", changed_input, Lifecycle),
                                    original)
        unrelated_change = workflow.replace(
            "      - uses: docker/setup-buildx-action@" + prepare_pin,
            "      - name: unrelated preparation\n        run: true\n"
            "      - uses: docker/setup-buildx-action@" + prepare_pin)
        self.assertEqual(release._recipe_sha256(b"FROM node", unrelated_change, Lifecycle), original)
        step_rename = workflow.replace("- name: Build\n", "- name: Build container\n")
        self.assertEqual(release._recipe_sha256(b"FROM node", step_rename, Lifecycle), original)
        metadata_only = workflow.replace(
            "      APP_VERSION: ${{ needs.prepare.outputs.version }}\n",
            "      APP_VERSION: ${{ needs.prepare.outputs.version }}\n"
            "      CONFIG_SHA: ${{ github.sha }}\n"
            "      CANDIDATE_ID: ${{ needs.prepare.outputs.candidate_id }}\n"
            "      FULL_REVIEW_PR: ${{ needs.prepare.outputs.full_pr }}\n")
        self.assertEqual(release._recipe_sha256(b"FROM node", metadata_only, Lifecycle), original)
        referenced_metadata = metadata_only.replace(
            "          labels: |\n", "          labels: |\n"
            "            io.example.configuration=${{ env.CONFIG_SHA }}\n")
        changed_reference = referenced_metadata.replace(
            "CONFIG_SHA: ${{ github.sha }}", "CONFIG_SHA: ${{ needs.prepare.outputs.config_sha }}")
        self.assertNotEqual(release._recipe_sha256(b"FROM node", referenced_metadata, Lifecycle),
                            release._recipe_sha256(b"FROM node", changed_reference, Lifecycle))
        unknown_environment = metadata_only.replace(
            "    env:\n", "    env:\n      DOCKER_BUILDKIT: 1\n")
        self.assertNotEqual(release._recipe_sha256(b"FROM node", unknown_environment, Lifecycle), original)

    def test_legacy_recipe_is_accepted_only_when_derived_from_exact_published_source(self):
        class Lifecycle:
            @staticmethod
            def patch_digest(files):
                digest = hashlib.sha256()
                for name, content in sorted(files):
                    digest.update(name.encode() + b"\0" + content + b"\0")
                return digest.hexdigest()

        workflow = (
            "jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n"
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
            if path == f"repos/{REPO}/git/ref/heads/downstream":
                return {"ref": "refs/heads/downstream", "object": {"type": "commit", "sha": HEAD}}
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
        adopted = False

        def native(path, *, method="GET", data=None, token=None):
            nonlocal adopted
            calls.append((path, method, data))
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": HEAD if adopted else CONFIG}
            if path == f"repos/{REPO}/git/commits/{HEAD}":
                return {"sha": HEAD, "parents": [{"sha": CONFIG}],
                        "message": "Review sanitized 9router repair #2"}
            if path == f"repos/{REPO}/git/refs/heads/downstream" and method == "PATCH":
                adopted = True
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

    def test_workflow_recipe_fast_forward_uses_owner_token_to_trigger_native_push(self):
        product = {"mode": "100644", "blob_sha": HEAD}
        tree = {"Dockerfile": product, "patches/0001-fix.patch": product,
                "patches/source.json": {"mode": "100644", "blob_sha": UPSTREAM}}
        policy_id, trusted_pin = "f" * 64, "9" * 40
        calls = []
        adopted = False

        def native(path, *, method="GET", data=None, token=None):
            nonlocal adopted
            calls.append((path, method, data, token))
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": HEAD if adopted else CONFIG}
            if path == f"repos/{REPO}/git/commits/{HEAD}":
                return {"sha": HEAD, "parents": [{"sha": CONFIG}],
                        "message": "Review sanitized 9router repair #2 at " + "a" * 40}
            if path == f"repos/{REPO}/git/refs/heads/downstream":
                adopted = True
                return {"ref": "refs/heads/downstream", "object": {
                    "type": "commit", "sha": HEAD}}
            self.fail(f"Unexpected native API request: {method} {path}")

        class Lifecycle:
            def validate_adoption(self, *_args):
                return True

        context = {"candidate": {"configuration_sha": HEAD}, "base_config_sha": CONFIG,
                   "candidate_id": policy_id,
                   "policy_validation": {"candidate_id": policy_id, "source": "native-run",
                                         "verified": True}}
        with (patch.dict(os.environ, {"TRUSTED_POLICY": trusted_pin}),
              patch.object(release, "owner_token", return_value="fixture-owner"),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "_native_full_tree", return_value=tree),
              patch.object(release, "_advance_trusted_policy_pin", return_value={})):
            release._validate_and_adopt_config(
                REPO, context, Lifecycle(), workflow_transition=True)
        adoption = next(call for call in calls if call[0].endswith("/git/refs/heads/downstream")
                        and call[1] == "PATCH")
        self.assertEqual(adoption[2], {"sha": HEAD, "force": False})
        self.assertEqual(adoption[3], "fixture-owner")

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
            if path == f"repos/{REPO}/git/ref/heads/downstream":
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
                    if path == f"repos/{REPO}/git/ref/heads/downstream":
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

        pages_calls = []

        def native_pages(path):
            pages_calls.append(path)
            if path == f"repos/{REPO}/pulls?state=all":
                return [closed, opened]
            if path == f"repos/{REPO}/issues/2/comments":
                return []
            self.fail(f"Unexpected paginated API request: {path}")

        with (patch.object(release, "pages", side_effect=native_pages),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "run", side_effect=command)):
            self.assertEqual(release._cleanup_shared_refs(REPO, lifecycle), [])
        self.assertEqual(lifecycle.plans, 2)
        self.assertEqual(lifecycle.asserted_active_refs, {"unrelated", "downstream"})
        self.assertEqual(pages_calls.count(f"repos/{REPO}/pulls?state=all"), 2)

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
            engine_env = kwargs["env"]
            self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "CODEX_REQUEST_TOKEN",
                              "NINEROUTER_KEY", "GITHUB_ENV", "GITHUB_PATH"} & engine_env.keys())
            env = dict(args[i + 1].split("=", 1) for i, value in enumerate(args) if value == "--env")
            self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "CODEX_REQUEST_TOKEN",
                              "NINEROUTER_KEY", "GITHUB_ENV", "GITHUB_PATH"} & env.keys())
            self.assertEqual(engine_env.get("HOME"), os.environ.get("HOME"))
            self.assertNotEqual(engine_env.get("HOME"), env["HOME"])
            self.assertEqual(env["CI"], "true")
            self.assertEqual(args[:2], ["docker", "run"])
            self.assertEqual(args[2], "--name")
            self.assertRegex(args[3], r"^9router-policy-tests-[A-Za-z0-9_-]+$")
            self.assertEqual(args[4:6], ["--rm", "--read-only"])
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

    def test_policy_workflows_install_the_exact_parser_in_both_jobs(self):
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
            "finalize": {"contents": "read", "issues": "write", "pull-requests": "write", "actions": "read"},
            "policy-only": {"contents": "write", "pull-requests": "write", "actions": "write"},
            # The test job inherits the workflow-wide read-only permission.
            "test": None,
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
            "test": {"name", "needs", "if", "runs-on", "timeout-minutes", "env", "steps"},
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
            "test": """always() && !cancelled() &&
                needs.prepare.result == 'success' && needs.finalize.result == 'success' &&
                needs.prepare.outputs.review_ready == 'true' &&
                needs.finalize.outputs.ready == 'true' && needs.finalize.outputs.mode == 'application' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.finalize.outputs.validated_run_id == github.run_id""",
            "build": """always() && !cancelled() &&
                needs.prepare.result == 'success' && needs.finalize.result == 'success' &&
                needs.prepare.outputs.review_ready == 'true' && needs.finalize.outputs.ready == 'true' &&
                needs.finalize.outputs.mode == 'application' && needs.test.result == 'success' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                needs.finalize.outputs.validated_run_id == github.run_id""",
            "publish": """always() && needs.prepare.outputs.review_ready == 'true' &&
                needs.finalize.result == 'success' && needs.finalize.outputs.ready == 'true' &&
                needs.prepare.outputs.prepared_run_id == github.run_id &&
                (((needs.finalize.outputs.mode == 'workflow-transition' ||
                needs.finalize.outputs.mode == 'workflow-transition-recovery') &&
                needs.finalize.outputs.transition_run_id == github.run_id &&
                needs.finalize.outputs.transition_run_attempt == github.run_attempt) ||
                needs.finalize.outputs.mode == 'already-validated' || needs.build.result == 'success')""",
            "repair": """always() && contains(needs.*.result, 'failure') &&
                (needs.prepare.outputs.prepared_run_attempt == '' ||
                needs.prepare.outputs.prepared_run_attempt == github.run_attempt)""",
        }
        for job_name, expected in expected_job_conditions.items():
            self.assertIsInstance(jobs[job_name].get("if"), str,
                                  "Policy job must retain its exact executable condition")
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
                ("run", "Select Source And Request The Native Review Pair", ""),
                ("uses", "", "actions/upload-artifact"),
                ("run", "Report The Actual State", ""),
            ],
            "policy-check": [
                ("run", "Reject A Job-Only Rerun Before Policy Tests", ""),
                ("uses", "", "actions/checkout"), ("uses", "", "actions/checkout"),
                ("run", "Read The Candidate Private Module Pin", ""),
                ("run", "Read The Trusted Baseline Private Module Pin", ""),
                ("uses", "", "actions/checkout"),
                ("uses", "Checkout The Trusted Baseline Private Module", "actions/checkout"),
                ("run", "Record The Exact Private Checkout Receipt", ""),
                ("run", "Record The Exact Trusted Baseline Private Checkout Receipt", ""),
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
                ("run", "Reject A Job-Only Rerun Before Workflow Adoption", ""),
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
                ("uses", "", "actions/checkout"),
                ("run", "Fetch The Exact Candidate Configuration For Repair Worktree", ""),
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
        baseline_private_checkout = {
            "repository": "warelik/machine-maintenance",
            "ref": "${{ steps.baseline-private-pin.outputs.revision }}",
            "path": "private-maintenance-baseline",
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
                baseline_private_checkout,
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
            "repair": [trusted_checkout,
                       {"ref": "${{ github.sha }}", "path": "candidate",
                        "persist-credentials": False}],
        }
        for job_name, expected in expected_checkouts.items():
            actual = [step.get("with") for step in jobs[job_name]["steps"]
                      if step.get("uses", "").startswith("actions/checkout@")]
            self.assertEqual(actual, expected,
                             f"{job_name} checkout sources and credential settings must be exact")

        buildx_steps = [(job_name, step) for job_name, job in jobs.items() for step in job["steps"]
                        if step.get("uses", "").startswith("docker/setup-buildx-action@")]
        self.assertEqual(len(buildx_steps), 1, "Only the final image build may set up the pinned Buildx action")
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
            ("policy-check", "Checkout The Trusted Baseline Private Module",
             "steps.private-pin.outputs.revision != steps.baseline-private-pin.outputs.revision"),
            ("policy-check", "Record The Exact Trusted Baseline Private Checkout Receipt",
             "steps.private-pin.outputs.revision != steps.baseline-private-pin.outputs.revision"),
            ("build", "Show Smoke Logs And Remove Only The Test Container", "always()"),
            ("publish", "Reject A Job-Only Rerun Before Workflow Adoption",
             "needs.finalize.outputs.mode == 'workflow-transition' || needs.finalize.outputs.mode == 'workflow-transition-recovery'"),
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
                ['{', '  echo "### Upstream plus patches"', '  printf \'%s\\n\' "- State: ${MODE:-stopped before a decision}"', '  printf \'%s\\n\' "- Review accepted: ${READY:-false}"', '  if [ -n "$SOURCE_SHA" ]; then printf \'%s\\n\' "- Application: $VERSION at $SOURCE_SHA"; fi', '  if [ -n "$FULL_PR" ]; then printf \'%s\\n\' "- Full review PR: #$FULL_PR"; fi', '  if [ -n "$DELTA_PR" ]; then printf \'%s\\n\' "- Delta review PR: #$DELTA_PR"; fi', '  if [ -n "$REASON" ]; then printf \'%s\\n\' "- Detail: $REASON"; fi', '  echo "- GitHub never deploys; the VPS recipe consumes verified releases"', '} >> "$GITHUB_STEP_SUMMARY"'],
            ("policy-check", "Reject A Job-Only Rerun Before Policy Tests"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
                 '[[ "$POLICY_RESERVATION_ID" =~ ^[1-9][0-9]*$ ]]'],
            ("policy-check", "Read The Candidate Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("candidate/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("policy-check", "Read The Trusted Baseline Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("trusted/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("policy-check", "Record The Exact Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance"); lock=json.loads(pathlib.Path("candidate/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
            ("policy-check", "Record The Exact Trusted Baseline Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance-baseline"); lock=json.loads(pathlib.Path("trusted/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
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
            ("publish", "Reject A Job-Only Rerun Before Workflow Adoption"):
                ['test "$PREPARED_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$PREPARED_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
                 'test "$TRANSITION_RUN_ID" = "$GITHUB_RUN_ID"',
                 'test "$TRANSITION_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"'],
            ("publish", "Read The Trusted Private Module Pin"):
                ['python3 -c \'import json,re; d=json.load(open("trusted/scripts/maintenance.lock.json")); r=d.get("revision", ""); assert re.fullmatch(r"[0-9a-f]{40}", r); print(f"revision={r}")\' >> "$GITHUB_OUTPUT"'],
            ("publish", "Record The Exact Private Checkout Receipt"):
                ['python3 -c \'import json,pathlib,subprocess; p=pathlib.Path("private-maintenance"); lock=json.loads(pathlib.Path("trusted/scripts/maintenance.lock.json").read_text()); actual=subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip(); assert actual==lock["revision"]; (p/".maintenance-source.json").write_text(json.dumps({"repository":lock["repository"],"revision":actual},separators=(",",":"))+"\\n")\''],
            ("publish", "Publish Only This Verified Candidate"):
                ['mkdir -p "$GITHUB_WORKSPACE/release"',
                 'cp "$GITHUB_WORKSPACE/lifecycle/shared-context.json" "$GITHUB_WORKSPACE/release/shared-context.json"',
                 'python3 trusted/scripts/release.py publish-shared "$GITHUB_WORKSPACE/release"'],
            ("repair", "Fetch The Exact Candidate Configuration For Repair Worktree"):
                ['test "$(git -C candidate rev-parse HEAD)" = "$GITHUB_SHA"',
                 'git -C candidate update-ref refs/heads/fork-candidate "$GITHUB_SHA"',
                 'git -C trusted fetch --no-tags "$GITHUB_WORKSPACE/candidate" refs/heads/fork-candidate',
                 'test "$(git -C trusted rev-parse FETCH_HEAD)" = "$GITHUB_SHA"',
                 'git -C trusted cat-file -e "$GITHUB_SHA^{commit}"'],
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
                "TMPDIR": "${{ runner.temp }}",
                "NINEROUTER_POLICY_BASELINE_MAINTENANCE": "${{ steps.private-pin.outputs.revision == steps.baseline-private-pin.outputs.revision && format('{0}/private-maintenance', github.workspace) || format('{0}/private-maintenance-baseline', github.workspace) }}",
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
            ("publish", "Reject A Job-Only Rerun Before Workflow Adoption"): {
                "PREPARED_RUN_ID": "${{ needs.prepare.outputs.prepared_run_id }}",
                "PREPARED_RUN_ATTEMPT": "${{ needs.prepare.outputs.prepared_run_attempt }}",
                "TRANSITION_RUN_ID": "${{ needs.finalize.outputs.transition_run_id }}",
                "TRANSITION_RUN_ATTEMPT": "${{ needs.finalize.outputs.transition_run_attempt }}",
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
                "FINAL_MODE": "${{ needs.finalize.outputs.mode }}",
                "TRANSITION_RUN_ID": "${{ needs.finalize.outputs.transition_run_id }}",
                "TRANSITION_RUN_ATTEMPT": "${{ needs.finalize.outputs.transition_run_attempt }}",
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
            ("policy-check", "Read The Trusted Baseline Private Module Pin", "baseline-private-pin"),
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
            "transition_run_id": "${{ steps.final.outputs.transition_run_id }}",
            "transition_run_attempt": "${{ steps.final.outputs.transition_run_attempt }}",
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
        self.assertEqual(prep_call.get("id"), "snapshot", "Prepare outputs must keep their reviewed producer identity")
        self.assertEqual(set(prep_call), {"name", "id", "env", "run"},
                         "Policy consumer must retain its strict trusted execution context")
        self.assertEqual(prep_call.get("run"),
                         "python3 trusted/scripts/release.py prepare-shared \"$RUNNER_TEMP/9router-source\"",
                         "Policy consumer must retain the trusted prepare CLI")
        self.assertNotIn("Install The Pinned Policy YAML Parser", "\n".join(
            str(step.get("name", "")) for step in prepare["steps"]))
        self.assertNotIn("unittest", "\n".join(str(step.get("run", "")) for step in prepare["steps"]))
        buildx_steps = [(index, step) for index, step in enumerate(prepare["steps"])
                        if step.get("uses", "").startswith("docker/setup-buildx-action@")]
        self.assertEqual(buildx_steps, [],
                         "Source preparation only inspects registry metadata with the preinstalled CLI")
        self.assertEqual(named_steps("prepare", "Require The Trusted Controller Pin")[1].get("with"), None,
                         "Trusted controller pin check cannot be replaced by an untrusted checkout")
        controller = next((step for step in prepare["steps"]
                           if step.get("name") == "Require The Trusted Controller Pin"), {})
        self.assertEqual(controller.get("env", {}).get("TRUSTED_POLICY"),
                         "${{ vars.ZED_TRUSTED_POLICY }}")
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
        self.assertEqual(" ".join(policy_gate.split()),
                         " ".join(expected_job_conditions["policy-check"].split()))
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
        self.assertEqual(set(consumer), {"name", "env", "run"},
                         "Policy consumer must retain strict execution settings")
        self.assertEqual(consumer.get("env"), expected_step_envs[
            ("policy-check", "Enforce Trusted Tests And Validate Proposed YAML")],
            "Policy consumer must retain the exact private module environment")
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
        self.assertTrue(any(
            step.get("uses", "").startswith("actions/download-artifact@")
            and step.get("with", {}).get("run-id") == "${{ needs.finalize.outputs.validated_run_id }}"
            for step in jobs["publish"]["steps"]),
            "Publication must select artifacts from the exact authorized validation run")
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
                expected_count = 2 if job_name == "policy-check" else 1
                self.assertEqual(len(checkouts), expected_count,
                                 f"{job_name} must acquire its exact private source checkout(s)")
                checkout = checkouts[0]
                self.assertEqual(checkout.get("with", {}).get("repository"), "warelik/machine-maintenance")
                self.assertEqual(checkout.get("with", {}).get("ssh-key"), "${{ secrets.MAINTENANCE_READ_KEY }}")
                if job_name == "policy-check":
                    self.assertEqual(checkout.get("with", {}).get("ref"), "${{ steps.private-pin.outputs.revision }}")
                    baseline_checkout = checkouts[1]
                    self.assertEqual(baseline_checkout.get("with", {}).get("ref"),
                                     "${{ steps.baseline-private-pin.outputs.revision }}")
                    self.assertEqual(baseline_checkout.get("with", {}).get("path"),
                                     "private-maintenance-baseline")
                    self.assertEqual(baseline_checkout.get("if"),
                                     "steps.private-pin.outputs.revision != steps.baseline-private-pin.outputs.revision")
                    self.assertEqual(baseline_checkout.get("with", {}).get("ssh-key"),
                                     "${{ secrets.MAINTENANCE_READ_KEY }}")
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
        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()
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
                        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

    def test_parser_bootstrap_rejects_commented_and_ignored_commands(self):
        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()
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
                            self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

    def test_policy_consumers_reject_disabled_and_replaced_checks(self):
        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()
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
                            self.test_policy_workflows_install_the_exact_parser_in_both_jobs()
            for mutation in ({"if": False}, {"continue-on-error": True},
                             {"defaults": {"run": {"shell": "bash {0} || true"}}}):
                with self.subTest(job=job, scope="job", mutation=mutation), tempfile.TemporaryDirectory() as directory:
                    document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                    document["jobs"][job].update(mutation)
                    candidate = Path(directory) / "proposed.yml"
                    candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                    with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                        with self.assertRaises(AssertionError):
                            self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

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
                            self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

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
                        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

    def test_policy_workflow_allows_pinned_action_refresh_and_operational_parameters(self):
        # Preserve the original O test identity. The current oracle allows only
        # exact action-pin refresh; it separately binds runner and timeout values.
        workflow = release.ROOT / ".github/workflows/release.yml"
        with tempfile.TemporaryDirectory() as directory:
            source = workflow.read_text(encoding="utf-8")
            source = re.sub(r"(?<=@)[0-9a-f]{40}", "c" * 40, source)
            candidate = Path(directory) / "proposed.yml"
            candidate.write_text(source, encoding="utf-8")
            with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

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


class RepairRefCleanupTests(unittest.TestCase):
    def test_repair_only_scope_keeps_all_open_refs_and_default_scope_unchanged(self):
        closed_repair = {
            "number": 2, "state": "closed",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "repair/expired", "sha": HEAD,
                     "repo": {"full_name": REPO}},
            "base": {"ref": "downstream", "sha": CONFIG,
                     "repo": {"full_name": REPO}},
        }
        open_repair = {
            "number": 3, "state": "open",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "repair/current", "sha": SEED,
                     "repo": {"full_name": REPO}},
            "base": {"ref": "downstream", "sha": CONFIG,
                     "repo": {"full_name": REPO}},
        }
        open_review = {
            "number": 4, "state": "open",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "review/full", "sha": HEAD,
                     "repo": {"full_name": REPO}},
            "base": {"ref": f"review-base/{UPSTREAM}", "sha": UPSTREAM,
                     "repo": {"full_name": REPO}},
        }
        open_oracle = {
            "number": 5, "state": "open",
            "user": {"login": "warelik", "type": "User"},
            "head": {"ref": "oracle/current", "sha": "f" * 40,
                     "repo": {"full_name": REPO}},
            "base": {"ref": "downstream", "sha": CONFIG,
                     "repo": {"full_name": REPO}},
        }
        pulls = [closed_repair, open_repair, open_review, open_oracle]
        refs = [
            {"ref": "refs/heads/repair/expired",
             "object": {"type": "commit", "sha": HEAD}},
            {"ref": "refs/heads/repair/current",
             "object": {"type": "commit", "sha": SEED}},
        ]
        calls = []

        def native(path, *, method="GET", data=None, token=None):
            calls.append(path)
            if path == f"repos/{REPO}/git/matching-refs/heads/review":
                return []
            if path == f"repos/{REPO}/git/matching-refs/heads/repair":
                return refs
            if path == f"repos/{REPO}/git/ref/pull/2/head":
                return {"ref": "refs/pull/2/head", "object": {"sha": HEAD}}
            if path == f"repos/{REPO}/git/ref/pull/3/head":
                return {"ref": "refs/pull/3/head", "object": {"sha": SEED}}
            self.fail(f"Unexpected native API request: {method} {path}")

        class Lifecycle:
            def __init__(self):
                self.plans = []

            def cleanup_plan(self, records, *, active_refs, protected_refs):
                assert all(record["pull"]["state"] == "closed" for record in records)
                self.plans.append({
                    "names": {record["name"] for record in records},
                    "active_refs": active_refs,
                    "protected_refs": protected_refs,
                })
                return []

        repair_lifecycle = Lifecycle()
        with (patch.object(release, "pages", return_value=pulls),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "run", side_effect=AssertionError("An empty plan cannot mutate refs"))):
            release._cleanup_shared_refs(REPO, repair_lifecycle, repair_only=True)
        self.assertEqual(calls, [
            f"repos/{REPO}/git/matching-refs/heads/repair",
            f"repos/{REPO}/git/ref/pull/2/head",
        ])
        self.assertEqual(repair_lifecycle.plans[0]["names"],
                         {"repair/expired"})
        self.assertTrue({"repair/current", "review/full", f"review-base/{UPSTREAM}",
                         "oracle/current", "downstream"} <= repair_lifecycle.plans[0]["active_refs"])
        self.assertEqual(repair_lifecycle.plans[0]["protected_refs"], {"main", "downstream"})

        calls.clear()
        default_lifecycle = Lifecycle()
        with (patch.object(release, "pages", return_value=pulls),
              patch.object(release, "api", side_effect=native),
              patch.object(release, "run", side_effect=AssertionError("An empty plan cannot mutate refs"))):
            release._cleanup_shared_refs(REPO, default_lifecycle)
        self.assertEqual(calls[:2], [
            f"repos/{REPO}/git/matching-refs/heads/review",
            f"repos/{REPO}/git/matching-refs/heads/repair",
        ])
        self.assertEqual(default_lifecycle.plans[0]["names"],
                         {"repair/expired"})

    def test_scheduled_prepare_cleans_before_candidate_selection(self):
        events = []

        class RepairSelectionReached(Exception):
            pass

        def native(path):
            events.append(f"api:{path}")
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG}
            self.fail(f"Unexpected native API request: {path}")

        def cleanup(repo, lifecycle, *, repair_only=False):
            events.append(f"cleanup:{repo}:{repair_only}")

        def select_repair(*_args):
            events.append("repair-selection")
            raise RepairSelectionReached

        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG,
                                          "GITHUB_EVENT_NAME": "schedule"}),
                  patch.object(release, "shared_lifecycle", return_value=SimpleNamespace()),
                  patch.object(release, "api", side_effect=native),
                  patch.object(release, "_cleanup_shared_refs", side_effect=cleanup),
                  patch.object(release, "_published_release_recovery", return_value=None),
                  patch.object(release, "_shared_repair_candidate", side_effect=select_repair),
                  self.assertRaises(RepairSelectionReached)):
                release.prepare_shared(Path(directory))
        self.assertLess(events.index(f"cleanup:{REPO}:True"), events.index("repair-selection"))

    def test_non_scheduled_prepare_preserves_existing_candidate_selection(self):
        class RepairSelectionReached(Exception):
            pass

        def native(path):
            if path == f"repos/{REPO}":
                return {"default_branch": "downstream"}
            if path == f"repos/{REPO}/commits/downstream":
                return {"sha": CONFIG}
            self.fail(f"Unexpected native API request: {path}")

        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG,
                                          "GITHUB_EVENT_NAME": "workflow_dispatch"}),
                  patch.object(release, "shared_lifecycle", return_value=SimpleNamespace()),
                  patch.object(release, "api", side_effect=native),
                  patch.object(release, "_cleanup_shared_refs") as cleanup,
                  patch.object(release, "_published_release_recovery", return_value=None),
                  patch.object(release, "_shared_repair_candidate", side_effect=RepairSelectionReached),
                  self.assertRaises(RepairSelectionReached)):
                release.prepare_shared(Path(directory))
        cleanup.assert_not_called()

    def test_scheduled_cleanup_failure_enters_existing_repair_path_before_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG,
                                          "GITHUB_EVENT_NAME": "schedule"}),
                  patch.object(release, "shared_lifecycle", return_value=SimpleNamespace()),
                  patch.object(release, "api", return_value={"default_branch": "downstream"}) as native,
                  patch.object(release, "_cleanup_shared_refs", side_effect=RuntimeError("cleanup blocked")) as cleanup,
                  patch.object(release, "_published_release_recovery") as recovery,
                  patch.object(release, "_shared_repair_candidate") as selection,
                  self.assertRaisesRegex(RuntimeError, "cleanup blocked")):
                release.prepare_shared(Path(directory))
        cleanup.assert_called_once_with(REPO, cleanup.call_args.args[1], repair_only=True)
        native.assert_called_once_with(f"repos/{REPO}")
        recovery.assert_not_called()
        selection.assert_not_called()


class PendingReviewSourceRefTests(unittest.TestCase):
    def source_fixture(self, patch_root):
        candidate_config = "f" * 40
        candidate_id = "9" * 64
        context_sha, tree_sha = "1" * 40, "2" * 40
        candidate = {
            "schema": 1, "repository": REPO, "upstream_sha": UPSTREAM,
            "application_sha": HEAD, "configuration_sha": candidate_config,
            "patchset_sha256": release.patch_identity(patch_root)[1],
            "recipe_sha256": "b" * 64, "platform": release.PLATFORM,
        }
        refs = [{
            "ref": f"refs/heads/review/{UPSTREAM}-{candidate_id}",
            "object": {"type": "commit", "sha": context_sha},
        }]

        def native_api(path, **_kwargs):
            if path == f"repos/{REPO}/git/matching-refs/heads/review":
                return refs
            if path == f"repos/{REPO}/git/commits/{context_sha}":
                return {"sha": context_sha,
                        "message": f"fork-review-context:v1 {candidate_id}\n",
                        "parents": [{"sha": HEAD}], "tree": {"sha": tree_sha}}
            if path == f"repos/{REPO}/git/commits/{HEAD}":
                return {"sha": HEAD, "tree": {"sha": tree_sha}}
            if path == f"repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}":
                return {"sha": "e" * 40}
            self.fail(f"Unexpected native API request {path}")

        lifecycle = SimpleNamespace(candidate_identity=lambda item:
                                    candidate_id if item == candidate else "0" * 64)
        return candidate, candidate_id, context_sha, tree_sha, native_api, lifecycle

    def test_full_ref_reconstructs_the_exact_candidate_without_an_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            patch_root = Path(temporary)
            (patch_root / "0001-fix.patch").write_bytes(b"patch series\n")
            candidate, candidate_id, _context, _tree, native_api, lifecycle = self.source_fixture(
                patch_root)
            with (patch.object(release, "api", side_effect=native_api),
                  patch.object(release, "pages", return_value=[]),
                  patch.object(release, "_shared_file", return_value=b"FROM node:22-alpine\n"),
                  patch.object(release, "_recipe_sha256", return_value="b" * 64),
                  patch.object(release, "_native_upstream_ancestor", return_value=True) as ancestor):
                recovered = release._pending_shared_ref_candidate(
                    REPO, lifecycle, config_sha=candidate["configuration_sha"],
                    patch_root=patch_root, workflow_text="exact current workflow",
                    accepted_upstream="7" * 40)
            self.assertEqual(recovered, candidate)
            self.assertEqual(lifecycle.candidate_identity(recovered), candidate_id)
            self.assertEqual(ancestor.call_args_list[0].args, ("7" * 40, UPSTREAM))
            self.assertEqual(ancestor.call_args_list[1].args, (UPSTREAM, "e" * 40))

    def test_malformed_context_commit_is_not_a_candidate_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            patch_root = Path(temporary)
            (patch_root / "0001-fix.patch").write_bytes(b"patch series\n")
            candidate, candidate_id, context_sha, _tree, native_api, lifecycle = self.source_fixture(
                patch_root)
            original = native_api

            def malformed(path, **kwargs):
                result = original(path, **kwargs)
                if path == f"repos/{REPO}/git/commits/{context_sha}":
                    result["message"] = "unrelated context\n"
                return result

            with (patch.object(release, "api", side_effect=malformed),
                  patch.object(release, "pages", return_value=[]),
                  patch.object(release, "_shared_file") as shared_file,
                  patch.object(release, "_native_upstream_ancestor") as ancestor):
                recovered = release._pending_shared_ref_candidate(
                    REPO, lifecycle, config_sha=candidate["configuration_sha"],
                    patch_root=patch_root, workflow_text="exact current workflow",
                    accepted_upstream="7" * 40)
            self.assertIsNone(recovered)
            shared_file.assert_not_called()
            ancestor.assert_not_called()

    def test_pending_candidate_outside_accepted_or_current_upstream_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            patch_root = Path(temporary)
            (patch_root / "0001-fix.patch").write_bytes(b"patch series\n")
            candidate, _candidate_id, _context, _tree, native_api, lifecycle = self.source_fixture(
                patch_root)
            with (patch.object(release, "api", side_effect=native_api),
                  patch.object(release, "pages", return_value=[]),
                  patch.object(release, "_shared_file", return_value=b"FROM node:22-alpine\n"),
                  patch.object(release, "_recipe_sha256", return_value="b" * 64),
                  patch.object(release, "_native_upstream_ancestor",
                               side_effect=(True, False))):
                with self.assertRaisesRegex(ValueError, "would downgrade or leave"):
                    release._pending_shared_ref_candidate(
                        REPO, lifecycle, config_sha=candidate["configuration_sha"],
                        patch_root=patch_root, workflow_text="exact current workflow",
                        accepted_upstream="7" * 40)

    def test_context_and_application_must_have_explicit_full_tree_shas(self):
        with tempfile.TemporaryDirectory() as temporary:
            patch_root = Path(temporary)
            (patch_root / "0001-fix.patch").write_bytes(b"patch series\n")
            candidate, _candidate_id, context_sha, _tree, native_api, lifecycle = self.source_fixture(
                patch_root)

            def missing_trees(path, **kwargs):
                result = native_api(path, **kwargs)
                if path in {
                    f"repos/{REPO}/git/commits/{context_sha}",
                    f"repos/{REPO}/git/commits/{HEAD}",
                }:
                    result.pop("tree", None)
                return result

            with (patch.object(release, "api", side_effect=missing_trees),
                  patch.object(release, "pages", return_value=[]),
                  patch.object(release, "_shared_file") as shared_file):
                recovered = release._pending_shared_ref_candidate(
                    REPO, lifecycle, config_sha=candidate["configuration_sha"],
                    patch_root=patch_root, workflow_text="exact current workflow",
                    accepted_upstream="7" * 40)
            self.assertIsNone(recovered)
            shared_file.assert_not_called()

    def test_foreign_fork_same_name_does_not_hide_native_open_full_pr(self):
        with tempfile.TemporaryDirectory() as temporary:
            patch_root = Path(temporary)
            (patch_root / "0001-fix.patch").write_bytes(b"patch series\n")
            candidate, candidate_id, context_sha, _tree, native_api, lifecycle = self.source_fixture(
                patch_root)
            head_ref = f"review/{UPSTREAM}-{candidate_id}"
            base_ref = f"review-base/{UPSTREAM}"
            foreign = {
                "state": "open",
                "head": {"ref": head_ref, "sha": context_sha,
                         "repo": {"full_name": "contributor/9router"}},
                "base": {"ref": base_ref, "sha": UPSTREAM,
                         "repo": {"full_name": REPO}},
            }
            native = {
                "state": "open",
                "head": {"ref": head_ref, "sha": context_sha,
                         "repo": {"full_name": REPO}},
                "base": {"ref": base_ref, "sha": UPSTREAM,
                         "repo": {"full_name": REPO}},
            }
            with (patch.object(release, "api", side_effect=native_api),
                  patch.object(release, "pages", return_value=[foreign, native]),
                  patch.object(release, "_shared_file", return_value=b"FROM node:22-alpine\n"),
                  patch.object(release, "_recipe_sha256", return_value="b" * 64),
                  patch.object(release, "_native_upstream_ancestor", return_value=True)):
                recovered = release._pending_shared_ref_candidate(
                    REPO, lifecycle, config_sha=candidate["configuration_sha"],
                    patch_root=patch_root, workflow_text="exact current workflow",
                    accepted_upstream="7" * 40)
            self.assertEqual(recovered, candidate)


class PendingReviewPostTests(unittest.TestCase):
    def run_review_post(self, page_batches):
        head_ref, base_ref = f"review/{UPSTREAM}-{'f' * 64}", f"review-base/{UPSTREAM}"
        head_sha, base_sha = HEAD, UPSTREAM
        pulls = iter(page_batches)
        api_calls = []

        def native_api(path, *, method="GET", data=None, token=None):
            api_calls.append((path, method))
            if method == "POST":
                raise subprocess.CalledProcessError(1, ["gh", "api"])
            self.fail(f"Unexpected native API request {method} {path}")

        def native_run(*args, cwd=None, env=None):
            if args[:3] == ("gh", "auth", "setup-git"):
                return ""
            if args[:2] == ("git", "rev-parse"):
                return base_sha
            if args[:2] == ("git", "ls-remote"):
                return ""
            if args[:2] == ("git", "push"):
                return ""
            self.fail(f"Unexpected command {args}")

        with (patch.object(release, "run", side_effect=native_run),
              patch.object(release, "api", side_effect=native_api),
              patch.object(release, "pages", side_effect=lambda _path: next(pulls)),
              patch.object(release.subprocess, "run",
                           return_value=subprocess.CompletedProcess([], 0))):
            try:
                result = release._review_pr(
                    REPO, Path("unused"), title="review", body="body",
                    head_ref=head_ref, head_sha=head_sha,
                    base_ref=base_ref, base_sha=base_sha)
            except release.PendingReviewPost as error:
                result = error
        return result, api_calls

    def test_uncertain_post_without_native_pull_returns_pending_after_one_post(self):
        result, api_calls = self.run_review_post([[], []])
        self.assertIsInstance(result, release.PendingReviewPost)
        self.assertEqual(api_calls, [(f"repos/{REPO}/pulls", "POST")])

    def test_uncertain_post_hydrates_the_exact_native_pull_without_retry(self):
        head_ref, base_ref = f"review/{UPSTREAM}-{'f' * 64}", f"review-base/{UPSTREAM}"
        pull = {
            "number": 77, "state": "open",
            "head": {"ref": head_ref, "sha": HEAD, "repo": {"full_name": REPO}},
            "base": {"ref": base_ref, "sha": UPSTREAM, "repo": {"full_name": REPO}},
        }
        result, api_calls = self.run_review_post([[], [pull]])
        self.assertEqual(result, pull)
        self.assertEqual(api_calls, [(f"repos/{REPO}/pulls", "POST")])


class NativeUpstreamAncestryTests(unittest.TestCase):
    def comparison(self, base, head, *, status, ahead, behind, total, commits):
        return {
            "url": f"https://api.github.com/repos/{release.UPSTREAM}/compare/{base}...{head}",
            "status": status,
            "base_commit": {"sha": base},
            "merge_base_commit": {"sha": base},
            "ahead_by": ahead,
            "behind_by": behind,
            "total_commits": total,
            "commits": commits,
        }

    def test_native_identical_compare_requires_no_head_commit_or_commit_rows(self):
        response = self.comparison(
            UPSTREAM, UPSTREAM, status="identical", ahead=0, behind=0,
            total=0, commits=[])
        with patch.object(release, "api", return_value=response) as native:
            self.assertTrue(release._native_upstream_ancestor(UPSTREAM, UPSTREAM))
        native.assert_called_once_with(
            f"repos/{release.UPSTREAM}/compare/{UPSTREAM}...{UPSTREAM}")

    def test_native_ahead_compare_over_250_uses_published_ancestry_fields(self):
        response = self.comparison(
            UPSTREAM, HEAD, status="ahead", ahead=301, behind=0,
            total=301, commits=[{} for _ in range(250)])
        with patch.object(release, "api", return_value=response) as native:
            self.assertTrue(release._native_upstream_ancestor(UPSTREAM, HEAD))
        native.assert_called_once_with(
            f"repos/{release.UPSTREAM}/compare/{UPSTREAM}...{HEAD}")


class FinalReservationPermissionTests(unittest.TestCase):
    def test_each_native_reservation_job_can_comment_on_its_review_pr(self):
        import re
        root = Path(release.__file__).resolve().parents[1]
        text = (root / '.github/workflows/release.yml').read_text()
        for job in ['finalize']:
            block = re.search(r"(?ms)^  " + re.escape(job) + r":\s*\n.*?(?=^  [A-Za-z0-9_-]+:\s*$|\Z)", text)
            self.assertIsNotNone(block)
            self.assertRegex(block[0], r"(?m)^      pull-requests: write$")
            self.assertNotRegex(block[0], r"(?m)^      contents: write$")


class OptionalPolicyLaneAdmissionTests(unittest.TestCase):
    def test_skipped_policy_ancestor_keeps_authorized_application_lane_live(self):
        import re
        document = release.yaml_module().safe_load((release.ROOT / ".github/workflows/release.yml").read_text())
        fields = {
            "needs.prepare.result": "success", "needs.finalize.result": "success", "needs.test.result": "success",
            "needs.prepare.outputs.review_ready": "true", "needs.finalize.outputs.ready": "true",
            "needs.finalize.outputs.mode": "application", "needs.prepare.outputs.prepared_run_id": "42",
            "needs.finalize.outputs.validated_run_id": "42", "github.run_id": "42",
        }
        def enabled(expression, values, cancelled=False):
            # GitHub supplies implicit success() only without an explicit status function.
            if not re.search(r"\b(?:always|cancelled|success|failure)\(", expression):
                return False  # the optional policy-check ancestor is skipped
            expression = re.sub(r"\b(?:needs|github)\.[A-Za-z0-9_.-]+", lambda m: repr(values[m[0]]), expression)
            expression = expression.replace("always()", "True").replace("!cancelled()", str(not cancelled))
            expression = expression.replace("&&", " and ").replace("||", " or ")
            return bool(eval(expression.strip(), {"__builtins__": {}}, {}))
        for job in ("test", "build"):
            condition = document["jobs"][job]["if"]
            self.assertTrue(enabled(condition, fields), job)
            self.assertFalse(enabled(condition, fields, cancelled=True), job)
            for parent in (("prepare", "finalize", "test") if job == "build" else ("prepare", "finalize")):
                self.assertFalse(enabled(condition, {**fields, "needs." + parent + ".result": "failure"}), (job, parent))
            self.assertFalse(enabled(condition, {**fields, "needs.finalize.outputs.mode": "policy-only"}), job)


class PolicyEngineEnvironmentTests(unittest.TestCase):
    def test_host_engine_paths_are_separate_from_container_fixture_paths_and_credentials(self):
        with patch.dict(os.environ, {"HOME": "/host/home", "XDG_DATA_HOME": "/host/data",
                                    "XDG_RUNTIME_DIR": "/run/user/1000",
                                    "GH_TOKEN": "fixture-secret", "CODEX_REQUEST_TOKEN": "fixture-secret"}, clear=True):
            env = release.policy_engine_environment()
        self.assertEqual(env, {"HOME": "/host/home", "XDG_DATA_HOME": "/host/data",
                               "XDG_RUNTIME_DIR": "/run/user/1000"})

class AcceptedWorkflowTransitionTests(unittest.TestCase):
    def test_already_accepted_configuration_does_not_pin_upstream_again(self):
        with patch.object(release, "_sanitized_repair_identity", side_effect=AssertionError("accepted transition must not be replayed")):
            self.assertIsNone(release._adopted_workflow_candidate("owner/repo", "a" * 40, object(),
                accepted_candidate={"configuration_sha": "a" * 40}))

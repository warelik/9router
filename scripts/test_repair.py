from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import release


REPO = "warelik/9router"
CONFIG = "a" * 40
SEED = "b" * 40
HEAD = "c" * 40
UPSTREAM = "d" * 40
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


class AdoptionTests(unittest.TestCase):
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

    def test_policy_workflows_install_the_exact_parser_in_both_jobs(self):
        workflow = Path(os.environ.get("NINEROUTER_POLICY_CANDIDATE_WORKFLOW") or
                        release.ROOT / ".github/workflows/release.yml")
        contents = workflow.read_text(encoding="utf-8")
        document = release.yaml_module().safe_load(contents)
        trusted = release.yaml_module().safe_load(
            (release.ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
        for job, consumer in (("prepare", "Test Release Policy"),
                              ("policy-check", "Enforce The Trusted Tests And Validate Proposed YAML")):
            steps = document["jobs"][job]["steps"]
            installers = [(index, step) for index, step in enumerate(steps)
                          if step.get("name") == "Install The Pinned Policy YAML Parser"]
            self.assertEqual(len(installers), 1, f"Missing parser bootstrap in {job}")
            index, step = installers[0]
            self.assertNotIn("if", step)
            self.assertNotIn("continue-on-error", step)
            script = step.get("run", "")
            baseline = next(item for item in trusted["jobs"][job]["steps"]
                            if item.get("name") == "Install The Pinned Policy YAML Parser")
            self.assertEqual(script, baseline["run"], "Parser bootstrap must retain the trusted executable body")
            use_index = next(i for i, item in enumerate(steps) if item.get("name") == consumer)
            self.assertLess(index, use_index)
        release.validate_action_pins(workflow)

    def test_parser_bootstrap_assertions_read_the_proposed_workflow(self):
        workflow = Path(os.environ.get("NINEROUTER_POLICY_CANDIDATE_WORKFLOW") or
                        release.ROOT / ".github/workflows/release.yml")
        yaml = release.yaml_module()
        for job in ("prepare", "policy-check"):
            with self.subTest(job=job), tempfile.TemporaryDirectory() as directory:
                document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
                document["jobs"][job]["steps"] = [step for step in document["jobs"][job]["steps"]
                    if step.get("name") != "Install The Pinned Policy YAML Parser"]
                candidate = Path(directory) / "proposed.yml"
                candidate.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
                with patch.dict(os.environ, {"NINEROUTER_POLICY_CANDIDATE_WORKFLOW": str(candidate)}):
                    with self.assertRaisesRegex(AssertionError, "Missing parser bootstrap"):
                        self.test_policy_workflows_install_the_exact_parser_in_both_jobs()

    def test_parser_bootstrap_rejects_commented_and_ignored_commands(self):
        workflow = release.ROOT / ".github/workflows/release.yml"
        yaml = release.yaml_module()
        for job in ("prepare", "policy-check"):
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
                        with self.assertRaisesRegex(AssertionError, "trusted executable body"):
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

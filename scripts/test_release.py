import json
import os
from pathlib import Path
import tempfile
import subprocess
import shutil
import unittest
from unittest.mock import patch

import release


HEAD = "a" * 40
OTHER = "b" * 40
REQUESTED = "2026-10-16T10:00:00Z"
COMPLETED = "2026-10-16T10:01:00Z"
BOT = {"login": release.BOT, "type": "Bot"}
APP = {"slug": release.APP}


def receipt(sha=HEAD):
    return {
        "user": BOT, "performed_via_github_app": APP, "created_at": COMPLETED,
        "body": f"Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `{sha}`",
    }


def native_state(sha=HEAD, **changes):
    state = {
        "commit_sha": sha, "status": "completed",
        "has_any_findings": False, "has_unresolved_findings": False, **changes,
    }
    return {
        "user": BOT, "performed_via_github_app": APP,
        "created_at": "2026-10-16T09:00:00Z", "updated_at": COMPLETED,
        "body": f"<!-- codex-review-state:v1 {json.dumps({'code_review': state})} -->",
    }


class ReviewPolicyTests(unittest.TestCase):
    def gate(self, *, sha=HEAD, requested=REQUESTED, reviews=(), inline=(), comments=(), resolve=None):
        return release.review_gate(
            sha, requested, reviews, inline, comments,
            resolve or (lambda prefix: HEAD if HEAD.startswith(prefix) else OTHER),
        )[0]

    def test_native_receipt_full_sha(self):
        self.assertTrue(self.gate(comments=[receipt()]))

    def test_native_receipt_resolves_abbreviated_sha(self):
        self.assertTrue(self.gate(comments=[receipt(HEAD[:10])]))

    def test_receipt_for_another_commit_is_not_a_review(self):
        self.assertFalse(self.gate(comments=[receipt(OTHER)]))

    def test_unresolvable_prefix_is_not_a_review(self):
        self.assertFalse(self.gate(comments=[receipt()], resolve=lambda _: None))

    def test_edited_native_summary_is_accepted_after_request(self):
        self.assertTrue(self.gate(comments=[native_state()]))

    def test_native_summary_requires_current_commit_and_completion(self):
        for record in (native_state(OTHER), native_state(status="in_progress"),
                       native_state(has_any_findings=True),
                       native_state(has_unresolved_findings=None),
                       native_state(has_any_findings=0)):
            with self.subTest(record=record):
                self.assertFalse(self.gate(comments=[record]))

    def test_stale_native_state_is_not_a_review(self):
        comment = native_state()
        comment["updated_at"] = "2026-10-16T09:59:00Z"
        self.assertFalse(self.gate(comments=[comment]))

    def test_bot_and_app_identity_are_required_for_native_comments(self):
        for changes in (
            {"user": {"login": "warelik", "type": "User"}},
            {"user": {"login": release.BOT, "type": "User"}},
            {"performed_via_github_app": None},
            {"performed_via_github_app": {"slug": "another-app"}},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(self.gate(comments=[{**receipt(), **changes}]))

    def test_ambiguous_reviewed_commit_text_is_not_accepted(self):
        record = receipt()
        record["body"] += f"\nReviewed commit: `{OTHER}`"
        self.assertFalse(self.gate(comments=[record]))

    def test_silence_and_thumbs_up_text_are_not_reviews(self):
        self.assertFalse(self.gate())
        self.assertFalse(self.gate(comments=[{**receipt(), "body": "+1"}]))

    def test_request_must_be_exact_sha_and_present(self):
        self.assertFalse(self.gate(sha=HEAD[:10], comments=[receipt()]))
        self.assertFalse(self.gate(requested="", comments=[receipt()]))

    def test_exact_inline_p1_overrides_clean_summary(self):
        finding = {"user": BOT, "commit_id": HEAD, "body": "**[P1]** Broken request"}
        self.assertFalse(self.gate(inline=[finding], comments=[native_state(), receipt()]))

    def test_all_priorities_in_structured_summary_block_publication(self):
        for severity in ("P0", "P1", "P2", "P3"):
            with self.subTest(severity=severity):
                comment = native_state()
                comment["body"] += f"\n**[{severity}]** Broken request despite clean JSON"
                self.assertFalse(self.gate(comments=[comment]))

    def test_duplicate_structured_markers_cannot_hide_an_exact_commit_p1(self):
        comment = native_state()
        comment["body"] += "\n" + native_state()["body"] + "\n[P1] Broken request"
        self.assertFalse(self.gate(comments=[comment, receipt()]))

    def test_old_commit_finding_does_not_block_current_commit(self):
        finding = {"user": BOT, "commit_id": OTHER, "body": "[P1] Broken old request"}
        self.assertTrue(self.gate(inline=[finding], comments=[receipt()]))

    def test_relocated_old_inline_finding_requires_a_fresh_clean_review(self):
        finding = {"user": BOT, "commit_id": HEAD, "original_commit_id": OTHER,
                   "body": "[P1] Broken old request"}
        self.assertFalse(self.gate(inline=[finding]))
        self.assertTrue(self.gate(inline=[finding], comments=[receipt()]))

    def test_original_current_inline_finding_still_blocks_when_relocated(self):
        finding = {"user": BOT, "commit_id": OTHER, "original_commit_id": HEAD,
                   "body": "[P2] Defect on the requested commit"}
        self.assertFalse(self.gate(inline=[finding], comments=[receipt()]))

    def test_p2_p3_and_unlabelled_findings_block_completed_formal_review(self):
        review = {"id": 12, "user": BOT, "commit_id": HEAD, "state": "COMMENTED", "submitted_at": COMPLETED}
        for body in ("[P2] Bug", "[P3] Bug", "Drops the last response chunk"):
            finding = {"user": BOT, "commit_id": HEAD, "pull_request_review_id": 12, "body": body}
            with self.subTest(body=body):
                self.assertFalse(self.gate(reviews=[review], inline=[finding], comments=[receipt()]))

    def test_structured_findings_override_an_approval_or_clean_receipt(self):
        review = {"id": 12, "user": BOT, "commit_id": HEAD, "state": "APPROVED", "submitted_at": COMPLETED}
        for state in (native_state(has_any_findings=True), native_state(has_unresolved_findings=True)):
            with self.subTest(state=state):
                self.assertFalse(self.gate(reviews=[review], comments=[state, receipt()]))

    def test_foreign_inline_comment_does_not_impersonate_a_codex_finding(self):
        finding = {"user": {"login": "somebody", "type": "User"}, "commit_id": HEAD, "body": "[P2] Bug"}
        self.assertTrue(self.gate(inline=[finding], comments=[receipt()]))

    def test_quota_comment_without_completed_review_is_not_success(self):
        review = {"user": BOT, "commit_id": HEAD, "state": "COMMENTED",
                  "submitted_at": COMPLETED, "body": "Review quota exceeded"}
        self.assertFalse(self.gate(reviews=[review]))
        self.assertFalse(self.gate(comments=[{**receipt(), "body": "Review quota exceeded"}]))

    def test_later_negative_formal_review_blocks_publication(self):
        reviews = [
            {"id": 1, "user": BOT, "commit_id": HEAD, "state": "APPROVED", "submitted_at": COMPLETED},
            {"id": 2, "user": BOT, "commit_id": HEAD, "state": "CHANGES_REQUESTED",
             "submitted_at": "2026-10-16T10:02:00Z"},
        ]
        self.assertFalse(self.gate(reviews=reviews, comments=[receipt()]))

    def test_changed_pr_head_is_rejected_before_reading_reviews(self):
        with patch.object(release, "api", return_value={"head": {"sha": OTHER}, "state": "open"}):
            self.assertFalse(release.check_review("warelik/9router", 1, HEAD, OTHER)[0])

    def test_closed_pr_cannot_publish(self):
        with patch.object(release, "api", return_value={"head": {"sha": HEAD}, "state": "closed"}):
            self.assertFalse(release.check_review("warelik/9router", 1, HEAD, OTHER)[0])

    def test_only_the_exact_clean_upstream_base_can_be_reviewed(self):
        repo = {"full_name": "warelik/9router"}
        correct = {"ref": f"review-base/{OTHER}", "sha": OTHER, "repo": repo}
        request = {
            "user": {"login": "warelik", "type": "User"}, "created_at": REQUESTED,
            "body": f"<!-- 9router-codex:{HEAD} -->",
        }
        for base, expected in (
            (correct, True),
            ({**correct, "ref": "master"}, False),
            ({**correct, "sha": HEAD}, False),
            ({**correct, "repo": {"full_name": "someone/9router"}}, False),
        ):
            pull = {"state": "open", "head": {"sha": HEAD, "repo": repo}, "base": base}
            with (self.subTest(base=base), patch.object(release, "api", return_value=pull),
                  patch.object(release, "pages", side_effect=[[request, native_state()], [], []])):
                self.assertEqual(release.check_review("warelik/9router", 1, HEAD, OTHER)[0], expected)


class PatchBoundaryTests(unittest.TestCase):
    def test_application_and_test_paths_are_allowed(self):
        release.validate_paths([
            "next.config.mjs", "Dockerfile", "npm-shrinkwrap.json",
            "open-sse/executors/default.js",
            "src/app/api/v1alpha/models/[...path]/route.js", "tests/unit/example.test.js",
        ])

    def test_release_owned_docker_workflow_is_the_only_allowed_workflow_path(self):
        release.validate_paths([".github/workflows/docker-publish.yml"])
        for path in (".github/workflows/other.yml", ".github/workflows/docker-publish.yml.bak",
                     ".github/docker-publish.yml", ".github/workflows/AGENTS.md"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                release.validate_paths([path])

    def test_old_controller_and_instructions_are_not_application_patches(self):
        for path in (".github/workflows/warelik-sync.yml", "warelik/automation/controller.py",
                     ".gitignore", "README.md", "package.json", "package-lock.json",
                     "docker-compose.yml",
                     "tests/translator/AGENTS.md", "open-sse/.rules"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                release.validate_paths([path])

    def test_patch_identity_is_deterministic_and_includes_names_and_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "0001-test.patch"
            first.write_bytes(b"first")
            digest = release.patch_identity(root)[1]
            self.assertEqual(digest, release.patch_identity(root)[1])
            first.write_bytes(b"second")
            self.assertNotEqual(digest, release.patch_identity(root)[1])
            first.write_bytes(b"first")
            first.rename(root / "0002-test.patch")
            self.assertNotEqual(digest, release.patch_identity(root)[1])

    def test_empty_patch_series_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            release.patch_identity(Path(directory))

    def test_source_records_the_fixed_cutoff_and_all_historical_test_files(self):
        source = json.loads((release.ROOT / "patches" / "source.json").read_text())
        self.assertEqual(source["source_repository"], "warelik/9router-warelik")
        self.assertEqual(source["source_tip"], "e01983276cb2f9ce05dc167e4d56c2c040559fd6")
        self.assertEqual(source["source_upstream_base"], "ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8")
        self.assertEqual(source["cutoff_exclusive"], "2026-10-13T00:00:00Z")
        self.assertEqual(len(source["test_files"]), 45)
        self.assertEqual(len(set(source["test_files"])), 45)


class TestEnvironmentTests(unittest.TestCase):
    def test_both_success_and_failure_isolate_and_remove_all_test_paths(self):
        for fails in (False, True):
            paths = []

            def execute(args, *, cwd, env, check, timeout):
                self.assertEqual(args[-2:], ["translator/example.test.js", "--update"])
                self.assertEqual(cwd, Path("/example/tests"))
                self.assertEqual(env["CI"], "true")
                self.assertTrue(check)
                self.assertEqual(timeout, 1550)
                self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "CODEX_REQUEST_TOKEN"} & env.keys())
                for name in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
                             "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "DATA_DIR"):
                    path = Path(env[name])
                    self.assertTrue(path.is_dir())
                    self.assertTrue(path.is_relative_to(Path(env["TMPDIR"]).parent))
                    self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                    paths.append(path)
                if fails:
                    raise subprocess.CalledProcessError(1, args)

            with (self.subTest(fails=fails),
                  patch.dict(os.environ, {"XDG_CONFIG_HOME": "/outside/config", "DATA_DIR": "/outside/data",
                                          "GH_TOKEN": "test-only", "GITHUB_TOKEN": "test-only",
                                          "CODEX_REQUEST_TOKEN": "test-only"}),
                  patch.object(release.subprocess, "run", side_effect=execute)):
                if fails:
                    with self.assertRaises(subprocess.CalledProcessError):
                        release.run_vitest(Path("/example"), ["translator/example.test.js"], update=True)
                else:
                    release.run_vitest(Path("/example"), ["translator/example.test.js"], update=True)
                self.assertTrue(paths)
                self.assertTrue(all(not path.exists() for path in paths))


class NodeBaseTests(unittest.TestCase):
    digest = "sha256:" + "e" * 64

    def inspect(self, *, candidate=None, current=None, upstream="node:22-alpine", platforms=None):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / "Dockerfile").write_text("ARG NODE_IMAGE=" + (candidate or f"node:22-alpine@{self.digest}") + "\n")
            metadata = {"digest": current if current is not None else self.digest,
                        "manifests": platforms if platforms is not None else [
                            {"platform": {"os": "linux", "architecture": "amd64"}}]}
            with patch.object(release, "run", side_effect=["ARG NODE_IMAGE=" + upstream, json.dumps(metadata)]) as run:
                release.check_node_base(app, OTHER)
            self.assertEqual(run.call_args.args,
                             ("docker", "buildx", "imagetools", "inspect", upstream,
                              "--format", "{{json .Manifest}}"))

    def test_current_index_pin_and_required_platform_are_accepted(self):
        self.inspect()

    def test_changed_base_tag_requires_reviewed_patch_and_rebuild(self):
        with self.assertRaisesRegex(ValueError, "pin is stale"):
            self.inspect(current="sha256:" + "f" * 64)

    def test_unpinned_or_changed_upstream_base_cannot_stay_on_old_node(self):
        with self.assertRaisesRegex(ValueError, "exact base tag"):
            self.inspect(candidate="node:22-alpine")
        with self.assertRaisesRegex(ValueError, "exact base tag"):
            self.inspect(upstream="node:24-alpine")

    def test_missing_digest_or_platform_is_not_a_successful_registry_check(self):
        with self.assertRaisesRegex(ValueError, "exact Node base digest"):
            self.inspect(current="")
        with self.assertRaisesRegex(ValueError, "no linux/amd64"):
            self.inspect(platforms=[{"platform": {"os": "linux", "architecture": "arm64"}}])

    def test_prepare_checks_base_before_the_already_published_shortcut(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            package = '{"version":"0.5.104"}'
            def git(*args, **kwargs):
                if args == ("git", "init", str(app)):
                    app.mkdir()
                    (app / "package.json").write_text(package)
                if args[:2] == ("git", "show"):
                    return package
                if args[:2] == ("git", "rev-parse"):
                    return HEAD
                return ""
            with (patch.dict(os.environ, {"GITHUB_REPOSITORY": "warelik/9router", "GITHUB_SHA": HEAD}),
                  patch.object(release, "api", side_effect=[{"sha": HEAD}, {"sha": OTHER}]),
                  patch.object(release, "proposal", return_value=None),
                  patch.object(release, "patch_identity", return_value=([Path("fix.patch")], "f" * 64)),
                  patch.object(release, "output"), patch.object(release, "run", side_effect=git),
                  patch.object(release, "check_node_base", side_effect=ValueError("pin is stale")) as check,
                  patch.object(release, "pages", side_effect=AssertionError("stale pin precedes release lookup")),
                  self.assertRaisesRegex(ValueError, "pin is stale")):
                release.prepare(app)
            check.assert_called_once_with(app, OTHER)


class GoldenBaselineTests(unittest.TestCase):
    def fixture(self, root):
        app, upstream = root / "app", root / "upstream"
        for directory in (app, upstream):
            (directory / "tests/translator/__snapshots__").mkdir(parents=True)
            (directory / "open-sse").mkdir()
            (directory / "package.json").write_text("{}")
            (directory / "tests/package.json").write_text("{}")
            (directory / "tests/translator/golden-url-header.test.js").write_text("shared test")
        (app / "node_modules").mkdir()
        (app / "tests/node_modules").mkdir()
        (app / "open-sse/identity.js").write_text("patched application")
        (upstream / "open-sse/identity.js").write_text("clean upstream")
        return app, upstream

    def execute(self, app, upstream, *, wrong_base=False, candidate_tracked=False):
        def git(*args, **kwargs):
            if args[1:3] == ("rev-parse", "HEAD"):
                return HEAD if wrong_base else OTHER
            return "tests/translator/golden-url-header.test.js"

        def process(args, **kwargs):
            if args[0] == "git":
                return subprocess.CompletedProcess(args, 0 if candidate_tracked and kwargs["cwd"] == app else 1)
            self.assertEqual(kwargs["cwd"], upstream / "tests")
            self.assertEqual(kwargs["env"]["CI"], "true")
            self.assertIn("--update", args)
            self.assertEqual(args[-2:], ["translator/golden-url-header.test.js", "--update"])
            self.assertEqual((upstream / "open-sse/identity.js").read_text(), "clean upstream")
            (upstream / "tests/translator/__snapshots__/golden-url-header.test.js.snap").write_bytes(b"upstream golden")
            return subprocess.CompletedProcess(args, 0)

        with patch.object(release, "run", side_effect=git), patch.object(release.subprocess, "run", side_effect=process):
            release.prepare_golden_baseline(app, upstream, OTHER)

    def test_missing_snapshot_comes_from_clean_upstream_not_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            app, upstream = self.fixture(Path(directory))
            self.execute(app, upstream)
            self.assertEqual((app / "tests/translator/__snapshots__/golden-url-header.test.js.snap").read_bytes(), b"upstream golden")
            self.assertEqual((app / "open-sse/identity.js").read_text(), "patched application")

    def test_another_upstream_commit_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            app, upstream = self.fixture(Path(directory))
            with self.assertRaises(ValueError):
                self.execute(app, upstream, wrong_base=True)

    def test_existing_different_untracked_snapshot_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            app, upstream = self.fixture(Path(directory))
            snapshot = app / "tests/translator/__snapshots__/golden-url-header.test.js.snap"
            snapshot.write_bytes(b"candidate-generated golden")
            with self.assertRaises(ValueError):
                self.execute(app, upstream)
            self.assertEqual(snapshot.read_bytes(), b"candidate-generated golden")

    def test_tracked_candidate_snapshot_cannot_replace_clean_upstream(self):
        with tempfile.TemporaryDirectory() as directory:
            app, upstream = self.fixture(Path(directory))
            snapshot = app / "tests/translator/__snapshots__/golden-url-header.test.js.snap"
            snapshot.write_bytes(b"candidate-generated golden")
            with self.assertRaises(ValueError):
                self.execute(app, upstream, candidate_tracked=True)
            self.assertEqual(snapshot.read_bytes(), b"candidate-generated golden")

    def test_tracked_upstream_snapshot_requires_exact_committed_bytes(self):
        for candidate, baseline, allowed in (
            (b"official golden", b"official golden", True),
            (b"changed candidate", b"official golden", False),
            (b"changed baseline", b"changed baseline", False),
        ):
            with self.subTest(candidate=candidate, baseline=baseline), tempfile.TemporaryDirectory() as directory:
                app, upstream = self.fixture(Path(directory))
                relative = "tests/translator/__snapshots__/golden-url-header.test.js.snap"
                (app / relative).write_bytes(candidate)
                (upstream / relative).write_bytes(baseline)
                with (patch.object(release, "run", return_value=OTHER),
                      patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)),
                      patch.object(release.subprocess, "check_output", return_value=b"official golden")):
                    if allowed:
                        release.prepare_golden_baseline(app, upstream, OTHER)
                    else:
                        with self.assertRaises(ValueError):
                            release.prepare_golden_baseline(app, upstream, OTHER)


class PublicationTests(unittest.TestCase):
    def artifacts(self, root, *, recipe=None):
        archive = root / "9router-image.tar.gz"
        archive.write_bytes(b"test archive")
        metadata = {
            "schema": 1, "repository": "warelik/9router", "upstream_repository": release.UPSTREAM,
            "candidate_sha": HEAD, "upstream_sha": OTHER, "config_sha": "c" * 40,
            "patchset_sha256": "d" * 64, "version": "0.5.104", "platform": "linux/amd64",
            "archive": archive.name, "archive_sha256": release.file_digest(archive),
            "image_id": "sha256:" + "e" * 64,
        }
        if recipe is not None:
            metadata.update({
                "recipe_sha256": recipe, "candidate_id": "a" * 64,
                "full_review_pr": 2, "delta_review_pr": 3,
                "run_id": 4, "run_attempt": 1,
            })
        provenance = root / "provenance.json"
        provenance.write_text(json.dumps(metadata))
        (root / "SHA256SUMS").write_text(
            "".join(f"{release.file_digest(path)}  {path.name}\n" for path in (archive, provenance)))
        env = {
            "GITHUB_REPOSITORY": "warelik/9router", "GITHUB_SHA": "c" * 40,
            "CANDIDATE_SHA": HEAD, "CANDIDATE_PR": "1", "UPSTREAM_SHA": OTHER,
            "PATCHSET_SHA256": "d" * 64, "APP_VERSION": "0.5.104",
            "RELEASE_TAG": (release._release_tag("0.5.104", OTHER, "d" * 64, recipe)
                            if recipe is not None else
                            release._legacy_release_tag("0.5.104", OTHER, "d" * 64)),
        }
        return env

    def fake_api(self, root, env, calls, *, bad_digest=False, draft_sha=HEAD, tag_sha=HEAD, missing_tag=False):
        assets = [
            {"name": path.name, "size": path.stat().st_size,
             "digest": "sha256:" + ("0" * 64 if bad_digest else release.file_digest(path))}
            for path in root.iterdir()
        ]

        def request(path, *, method="GET", data=None, **kwargs):
            calls.append((path, method, data))
            path = path.split("?")[0]
            if path.endswith("/pulls/1/comments"):
                return []
            if path == "repos/warelik/9router":
                return {"default_branch": "downstream"}
            if path.endswith("/commits/downstream"):
                return {"sha": env["GITHUB_SHA"]}
            if path.endswith("/releases") and method == "GET":
                return [{"id": 7, "tag_name": env["RELEASE_TAG"], "draft": True,
                         "target_commitish": draft_sha}]
            if path.endswith("/releases/7/assets"):
                return assets
            if "/git/matching-refs/tags/" in path:
                return [{"ref": "refs/tags/" + env["RELEASE_TAG"] + ("-other" if missing_tag else ""),
                         "object": {"type": "commit", "sha": tag_sha}}]
            if "/git/ref/tags/" in path:
                return {"ref": "refs/tags/" + env["RELEASE_TAG"],
                        "object": {"type": "commit", "sha": tag_sha}}
            if path.endswith("/git/refs") and method == "POST":
                return data
            if path.endswith("/pulls") and method == "GET":
                return [{"number": 1, "head": {"sha": HEAD, "ref": "review/example",
                                               "repo": {"full_name": "warelik/9router"}},
                         "base": {"sha": OTHER, "ref": f"review-base/{OTHER}"}}]
            if method == "PATCH":
                return {}
            raise AssertionError(f"Unexpected GitHub request: {path} {method}")

        return request

    def test_verified_legacy_twelve_field_draft_is_published_without_clobbering_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = self.artifacts(root)
            metadata = json.loads((root / "provenance.json").read_text())
            self.assertEqual(len(metadata), 12)
            self.assertNotIn("recipe_sha256", metadata)
            calls = []
            with (patch.dict(os.environ, env),
                  patch.object(release, "check_review", return_value=(True, "reviewed")) as review,
                  patch.object(release, "api", side_effect=self.fake_api(root, env, calls)),
                  patch.object(release, "run", side_effect=AssertionError("Do not overwrite assets"))):
                release.publish(root)
            self.assertEqual(review.call_count, 2)
            writes = [(path, data) for path, method, data in calls if method == "PATCH"]
            self.assertEqual(writes, [
                ("repos/warelik/9router/releases/7", {"draft": False, "make_latest": "true"}),
                ("repos/warelik/9router/pulls/1", {"state": "closed"}),
            ])

    def test_verified_recipe_tagged_draft_uses_full_shared_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            recipe = "f" * 64
            env = self.artifacts(root, recipe=recipe)
            metadata = json.loads((root / "provenance.json").read_text())
            self.assertEqual(len(metadata), 18)
            self.assertEqual(metadata["recipe_sha256"], recipe)
            self.assertTrue(env["RELEASE_TAG"].endswith("-r" + recipe[:12]))
            calls = []
            with (patch.dict(os.environ, env),
                  patch.object(release, "check_review", return_value=(True, "reviewed")) as review,
                  patch.object(release, "api", side_effect=self.fake_api(root, env, calls)),
                  patch.object(release, "run", side_effect=AssertionError("Do not overwrite assets"))):
                release.publish(root)
            self.assertEqual(review.call_count, 2)

    def test_publish_passes_the_captured_repair_head_to_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = self.artifacts(root)
            env["REPAIR_HEAD"] = OTHER
            calls = []
            with (patch.dict(os.environ, env),
                  patch.object(release, "check_review", return_value=(True, "reviewed")),
                  patch.object(release, "api", side_effect=self.fake_api(root, env, calls)),
                  patch.object(release, "close_recovered_repair") as close):
                release.publish(root)
            close.assert_called_once_with(
                "warelik/9router", env["GITHUB_SHA"], expected_head=OTHER)

    def test_publish_step_wires_the_prepared_repair_head(self):
        workflow = (Path(__file__).parents[1] / ".github/workflows/release.yml").read_text()
        publish_step = workflow.split("- name: Publish Only This Verified Candidate", 1)[1].split("run:", 1)[0]
        self.assertIn("REPAIR_HEAD: ${{ needs.prepare.outputs.repair_head }}", publish_step)

    def test_wrong_uploaded_digest_source_or_tag_never_publishes(self):
        for scenario in ({"bad_digest": True}, {"draft_sha": OTHER}, {"tag_sha": OTHER}):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                env = self.artifacts(root)
                calls = []
                with (patch.dict(os.environ, env),
                      patch.object(release, "check_review", return_value=(True, "reviewed")),
                      patch.object(release, "api", side_effect=self.fake_api(root, env, calls, **scenario)),
                      self.assertRaises(ValueError)):
                    release.publish(root)
                self.assertFalse(any(method == "PATCH" for _, method, _ in calls))

    def test_absent_exact_tag_is_created_and_verified_not_confused_with_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = self.artifacts(root)
            calls = []
            with (patch.dict(os.environ, env),
                  patch.object(release, "check_review", return_value=(True, "reviewed")),
                  patch.object(release, "api", side_effect=self.fake_api(root, env, calls, missing_tag=True))):
                release.publish(root)
            self.assertIn(("repos/warelik/9router/git/refs", "POST",
                           {"ref": "refs/tags/" + env["RELEASE_TAG"], "sha": HEAD}), calls)
            self.assertIn(("repos/warelik/9router/git/ref/tags/" + env["RELEASE_TAG"], "GET", None), calls)

    def test_changed_archive_is_rejected_before_release_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = self.artifacts(root)
            calls = []
            (root / "9router-image.tar.gz").write_bytes(b"changed")
            with (patch.dict(os.environ, env),
                  patch.object(release, "check_review", return_value=(True, "reviewed")),
                  patch.object(release, "api", side_effect=self.fake_api(root, env, calls)),
                  self.assertRaises(ValueError)):
                release.publish(root)
            self.assertFalse(any(method != "GET" for _, method, _ in calls))

    def test_published_release_cleanup_closes_only_its_exact_review(self):
        repo = "warelik/9router"
        pull = {"number": 1, "head": {"sha": HEAD, "repo": {"full_name": repo}},
                "base": {"sha": OTHER, "ref": f"review-base/{OTHER}"}}
        changed = {**pull, "number": 2, "head": {**pull["head"], "sha": OTHER}}
        with (patch.object(release, "pages", return_value=[pull, changed]),
              patch.object(release, "api") as api):
            release.close_published_reviews(repo, HEAD, OTHER, "review/example")
        api.assert_called_once_with("repos/warelik/9router/pulls/1", method="PATCH", data={"state": "closed"})

    def test_provenance_requires_the_declared_oci_source_label(self):
        for source in (None, "https://github.com/someone/else", "https://github.com/warelik/9router"):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                env = self.artifacts(root)
                env.update({"CONFIG_SHA": env["GITHUB_SHA"], "IMAGE_TAG": "example:test"})
                image = {
                    "Architecture": "amd64", "Os": "linux", "Id": "sha256:" + "e" * 64,
                    "Config": {"Labels": {
                        "org.opencontainers.image.source": source,
                        "org.opencontainers.image.revision": HEAD,
                        "org.opencontainers.image.version": env["APP_VERSION"],
                        "io.9router.upstream.revision": OTHER,
                        "io.9router.patches.sha256": env["PATCHSET_SHA256"],
                    }},
                }
                with patch.dict(os.environ, env), patch.object(release, "run", return_value=json.dumps([image])):
                    if source == "https://github.com/warelik/9router":
                        release.provenance(root / "9router-image.tar.gz")
                        metadata = json.loads((root / "provenance.json").read_text())
                        self.assertEqual(set(metadata), {
                            "schema", "repository", "upstream_repository", "version",
                            "candidate_sha", "upstream_sha", "config_sha", "patchset_sha256",
                            "image_id", "platform", "archive", "archive_sha256",
                        })
                    else:
                        with self.assertRaises(ValueError):
                            release.provenance(root / "9router-image.tar.gz")

    def test_cached_release_requires_source_and_remote_asset_integrity(self):
        for scenario in ("valid", "valid_legacy", "bad_digest", "bad_candidate", "bad_tag", "bad_target"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                recipe = None if scenario == "valid_legacy" else "f" * 64
                env = self.artifacts(root, recipe=recipe)
                if scenario == "bad_candidate":
                    provenance = root / "provenance.json"
                    metadata = json.loads(provenance.read_text())
                    metadata["candidate_sha"] = OTHER
                    provenance.write_text(json.dumps(metadata))
                    (root / "SHA256SUMS").write_text("".join(
                        f"{release.file_digest(root / name)}  {name}\n"
                        for name in ("9router-image.tar.gz", "provenance.json")))
                published = {"id": 7, "draft": False, "tag_name": env["RELEASE_TAG"],
                             "target_commitish": OTHER if scenario == "bad_target" else HEAD}

                def download(*args):
                    destination = Path(args[args.index("--dir") + 1])
                    for name in ("provenance.json", "SHA256SUMS"):
                        shutil.copyfile(root / name, destination / name)
                    return ""

                fake = self.fake_api(root, env, [], bad_digest=scenario == "bad_digest",
                                     tag_sha=OTHER if scenario == "bad_tag" else HEAD)
                with patch.object(release, "api", side_effect=fake), patch.object(release, "run", side_effect=download):
                    if scenario in {"valid", "valid_legacy"}:
                        release.verify_published_release("warelik/9router", published, HEAD, OTHER,
                                                         env["PATCHSET_SHA256"], env["APP_VERSION"],
                                                         recipe)
                    else:
                        with self.assertRaises(ValueError):
                            release.verify_published_release("warelik/9router", published, HEAD, OTHER,
                                                             env["PATCHSET_SHA256"], env["APP_VERSION"])

if __name__ == "__main__":
    unittest.main()

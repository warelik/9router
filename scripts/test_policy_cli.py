"""Trusted CLI regressions for the proposed 9router release-policy program."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import release


REPO = "warelik/9router"
CONFIG = "a" * 40
UPSTREAM = "d" * 40
SEED = "b" * 40
HEAD = "c" * 40
CYCLE = "e" * 64


class CandidatePolicyCliTests(unittest.TestCase):
    def candidate_release(self):
        configured = os.environ.get("NINEROUTER_POLICY_CANDIDATE_RELEASE")
        return Path(configured or release.__file__).resolve()

    def test_hosted_shared_policy_requires_the_trusted_baseline_private_pin(self):
        with (patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=True),
              self.assertRaisesRegex(ValueError, "requires its exact trusted baseline pin")):
            release.check_policy_shared(Path("/unavailable/candidate"))

    def test_shared_policy_launcher_isolates_original_oracle_and_refuses_incomplete_runs(self):
        source = self.candidate_release().read_text(encoding="utf-8")
        check_policy_start = source.index("def check_policy(candidate, *, shared=False):")
        check_policy_end = source.index("\ndef check_policy_shared(", check_policy_start)
        check_policy = source[check_policy_start:check_policy_end]
        shared_start = check_policy.index("    if shared:\n        launcher = (\n")
        legacy_start = check_policy.index("    else:\n        launcher = (\n", shared_start)
        shared_launcher = check_policy[shared_start:legacy_start]

        for fragment in (
                'baseline_private_root_text = os.environ.get("NINEROUTER_POLICY_BASELINE_MAINTENANCE", "")',
                "baseline_private_pin_available = bool(baseline_private_root_text)",
                "baseline_private_identity_enabled = shared and baseline_private_pin_available",
                'if shared and os.environ.get("GITHUB_ACTIONS") and not baseline_private_pin_available:',
                'trusted_maintenance = trusted_scripts / "maintenance.py"',
                'trusted_maintenance_lock = trusted_scripts / "maintenance.lock.json"',
                "trusted_lock = _json_object(trusted_maintenance_lock.read_bytes())",
                "candidate_private_source, candidate_private_receipt = _candidate_private_lifecycle(",
                "candidate_lock = _json_object((candidate_scripts / \"maintenance.lock.json\").read_bytes())",
                "if trusted_lock != candidate_lock:",
                '"NINEROUTER_POLICY_BASELINE_MAINTENANCE", ""',
                'baseline_module_path = baseline_private_root / "fork_lifecycle.py"',
                "_json_object(baseline_receipt) != {",
                'trusted_lock["module_sha256"]',
                'hashlib.sha256(baseline_module).hexdigest() != trusted_lock["module_sha256"]',
                "candidate_test_delta = []",
                "trusted_by_name = {test.name: test for test in trusted_tests}",
                "if baseline is None or test.read_bytes() != baseline.read_bytes():",
                "candidate_test_delta.append(test)",
                "for path in candidate_test_delta",
                'str(root / "candidate" / path.relative_to(candidate))',
                "for path in candidate_test_delta)",
                "candidate_tests=[pathlib.Path(p) for p in sys.argv[4:-1]]",
                'command.append(str(writable / "policy-suite-completion.json"))',
                "NINEROUTER_POLICY_PARSER=str(trusted_parser)",
                "NINEROUTER_POLICY_CANDIDATE_RELEASE=str(candidate_module)",
                "NINEROUTER_POLICY_CANDIDATE_WORKFLOW=str(proposed_workflow)",
                'env["NINEROUTER_POLICY_BASELINE_WORKFLOW"] = str(trusted_workflow_path)',
                'if completion.exists() or completion.is_symlink():',
                'env["NINEROUTER_SOURCE_ROOT"] = str(sandbox_candidate)',
                'env["FORK_MAINTENANCE_ROOT"] = str(private_root)',
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, source)

        for fragment in (
                "import importlib.util,json,pathlib,sys,unittest",
                "parser=pathlib.Path(sys.argv[3]).resolve()",
                "sys.path.insert(0,str(parser))",
                "import yaml",
                "if not pathlib.Path(yaml.__file__).resolve().is_relative_to(parser):",
                "sys.path[:0]=[str(candidate),str(oracle)]",
                "oracle_tests=sorted(oracle.glob('test_*.py'))",
                "candidate_tests=[pathlib.Path(p) for p in sys.argv[4:-1]]",
                "load(oracle_tests,'immutable_a')",
                "load(candidate_tests,'candidate_b')",
                "suite=unittest.TestSuite([load(oracle_tests,'immutable_a'),load(candidate_tests,'candidate_b')])",
                "expected=suite.countTestCases()",
                "result=runner.run(suite)",
                "'expected_count':expected",
                "'executed_count':result.testsRun",
                "'successful':result.wasSuccessful()",
                "completion.write_text(json.dumps(",
                "sys.exit(not result.wasSuccessful())",
                "pathlib.Path(release.__file__).resolve()!=candidate/'release.py'",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, shared_launcher)

        launcher_import = shared_launcher.index("import release")
        self.assertLess(shared_launcher.index("sys.path[:0]=[str(candidate),str(oracle)]"),
                        launcher_import)
        self.assertLess(launcher_import,
                        shared_launcher.index("oracle_tests=sorted(oracle.glob('test_*.py'))"))
        self.assertLess(shared_launcher.index("expected=suite.countTestCases()"),
                        shared_launcher.index("result=runner.run(suite)"))

        self.assertIn("_verify_policy_test_completion(completion, result.returncode)", source)
        completion_start = source.index("def _verify_policy_test_completion(")
        completion_end = source.index("\ndef _stop_policy_container(", completion_start)
        completion = source[completion_start:completion_end]
        for fragment in (
                "if returncode != 0:",
                "marker_path.is_symlink() or not marker_path.is_file() or marker_path.stat().st_size > 1024",
                'set(marker) != {"schema", "expected_count", "executed_count", "successful"}',
                'type(marker.get("schema")) is not int',
                'type(marker.get("expected_count")) is not int',
                'type(marker.get("executed_count")) is not int',
                'marker["expected_count"] <= 0',
                'marker["executed_count"] != marker["expected_count"]',
                'marker.get("successful") is not True',
        ):
            with self.subTest(completion_guard=fragment):
                self.assertIn(fragment, completion)

    def _pull(self, *, config=CONFIG, seed=SEED, head=HEAD):
        identity = {"schema": 1, "config": config, "upstream": UPSTREAM,
                    "seed": seed, "cycle": CYCLE, "window": "run-42"}
        return {
            "number": 42,
            "state": "open",
            "user": {"login": "warelik", "type": "User"},
            "created_at": "2026-10-17T00:00:00Z",
            "body": "<!-- 9router-repair:v1 " + json.dumps(identity, separators=(",", ":")) + " -->",
            "base": {"ref": "downstream", "sha": config, "repo": {"full_name": REPO}},
            "head": {"ref": "repair/policy-fixture", "sha": head,
                     "repo": {"full_name": REPO}},
        }

    def _routes(self, *, config=CONFIG, seed=SEED, head=HEAD, finding=None,
                adoption=False, expired_fix=False):
        pull = self._pull(config=config, seed=seed, head=head)
        requested_at = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
        comments = [{
            "user": {"login": "warelik", "type": "User"},
            "created_at": requested_at,
            "body": f"@codex review\n<!-- 9router-policy:{head} -->",
        }]
        if expired_fix:
            started = (datetime.now(timezone.utc)
                       - timedelta(seconds=release.REVIEW_WAIT_SECONDS + 30)).isoformat()
            comments.append({
                "user": {"login": "warelik", "type": "User"},
                "created_at": started,
                "body": f"@codex fix this repair\n<!-- 9router-fix:{seed}:1 -->",
            })
        review = {
            "user": {"login": release.BOT, "type": "Bot"},
            "commit_id": head,
            "submitted_at": datetime.now(timezone.utc).isoformat(),
            "state": "COMMENTED",
            "body": "Codex Review: Didn't find any major issues.",
        }
        inline = []
        if finding:
            inline.append({
                "user": {"login": release.BOT, "type": "Bot"},
                "commit_id": head,
                "path": "scripts/release.py",
                "line": 1,
                "body": finding,
            })
        routes = {
            f"GET repos/{REPO}/commits/downstream": {"sha": config},
            f"GET repos/{REPO}/pulls?state=open&base=downstream": [pull],
            f"GET repos/{REPO}/pulls?state=all&base=downstream": [pull],
            f"GET repos/{REPO}/issues/42/comments": comments,
            f"GET repos/{REPO}/pulls/42": pull,
            f"GET repos/{REPO}/pulls/42/reviews": [review],
            f"GET repos/{REPO}/pulls/42/comments": inline,
        }
        if adoption:
            routes.update({
                f"GET repos/{REPO}/issues?state=open": [],
                f"POST repos/{REPO}/issues/42/comments": None,
                f"PATCH repos/{REPO}/pulls/42": None,
                f"POST repos/{REPO}/actions/workflows/release.yml/dispatches": None,
            })
        return routes

    @staticmethod
    def _write_fake_gh(binary_dir):
        executable = binary_dir / "gh"
        executable.write_text("#!" + sys.executable + "\n" + r'''import json, os, sys
args = sys.argv[1:]
if args[:2] == ["auth", "setup-git"]:
    raise SystemExit(0)
if not args or args[0] != "api":
    print("unexpected fake gh command", file=sys.stderr)
    raise SystemExit(2)
method = args[args.index("--method") + 1] if "--method" in args else "GET"
path = next(arg for arg in args[1:]
            if not arg.startswith("-") and arg not in {"GET", "POST", "PATCH", "PUT", "DELETE"})
body = sys.stdin.read() if "--input" in args else ""
try:
    payload = json.loads(body) if body else None
except ValueError:
    payload = body
base_path = path.split("&per_page=", 1)[0].split("?per_page=", 1)[0]
record = {"method": method, "path": base_path, "body": payload}
with open(os.environ["NINEROUTER_FAKE_GH_CALLS"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(record, sort_keys=True) + "\n")
routes = json.load(open(os.environ["NINEROUTER_FAKE_GH_ROUTES"], encoding="utf-8"))
key = f"{method} {base_path}"
if key not in routes:
    print("unexpected fake GitHub API request: " + key, file=sys.stderr)
    raise SystemExit(2)
print(json.dumps(routes[key]))
''', encoding="utf-8")
        executable.chmod(0o700)

    @staticmethod
    def _write_prepare_git(binary_dir):
        executable = binary_dir / "git"
        executable.write_text("#!" + sys.executable + "\n" + r'''import json, os, sys
args = sys.argv[1:]
with open(os.environ["NINEROUTER_FAKE_GIT_CALLS"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
mode = os.environ["NINEROUTER_FAKE_GIT_MODE"]
if mode == "prepare":
    if args and args[0] in {"fetch", "merge-base"}:
        raise SystemExit(0)
    if args and args[0] == "rev-parse" and args[-1].endswith("^"):
        print(os.environ["NINEROUTER_FAKE_GIT_CONFIG"])
        raise SystemExit(0)
    if args and args[0] == "diff" and "--name-only" in args:
        sys.stdout.write(os.environ["NINEROUTER_FAKE_GIT_CHANGED_PATHS"])
        raise SystemExit(0)
    if args and args[0] == "ls-tree":
        path = args[-1]
        print("100644 blob " + "f" * 40 + "\t" + path)
        raise SystemExit(0)
    print("unexpected prepare git command", file=sys.stderr)
    raise SystemExit(2)
if mode == "rewrite":
    remote = os.environ["NINEROUTER_FAKE_GIT_REMOTE"]
    args = [remote if arg == "https://github.com/warelik/9router.git" else arg for arg in args]
    os.execv(os.environ["NINEROUTER_REAL_GIT"], [os.environ["NINEROUTER_REAL_GIT"], *args])
print("unexpected fake git mode", file=sys.stderr)
raise SystemExit(2)
''', encoding="utf-8")
        executable.chmod(0o700)

    @staticmethod
    def _output_map(text):
        values = {}
        for line in text.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        return values

    def run_prepare_cli(self, candidate, *, finding=None, expired_fix=False):
        with tempfile.TemporaryDirectory(prefix="9router-policy-cli-",
                                         dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
            root = Path(temporary)
            binary_dir = root / "bin"
            binary_dir.mkdir()
            routes_file = root / "github-routes.json"
            routes_file.write_text(json.dumps(self._routes(finding=finding,
                                                            expired_fix=expired_fix)), encoding="utf-8")
            gh_calls = root / "github-calls.jsonl"
            gh_calls.touch()
            git_calls = root / "git-calls.jsonl"
            git_calls.touch()
            self._write_fake_gh(binary_dir)
            self._write_prepare_git(binary_dir)
            home, tmp = root / "home", root / "tmp"
            home.mkdir(mode=0o700)
            tmp.mkdir(mode=0o700)
            output = root / "github-output"
            output.touch()
            env = {
                "PATH": f"{binary_dir}:{os.defpath}",
                "HOME": str(home),
                "TMPDIR": str(tmp),
                "GITHUB_REPOSITORY": REPO,
                "GITHUB_SHA": CONFIG,
                "GITHUB_RUN_ID": "42",
                "GITHUB_OUTPUT": str(output),
                "PYTHONDONTWRITEBYTECODE": "1",
                "LC_ALL": "C.UTF-8",
                "TZ": "UTC",
                "NINEROUTER_FAKE_GH_ROUTES": str(routes_file),
                "NINEROUTER_FAKE_GH_CALLS": str(gh_calls),
                "NINEROUTER_FAKE_GIT_CALLS": str(git_calls),
                "NINEROUTER_FAKE_GIT_MODE": "prepare",
                "NINEROUTER_FAKE_GIT_CONFIG": CONFIG,
                "NINEROUTER_FAKE_GIT_CHANGED_PATHS": "scripts/release.py\nscripts/test_policy_cli.py\n",
            }
            result = subprocess.run(
                [sys.executable, "-B", str(candidate), "prepare", str(root / "source")],
                cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=30, check=False,
            )
            output_text = output.read_text(encoding="utf-8")
            api_calls = [json.loads(line) for line in gh_calls.read_text(encoding="utf-8").splitlines()]
            git_calls_data = [json.loads(line) for line in git_calls.read_text(encoding="utf-8").splitlines()]
            return result, output_text, api_calls, git_calls_data

    def assert_policy_prepare_ready(self, result, output, api_calls, git_calls):
        self.assertEqual(result.returncode, 0, result.stderr)
        values = self._output_map(output)
        self.assertEqual(values.get("ready"), "true")
        self.assertEqual(values.get("mode"), "policy")
        self.assertEqual(values.get("repair_head"), HEAD)
        paths = {call["path"] for call in api_calls}
        self.assertIn(f"repos/{REPO}/pulls/42/reviews", paths)
        self.assertIn(f"repos/{REPO}/pulls/42/comments", paths)
        self.assertFalse(any(call["method"] in {"POST", "PATCH"} for call in api_calls))
        self.assertTrue(any(call and call[0] == "diff" for call in git_calls))

    def test_prepare_cli_returns_readiness_for_a_clean_exact_sha_review(self):
        candidate = self.candidate_release()
        result, output, api_calls, git_calls = self.run_prepare_cli(candidate)
        self.assert_policy_prepare_ready(result, output, api_calls, git_calls)

    def test_candidate_check_policy_cli_rejects_semantic_unpinned_yaml_before_container(self):
        parser = os.environ.get("NINEROUTER_POLICY_PARSER")
        self.assertTrue(parser, "trusted pinned YAML parser must be installed before CLI tests")
        for workflow_text in (
            'jobs:\n  check:\n    steps:\n      - "uses": actions/checkout@main\n',
            'jobs:\n  check:\n    steps:\n      - {uses: "actions/checkout@main"}\n',
        ):
            with self.subTest(workflow=workflow_text), tempfile.TemporaryDirectory(
                    prefix="9router-policy-yaml-cli-",
                    dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
                root = Path(temporary).resolve()
                scripts = root / "scripts"
                scripts.mkdir()
                candidate = scripts / "release.py"
                candidate.write_bytes(self.candidate_release().read_bytes())
                (scripts / "yaml.py").write_text(
                    "from pathlib import Path\n"
                    f"Path({str(root / 'candidate-yaml-shadowed')!r}).write_text('bad')\n",
                    encoding="utf-8",
                )
                (root / "yaml.py").write_text(
                    "from pathlib import Path\n"
                    f"Path({str(root / 'cwd-yaml-shadowed')!r}).write_text('bad')\n",
                    encoding="utf-8",
                )
                workflow = root / ".github/workflows/release.yml"
                workflow.parent.mkdir(parents=True)
                workflow.write_text(workflow_text, encoding="utf-8")
                home, tmp = root / "home", root / "tmp"
                home.mkdir(mode=0o700)
                tmp.mkdir(mode=0o700)
                env = {
                    "PATH": os.defpath,
                    "HOME": str(home),
                    "TMPDIR": str(tmp),
                    "NINEROUTER_POLICY_PARSER": parser,
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "LC_ALL": "C.UTF-8",
                    "TZ": "UTC",
                }
                result = subprocess.run(
                    [sys.executable, "-B", str(candidate), "check-policy", str(root)],
                    cwd=root, env=env, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
                )
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("exact commit SHA", result.stderr)
                self.assertFalse((root / "candidate-yaml-shadowed").exists())
                self.assertFalse((root / "cwd-yaml-shadowed").exists())

    def test_prepare_cli_blocks_p2_findings_in_a_changed_candidate(self):
        candidate = self.candidate_release()
        if candidate.read_bytes() == Path(release.__file__).resolve().read_bytes():
            self.skipTest("The bootstrap candidate is its own trusted baseline")
        result, output, api_calls, _ = self.run_prepare_cli(candidate, finding="[P2] unresolved correctness defect")
        values = self._output_map(output)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(values.get("ready"), "false")
        self.assertEqual(values.get("mode"), "policy")
        self.assertIn("unresolved finding", result.stderr)
        self.assertFalse(any(call["method"] in {"POST", "PATCH"} for call in api_calls))

    def test_prepare_cli_timeout_fails_without_owner_escalation_for_changed_candidate(self):
        candidate = self.candidate_release()
        if candidate.read_bytes() == Path(release.__file__).resolve().read_bytes():
            self.skipTest("The bootstrap candidate is its own trusted baseline")
        result, output, api_calls, _ = self.run_prepare_cli(candidate, expired_fix=True)
        values = self._output_map(output)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(values.get("ready"), "false")
        self.assertEqual(values.get("mode"), "waiting")
        self.assertIn("two-hour", result.stderr)
        self.assertFalse(any(call["method"] in {"POST", "PATCH"} for call in api_calls))

    def run_stale_node_pin_cli(self, candidate):
        with tempfile.TemporaryDirectory(prefix="9router-node-policy-cli-",
                                         dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
            root = Path(temporary)
            candidate_root = root / "candidate"
            scripts = candidate_root / "scripts"
            patches = candidate_root / "patches"
            scripts.mkdir(parents=True)
            patches.mkdir()
            shutil.copy2(candidate, scripts / "release.py")
            (patches / "0001-fixture.patch").write_text("fixture patch\n", encoding="utf-8")

            binary_dir = root / "bin"
            binary_dir.mkdir()
            routes_file = root / "github-routes.json"
            routes_file.write_text(json.dumps({
                f"GET repos/{REPO}/commits/downstream": {"sha": CONFIG},
                f"GET repos/{release.UPSTREAM}/commits/{release.UPSTREAM_BRANCH}": {"sha": UPSTREAM},
                f"GET repos/{REPO}/pulls?state=open&base=downstream": [],
                f"GET repos/{REPO}/releases": [],
            }), encoding="utf-8")
            gh_calls = root / "github-calls.jsonl"
            gh_calls.touch()
            git_calls = root / "git-calls.jsonl"
            git_calls.touch()
            docker_calls = root / "docker-calls.jsonl"
            docker_calls.touch()
            self._write_fake_gh(binary_dir)

            fake_git = binary_dir / "git"
            fake_git.write_text("#!" + sys.executable + "\n" + r'''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["NINEROUTER_FAKE_GIT_CALLS"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
if args and args[0] == "init":
    Path(args[-1]).mkdir(parents=True)
    raise SystemExit(0)
if args and args[0] == "checkout":
    Path("package.json").write_text('{"version":"1.2.3"}\n', encoding="utf-8")
    Path("Dockerfile").write_text("ARG NODE_IMAGE=node:22-alpine@sha256:" + "a" * 64 + "\n",
                                  encoding="utf-8")
    raise SystemExit(0)
if args and args[0] == "rev-parse":
    print("c" * 40)
    raise SystemExit(0)
if args and args[0] == "diff" and "--name-only" in args:
    print("Dockerfile")
    raise SystemExit(0)
if args and args[0] == "show":
    if args[-1].endswith(":package.json"):
        print('{"version":"1.2.3"}')
        raise SystemExit(0)
    if args[-1].endswith(":Dockerfile"):
        print("ARG NODE_IMAGE=node:22-alpine")
        raise SystemExit(0)
if args and args[0] in {"config", "remote", "fetch", "am"}:
    raise SystemExit(0)
print("unexpected fixture git command: " + json.dumps(args), file=sys.stderr)
raise SystemExit(2)
''', encoding="utf-8")
            fake_git.chmod(0o700)

            fake_docker = binary_dir / "docker"
            fake_docker.write_text("#!" + sys.executable + "\n" + r'''import json, os, sys
args = sys.argv[1:]
with open(os.environ["NINEROUTER_FAKE_DOCKER_CALLS"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
if args[:3] != ["buildx", "imagetools", "inspect"]:
    print("unexpected fixture docker command", file=sys.stderr)
    raise SystemExit(2)
print(json.dumps({"digest": "sha256:" + "b" * 64,
                  "manifests": [{"platform": {"os": "linux", "architecture": "amd64"}}]}))
''', encoding="utf-8")
            fake_docker.chmod(0o700)
            home, tmp = root / "home", root / "tmp"
            home.mkdir(mode=0o700)
            tmp.mkdir(mode=0o700)
            output = root / "github-output"
            output.touch()
            env = {
                "PATH": f"{binary_dir}:{os.defpath}",
                "HOME": str(home), "TMPDIR": str(tmp),
                "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": CONFIG,
                "GITHUB_RUN_ID": "42", "GITHUB_OUTPUT": str(output),
                "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C.UTF-8", "TZ": "UTC",
                "NINEROUTER_FAKE_GH_ROUTES": str(routes_file),
                "NINEROUTER_FAKE_GH_CALLS": str(gh_calls),
                "NINEROUTER_FAKE_GIT_CALLS": str(git_calls),
                "NINEROUTER_FAKE_DOCKER_CALLS": str(docker_calls),
            }
            result = subprocess.run(
                [sys.executable, "-B", str(scripts / "release.py"), "prepare", str(root / "source")],
                cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=30, check=False,
            )
            api_calls = [json.loads(line) for line in gh_calls.read_text(encoding="utf-8").splitlines()]
            git_calls_data = [json.loads(line) for line in git_calls.read_text(encoding="utf-8").splitlines()]
            docker_calls_data = [json.loads(line) for line in docker_calls.read_text(encoding="utf-8").splitlines()]
            return result, output.read_text(encoding="utf-8"), api_calls, git_calls_data, docker_calls_data

    def test_prepare_cli_rechecks_a_stale_node_pin_before_release_lookup(self):
        candidate = self.candidate_release()
        if candidate.read_bytes() == Path(release.__file__).resolve().read_bytes():
            self.skipTest("The bootstrap candidate is its own trusted baseline")
        result, output, api_calls, git_calls, docker_calls = self.run_stale_node_pin_cli(candidate)
        values = self._output_map(output)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(values.get("ready"), "false")
        self.assertIn("Node base pin is stale", result.stderr)
        self.assertTrue(any(call[:2] == ["show", f"{UPSTREAM}:Dockerfile"] for call in git_calls))
        self.assertTrue(docker_calls)
        self.assertNotIn(f"repos/{REPO}/releases", {call["path"] for call in api_calls})

    def test_top_level_exit_and_forged_output_do_not_satisfy_prepare_cli_contract(self):
        head = "c" * 40
        for source in (
            "import os\nos._exit(0)\n",
            "import os\nwith open(os.environ['GITHUB_OUTPUT'], 'a') as f:\n"
            f"    f.write('ready=true\\nmode=policy\\nrepair_head={head}\\n')\n",
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory(
                    prefix="9router-policy-fake-cli-", dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
                fake = Path(temporary) / "release.py"
                fake.write_text(source, encoding="utf-8")
                result, output, api_calls, git_calls = self.run_prepare_cli(fake)
                self.assertEqual(result.returncode, 0)
                with self.assertRaises(AssertionError):
                    self.assert_policy_prepare_ready(result, output, api_calls, git_calls)
                self.assertFalse(api_calls)
                self.assertFalse(git_calls)

    @staticmethod
    def git(cwd, *arguments):
        result = subprocess.run(["git", *map(str, arguments)], cwd=cwd, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode != 0:
            raise AssertionError(f"git {' '.join(map(str, arguments))} failed: {result.stderr}")
        return result.stdout.strip()

    @staticmethod
    def git_output(cwd, *arguments):
        result = subprocess.run(["git", *map(str, arguments)], cwd=cwd, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode != 0:
            raise AssertionError(f"git {' '.join(map(str, arguments))} failed: {result.stderr}")
        return result.stdout

    def make_adoption_fixture(self, root, release_source):
        remote = root / "origin.git"
        work = root / "policy-checkout"
        self.git(root, "init", "--bare", "--initial-branch=downstream", remote)
        self.git(root, "init", "--initial-branch=downstream", work)
        self.git(work, "config", "user.name", "9router policy fixture")
        self.git(work, "config", "user.email", "9router-policy@example.invalid")
        (work / "scripts").mkdir()
        (work / "scripts/release.py").write_text("# trusted policy baseline\n", encoding="utf-8")
        (work / "scripts/test_policy_cli.py").write_text("# trusted CLI baseline\n", encoding="utf-8")
        self.git(work, "add", "--all")
        self.git(work, "commit", "-m", "trusted policy fixture")
        config = self.git(work, "rev-parse", "HEAD")
        self.git(work, "remote", "add", "origin", remote)
        self.git(work, "push", "origin", "HEAD:refs/heads/downstream")
        self.git(work, "checkout", "-b", "repair/policy-fixture")
        self.git(work, "commit", "--allow-empty", "-m", "repair context seed")
        seed = self.git(work, "rev-parse", "HEAD")
        self.git(work, "push", "origin", "HEAD:refs/heads/repair/policy-fixture")
        (work / "scripts/release.py").write_text(release_source, encoding="utf-8")
        (work / "scripts/test_policy_cli.py").write_text("# reviewed CLI regression\n", encoding="utf-8")
        self.git(work, "add", "--", "scripts/release.py", "scripts/test_policy_cli.py")
        self.git(work, "commit", "-m", "reviewed policy proposal")
        head = self.git(work, "rev-parse", "HEAD")
        self.git(work, "push", "origin", "HEAD:refs/heads/repair/policy-fixture")
        return remote, work, config, seed, head

    def run_land_cli(self, root, release_source, *, finding=None):
        remote, work, config, seed, head = self.make_adoption_fixture(root, release_source)
        routes = self._routes(config=config, seed=seed, head=head, finding=finding, adoption=True)
        binary_dir = root / "bin"
        binary_dir.mkdir()
        routes_file = root / "github-routes.json"
        routes_file.write_text(json.dumps(routes), encoding="utf-8")
        gh_calls = root / "github-calls.jsonl"
        gh_calls.touch()
        git_calls = root / "git-calls.jsonl"
        git_calls.touch()
        self._write_fake_gh(binary_dir)
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git)
        git_wrapper = binary_dir / "git"
        git_wrapper.write_text("#!" + sys.executable + "\n" + r'''import json, os, sys
args = sys.argv[1:]
with open(os.environ["NINEROUTER_FAKE_GIT_CALLS"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
remote = os.environ["NINEROUTER_FAKE_GIT_REMOTE"]
args = [remote if arg == "https://github.com/warelik/9router.git" else arg for arg in args]
os.execv(os.environ["NINEROUTER_REAL_GIT"], [os.environ["NINEROUTER_REAL_GIT"], *args])
''', encoding="utf-8")
        git_wrapper.chmod(0o700)
        home, tmp = root / "home", root / "tmp"
        home.mkdir(mode=0o700)
        tmp.mkdir(mode=0o700)
        env = {
            "PATH": f"{binary_dir}:{os.defpath}",
            "HOME": str(home), "TMPDIR": str(tmp),
            "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": config,
            "REPAIR_PR": "42", "REPAIR_HEAD": head,
            "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C.UTF-8", "TZ": "UTC",
            "NINEROUTER_FAKE_GH_ROUTES": str(routes_file),
            "NINEROUTER_FAKE_GH_CALLS": str(gh_calls),
            "NINEROUTER_FAKE_GIT_CALLS": str(git_calls),
            "NINEROUTER_REAL_GIT": real_git,
            "NINEROUTER_FAKE_GIT_REMOTE": str(remote),
        }
        staging = root / "land-staging"
        result = subprocess.run(
            [sys.executable, "-B", str(work / "scripts/release.py"), "land", str(staging)],
            cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=45, check=False,
        )
        calls = [json.loads(line) for line in gh_calls.read_text(encoding="utf-8").splitlines()]
        return result, calls, remote, work, config, seed, head

    def test_land_cli_adopts_only_a_clean_exact_sha_to_local_bare_downstream(self):
        source = self.candidate_release().read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="9router-policy-land-clean-",
                                         dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
            root = Path(temporary)
            result, calls, remote, _, config, _, head = self.run_land_cli(root, source)
            published = self.git(root, "--git-dir", remote, "rev-parse", "refs/heads/downstream")
            parents = self.git(root, "--git-dir", remote, "show", "-s", "--format=%P", published)
            changed = self.git(root, "--git-dir", remote, "diff-tree", "--no-commit-id", "--name-only",
                               "-r", config, published).splitlines()
            adopted_release = self.git_output(root, "--git-dir", remote,
                                              "show", f"{published}:scripts/release.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Adopted ", result.stdout)
        self.assertEqual(parents, config)
        self.assertNotEqual(published, head)
        self.assertEqual(sorted(changed), ["scripts/release.py", "scripts/test_policy_cli.py"])
        self.assertEqual(adopted_release, source)
        self.assertTrue(any(call["method"] == "PATCH" and call["path"].endswith("/pulls/42") for call in calls))
        self.assertTrue(any(call["method"] == "POST" and "dispatches" in call["path"] for call in calls))

    def assert_land_adoption_contract(self, result, calls, remote, config, source):
        published = self.git(remote.parent, "--git-dir", remote,
                             "rev-parse", "refs/heads/downstream")
        parents = self.git(remote.parent, "--git-dir", remote,
                           "show", "-s", "--format=%P", published)
        changed = self.git(remote.parent, "--git-dir", remote, "diff-tree",
                           "--no-commit-id", "--name-only", "-r", config, published).splitlines()
        adopted_release = self.git_output(remote.parent, "--git-dir", remote,
                                          "show", f"{published}:scripts/release.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Adopted {published};", result.stdout)
        self.assertEqual(parents, config)
        self.assertEqual(sorted(changed), ["scripts/release.py", "scripts/test_policy_cli.py"])
        self.assertEqual(adopted_release, source)
        self.assertTrue(any(call["method"] == "PATCH" and call["path"].endswith("/pulls/42")
                            for call in calls))
        self.assertTrue(any(call["method"] == "POST" and "dispatches" in call["path"]
                            for call in calls))

    def test_land_cli_rejects_p2_for_a_changed_candidate(self):
        source = self.candidate_release().read_text(encoding="utf-8")
        if source == Path(release.__file__).resolve().read_text(encoding="utf-8"):
            self.skipTest("The bootstrap candidate is its own trusted baseline")
        with tempfile.TemporaryDirectory(prefix="9router-policy-land-p2-",
                                         dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
            root = Path(temporary)
            result, calls, remote, _, config, _, _ = self.run_land_cli(
                root, source, finding="[P2] unresolved correctness defect")
            current = self.git(root, "--git-dir", remote, "rev-parse", "refs/heads/downstream")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unresolved finding", result.stderr)
        self.assertEqual(current, config)
        self.assertFalse(any(call["method"] == "POST" and "dispatches" in call["path"] for call in calls))

    def test_land_cli_rejects_no_op_candidates_without_changing_local_bare(self):
        source = self.candidate_release().read_text(encoding="utf-8")
        for fake_source in ("import os\nos._exit(0)\n", "print('Adopted fake'); raise SystemExit(0)\n"):
            with self.subTest(fake_source=fake_source), tempfile.TemporaryDirectory(
                    prefix="9router-policy-land-no-op-", dir=os.environ.get("TMPDIR") or "/var/tmp") as temporary:
                root = Path(temporary)
                result, calls, remote, _, config, _, _ = self.run_land_cli(root, fake_source)
                current = self.git(root, "--git-dir", remote, "rev-parse", "refs/heads/downstream")
                self.assertEqual(current, config)
                self.assertFalse(any(call["method"] == "POST" and "dispatches" in call["path"] for call in calls))
                with self.assertRaises(AssertionError):
                    self.assert_land_adoption_contract(result, calls, remote, config, fake_source)


if __name__ == "__main__":
    unittest.main()

"""Build one upstream snapshot plus the patch series; GitHub PRs hold reviews."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlencode

UPSTREAM = "decolua/9router"
UPSTREAM_BRANCH = "master"
BOT = "chatgpt-codex-connector[bot]"
APP = "chatgpt-codex-connector"
SHA = re.compile(r"^[0-9a-f]{40}$")
SEVERITY = re.compile(r"\bP[01]\b|\b(?:critical|high)\s+severity\b", re.I)
REVIEWED = re.compile(r"(?im)^.*?Reviewed commit[^0-9a-f]*`?([0-9a-f]{7,40})`?\s*\*{0,2}\s*$")
CLEAN = re.compile(r"Codex Review:\s*Didn't find any major issues\.", re.I)
NATIVE_STATE = re.compile(r"<!-- codex-review-state:v1 (\{.*?\}) -->", re.S)
ROOT = Path(__file__).resolve().parent.parent


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()


def api(path, *, method="GET", data=None, token=None):
    command = ["gh", "api", "--method", method, path]
    env = os.environ.copy()
    if token:
        env["GH_TOKEN"] = token
    if data is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json.dumps(data) if data is not None else None,
                            text=True, stdout=subprocess.PIPE, check=True, env=env)
    return json.loads(result.stdout) if result.stdout.strip() else None


def pages(path):
    result = []
    separator = "&" if "?" in path else "?"
    for page in range(1, 1001):
        batch = api(f"{path}{separator}per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("Expected a paginated GitHub list")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise ValueError("GitHub pagination did not terminate")


def actor(record, *, completion=False):
    user = record.get("user") or {}
    app = record.get("performed_via_github_app")
    return (user.get("login") == BOT and user.get("type") == "Bot"
            and (isinstance(app, dict) and app.get("slug") == APP
                 if completion or app is not None else True))


def review_gate(sha, requested_at, reviews, inline, comments, resolve):
    """A reaction or a comment without an exact reviewed commit is not a review."""
    if not SHA.fullmatch(sha) or not requested_at:
        return False, "No exact-SHA review request"
    exact = [r for r in reviews if actor(r) and r.get("commit_id") == sha]
    evidence = exact + [r for r in inline if actor(r) and r.get("commit_id") == sha]
    completions = []
    clean_states = []
    for comment in comments:
        if not actor(comment, completion=True):
            continue
        timestamp = comment.get("updated_at") or comment.get("created_at") or ""
        states = NATIVE_STATE.findall(comment.get("body") or "")
        for encoded in states:
            try:
                state = json.loads(encoded)["code_review"]
            except (ValueError, KeyError, TypeError):
                continue
            if not isinstance(state, dict):
                continue
            if state.get("commit_sha") == sha:
                evidence.append(comment)
            if (len(states) == 1 and state.get("commit_sha") == sha and state.get("status") == "completed"
                    and state.get("has_any_findings") is False
                    and state.get("has_unresolved_findings") is False
                    and timestamp >= requested_at):
                clean_states.append(comment)
        matches = REVIEWED.findall(comment.get("body") or "")
        if len(matches) == 1 and resolve(matches[0]) == sha:
            evidence.append(comment)
            if timestamp >= requested_at:
                completions.append(comment)
    if any(SEVERITY.search(r.get("body") or "") for r in evidence):
        return False, "Codex reported a P0/P1 finding on this commit"
    submitted = [r for r in exact if (r.get("submitted_at") or "") >= requested_at]
    if submitted:
        latest = max(submitted, key=lambda r: (r.get("submitted_at") or "", r.get("id", 0)))
        if latest.get("state") not in {"APPROVED", "COMMENTED"}:
            return False, "Latest exact-SHA Codex review is not positive"
        if (latest["state"] == "APPROVED" or CLEAN.search(latest.get("body") or "")
                or any(c.get("pull_request_review_id") == latest.get("id")
                       for c in evidence if c in inline)):
            return True, "Completed exact-SHA Codex PR review"
    if clean_states or any(CLEAN.search(c.get("body") or "") for c in completions):
        return True, "Completed exact-SHA native Codex review"
    return False, "Waiting for Codex; no completed exact-SHA review"


def request_text(sha, upstream, config):
    return (
        "@codex review\n\n"
        f"Review the complete application diff at exact commit `{sha}`.\n"
        f"Base: `{UPSTREAM}@{upstream}`. Patch configuration: `{config}`.\n"
        "These patches preserve downstream application changes made before "
        "2026-10-13; do not add unrelated fixes or rewrite upstream.\n"
        "Check preservation of upstream provider protocols, OAuth client values, "
        "request fingerprints, headers and signing inputs. Check streaming and "
        "non-streaming behavior, tool-call/result identity, Gemini native "
        "passthrough, conversation isolation and Responses/Claude compatibility.\n"
        "Report findings in the normal Codex review format and identify the "
        "reviewed commit. Do not modify code, push commits, merge or deploy.\n\n"
        f"<!-- 9router-codex:{sha} -->"
    )


def check_review(repo, pr, sha, upstream):
    pull = api(f"repos/{repo}/pulls/{pr}")
    if pull["head"]["sha"] != sha or pull["state"] != "open":
        return False, "Candidate PR is closed or its head changed"
    base = pull.get("base") or {}
    if (not SHA.fullmatch(upstream)
            or base.get("ref") != f"review-base/{upstream}"
            or base.get("sha") != upstream
            or (base.get("repo") or {}).get("full_name") != repo
            or (pull["head"].get("repo") or {}).get("full_name") != repo):
        return False, "Candidate PR no longer compares against the exact upstream base"
    comments = pages(f"repos/{repo}/issues/{pr}/comments")
    marker = f"<!-- 9router-codex:{sha} -->"
    owner = repo.split("/")[0]
    requests = [c for c in comments
                if c.get("user", {}).get("login") == owner
                and c.get("user", {}).get("type") == "User"
                and marker in (c.get("body") or "")]
    if not requests:
        return False, "No owner-authored exact-SHA Codex request"
    requested_at = min(c["created_at"] for c in requests)
    reviews = pages(f"repos/{repo}/pulls/{pr}/reviews")
    inline = pages(f"repos/{repo}/pulls/{pr}/comments")
    cache = {}

    def resolve(prefix):
        if prefix not in cache:
            try:
                cache[prefix] = api(f"repos/{repo}/commits/{prefix}")["sha"]
            except subprocess.CalledProcessError:
                cache[prefix] = None
        return cache[prefix]

    return review_gate(sha, requested_at, reviews, inline, comments, resolve)


def patch_identity(directory):
    patches = sorted(directory.glob("*.patch"))
    if not patches:
        raise ValueError("Patch series is empty")
    digest = hashlib.sha256()
    for patch in patches:
        digest.update(patch.name.encode() + b"\0" + patch.read_bytes() + b"\0")
    return patches, digest.hexdigest()


def validate_paths(paths):
    for path in paths:
        if (path != "next.config.mjs"
                and not path.startswith(("open-sse/", "src/", "tests/"))):
            raise ValueError(f"Patch escapes the application/test boundary: {path}")
        if Path(path).name in {"AGENTS.md", "CLAUDE.md", ".rules"}:
            raise ValueError(f"Instructions must not be imported as application patches: {path}")


def output(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for name, value in values.items():
            text = str(value).lower() if isinstance(value, bool) else str(value)
            if "\n" in text or "\r" in text:
                raise ValueError("Invalid workflow output")
            stream.write(f"{name}={text}\n")


def close_published_reviews(repo, sha, upstream, head):
    base = f"review-base/{upstream}"
    query = urlencode({"state": "open", "head": f"{repo.split('/')[0]}:{head}", "base": base})
    for pull in pages(f"repos/{repo}/pulls?{query}"):
        if (pull["head"]["sha"] == sha and pull["base"]["sha"] == upstream
                and pull["base"]["ref"] == base
                and (pull["head"].get("repo") or {}).get("full_name") == repo):
            api(f"repos/{repo}/pulls/{pull['number']}", method="PATCH", data={"state": "closed"})


def prepare(app):
    repo = os.environ["GITHUB_REPOSITORY"]
    config = os.environ["GITHUB_SHA"]
    if not SHA.fullmatch(config):
        raise ValueError("Expected a full configuration commit")
    upstream = api(f"repos/{UPSTREAM}/commits/{UPSTREAM_BRANCH}")["sha"]
    if not SHA.fullmatch(upstream):
        raise ValueError("Expected a full upstream commit")
    patches, patchset = patch_identity(ROOT / "patches")
    if app.exists():
        raise ValueError("Source destination must be fresh")
    run("git", "init", str(app))
    run("git", "config", "user.name", "github-actions[bot]", cwd=app)
    run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com", cwd=app)
    run("git", "config", "core.hooksPath", "/dev/null", cwd=app)
    run("git", "config", "commit.gpgSign", "false", cwd=app)
    run("git", "remote", "add", "upstream", f"https://github.com/{UPSTREAM}.git", cwd=app)
    run("git", "fetch", "--filter=blob:none", "upstream", upstream, cwd=app)
    run("git", "checkout", "--detach", "FETCH_HEAD", cwd=app)
    run("git", "am", "--committer-date-is-author-date", *(str(p) for p in patches), cwd=app)
    sha = run("git", "rev-parse", "HEAD", cwd=app)
    paths = run("git", "diff", "--name-only", upstream, sha, cwd=app).splitlines()
    validate_paths(paths)
    version = json.loads((app / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected an upstream stable package version")
    if run("git", "show", f"{upstream}:package.json", cwd=app) != (app / "package.json").read_text().strip():
        raise ValueError("Patch series changed upstream package.json")
    release = f"build-{version}-{upstream[:12]}-{patchset[:12]}"
    base = f"review-base/{upstream}"
    head = f"review/{upstream}-{patchset}"
    releases = pages(f"repos/{repo}/releases")
    existing = next((r for r in releases if r["tag_name"] == release and not r["draft"]), None)
    if existing:
        verify_published_release(repo, existing, sha, upstream, patchset, version)
        close_published_reviews(repo, sha, upstream, head)
        output(ready=False, reason=f"Already published: {release}")
        return
    # Pushes are append-only: a pre-existing different branch fails, never rewrites.
    run("gh", "auth", "setup-git")
    remote = f"https://github.com/{repo}.git"
    for branch, expected in ((base, upstream), (head, sha)):
        existing_ref = run("git", "ls-remote", "--refs", remote, f"refs/heads/{branch}", cwd=app)
        if existing_ref and existing_ref.split()[0] != expected:
            raise ValueError(f"Review branch changed: {branch}; refusing to overwrite it")
    run("git", "push", remote, f"{upstream}:refs/heads/{base}", f"{sha}:refs/heads/{head}", cwd=app)
    query = urlencode({"state": "all", "head": f"{repo.split('/')[0]}:{head}", "base": base})
    pulls = pages(f"repos/{repo}/pulls?{query}")
    if pulls:
        pull = pulls[0]
    else:
        pull = api(f"repos/{repo}/pulls", method="POST", data={
            "title": f"Review 9router {version} plus downstream patches",
            "head": head, "base": base,
            "body": (f"One upstream snapshot: `{UPSTREAM}@{upstream}`.\n\n"
                     f"Patch configuration: `{repo}@{config}`; patch SHA-256: `{patchset}`.\n\n"
                     f"Application commit: `{sha}`.\n\n"
                     "Review-only PR: publication uses this exact commit; no merge or deployment."),
        })
    pr = pull["number"]
    if pull["state"] != "open" or pull["head"]["sha"] != sha:
        raise ValueError("Existing review PR is closed or its head changed")
    comments = pages(f"repos/{repo}/issues/{pr}/comments")
    marker = f"<!-- 9router-codex:{sha} -->"
    if not any(marker in (c.get("body") or "") and c.get("user", {}).get("login") == repo.split("/")[0]
               for c in comments):
        token = os.environ.get("CODEX_REQUEST_TOKEN")
        if not token:
            output(ready=False, reason="Codex setup required: CODEX_REQUEST_TOKEN is missing",
                   sha=sha, upstream=upstream, patchset=patchset, version=version, release=release, pr=pr)
            raise ValueError("Set CODEX_REQUEST_TOKEN and enable Codex review for this repository")
        user = api("user", token=token)
        if user["login"] != repo.split("/")[0] or user.get("type") != "User":
            raise ValueError("CODEX_REQUEST_TOKEN must belong to the repository owner")
        api(f"repos/{repo}/issues/{pr}/comments", method="POST",
            data={"body": request_text(sha, upstream, f"{repo}@{config}")}, token=token)
    ready, reason = check_review(repo, pr, sha, upstream)
    print(reason)
    output(ready=ready, reason=reason, sha=sha, upstream=upstream, patchset=patchset,
           version=version, release=release, pr=pr)


def run_vitest(app, tests, *, update=False):
    with tempfile.TemporaryDirectory(prefix="9router-tests-") as directory:
        root = Path(directory)
        env = {**os.environ, "CI": "true"}
        for name in ("GH_TOKEN", "GITHUB_TOKEN", "CODEX_REQUEST_TOKEN"):
            env.pop(name, None)
        for name, relative in {
            "HOME": "home", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "share",
            "XDG_CACHE_HOME": "cache", "XDG_STATE_HOME": "state",
            "XDG_RUNTIME_DIR": "run", "TMPDIR": "tmp", "DATA_DIR": "data",
        }.items():
            path = root / relative
            path.mkdir(mode=0o700)
            env[name] = str(path)
        command = ["node", "node_modules/vitest/vitest.mjs", "run", *tests]
        if update:
            command.append("--update")
        subprocess.run(command, cwd=app / "tests", env=env, check=True)


def prepare_golden_baseline(app, upstream, upstream_sha):
    relative = Path("tests/translator/__snapshots__/golden-url-header.test.js.snap")
    if not SHA.fullmatch(upstream_sha) or run("git", "rev-parse", "HEAD", cwd=upstream) != upstream_sha:
        raise ValueError("Golden baseline must use the exact selected upstream commit")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(relative)], cwd=upstream,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if tracked.returncode == 0:
        subprocess.run(["git", "ls-files", "--error-unmatch", str(relative)], cwd=app, check=True)
        expected = subprocess.check_output(["git", "show", f"HEAD:{relative}"], cwd=upstream)
        if (upstream / relative).read_bytes() != expected or (app / relative).read_bytes() != expected:
            raise ValueError("Tracked URL/header snapshot differs from the exact upstream baseline")
        return
    fixture = Path("tests/translator/golden-url-header.test.js")
    for manifest in ("package.json", "tests/package.json"):
        if (app / manifest).read_bytes() != (upstream / manifest).read_bytes():
            raise ValueError(f"Cannot share baseline dependencies: {manifest} differs")
    allowed = {str(fixture)}
    if set(run("git", "diff", "--name-only", "HEAD", cwd=upstream).splitlines()) - allowed:
        raise ValueError("Golden baseline checkout contains unrelated changes")
    shutil.copyfile(app / fixture, upstream / fixture)
    for relative_modules in ("node_modules", "tests/node_modules"):
        modules = upstream / relative_modules
        target = (app / relative_modules).resolve()
        if not target.is_dir():
            raise ValueError("Application test dependencies are missing")
        if modules.exists():
            if modules.resolve() != target:
                raise ValueError("Use a disposable clean upstream baseline checkout")
        else:
            modules.symlink_to(target, target_is_directory=True)
    # Only the shared test harness is overlaid; expected headers come from CLEAN upstream.
    run_vitest(upstream, ["translator/golden-url-header.test.js"], update=True)
    if set(run("git", "diff", "--name-only", "HEAD", cwd=upstream).splitlines()) - allowed:
        raise ValueError("Baseline generation modified upstream source")
    snapshot = (upstream / relative).read_bytes()
    destination = app / relative
    if destination.exists() and destination.read_bytes() != snapshot:
        raise ValueError("Refusing to replace a different untracked golden snapshot")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(snapshot)
    print(f"URL/header baseline comes from clean upstream {upstream_sha}")


def test_patches(app):
    source = json.loads((ROOT / "patches" / "source.json").read_text())
    tests = source["test_files"]
    if not tests or len(tests) != len(set(tests)):
        raise ValueError("Historical regression test list is empty or contains duplicates")
    for test in tests:
        if not re.fullmatch(r"tests/(unit|translator)/[A-Za-z0-9_-]+\.test\.js", test):
            raise ValueError(f"Unexpected test path: {test}")
        if not (app / test).is_file():
            raise ValueError(f"Historical regression test is missing: {test}")
    prepare_golden_baseline(app, Path(os.environ["UPSTREAM_DIR"]).resolve(), os.environ["UPSTREAM_SHA"])
    run_vitest(app, [test.removeprefix("tests/") for test in tests])


def provenance(archive):
    repo = os.environ["GITHUB_REPOSITORY"]
    expected = {name: os.environ[name] for name in ("CANDIDATE_SHA", "UPSTREAM_SHA", "CONFIG_SHA", "PATCHSET_SHA256")}
    if any(not SHA.fullmatch(expected[name]) for name in ("CANDIDATE_SHA", "UPSTREAM_SHA", "CONFIG_SHA")):
        raise ValueError("Provenance requires full commit SHAs")
    if not re.fullmatch(r"[0-9a-f]{64}", expected["PATCHSET_SHA256"]):
        raise ValueError("Invalid patch series SHA-256")
    image = json.loads(run("docker", "image", "inspect", os.environ["IMAGE_TAG"]))[0]
    labels = image["Config"]["Labels"]
    if (image["Architecture"] != "amd64" or image["Os"] != "linux"
            or labels.get("org.opencontainers.image.source") != f"https://github.com/{repo}"
            or labels.get("org.opencontainers.image.revision") != expected["CANDIDATE_SHA"]
            or labels.get("io.9router.upstream.revision") != expected["UPSTREAM_SHA"]
            or labels.get("io.9router.patches.sha256") != expected["PATCHSET_SHA256"]
            or labels.get("org.opencontainers.image.version") != os.environ["APP_VERSION"]):
        raise ValueError("Built image identity does not match the reviewed source")
    metadata = {
        "schema": 1, "repository": repo, "upstream_repository": UPSTREAM,
        "version": os.environ["APP_VERSION"], **{k.lower(): v for k, v in expected.items()},
        "image_id": image["Id"], "platform": "linux/amd64",
        "archive": archive.name, "archive_sha256": file_digest(archive),
    }
    (archive.parent / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n")
    assets = [archive, archive.parent / "provenance.json"]
    (archive.parent / "SHA256SUMS").write_text(
        "".join(f"{file_digest(path)}  {path.name}\n" for path in assets))


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_published_release(repo, release, sha, upstream, patchset, version):
    tag = f"build-{version}-{upstream[:12]}-{patchset[:12]}"
    ref = api(f"repos/{repo}/git/ref/tags/{tag}")
    if (release.get("tag_name") != tag or release.get("target_commitish") != sha
            or ref.get("ref") != f"refs/tags/{tag}"
            or ref["object"].get("type") != "commit" or ref["object"].get("sha") != sha):
        raise ValueError("Existing release does not identify the exact candidate")
    assets = {item["name"]: item for item in pages(f"repos/{repo}/releases/{release['id']}/assets")}
    if set(assets) != {"9router-image.tar.gz", "provenance.json", "SHA256SUMS"}:
        raise ValueError("Existing release assets are incomplete or unexpected")
    with tempfile.TemporaryDirectory(prefix="9router-release-") as directory:
        root = Path(directory)
        run("gh", "release", "download", tag, "--repo", repo, "--dir", directory,
            "--pattern", "provenance.json", "--pattern", "SHA256SUMS")
        metadata = json.loads((root / "provenance.json").read_text())
        expected = {
            "schema": 1, "repository": repo, "upstream_repository": UPSTREAM,
            "candidate_sha": sha, "upstream_sha": upstream,
            "patchset_sha256": patchset, "version": version,
            "platform": "linux/amd64", "archive": "9router-image.tar.gz",
        }
        if (any(metadata.get(key) != value for key, value in expected.items())
                or not SHA.fullmatch(metadata.get("config_sha", ""))
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", metadata.get("image_id", ""))
                or not re.fullmatch(r"[0-9a-f]{64}", metadata.get("archive_sha256", ""))):
            raise ValueError("Existing release provenance does not match the selected source")
        checksums = [
            f"{metadata['archive_sha256']}  9router-image.tar.gz",
            f"{file_digest(root / 'provenance.json')}  provenance.json",
        ]
        if sorted((root / "SHA256SUMS").read_text().splitlines()) != sorted(checksums):
            raise ValueError("Existing release checksums do not match its provenance")
        for name, asset in assets.items():
            digest = metadata["archive_sha256"] if name == "9router-image.tar.gz" else file_digest(root / name)
            if asset.get("digest") != f"sha256:{digest}" or asset.get("size", 0) <= 0:
                raise ValueError(f"Existing release asset integrity check failed: {name}")


def publish(directory):
    repo = os.environ["GITHUB_REPOSITORY"]
    sha, pr, tag = os.environ["CANDIDATE_SHA"], int(os.environ["CANDIDATE_PR"]), os.environ["RELEASE_TAG"]
    ready, reason = check_review(repo, pr, sha, os.environ["UPSTREAM_SHA"])
    if not ready:
        raise ValueError(reason)
    default = api(f"repos/{repo}")["default_branch"]
    if api(f"repos/{repo}/commits/{default}")["sha"] != os.environ["GITHUB_SHA"]:
        raise ValueError("Patch configuration changed during the build; do not publish stale patches")
    checksums = (directory / "SHA256SUMS").read_text().splitlines()
    expected_checksums = [
        f"{file_digest(directory / name)}  {name}"
        for name in ("9router-image.tar.gz", "provenance.json")
    ]
    if sorted(checksums) != sorted(expected_checksums):
        raise ValueError("Artifact SHA256SUMS is incomplete or does not match the files")
    metadata = json.loads((directory / "provenance.json").read_text())
    for key, value in (("candidate_sha", sha), ("upstream_sha", os.environ["UPSTREAM_SHA"]),
                       ("config_sha", os.environ["GITHUB_SHA"]), ("patchset_sha256", os.environ["PATCHSET_SHA256"])):
        if metadata.get(key) != value:
            raise ValueError(f"Artifact provenance mismatch: {key}")
    if (metadata.get("version") != os.environ["APP_VERSION"]
            or metadata.get("platform") != "linux/amd64"
            or metadata.get("archive") != "9router-image.tar.gz"
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", metadata.get("image_id", ""))
            or metadata.get("archive_sha256") != file_digest(directory / "9router-image.tar.gz")):
        raise ValueError("Artifact version, platform or archive identity mismatch")
    expected_tag = f"build-{metadata['version']}-{metadata['upstream_sha'][:12]}-{metadata['patchset_sha256'][:12]}"
    if tag != expected_tag:
        raise ValueError("Release tag does not match the verified artifact")
    assets = [directory / name for name in ("9router-image.tar.gz", "provenance.json", "SHA256SUMS")]
    releases = pages(f"repos/{repo}/releases")
    release = next((r for r in releases if r["tag_name"] == tag), None)
    notes = (f"9router {metadata['version']}; upstream `{UPSTREAM}@{metadata['upstream_sha']}`.\n\n"
             f"Application `{sha}`; patches `{metadata['patchset_sha256']}`.\n\n"
             f"Exact-source Codex review: https://github.com/{repo}/pull/{pr}.\n\n"
             "Container: linux/amd64. No VPS deployment is performed.")
    if release is None:
        release = api(f"repos/{repo}/releases", method="POST", data={
            "tag_name": tag, "target_commitish": sha, "name": f"9router {metadata['version']} + downstream patches",
            "body": notes, "draft": True, "prerelease": False,
        })
    if not release["draft"]:
        verify_published_release(repo, release, sha, os.environ["UPSTREAM_SHA"],
                                 os.environ["PATCHSET_SHA256"], os.environ["APP_VERSION"])
        close_published_reviews(repo, sha, os.environ["UPSTREAM_SHA"],
                                f"review/{os.environ['UPSTREAM_SHA']}-{os.environ['PATCHSET_SHA256']}")
        print(f"Release already published: {tag}")
        return
    if release.get("target_commitish") != sha:
        raise ValueError("Draft release targets another source commit")
    remote_assets = {asset["name"]: asset for asset in pages(f"repos/{repo}/releases/{release['id']}/assets")}
    if set(remote_assets) - {path.name for path in assets}:
        raise ValueError("Draft release contains unexpected assets")
    for path in assets:
        if path.name not in remote_assets:
            run("gh", "release", "upload", tag, str(path), "--repo", repo)
    uploaded = {asset["name"]: asset for asset in pages(f"repos/{repo}/releases/{release['id']}/assets")}
    for path in assets:
        record = uploaded.get(path.name, {})
        if record.get("digest") != f"sha256:{file_digest(path)}" or record.get("size") != path.stat().st_size:
            raise ValueError(f"Release asset integrity check failed: {path.name}")
    refs = api(f"repos/{repo}/git/matching-refs/tags/{tag}")
    exact = next((ref for ref in refs if ref["ref"] == f"refs/tags/{tag}"), None)
    if exact is None:
        api(f"repos/{repo}/git/refs", method="POST", data={"ref": f"refs/tags/{tag}", "sha": sha})
    exact = api(f"repos/{repo}/git/ref/tags/{tag}")
    if (exact.get("ref") != f"refs/tags/{tag}" or exact["object"].get("type") != "commit"
            or exact["object"].get("sha") != sha):
        raise ValueError("Release tag does not point to the exact reviewed source commit")
    ready, reason = check_review(repo, pr, sha, os.environ["UPSTREAM_SHA"])
    if not ready:
        raise ValueError(reason)
    current_default = api(f"repos/{repo}")["default_branch"]
    if api(f"repos/{repo}/commits/{current_default}")["sha"] != os.environ["GITHUB_SHA"]:
        raise ValueError("Patch configuration changed before publication")
    api(f"repos/{repo}/releases/{release['id']}", method="PATCH", data={"draft": False, "make_latest": "true"})
    close_published_reviews(repo, sha, os.environ["UPSTREAM_SHA"],
                            f"review/{os.environ['UPSTREAM_SHA']}-{os.environ['PATCHSET_SHA256']}")
    print(f"Published {tag}; VPS untouched")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "test", "provenance", "publish"))
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    {"prepare": prepare, "test": test_patches, "provenance": provenance, "publish": publish}[args.command](args.path.resolve())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"Release stopped: {error}", file=sys.stderr)
        sys.exit(1)
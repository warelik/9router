# 9router + downstream patches

A fork of [decolua/9router](https://github.com/decolua/9router), built like
[zed-titlebarless](https://github.com/warelik/zed-titlebarless): one upstream
snapshot, an ordered patch series, one reviewed build.

The default `downstream` branch contains patches and build automation, not a
second application tree. `master` preserves the original upstream checkout.

## Initial patch series

The migration source is the old downstream's `e01983276cb2f9ce05dc167e4d56c2c040559fd6`
from October 9, 2026, relative to upstream
`ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8`.
Only local application changes made before October 13 are carried.

1. Transport selection, Responses reasoning wire and SSE collection.
2. Native Gemini APIs and AIStudio.
3. Native Gemini through Antigravity.
4. Gemini history, thought signatures, tools and hosted search.
5. Codex/Responses namespaces, multi-agent history and portable collaboration.
6. Claude thinking signatures, adaptive display and stream decloaking.
7. Cloudflare System One response envelopes.
8. Historical regression fixtures.

`patches/source.json` records the exact source commits and all 45 historical
test files. The old `warelik/` controller, per-commit queue, notes state,
deployment recipes, and downstream fixes made on October 13 or later are absent.
The upstream snapshot itself remains current; this cutoff applies only to the
local changes extracted during migration.

## Automatic updates

The release workflow checks the current upstream `master` every six hours and
after patch changes. Upstream GitHub Releases are not the version source:
they lag behind the actual application version.

1. Resolve one full upstream commit and apply `patches/*.patch` in name order.
2. Open one review-only application PR against that exact clean upstream snapshot.
3. Request Codex review as the owner; wait without rebuilding while review is pending.
4. Accept only authenticated Codex review of that exact application commit.
5. Run the preserved and newly added regression files, build one container from immutable Git
   source, and check its health, application version, platform and image labels.
6. Recheck review and patch configuration, then publish the image archive,
   provenance and SHA-256 checksums. Close the review PR without merging.

Codex completion comments, including edits to its structured summary, resume the
workflow immediately. The schedule is also a fallback. P0/P1 findings, incomplete
review, a changed PR head, failing tests, patch conflicts or integrity errors stop
publication. A reaction alone is not approval. No historical upstream commit
queue is used. P2/P3 findings retain their nonblocking status but request an
automatic repair, including findings on an already published application.

## Native Codex repair

Ordinary application failures are repaired on the exact upstream snapshot and
ordered patch series. Policy repairs are checked without write credentials.
The policy job uses only its immutable trusted test files and release module;
the proposed release module runs as a separate process through the existing
`prepare` and `land` commands. Disposable GitHub fixtures check readiness and
review reads, and a local bare Git remote records the exact selectively adopted
files. The verifier asserts actual outputs, API calls and Git changes, so an
early `os._exit(0)` or printed success cannot meet the positive contract.

The checker syntax-parses proposed Python without importing it, requires
full commit SHAs for remote Actions, and runs checksum-pinned actionlint on the
proposed workflow. Candidate-authored tests are not used as the pre-adoption
verdict. Each policy candidate receives exact-SHA Codex review before selective
adoption; the next default-branch run executes the adopted tests as trusted code.
Application patches and release-policy repairs cannot be mixed.

Policy repair may include `README.md` alongside release scripts, workflow and
tests. Application repair may change only `patches/*.patch`; mixed changes are
rejected before checks or adoption.

The CLI verifier is a separate trusted-base transition. Its regression file
must already exist on the default branch to run before later policy changes are
adopted. The first transition requires its own exact-SHA review and isolated
native checks before the verifier is used as the baseline for subsequent
policy repairs.

## GitHub setup

- Use `downstream` as the default branch and enable its Actions workflow.
- Allow GitHub Actions to create pull requests.
- Enable the Codex GitHub integration for `warelik/9router`.
- Set the repository secret `CODEX_REQUEST_TOKEN` to the existing owner token
  allowed to comment on PRs and update workflows for independently reviewed policy
  repairs. Requests from the Actions bot are not used as owner requests.
- Native Codex cloud tasks need permission to push to their repair PR branch.
- Run **Upstream Plus Patches**. No VPS access or deployment secrets are needed.

If upstream breaks a patch, the native task minimally refreshes that patch and
retains its regression cases. Do not skip patches, replace upstream source with
old files, force-push, or weaken review.

Published releases are named `build-VERSION-UPSTREAM-PATCHSET`; they contain a
`linux/amd64` Docker image, `provenance.json` and `SHA256SUMS`, not a VPS deployment.
The server recipe downloads that immutable release; GitHub has no VPS credentials.

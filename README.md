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
5. Run the preserved regression files, build one container from immutable Git
   source, and check its health, application version, platform and image labels.
6. Recheck review and patch configuration, then publish the image archive,
   provenance and SHA-256 checksums. Close the review PR without merging.

Codex completion comments, including edits to its structured summary, resume the
workflow immediately. The schedule is also a fallback. P0/P1 findings, incomplete
review, a changed PR head, failing tests, patch conflicts or integrity errors stop
publication. A reaction alone is not approval. No historical upstream commit
queue or automatic AI repair loop is used.

Upstream omits its URL/header snapshot. When missing from reviewed source, the
test job generates it from the exact clean upstream with the shared test harness,
then compares the patched application against it with `CI=true`. It never accepts
snapshot values generated from the patched application itself.
Both test phases run with disposable `HOME`, `XDG_*`, `TMPDIR` and `DATA_DIR`;
client-config writers cannot use the operator's inherited configuration paths.

## GitHub setup

- Use `downstream` as the default branch and enable its Actions workflow.
- Allow GitHub Actions to create pull requests.
- Enable the Codex GitHub integration for `warelik/9router`.
- Set the repository secret `CODEX_REQUEST_TOKEN` to an owner token allowed to
  comment on its PRs. Requests from the Actions bot are not used as owner requests.
- Run **Upstream Plus Patches**. No VPS access or deployment secrets are needed.

If upstream breaks a patch, regenerate the affected patch against the new
snapshot, retain its regression cases and push the patch change. Do not skip
patches, replace upstream source with old files, force-push, or weaken review.

Published releases are named `build-VERSION-UPSTREAM-PATCHSET`; they contain a
`linux/amd64` Docker image, not a VPS deployment. Recipes and the running VPS
remain unchanged.

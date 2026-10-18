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
workflow immediately. The schedule is also a fallback. Unresolved findings of any priority, incomplete
review, a changed PR head, failing tests, patch conflicts or integrity errors stop
publication. A reaction alone is not approval. No historical upstream commit
queue is used. Real P2/P3 defects require the same fix, regression and fresh
exact-commit review before publication as other defects. Review requests exclude
optional optimization and stylistic preferences; a false positive must be
resolved with evidence. Findings on an already published application trigger
repair while the last working installation is preserved.

The Dockerfile pins the Node image by the registry index digest. Every preparation
checks the current digest and `linux/amd64` availability for the base tag selected
by that upstream snapshot, before the already-published shortcut. A moved tag or
changed upstream base enters the existing Codex repair flow: update the small
Dockerfile patch, review the new commit and rebuild. The patch hash changes the
release identity even when the application's version has not changed.

## Native Codex repair

Ordinary failures open a repair PR and request `@codex fix ...` using the owner's
existing authorization. Its temporary upstream archive supplies exact source
context even when the cloud task has no internet access. Codex updates the real
branch: task acknowledgements, reports and unpublished commits are not fixes.

Application repairs change the ordered patches. The resulting application gets
a fresh exact-SHA review and regressions before the verified patch diff is
adopted. Before a policy repair is adopted, the read-only job runs tests and the
release module from the trusted checkout. Proposed Python is syntax-parsed, not
imported into that process. The trusted CLI regression launches the proposed
`prepare` and `land` commands in separate subprocesses with disposable GitHub
and Git fixtures; it checks readiness output, exact-review API reads, absence of
mutating calls during prepare, and the actual commit and dispatch caused by a
clean adoption. Exact-SHA P2 findings block adoption. Early `os._exit(0)` and
forged success output do not satisfy those contracts. Candidate-authored tests
are parsed but do not define the pre-adoption verdict. The proposed workflow is
checked with a checksum-pinned official actionlint binary. Remote GitHub Actions
references require full commit SHAs; Docker Actions remain supported only with an
exact `docker://image[:tag]@sha256:<64 lowercase hex>` reference. Registry ports
and optional image tags are allowed when the exact digest is present; mutable
Docker tags without a digest are rejected. Local `./` Actions remain allowed.
The validator reads workflow YAML with PyYAML `safe_load` and checks semantic job
and step `uses` fields, including quoted keys, flow mappings, and reusable or
subdirectory references. It does not construct custom YAML tags. The official
`PyYAML==6.0.3` wheel is pinned by SHA-256
`ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc` and installed
with `pip --require-hashes` into an isolated runner-temp directory before the
prepare tests and trusted policy check. The check-policy runner copies that
trusted parser into its read-only fixture mount, imports it before trusted tests
or candidate subprocesses, and starts Python with isolated mode so writable
current-directory modules cannot shadow it. Candidate `prepare` and `land` CLI
commands lazy-load the parser only if YAML validation is requested, preserving
the immutable bootstrap oracle's stdlib-only CLI path. Codex reviews the exact
policy SHA.
The immutable suite receives a read-only copy of the proposed workflow and
checks its parser bootstrap in both jobs before the corresponding parser use.
Inline findings are attributed to their original reviewed commit: GitHub may
relocate an old comment to a new head. A relocated old finding cannot replace
the required fresh clean review, and a current-commit finding still blocks it.
The verified policy diff is selectively adopted; the next default-branch run
then executes the newly trusted tests and continues through fresh review and
build. Policy and application repairs cannot be mixed.

The first trusted CLI regression must already exist on the default branch for
it to run during a policy-repair check. Adding it in the same untrusted repair
does not make it part of that repair's trusted suite; the first adoption of
this verifier therefore needs a separate trusted-base transition and a fresh
default-branch run before later policy changes can rely on it.

Only that verified diff is adopted into `downstream`; repair context is never
merged. A dispatched normal cycle rechecks the new configuration and builds and
publishes the exact reviewed application. New regression filenames are recorded
in `patches/source.json` separately from its frozen historical `test_files`, and
continue running if upstream absorbs the corresponding fix.

The upstream snapshot and last published release identify a repair campaign.
Its two-hour task/review deadline starts at the first owner fix request and spans
configuration commits, patch changes, and workflow dispatches. A later fix or
review does not reset the current window. Request numbers are history, not a limit.
Each repair PR records its bounded window; callbacks and the scheduled workflow
check its deadline. On timeout the current workflow fails, records the evidence,
and closes that window without assigning an owner-decision issue. A later callback
does not reopen it. The next scheduled run starts a fresh bounded window, carries
all previous attempts into the prompt, and requires evidence for a changed approach.
Elapsed time and attempt count alone never trigger human escalation. A blocked
review or failed verification is a failed workflow, not a green `ready=false`;
unavailable owner authorization remains an explicit platform blocker. The last
verified release remains available throughout repair.

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

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

1. Resolve one exact upstream commit, apply `patches/*.patch` in filename order,
   and calculate the application, configuration, patch, recipe and platform
   identities.
2. Open two review-only PRs: the complete assembled application against that
   upstream commit, and the downstream configuration or application delta
   against the native accepted-baseline checkpoint. The full-review branch uses
   a tree-identical review context commit; the artifact still uses the actual
   assembled application SHA.
3. Request both reviews as the repository owner. Wait for both exact native
   Codex completions before preparing a single batch of repairs. The trusted
   controller clears a carried inline finding only after it verifies that the
   cited application file and a regression changed together in an ordered patch;
   it then posts and rereads an immutable owner-authored disposition. Codex
   disposition text is never authority, and omitted findings remain unresolved.
4. After the pair is clean, run the trusted policy check once unless an exact
   native final-bundle receipt proves that the same policy candidate already
   passed it. Record a native candidate/run/attempt policy reservation before
   its test starts; a completed exact-source result is reused on a workflow
   rerun, while a failed or interrupted test blocks a repeat until a newly
   reviewed source is ready. Run the preserved and new application regressions
   once for an application candidate. Reserve the exact native workflow run and
   attempt before starting application tests or the image build.
5. Build one container from the immutable application SHA and verify its health,
   version, platform, labels, provenance and checksums. Reuse a prior artifact
   only when its exact candidate and successful native run attempt are proven.
6. Recheck the native review pair, publish the verified archive and metadata,
   advance the accepted-baseline checkpoint, and close and safely clean up the
   temporary review refs. GitHub does not deploy the artifact to the VPS.

The workflow runs its controller from the native `ZED_TRUSTED_POLICY` pin.
Candidate policy files remain data until the credential-free policy check passes.
The shared lifecycle module is acquired by an exact private-source pin and
checksum; its source is not copied into public artifacts. Review and attempt
receipts are native GitHub objects, not workflow-generated claims. A single-job
rerun cannot repeat tests or a build because the final guard binds the prepared
candidate, run ID and run attempt. A later heavy attempt after failure requires
an unedited owner grant naming that candidate and the latest stopped attempt.

Codex completion comments, including edits to their structured summary, resume
the workflow immediately; the schedule is a fallback. Every actionable finding
blocks publication regardless of priority, including P2/P3 and unlabelled inline
findings. A reaction alone is not approval. No intermediate upstream queue is
used. Review requests exclude optional optimization and stylistic preferences;
a false positive must be resolved with exact-source evidence. Findings on an
already published application trigger a repair while the last working release
is retained.

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

Application repairs update the ordered patch series and regression manifest.
The resulting application and complete configuration delta receive a fresh
native review pair. Tests run only after both reviews complete, and selective
adoption preserves every reviewed patch and regression-manifest blob.

Policy repairs run the trusted parser bootstrap and trusted immutable policy
oracle in a credential-free sandbox. The candidate CLI is never imported into
the trusted process. The shared final policy mode first runs the original baseline tests against
their original controller, workflow, wrapper and exact private-module pin in an
isolated child interpreter. It then imports the candidate's `release.py` and
runs the immutable transitioned oracle against that candidate plus candidate test
files that are new or byte-changed. Both stages must complete every selected
test successfully. The hosted workflow requires the exact baseline private pin;
historical nested unit fixtures retain their original launcher contract.
The full candidate tree and exact private modules are mounted read-only in a
network-disabled, credential-free sandbox. For a policy-only
migration, a native exact-source final-bundle receipt may reuse that completed
policy validation; absent proof runs the normal check, and malformed evidence
blocks. Both paths still recheck the full review pair and final-attempt history.
The workflow contract checks the exact review-before-test ordering, private
checkout identity, credential boundaries, attempt reservation, same-run
test/build gates, artifact reuse and publication gates. Remote actions
must use full commit SHAs; Docker Actions require an exact image digest; local
`./` Actions remain allowed. Workflow YAML is read with PyYAML `safe_load`, and
the parser wheel is SHA-256 pinned. A policy-only change with unchanged
application, patch, recipe and platform identity advances the accepted policy
checkpoint while retaining the existing verified image; it does not rebuild the
container.

For a future repair that changes the release workflow, successful native policy
validation permits adoption before application tests or a build are reserved.
The owner-authenticated fast-forward starts the accepted workflow on the exact
reviewed revision. Its continuation reuses the original candidate's completed
native policy job and reservation, including when a later adoption or pin-update
step failed. A stale trusted pin is recovered before heavy work; native run
history prevents a duplicate continuation. Missing or inconsistent transition
proof blocks the candidate and enters the existing repair path.

Temporary repair context is never adopted. Full and delta review requests and
their exact native completions remain available as evidence. Closed review refs
are deleted only after the pull-ref archive and independent base retention are
verified, with an expected-OID lease. Policy and application repairs remain
separate.

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

- Use `downstream` as the default branch. Keep the release workflow paused until
  the checked activation below is complete.
- Allow GitHub Actions to create pull requests.
- Enable the Codex GitHub integration for `warelik/9router`.
- Set the repository secret `CODEX_REQUEST_TOKEN` to the existing owner token
  allowed to comment on PRs and update workflows for independently reviewed policy
  repairs. Requests from the Actions bot are not used as owner requests.
- Set `MAINTENANCE_READ_KEY` to the dedicated read-only deploy key for the private
  shared maintenance module; policy tests mount that checkout read-only without
  the owner token.
- Native Codex cloud tasks need permission to push to their repair PR branch.
- After checked activation, run **Upstream Plus Patches** on the accepted default
  revision. No VPS access or deployment secrets are needed.

### Initial shared-policy activation

Machines perform the initial activation with the existing owner authority:

1. Freeze the candidate configuration, application, patch series, recipe, shared
   module and regression-oracle revisions. Complete both exact native review
   scopes for the shared module and each of the four adapters, carrying every
   finding to an explicit source-bound disposition.
2. Run the private shared-policy workflow once with that protected exact-source
   manifest. Require its native review and final policy-regression jobs and their
   mandatory steps to finish successfully on the exact dispatcher/run attempt.
3. Retain the immutable owner-authored checked-bundle receipt on the full review
   PR. Recheck the default revision and accepted publication checkpoint against
   the frozen baseline before changing either policy reference.
4. While the public release workflow is paused, fast-forward the default branch
   to the exact reviewed configuration and initialize `ZED_TRUSTED_POLICY` to
   that same revision. Both writes require the successful checked bundle and
   native readback of the exact values.
5. Enable the existing release workflow and dispatch it on that accepted
   revision. It reuses the exact bundle's policy result and still requires the
   application's one authorized final test/build/publication sequence.

The pre-shared baseline controller is not invoked with the new shared CLI ABI
during this activation. Routine subsequent repairs use the installed shared
controller's native review, validation and adoption path; the owner does not
perform routine pin updates or merges.

If upstream breaks a patch, the native task minimally refreshes that patch and
retains its regression cases. Do not skip patches, replace upstream source with
old files, force-push, or weaken review.

The paired shared workflow publishes releases named
`build-VERSION-UPSTREAM12-PATCHSET12-rRECIPE12`; the recipe prefix keeps
recipe-only changes distinct while upstream, patch and recipe identities stay in
the full shared provenance. The legacy `prepare`/`publish` CLI retains
`build-VERSION-UPSTREAM12-PATCHSET12` and its original twelve-field provenance
when no recipe is supplied. Readers accept both tag forms; legacy artifacts are
reused by the shared workflow only when verified provenance and recipe match the
selected candidate. Releases contain a `linux/amd64` Docker image,
`provenance.json` and `SHA256SUMS`, not a VPS deployment.
The server recipe downloads that immutable release; GitHub has no VPS credentials.

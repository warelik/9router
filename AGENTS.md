# 9router patch overlay

The `downstream` branch holds an ordered application patch series and a release
workflow. Inspect the exact upstream snapshot before changing an application
patch. A repair PR supplies its clean tree in `.repair/upstream.tar.gz` for
offline work. Do not restore the retired per-commit integration controller.

The initial migration source and cutoff are recorded in `patches/source.json`.
Do not import later downstream repairs into that historical migration.
Future intentional fixes are separate changes with their own regression cases.

Preserve upstream provider protocol implementations, OAuth client IDs and client
secrets, request fingerprints, headers and signing inputs. These public upstream
values must not be redacted or replaced in patches, builds or scan repairs.

Keep application changes in `patches/*.patch`, with their regression tests.
Apply the complete series to the selected clean upstream snapshot. Preserve the
new upstream behavior when refreshing context; never copy old whole files over it.

Review source identity, both streaming paths, tool-call/result identity, native
Gemini headers and framing, conversation isolation and error propagation.
Release policy changes are separate from application repairs and require review.
Ordinary conflicts, test failures and review findings belong to native Codex
repair tasks, not the owner. Push the actual fix to the repair PR branch; a report
or an unpublished commit does not count. New application SHAs need their own
review and regressions before publication. Every real unresolved finding blocks
publication and adoption, including P2/P3. Machines fix it, retain a regression,
and request fresh review of the changed exact SHA. Resolve a false positive with
evidence; optional optimization and style are not product defects.

The workflow adopts only the verified patch or policy diff, never repair-context
files. It records future regression files separately from the historical
manifest entries, so upstream absorption cannot silently remove their coverage.
Bound each task and job by time and resources. A later scheduled run continues
with the prior evidence and a changed diagnostic approach. Elapsed time and
attempt count alone never justify escalation. Use existing GitHub notifications
only when evidence shows no simple correct solution without workarounds or
overengineering, or the owner's scope or permissions must change. Explain the
attempts, alternatives and consequences; routine maintenance belongs to machines.

When upstream fixes a defect, prove the regression passes without our product
patch, remove the redundant change, and retain the useful test. Prefer existing
GitHub and Codex mechanisms; do not create a separate product or a controller
without demonstrated need.

Do not force-push, rewrite existing branches, skip conflicting patches or weaken
tests/review to make publication pass. A published build is not a deployment.
GitHub never deploys to the VPS. Delivery belongs to the server's managed recipe,
which verifies the finished release and preserves user intent, health and rollback.

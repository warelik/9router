# 9router patch overlay

The `downstream` branch holds an ordered application patch series and a release
workflow. Download the exact upstream commit before inspecting or changing an
application patch. Do not restore the retired per-commit integration controller.

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

Do not force-push, rewrite existing branches, skip conflicting patches or weaken
tests/review to make publication pass. A published build is not a deployment.
Do not touch VPS recipes, service state or deployment configuration in this task.

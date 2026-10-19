# Ranger cloud validation, 19 October 2026

## Verified on the current working tree

The backend and frontend were built in a fresh Linux cloud workspace. Provider credentials were injected into the backend process by Doppler; they are not part of the repository or frontend bundle.

* Backend unit suite: 375 tests passed on the final tree.
* Full integration suite: 101 tests passed, including real local Trace indexing and retrieval with the pinned model cache.
* Offline end-to-end suite: 16 passed, 7 skipped. Skips are not passes.
* Frontend: 124 tests passed; typecheck, lint, and production build passed.
* Live xAI: audio response, tool relay, screen image inspection, and reconnect passed. A separate real voice-tool request produced a persisted draft with no approval, run, or workspace creation.
* Live Instabox: one real public-API flow created a VM, bootstrapped it, wrote source, verified actual guest SHA256 and behavior, checked workload isolation, cancelled a background process, ran another command, and destroyed the VM. Provider cleanup was verified.

* A real approved coding run passed through the public API and compiled worker: four model turns fixed a synthetic bug, ran tests inside the guest, passed independent behavior/hash checks, and retained saved results after VM deletion. Duration: 61.31 seconds. Reported model usage for that run: $0.007112. This was an isolated synthetic project, not a production user approval.

* Generated spoken input: xAI synthesized a 25.63-second customer request. Feeding only its PCM audio through Ranger produced the requested unapproved plan, with no runs, approvals, or VM creation. Final test passed in 44.40 seconds. Two earlier attempts exposed an overly strict test assertion rejecting the valid evidence scope; another attempt timed out during the provider handshake before any accounted spend. The assertion was corrected with regressions, and the unchanged timeout attempt passed on retry.

## Important fixes

The VM bootstrap moved PID 1 into another cgroup, which disabled subsequent provider command execution. The unnecessary migration was removed while retaining workload limits and adding a fresh fenced readiness check. Source writes now use exact input length, checksum verification, atomic replacement, and preserved ordinary file modes.

Voice uses the configured outbound proxy for its WebSocket connection. Screen inspection results survive later screen frames and retain their capture timestamp. Confirmed voice requests can create plans, but only explicit review and approval of that exact plan version enables execution. Stale and duplicate requests fail safely.

The result views show actual stored outcomes and command history. Saved source is not presented as a patch. Malformed or truncated stored tool output no longer breaks the entire results response. Trace readiness now invalidates on same-length changes and changes made through another database connection.

## Recording flow

1. Connect the intended local checkout to a project and wait for preparation and indexing.
2. Start the call and optionally share a screen. Ask a question about the connected code.
3. Request one concrete change and confirm the request and acceptance conditions.
4. Review the generated plan and approve the exact version in the UI.
5. Ask Ranger to start the approved work. Ask for status while it runs.
6. Inspect Changes, Checks, and Review results. A preview requires launch scope in the approved plan.

## Still unverified

Human microphone and speaker quality, browser screen capture permissions, visual interaction, and a single uninterrupted call through UI approval, worker execution, and displayed results have not been verified here. The shell browser could not bind its required socket in this execution environment. Component live tests do not establish that full browser journey.

This document does not claim a deployment. Publishing the commits and updating a running deployment are separate operations. Preserve the existing deployment's provider-budget history when applying changes.

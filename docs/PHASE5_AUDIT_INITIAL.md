# Phase 5 — initial audit (before any change in this phase)

Baseline commit `6ba3307`, 2026-10-16. Sandbox: 2 vCPU, 2 GB RAM, Linux, Node 20.20.2.
Restored snapshot: `node_modules`, Playwright Chromium and the model cache were absent and were
reinstalled; `.data/campus` was captured mid-write again (unopenable), moved aside to
`.data/campus.unreadable-2` (not deleted) and rebuilt with `npm run db:reset`
(REAL 0 issues / 0 reports, DEMO 0 / 0).

Baseline checks, run before editing anything:

| Check | Result |
|---|---|
| `npm test` (vitest) | 148 passed, 3 skipped (2 need native PostgreSQL, 1 opt-in genuine model test) |
| `npm run typecheck` / `typecheck:web` | clean / clean |
| `npm run smoke:api` | 53 passed, 0 failed |
| `npm run e2e` (Chromium, fake camera) | 25/25 — first attempt crashed at sign-in because `smoke:api` had just used up the 10/min login limit; passed when rerun after 65 s |
| Linter | none configured |

| Feature | Expected | Actual (initial) | Evidence | Status | Required fix |
|---|---|---|---|---|---|
| Live camera capture | getUserMedia, rear camera preferred, preview/retake, tracks stopped, no gallery | Implemented exactly so (`useCamera.ts`, `facingMode: ideal environment`, tracks stopped on capture/unmount, no `<input type=file>`) | code + e2e "no gallery upload control", "photograph captured from the live camera stream" | PASS | — |
| Server-side freshness | Server should not accept an arbitrary file as a "fresh capture" | Server accepts ANY JPEG/PNG multipart upload from any authenticated client. Only a client `capturedAt` (untrusted) is recorded. No server-issued capture session. | `routes/reports.ts` | FAIL | Server-issued, single-use, short-lived capture ticket bound to the user |
| Repeated submit taps | One report per capture | Client guard only (`submitting` React state; two clicks in one tick can both pass). No server idempotency. A network retry after commit creates a second report. | `ReportIssuePage.tsx:134`, `routes/reports.ts` | PARTIAL | Server-side idempotency per capture |
| Block/spot validation | Server rejects mismatched pairs; stable IDs | `submitReport` rejects unknown spot, spot not in block, inactive location; UUIDs throughout; spot reset on block change | `issues.ts:93-106`, `ReportIssuePage.tsx:334`, tests | PASS | — |
| GPS optional | Report possible without GPS | `getCurrentPosition` optional; lat/long optional server-side | code | PASS | — |
| Report persistence | Real row, server timestamp, protected photo | Yes; `submitted_at` server default; evidence behind authorised route with `no-store` | e2e + smoke | PASS | — |
| AI model genuine | Real image analysis | Local CLIP ViT-B/32 (q8) zero-shot over the active categories + "nothing wrong" label; output schema-validated; failures persisted | Phase 4 genuine test 6/7 | PASS (classification only) | — |
| AI severity / repair recommendation | Estimated where supported | Always `null` — CLIP classifies, it cannot write a recommendation | `clip.ts` | NOT IMPLEMENTED | Needs a generative vision model (user decision) |
| Background worker | Processes new reports | Polls, retries ≤3, skips permanent failures | worker tests, e2e | PASS | — |
| 10-token credit on AI validation | Credit when AI validates | The worker NEVER credits. Credit only when an HOD calls `/validation`. A SUCCEEDED, category-agreeing analysis earns nothing until a human acts. | `worker.ts` header, e2e "no tokens credited by the AI" | FAIL vs business rule | Server applies AI_VALIDATED + idempotent credit inside the analysis transaction when the deterministic policy passes |
| Duplicate linking | Same defect → one master issue | Same spot + same category → one open master (partial unique index; 8 concurrent requests → 1 issue) | concurrency tests | PASS | — |
| Uncertain-match review | Suggestions for HOD review | `CANDIDATE_FOUND` exists in schema/enum but NOTHING ever produces it; no way for an HOD to confirm/dismiss; no merge | grep | FAIL | Produce candidates, HOD confirm (merge) / dismiss |
| HOD dashboard | One actionable issue with counts | Report count shown on dashboard + detail; overdue filter on issues list | code | PASS (verify UI) | — |
| Workflow + note | S→A→IP→R, note required, invalid rejected | Enforced in `state-machine.ts`, history recorded | tests + e2e | PASS | — |
| 72-hour overdue | Server-calculated | `due_at = submit + overdue_hours (72, configured)`; `overdueOnly` filter | code | PASS (verify) | — |
| Student status | Own reports, status, note, tokens | Verified by e2e | e2e | PASS | — |
| Admin twin | Interactive or fallback | Interactive with WebGL. **Without WebGL the whole app goes blank** (no error boundary; THREE throws) | `tools/probes/webgl-off.mjs`: body text length 0, `pageerror: Error creating WebGL context` | FAIL | WebGL detection + error boundary + data fallback |
| Expired session | Redirect to sign-in | Single 401 handler in `api.ts` | code | NOT TESTED (to test) | — |

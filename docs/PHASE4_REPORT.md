# Phase 4 report — integration, hardening, testing, demo readiness

AI Sustainable Campus · Dayananda Sagar University Main Campus, Bengaluru
Commits this phase: `fdba4d3` (Phase 3 web client, committed first) → `550ed9a` → `411e592` → `0f00061`

Every result below says how it was obtained. **Verified** means a command was run and its
output was read in this session. **Not verified** means exactly that.

---

## 1. Initial repository state

| Item | Found |
|---|---|
| Git | `master` at `2391e70` with **24 uncommitted paths**: the whole Phase 3 web client had never been committed. |
| Tests | `npm test` 140 passed / 3 skipped. Root `tsc` clean. Web `tsc` clean. Web build clean. |
| Lint | **No linter is configured.** Strict TypeScript is the only static check. Not added in this phase (§2: no new dependencies without a reason). |
| Database | The local PGlite directory **would not open** (`PGlite failed to initialize properly`). Every file had the same creation timestamp: it had been snapshotted mid-write. |
| Dependencies | `node_modules` absent (workspace snapshots exclude it); `npm install` restores it from the committed lockfile. |

### What worked, partly worked, was missing, or failed

| | |
|---|---|
| **Worked** | Auth and server-side role checks; the issue state machine; dedupe with one master per spot and category under concurrency; the token ledger with idempotency keys; authorised evidence storage; analytics from SQL; the real CLIP adapter when called by hand. |
| **Partly worked** | The web client rendered every page, but see "failed". AI analysis existed only as a manual HOD/ADMIN endpoint. |
| **Missing** | **The background analysis worker.** `AI_WORKER_ENABLED` and `AI_WORKER_INTERVAL_MS` were documented and validated, but no code read them. Also missing: a safe reset procedure, an end-to-end test through the UI, and Windows instructions for the web app. |
| **Failed** | **Every student submission from the app** (400, missing `title`); photo thumbnails that never loaded; an HOD page that triggered a 403; a "Full photo" link that returned 401; a Resolve button the server always refused; twin blocks drawn off-canvas. All are detailed in §2. |
| **Blocked the demo** | The missing worker and the broken submission. Each alone stops the primary journey. |

---

## 2. Critical bugs discovered (all fixed and re-verified)

| # | Severity | Defect | How it was found |
|---|---|---|---|
| B1 | **P0** | **Student submission always failed.** The API contract requires `title` (5–160 characters), and the report form never sent one. Every backend test and the API smoke test passed because they post `title` themselves. | Driving the journey through the UI with Chromium's synthetic camera. |
| B2 | **P0** | **No background worker.** Reports stayed PENDING forever: no analysis, no review entry, no status change. | Repository audit: `runAnalysis` was reachable only from the manual route. |
| B3 | P1 | **Thumbnails never loaded.** Shared photo requests were tied to the first subscriber's `AbortSignal`. When that component unmounted (StrictMode, or a real navigation), the second subscriber reused the aborted promise and stayed on "loading". | Browser smoke test: requests were `ERR_ABORTED` and never succeeded. |
| B4 | P1 | **HOD "Full photo" was a plain `<a href>`** to an endpoint that needs a bearer token. Measured: **401**. | Reading the e2e screenshot, then `curl`. |
| B5 | P1 | **Resolve was offered in SUBMITTED and APPROVED**, where the state machine forbids it. The server answered 409 every time. | e2e journey. |
| B6 | P1 | **HOD review queue called the ADMIN-only `/v1/admin/ai/status`**, so HODs got a 403 on their own page. | Browser smoke test. |
| B7 | P2 | The worker retried **permanent** failures, such as an unusable photo, three times. `.env.example` says it must not. | Live log, then reading the persisted `AI_INVALID_EVIDENCE` reason. |
| B8 | P2 | **Twin:** `z` was never centred and the camera was fixed, so outer blocks were drawn off the canvas. The legend also covered a block. | Looking at the screenshots. |
| B9 | P2 | **Report photo overflowed its card** on a 390 px phone. `.detail-photo` was referenced but never defined in CSS. After the first fix the photo was cropped; it now uses `contain`, verified by pixel sampling. | Phone-viewport screenshot, then a DOM probe. |
| B10 | P3 | Sidebar brand cut off mid-word; campus cache not cleared on sign-out; duplicate notice said "other students" and "three times" whatever the facts. | Screenshots and audit. |
| B11 | env | An unopenable PGlite directory gave an error with no cause and no remedy. | Startup failure. |

My own test tooling also produced false results, and these were fixed too, because a check that passes for the wrong reason is worse than none:
- The e2e script validated the **wrong report** (the first Validate button on the ticket). The balance still rose by 10, so the check passed. It now targets the report by `data-report-id` and asserts exactly one ledger row against that report.
- The API smoke test assumed AI was always off.
- The browser smoke test reported StrictMode's expected aborts as failures, and also signed in again on every poll until it hit the rate limiter.

---

## 3. Changes implemented

- **Worker** (`apps/api/src/worker.ts`). It runs inside `npm start` and calls the same `runAnalysis` as the manual route. It cannot approve, merge, resolve or credit anything, and its work is attributed to no human (`actor_user_id NULL`). It stops by analysis *history*: a report with a usable result is never re-analysed (restart-safe); transient failures get up to `AI_MAX_ATTEMPTS` tries; permanent failures get one. With `AI_PROVIDER=unconfigured` it idles, says so once, and records no attempts. One analyzer instance is shared by the HTTP routes and the worker.
- **Submission**: a required, visible, editable title field, suggested from the chosen category.
- **Evidence**: the request owns its controller and is aborted only when the last subscriber leaves. Cleanup releases only cache references it actually took. Requests in flight are cancelled on sign-out. HOD full photo now opens in an authorised dialog.
- **Workflow UI**: Resolve is shown only in IN_PROGRESS.
- **Review queue**: the response now carries its own AI context. `/ai/status` stays ADMIN-only.
- **Twin**: camera fitted to the layout's bounds, grid centred, legend moved below the canvas.
- **`npm run db:reset`**: the safe rebuild procedure for §11. It refuses in production, against a non-loopback database, on a directory that isn't a PGlite cluster, and while the API is running. It never drops a native PostgreSQL database and never touches `storage/evidence`. It prints REAL/DEMO row counts afterwards.
- **Startup diagnosis**: an unopenable data directory now names the likely cause and the fix.
- **Docs**: RUNBOOK rewritten for Windows. Root scripts added: `web`, `web:build`, `typecheck:web`, `db:reset[:dry]`, `worker:verify`, `smoke:api`, `smoke:web`, `e2e`, `screens`.

## 4. Files created or modified

**Created:** `apps/api/src/worker.ts`, `scripts/db-reset.ts`, `tests/worker.test.ts`, `tools/verify-worker.mjs`, `tools/e2e-journey.mjs`, `tools/screens.mjs`, `docs/PHASE4_REPORT.md`.
**Modified:** `apps/api/src/{server,app}.ts`, `apps/api/src/routes/analysis.ts`, `packages/db/src/{driver,repositories}.ts`, `packages/domain/src/adapters/{storage,ai-errors}.ts`, `apps/web/src/lib/{evidence,session,types}.ts(x)`, `apps/web/src/components/ReportThumb.tsx`, `apps/web/src/pages/student/{ReportIssuePage,ReportDetailPage}.tsx`, `apps/web/src/pages/hod/{IssueDetailPage,ReviewQueuePage}.tsx`, `apps/web/src/pages/admin/CampusTwinPage.tsx`, `apps/web/src/styles/components.css`, `scripts/smoke-test.mjs`, `tools/smoke-web.mjs`, `docs/RUNBOOK.md`, `package.json`, `.gitignore`.

---

## 5. Tests actually run (final state, this session)

| Suite | Result | Notes |
|---|---|---|
| `npm test` | **148 passed / 3 skipped** | +8 new worker tests. They use a **mocked analyzer** and say so in the file: they prove queue mechanics, not model quality. |
| `AI_GENUINE_TEST=1` genuine inference | **passed**: 6/7 top-1 on 7 **synthetic** fixtures | Real CLIP. The one miss (water leakage, predicted as damaged toilets at 0.565) was routed to human review. **Feasibility evidence, not accuracy.** |
| Native-PostgreSQL race tests (2) | **not run** | No PostgreSQL server in this sandbox. They need `TEST_DATABASE_URL`. |
| `npm run smoke:api` | **53 / 0** | Real HTTP against a running server: upload, duplicate linking, lifecycle, tokens, reversal, isolation. |
| `npm run worker:verify` | **all pass** | Real photo → PENDING with 0 credited → the worker analyses it with no client request → still 0 → human validation credits **10** → a repeat credits 0 → four more ticks leave the analysis row unchanged. |
| `npm run smoke:web` | **35 / 35** | Real Chromium. Every route as every role; every forbidden route refused by the guard; 0 console errors; 0 failed requests. |
| `npm run e2e` | **25 / 25** | The whole journey through the UI (see §7). |

## 6. Build, lint and type check

Root `tsc --noEmit`: **clean**. Web `tsc --noEmit`: **clean**. `npm run web:build`: **clean** (initial JS 118.5 kB gzip; the twin and analytics pages load on demand). Lint: **no linter configured**. `npm audit`: **5 moderate, 0 high**, all one chain (see §9).

## 7. End-to-end workflow results (`npm run e2e`, verified)

1. The student signs in on a 390 px viewport. **There is no file-upload control.** "Start camera" opens a live stream (Chromium's synthetic device), and Capture takes the frame.
2. Block, spot and category are chosen, the title is suggested and visible, and the report is submitted. The server returns 200 with the real reference, e.g. `DSU-2026-00008`. **The UI does not claim any tokens.**
3. The worker analyses the report on its own. The real model rated the synthetic test pattern `NEEDS_HUMAN_REVIEW` at confidence 0.258, which is an honest answer for a test pattern. Balance unchanged.
4. The HOD claims the issue and opens "Full photo" (the image loads). They validate **this** report (+10). Resolve is not offered yet. Approve returns 200, then Start work returns 200. Resolve is disabled until a note is typed, then returns 200. **After a page refresh**, the note and the resolution are still there.
5. The student signs in again. The report shows Resolved, with their own photo, balance +10, **exactly one ledger row for this report**, and it no longer says "Awaiting validation".
6. The admin finds the issue in the list, opens it with the HOD's note, and the twin renders.

An earlier run also took the **duplicate path**: the report was `LINKED` into an existing issue and still got its own 10-token credit.

---

## 8. Security issues found and resolved

| Found | Resolved |
|---|---|
| HOD page requested an ADMIN-only endpoint (B6) | The endpoint each role needs now carries the data. **No guard was loosened.** Verified: HOD → `/ai/status` 403; student → review queue 403. |
| Plain link to protected evidence (B4) | Replaced with the authorised loader. No credential ever goes in a URL. |
| Campus cache survived sign-out and session loss | Cleared on both paths, together with the evidence cache, and requests in flight are cancelled. |
| Destructive reset could run against the wrong target | `db:reset` guards: production, remote database, foreign directory, running API. |

**Checked and found sound:**
- Roles come from the session and are never trusted from the client.
- Entering another role's URL fails, both in the browser guard and on the server.
- Students cannot read other students' reports or photos (existing tests + smoke).
- Uploads are checked by magic bytes and limited to 8 MiB.
- 500 responses carry only a request id, never a stack trace.
- Logs carry `userId` and role. The logger redacts `authorization` and `cookie` headers, `set-cookie`, and the `password` and `email` body fields; request bodies are never logged.
- Login is limited to 10 per minute per IP, with a global limit of 300 per minute.
- There is no CORS plugin, so the API is same-origin only (the website reaches it through the Vite proxy).
- The token is a bearer header, not a cookie, so classic CSRF does not apply.
- **REAL workspace: 0 reports, 0 issues after every test run in this session.**

## 9. Remaining blockers and risks (not resolved)

1. **Not run on Windows.** All commands were run on Linux. The scripts avoid shell-specific syntax (everything is `node`/`tsx`), and the RUNBOOK gives PowerShell equivalents, but **nobody has executed them on a Windows laptop yet.** Do one full rehearsal there before the demo.
2. **Only Chromium's synthetic camera has been tested.** Real phone cameras need `https://` or `localhost`. Phone capture over the LAN needs an HTTPS tunnel; this is untested.
3. **Memory.** With the model loaded the API uses about **735 MB**. On this 2 GB sandbox, the API, the dev server and a browser together caused swapping and timeouts. A typical 8 GB laptop is fine; a 4 GB machine is marginal. Close other apps for the demo.
4. **The worker runs in a single process.** Two API processes could each analyse the same report once (no row claim). Run **one** API instance. PGlite enforces this anyway.
5. **AI quality is unproven.** 6/7 on synthetic images is a feasibility signal, not accuracy. Confidence is a ranking score, not a calibrated probability, and the UI says so.
6. **Phase 2 Stages 4–6 are still deferred** (your Option C decision). Severity and repair recommendations are not produced: the UI shows "Not produced yet". AI duplicate candidates are empty. There is **no merge/confirm-duplicate endpoint** (G5), so none is rendered.
7. **`npm audit`: 5 moderate**, one chain. `sprintf-js` (DoS through unbounded precision specifiers) is reached via `@huggingface/transformers` → `onnxruntime-node` → `global-agent` → `roarr`. The fix needs a **major** upgrade to transformers 4.x, which would need re-validating the AI adapter. Not done during release preparation.
8. **The session token is in `sessionStorage`**, so an XSS bug could read it. There is no known XSS, and React escapes output, but a strict Content-Security-Policy header is not set yet.
9. **Live updates are not implemented** (`/v1/events/stream` honestly returns 501). Pages reflect changes on refresh or navigation.
10. **The campus geometry is a placeholder.** Block names carry "(placeholder)" and the twin is a labelled schematic. `docs/INPUTS_NEEDED.md` §1–§5 decisions are still open: hosting, photo storage, dedupe granularity, row-level security, pilot block/HOD.
11. **No linter.** Only strict TypeScript.

---

## 10. Exact Windows PowerShell commands

```powershell
# ── once ──────────────────────────────────────────────
node -v                          # v20.12 or newer
npm install
Copy-Item .env.example .env
notepad .env                     # DEMO_SEED_PASSWORD="CampusDemo#2026" (quoted)
                                 # AI_PROVIDER=local-clip   (to run the free local model)
npm run ai:warm                  # one-time ~149 MB model download, then works offline
npm run db:reset                 # local database: migrate + seed (API must be stopped)

# ── Terminal 1: API + background worker ─────────────────
npm start                        # expect: "analysis worker started"

# ── Terminal 2: website ─────────────────────────────────
npm run web                      # open http://localhost:5173

# ── Terminal 3: checks (optional, both terminals up) ────
npm test                         # in-memory databases; on a <8 GB machine stop Terminal 1 first
npm run typecheck; npm run typecheck:web
npm run web:build
npm run smoke:api
npx playwright install chromium  # once, for the browser checks
npm run smoke:web
npm run e2e

# ── reset before judges (stop Terminal 1 first) ─────────
npm run db:reset
```

## 11. Judge-demo checklist

- [ ] Stop Terminal 1, run `npm run db:reset`, start Terminal 1. Confirm the log says **`analysis worker started`**.
- [ ] Terminal 2: `npm run web`. Open `http://localhost:5173` **on the laptop** (the camera needs localhost or https).
- [ ] **Student** `student@demo.dsu.edu.in`: Report an issue → Start camera → capture → block/spot → category → check the title → Submit. Point out the real reference and **"no tokens yet"**.
- [ ] Wait about 3 s, then open the report: AI verdict plus the "ranking score, not a calibrated probability" note.
- [ ] **HOD** `hod@demo.dsu.edu.in`: Needs review → the issue → Full photo → Validate (credits 10) → Approve → Start work → Resolve (show the button is disabled without a note) → refresh to show it persisted.
- [ ] **Student**: the report shows Resolved, the progress history, and +10 in My tokens.
- [ ] **Admin** `admin@demo.dsu.edu.in`: Overview → Issues → Campus digital twin. **Say "schematic, not a survey"**; the banner says it too.
- [ ] Show security: paste `/admin/accounts` while signed in as the student, and it is refused.
- [ ] Have `CampusDemo#2026` ready. Every account shows the **Demo data** badge.

## 12. Is it ready for demonstration?

**Yes, for a supervised demo on the DEMO workspace, with conditions.** The brief's primary objective has been run end to end through the real UI in this session: student camera → backend → AI worker → HOD review and resolution → student status and tokens → admin dashboard and twin, with the server as the source of truth at each step.

**Conditions:** rehearse once on the actual Windows laptop (not yet done); use the laptop's own browser for the camera; run a single API instance; and present the AI as a review aid with an uncalibrated score, not a proven classifier.

**Not ready for:** real students or real data. That needs the `INPUTS_NEEDED.md` decisions, official campus data, a production database and photo storage, a CSP header, HTTPS hosting, and Phase 2 Stages 4–6.

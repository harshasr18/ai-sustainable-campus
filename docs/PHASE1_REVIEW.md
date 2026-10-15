# Phase 1 review (Stage 6)

**Date:** 2026-10-15 · **Status:** Phase 1 complete · **Phase 2 not started**

This is the honest close-out: what was actually implemented, the real test results, what was **not**
done, and the limitations a reviewer should know about.

---

## 1. What was implemented

| # | Phase 1 objective | Status | Evidence |
|---|---|---|---|
| 1 | Repository inspection and architecture documentation | ✅ | `docs/PHASE1_AUDIT.md` — the workspace was **empty**, so this is a greenfield build; the audit documents that blocker explicitly rather than inventing a repository |
| 2 | Shared backend structure | ✅ | `apps/api` + `packages/{contracts,domain,db}` npm workspace |
| 3 | Database schema and migrations | ✅ | 6 numbered SQL migrations; idempotent; applied on **2 engines** |
| 4 | Authentication with secure password handling | ✅ | argon2id (`@node-rs/argon2`, prebuilt — no Windows toolchain), opaque revocable sessions, SHA-256 hashed at rest |
| 5 | Server-side role-based authorization | ✅ | `requireAuth(…roles)` on every protected route; roles never accepted from a client |
| 6 | User and campus-location models | ✅ | `users`, `workspaces`, `campus_blocks`, `campus_spots` |
| 7 | Issue / report / status-history / token-ledger models | ✅ | `issues`, `reports`, `issue_status_history`, `token_transactions`, plus `audit_log`, `event_outbox`, `ai_analyses` |
| 8 | Demo vs real isolation | ✅ | NOT NULL `workspace_id` + session-derived scoping + bidirectional tests |
| 9 | Consistent error handling and validation | ✅ | One error envelope, one Zod validator layer, no leaks |
| 10 | Health checks and operational logging | ✅ | `/healthz` with DB latency; structured logs with redaction |
| 11 | API documentation and typed contracts | ✅ | `docs/API.md` + `packages/contracts` |
| 12 | Automated tests for critical business rules | ✅ | 99 tests across 6 files |
| 13 | Handoff contract for app / website / AI / real-time | ✅ | `docs/HANDOFF_PHASE2.md` |

### By the numbers

| Metric | Result |
|---|---|
| Automated tests | **99 total** |
| — on PGlite (default) | **97 passed, 2 skipped** (native-PG-only race tests) |
| — on native PostgreSQL | **99 passed, 0 skipped** |
| Test files | 6, all passing; stable across 3 consecutive full runs |
| End-to-end smoke checks | **50 passed, 0 failed** against the running server |
| TypeScript | `tsc --noEmit` clean (strict, `noUncheckedIndexedAccess`) |
| npm vulnerabilities | **0** |
| Migrations | 6 applied cleanly; re-run is a no-op |

> **Honesty note.** All of the above are real, reproducible outputs from this environment — not
> projections. Nothing in the AI pipeline, the event transport, or the digital twin is claimed to
> work, because none of it is implemented.

The suite covers all 17 mandated acceptance checks. Highlights:

```
Criterion 1  valid user authenticates ............................. PASS
Criterion 2  invalid password rejected ............................ PASS  (+ no user enumeration)
Criterion 3  unauthorized cannot access protected endpoints ....... PASS
Criterion 4  student cannot self-elevate .......................... PASS  (+ own-role change blocked)
Criterion 5  student cannot approve/claim/resolve ................. PASS
Criterion 6  HOD can perform permitted transitions ................ PASS
Criterion 7  invalid transitions rejected ......................... PASS  (+ no generic status route)
Criterion 8  resolution without a note rejected ................... PASS  (+ enforced at the DB layer)
Criterion 9  every transition writes status history ............... PASS  (+ nothing written on rejection)
Criterion 10 report cannot reference a nonexistent block/spot ..... PASS  (+ cross-workspace blocked)
Criterion 11 token award not duplicated on retry .................. PASS  (6 retries → 1 credit)
Criterion 12 valid duplicate links without a second ticket ........ PASS  (2 reports → 1 ticket, 20 tokens)
Criterion 13 reversals require authorization + reason ............. PASS  (+ DB CHECK constraint)
Criterion 14 demo data isolated from real, both directions ........ PASS
Criterion 15 private photo authorization .......................... PASS
Criterion 16 failed writes never report success ................... PASS
Criterion 17 concurrent duplicates handled safely ................. PASS  (see below)
```

### Criterion 17 — proven, not asserted

The concurrency requirement was tested at two levels:

* **HTTP layer** (always runs): 8 simultaneous identical submissions → **1 master ticket created, 7
  linked**.
* **Database layer** (runs with `TEST_DATABASE_URL`): 8 genuinely parallel transactions, each on its
  own backend connection (verified: multiple distinct `pg_backend_pid()`), forced by a barrier so
  **all of them read before any of them wrote**. Result: **1 ticket, 7 linked**.

That second test is the exact scenario the brief warned about. During Stage 1 I measured the naive
implementation producing **10 master tickets for one defect**; the shipped design produces **1**.

---

## 2. Real defects found and fixed during the build

Recorded because they are the substance of "verify, don't assume" — and because several would have
been invisible until production.

| # | Defect | How it surfaced | Fix |
|---|---|---|---|
| 1 | **`ON CONFLICT` vs catching a unique violation.** In PostgreSQL any error aborts the transaction (`25P02`), so the natural "try/catch then link" duplicate pattern breaks | Stage 1 spike | Use `ON CONFLICT … DO NOTHING RETURNING`; documented as an anti-pattern and covered by tests |
| 2 | **Email validated before normalization.** `"Student@DSU.edu.in "` (a trailing space from a mobile keyboard) was rejected with an opaque 400 | Stage 1 spike | `z.string().trim().toLowerCase().pipe(z.email())` — normalize *then* validate |
| 3 | **`/v1/tokens/balance` returned 500.** The query did `::text - ::text`; PostgreSQL has no `text - text` operator | Full-suite run | Subtract in integer space, cast to text last |
| 4 | **`reportCount` was 0 in transition responses.** `applyTransition` used `RETURNING *`, which cannot produce the *computed* `report_count` column, while `GET /v1/issues/:id` returned the real count — the app and the website would have disagreed | End-to-end smoke test | Re-read through the single enriched projection; regression test asserts every endpoint returns identical values |
| 5 | **`DEMO_SEED_PASSWORD` was ignored on re-seed.** `ON CONFLICT DO UPDATE` refreshed the display name but not the password hash, so a documented workflow silently did nothing | End-to-end smoke test | Refresh `password_hash` (and documented that roles are deliberately *not* reset) |
| 6 | **Unquoted `#` in `.env` truncated the password.** `CampusDemo#2026` silently became `CampusDemo` | Login failed after a clean re-seed | Quoted in `.env`/`.env.example`; the seeder now rejects implausibly short values and reports the length |
| 7 | **PGlite deadlock.** A query on the *outer* db handle inside a transaction callback hangs forever (single connection) | Four tests timed out at 30s | Added a dev-time guard that throws an explanatory error instead of hanging |
| 8 | **vitest worker OOM-killed.** Tests that booted a second PostgreSQL engine caused "Worker exited unexpectedly", silently skipping tests | Full-suite runs reported fewer tests than expected | Tests share one engine per file and stub only the DB boundary for failure paths; suite now stable |
| 9 | **npm 10.8.2 arborist crash** on incremental `npm i -D` (`edgesOut` null) | Dependency install | Declare deps in `package.json`, single `npm install`; documented in the runbook |

Defects 3–8 were caught by *running* the system, not by reading it. This is the case for the
"implement → test → verify" loop the brief mandates.

---

## 3. What was NOT implemented (with the reason)

| Item | Status | Reason |
|---|---|---|
| AI classification / severity / repair recommendation | ⛔ **Not implemented.** `POST /v1/reports/:id/analyze` → **501** | Explicitly out of scope for Phase 1. The adapter boundary, the versioned `ai_analyses` table, and the human-review policy (`requiresHumanReview`, threshold 0.7) are in place. **No prediction is ever fabricated** — a fake result could trigger unearned token awards |
| Live event transport (WebSocket/SSE) | ⛔ **Not implemented.** `/v1/events/stream` → **501** | Not claimed. The durable half exists: every change writes to `event_outbox` in the same transaction, with 9 declared event types and workspace scoping |
| 3D campus digital twin | ⛔ **Not implemented** | Data model supports it (block/spot coordinates, `byBlock` counts, marker endpoints) |
| Student app, HOD app, admin website UI | ⛔ **Not implemented** | Later phases. The API contract they will consume is complete and documented; a development API console at `/` exercises it end-to-end |
| Distinct maintenance role / assignment workflow | ⛔ **Not implemented** | The brief says not to invent a separate mandatory workflow without confirming requirements. `IN_PROGRESS` is the tracked maintenance stage |
| `REJECTED` reports / reopened issues | ⛔ **Not implemented** | Deliberately excluded so the state machine stays exactly as specified; extending it requires updating the transition table **and** the tests |
| PostgreSQL row-level security | ⚠️ **Not implemented** — isolation is enforced in the repository layer | RLS must be implemented and tested carefully (it interacts with connection pooling). Claiming it without testing would be dishonest; it is listed as defence-in-depth for Phase 2 |

---

## 4. Environment variables and commands

Full detail in `docs/RUNBOOK.md`. Minimum to run:

```powershell
npm install
Copy-Item .env.example .env      # then set DEMO_SEED_PASSWORD="…"  (KEEP THE QUOTES)
npm run migrate
npm run seed
npm start                        # http://localhost:3001
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | no | *(empty → PGlite)* | Set to use native PostgreSQL |
| `PGLITE_DIR` | no | `.data/campus` | PGlite data directory |
| `PORT` / `HOST` | no | `3001` / `0.0.0.0` | |
| `NODE_ENV` | no | `development` | `production` requires `DATABASE_URL` |
| `SESSION_TTL_HOURS` | no | `8` | |
| `LOGIN_RATE_LIMIT_MAX` | no | `10` | Login attempts/min/IP |
| `RATE_LIMIT_MAX` | no | `300` | Global requests/min/IP |
| `DEMO_SEED_PASSWORD` | **for a predictable demo** | random, printed once | **Quote it if it contains `#`** |
| `EVIDENCE_DIR` | no | `storage/evidence` | Private photo storage |
| `MAX_EVIDENCE_BYTES` | no | `8388608` (8 MiB) | |
| `TEST_DATABASE_URL` | no | — | Enables the true-parallel race tests |
| `AI_PROVIDER`, `AI_API_KEY` | no | — | Phase 2 only; unused today |

Commands: `npm run migrate` · `npm run seed` · `npm start` · `npm run dev` · `npm test` ·
`npm run test:watch` · `npm run typecheck` · `node scripts/smoke-test.mjs`

---

## 5. Known security and reliability limitations

Stated plainly so nobody assumes more than is true.

1. **Rate limiting is in-memory and per process.** Correct for one server; a multi-instance
   deployment needs a shared store.
2. **Session spans are a single access token**, not a refresh-token pair. Revocation is immediate
   (verified), but a client must re-authenticate after expiry (`SESSION_TTL_HOURS`, default 8).
3. **No password-reset / email-verification flow.** Accounts are provisioned by an admin or the
   development seeder. There is no self-service recovery.
4. **Client `capturedAt` is untrusted** and stored as evidence only. The server records
   `submitted_at` itself, but **nothing cryptographically proves a photograph is fresh**. The brief
   acknowledges this; the in-app camera requirement is a client-side policy, not a server guarantee.
5. **Workspace isolation relies on the repository layer**, not RLS. Every scoped query requires a
   `workspaceId` and there is no unscoped helper, and tests check both directions — but RLS remains
   the stronger guarantee and is Phase 2 work.
6. **Evidence files can be orphaned** if a report transaction fails after the photo is written.
   Unreadable without authorization, but a sweeper job is advisable.
7. **PGlite is single-process.** Two processes cannot share a data directory. Fine for one developer
   or a demo laptop; use native PostgreSQL for anything shared.
8. **`npm run seed` refreshes demo passwords.** Intentional, documented, and it never touches roles —
   but do not run it against a database holding real accounts.
9. **No OpenAPI document is generated yet.** The schema-first Zod contracts and `docs/API.md` are
   authoritative, and `createJsonSchemaTransform` (from `fastify-type-provider-zod`) is verified
   available so a spec can be generated with little work in Phase 2.
10. **No CI pipeline.** There is no repository to attach one to yet; `npm test` +
    `npm run typecheck` are the checks to run in CI.

---

## 6. Exact handoff to Phase 2

**Do not start Phase 2 automatically.** When the team is ready:

1. **Read `docs/HANDOFF_PHASE2.md`** — it is the contract for every remaining component.
2. **Replace the placeholder campus data** (`packages/db/src/seed-data.ts`) with DSU's official block
   and spot names. Until this is done, the location picker shows obviously-labelled placeholders.
3. **Build one client first** (student reporting) against `packages/contracts`, and prove the full
   journey: sign in → capture → submit → appears in the HOD queue → resolve. That single path is the
   strongest demo foundation.
4. **Implement the AI adapter** behind `createAiAnalyzer()` and route uncertainty to human review via
   the existing `requiresHumanReview`. Persist versioned results in `ai_analyses`.
5. **Implement one live transport** over the existing outbox, scoped by workspace, and test it
   end-to-end — then, and only then, describe the system as real-time.
6. **Do not change the invariants** in section 6 of the handoff doc without updating the tests.

### Interface stability

These are depended on by tests and clients and should be treated as stable:
`TOKEN_POLICY`, `tokenCreditIdempotencyKey()`, the `ERROR_CODES` set, the `EventEnvelope` schema,
`TRANSITIONS`, `requiresHumanReview()`, the `AiAnalyzer` / `EvidenceStorage` / `EventPublisher`
interfaces, and every route documented in `docs/API.md`.

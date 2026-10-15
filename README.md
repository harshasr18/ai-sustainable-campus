# AI Sustainable Campus

**Dayananda Sagar University — main campus, Bengaluru**

Students photograph campus infrastructure problems; AI validates the reports; HODs run the repair
workflow; admins see the whole campus. One shared backend and one authoritative database serve the
student app, the HOD workflow, and the admin website.

> **Current status: Phase 1 (foundation) complete.** The backend, database, authentication,
> permissions, issue lifecycle, token ledger, and integration contracts are implemented and tested.
> The AI engine, live event transport, 3D digital twin, and the final UIs are **later phases** and
> are **not implemented** — they return HTTP `501 NOT_IMPLEMENTED` rather than faking results.

---

## Quick start (Windows, PowerShell)

Requires **Node.js 20+**. No database installation is needed — the default database is real
PostgreSQL compiled to WebAssembly (`PGlite`), running in-process.

```powershell
# 1. Install dependencies (see note below on npm quirks)
npm install

# 2. Create your environment file and set a demo password
Copy-Item .env.example .env
#    then edit .env and set DEMO_SEED_PASSWORD="SomethingStrong#2026"
#    IMPORTANT: keep the quotes — an unquoted '#' starts a comment.

# 3. Create the schema and demo accounts
npm run migrate
npm run seed          # prints the demo accounts it created

# 4. Start the API
npm start
```

Then open <http://localhost:3001> for the **development API console** — a small page that lets you
sign in as each role and walk a report through the entire lifecycle in the browser.

```powershell
npm test              # 97 tests (99 with native PostgreSQL)
npm run typecheck     # strict TypeScript, no errors
node scripts/smoke-test.mjs   # 50 end-to-end checks against the running server
```

Full setup, options and troubleshooting: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

---

## What exists today

| Capability | Status |
|---|---|
| Database schema + 6 migrations | ✅ implemented, idempotent, verified on 2 engines |
| Authentication (argon2id, revocable sessions) | ✅ implemented + tested |
| Server-side roles (STUDENT / HOD / ADMIN) | ✅ enforced on every protected route |
| Campus blocks, named spots, configurable categories | ✅ implemented, seeded with placeholders |
| Report submission with camera photograph | ✅ multipart, magic-byte validated, stored privately |
| Master issues + duplicate handling | ✅ concurrency-safe (race-tested) |
| Issue lifecycle `SUBMITTED → APPROVED → IN_PROGRESS → RESOLVED` | ✅ enforced by state machine + DB constraints |
| Status history, audit log, transactional outbox | ✅ written in the same transaction as each change |
| Token ledger (10/report), idempotent, auditable reversals | ✅ implemented + tested |
| Demo vs real workspace isolation | ✅ session-derived, tested both directions |
| AI pipeline | ⛔ **not implemented** — adapter boundary + contracts only (HTTP 501) |
| Live event transport (WebSocket/SSE) | ⛔ **not implemented** — durable outbox in place (HTTP 501) |
| 3D campus digital twin | ⛔ **not implemented** — data model supports it |
| Student app / admin website UI | ⛔ **later phase** — the API contract is ready |

---

## Repository layout

```
apps/api/                Fastify HTTP layer: routes, validation, error mapping  (thin)
packages/contracts/      SHARED Zod schemas + types — the API contract for every client
packages/domain/         Business rules: state machine, tokens, dedupe, auth, adapters
packages/db/             Migrations, workspace-scoped repositories, driver (pg | PGlite)
docs/                    Audit, runbook, API reference, Phase 2 handoff, review
tests/                   Automated suite covering the Phase 1 acceptance criteria
scripts/smoke-test.mjs   End-to-end verification against a running server
```

**Architectural rule:** only `packages/domain` may express a business rule. Route handlers
validate → delegate → map. The mobile app and the admin website import types from
`packages/contracts` and **never** re-implement status transitions, token rules, duplicate handling,
or authorization. That is what prevents two clients from drifting apart.

## Two supported databases

| | PGlite (default) | Native PostgreSQL |
|---|---|---|
| Setup | none — runs in-process | install PostgreSQL 14+ |
| Use for | development, `npm test` | the demo / any real deployment |
| Switch | leave `DATABASE_URL` empty | set `DATABASE_URL` in `.env` |

Both are genuine PostgreSQL and were verified to enforce the same partial unique indexes, `ON
CONFLICT` semantics and `FOR UPDATE` locking. **PGlite is single-process** — stop the server before
running `npm run seed`. See the runbook.

## Documentation

| Document | Purpose |
|---|---|
| [docs/PHASE1_AUDIT.md](docs/PHASE1_AUDIT.md) | Stage 1 repository audit, verification evidence, risks |
| [docs/PHASE1_REVIEW.md](docs/PHASE1_REVIEW.md) | What was built, real test results, known limitations |
| [docs/API.md](docs/API.md) | Every endpoint, error codes, and examples |
| [docs/HANDOFF_PHASE2.md](docs/HANDOFF_PHASE2.md) | Integration contract for app, website, AI, real-time |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, commands, operations, troubleshooting |

# AI Sustainable Campus — Phase 1, Stage 1: Repository Audit & Implementation Plan

**Institution:** Dayananda Sagar University, main campus, Bengaluru, Karnataka, India
**Document status:** Stage 1 complete. **Phase 1 was subsequently implemented and verified — see
`docs/PHASE1_REVIEW.md` for the results and `docs/HANDOFF_PHASE2.md` for what remains.** Section 10's
open decisions were resolved as follows: no existing repository was ever supplied (so this is a
greenfield build, structured so it can be reconciled with a repo later), React + TypeScript was
chosen for the clients, and the database runs on PGlite for development with native PostgreSQL for
the demo.
**Audit executed:** 2026-10-15, against the live sandbox that will host the code
**Author:** engineering agent (architect / backend / DB / security / API design)

---

## 0. Headline finding — blocking, must be resolved before any file is written

**The workspace is empty. There is no repository to inspect.**

Section 5 of the brief mandates that I inspect the actual repository and forbids inventing
its structure. I therefore report the blocker instead of assuming a stack:

| Check | Command | Result |
|---|---|---|
| Working directory contents | `ls -la /home/user` | **empty** (no files, no dotfiles, only `.` and `..`) |
| Any git repository on the filesystem | `find / -maxdepth 4 -name .git -type d` | **none found** |
| Any JS/TS/Python/manifest file | `find / -maxdepth 5 \( -name package.json -o -name pyproject.toml -o -name pubspec.yaml -o -name "*.sln" \)` | **none found** |
| Mount points `/mnt`, `/opt`, `/srv` | `ls -la` | **all empty** |

Your brief states the project owner has "an existing codebase" on Windows. That codebase
is **not present in this environment**. Consequently:

- I cannot identify the current frontend framework, backend runtime, database, migration
  system, or existing API conventions — because none exist here.
- There is **nothing to preserve and nothing to overwrite**. The rule "never overwrite a
  working application with a generic starter template" is not at risk *in this sandbox*,
  but it **is** at risk if I scaffold a fresh project while a real repo exists on your machine.
- **Do not let me guess.** If the real repo exists, upload/connect it first, and I will
  re-run Stage 1 against it before writing a single line of application code.

To keep the audit productive despite the blocker, I used this sandbox to **empirically verify
the stack I intend to recommend** (Section 3) rather than asserting it from memory. Two of
those verifications surfaced real defects that would otherwise have cost the team hours
(Sections 3.3 and 3.4).

---

## 1. Repository and technology-stack findings

**Finding: greenfield environment. No existing stack, tooling, conventions, tests, or CI.**

What the sandbox actually provides (measured, not assumed):

| Capability | Status | Version |
|---|---|---|
| Node.js | available | v20.20.2 |
| npm | available | 10.8.2 |
| pnpm / yarn / bun / deno | **not installed** | — |
| Python | available | 3.13.16 |
| git | available | 2.47.3 |
| Docker | **not installed** | — |
| Native PostgreSQL server | installable, verified running | **17.11** |
| SQLite CLI | not installed | — |
| `npm` registry reachable | yes | PONG 344 ms |
| `apt-get` + passwordless `sudo` | available | apt 3.0.3 |
| Flutter / .NET | not installed | — |

Consequences for the plan:

- **Package manager:** `npm` is the only package manager present. I will use **npm workspaces**
  for the monorepo so the project runs identically here and on your Windows machine without
  requiring pnpm/yarn. (If your existing repo already uses pnpm/yarn, that takes precedence —
  this is an open decision, Section 10.)
- **Container-based setup is not an option in this sandbox** (no Docker). This is actually
  good news for the team: I confirmed a **zero-install database path** (Section 3.2), so the
  hackathon team does not need Docker Desktop on Windows either.
- **No CI exists.** "Run the available baseline checks" has no baseline; I will define the
  check suite (`format`, `lint`, `typecheck`, `test`, `migrate`) as part of Stage 2 and report
  real output from Stage 6.

---

## 2. Existing database and authentication findings

**Finding: neither exists. Both must be built from zero in Phase 1.**

| Area | Expected by brief | Actual |
|---|---|---|
| Database engine | to be determined from repo | none present |
| Migration system | to be determined from repo | none present |
| ORM / query layer | to be determined from repo | none present |
| Authentication | "inspect the existing authentication system first" | **none exists** — nothing to inspect |
| Roles / permissions | required | none exist |
| Seed data | demo accounts required | none exist |
| Tests | required | **none exist** |

Because there is no identity provider in the repository, the brief's fallback applies:
*"If none exists, implement a secure solution suitable for the chosen stack."* My recommendation
is in Section 4.4, and its security properties were verified live (Section 3.3).

---

## 3. Verification evidence (measured in this sandbox)

Everything below is **observed output**, not expectation. This is the basis for every
technology choice I am recommending.

### 3.1 Stack smoke test — Fastify 5 + Zod 4 + argon2id + Postgres

```
dependency             version      dependency                version
fastify                5.12.7       drizzle-orm               0.45.4
zod                    4.6.7        fastify-type-provider-zod 6.1.0
@electric-sql/pglite   0.5.10       @fastify/rate-limit       10.3.0
@node-rs/argon2        2.2.2        vitest                    3.2.7
pg                     8.23.1       typescript                5.9.3
```

Live HTTP/authorization test results (`api-spike.mjs`, run to completion):

```
PASS  GET /healthz + DB connectivity check                          | status=200
PASS  invalid password rejected                                     | status=401 code=INVALID_CREDENTIALS
PASS  malformed request rejected by Zod before handler              | status=400
PASS  valid login (email case/whitespace normalized)                | status=200 role=STUDENT
PASS  unauthenticated request to protected endpoint                 | status=401
PASS  STUDENT cannot approve an issue (server-enforced)             | status=403 code=FORBIDDEN
PASS  HOD can perform permitted action                              | status=200
PASS  client-supplied role=ADMIN is ignored server-side             | created_role=STUDENT
PASS  revoked session is immediately rejected (logout works)        | status=401
PASS  raw session token never stored in DB (SHA-256 only)           | len=64
```

This directly covers brief test requirements **1, 2, 3, 4 (escalation), 6** and partially **16**.
argon2id was confirmed at the expected parameters (`$argon2id$v=19$m=19456,t=2,p=1`) in ~36 ms
hash+verify, and correctly returns `true`/`false` for correct/incorrect passwords.

### 3.2 Database: two engine options, both verified working

The single most useful discovery for a Windows-based hackathon team:

| Option | Verified result |
|---|---|
| **PGlite** — real PostgreSQL compiled to WASM, runs **in-process**, no server, no Docker | `SELECT version()` → **PostgreSQL 18.6** |
| **Native PostgreSQL** via `apt-get install postgresql` | **PostgreSQL 17.11**, TCP + SCRAM auth confirmed over `127.0.0.1:5432` |

Critically, PGlite is **not** a SQLite-like imitation — it is the genuine PostgreSQL engine.
I verified that it enforces the exact features Phase 1 depends on:

```
PARTIAL UNIQUE INDEX enforced -> duplicate key value violates unique constraint "ux_issue_dedu…"
IDEMPOTENCY unique enforced   -> duplicate key value violates unique constraint "ledger_idem_…"
SELECT ... FOR UPDATE ok, rows: 1
pg_advisory_xact_lock ok | server_version: 18.6
rows for k1 after failed txn (expect 1): 1
```

**Recommendation:** one SQL codebase, two drivers. Develop and run the automated test suite on
PGlite (zero setup, instant, works offline and in CI); run the demo/release build on native
PostgreSQL. This is a deliberate, reversible trade-off, not a compromise of the data model —
the identical schema and the identical atomic SQL were proven on **both** engines.

### 3.3 Real defect #1 — email normalization order (would have shipped as a mobile bug)

A student typing their email with a trailing space (routine on mobile keyboards) was rejected:

```
FAIL  valid login (email case/whitespace normalized)  | status=400
```

Cause: Zod validated the raw string **before** normalization, so `"Student@DSU.edu.in "` failed
`email()` and the user got an opaque 400 despite typing valid credentials.

Fix: normalize **before** validating — `z.string().trim().toLowerCase().pipe(z.email())`.
After the fix: `PASS … status=200 role=STUDENT`.

This matters beyond UX: `normalized_email` is the uniqueness key for accounts, so normalization
must be a single deterministic server-side rule, applied in exactly one place. Enforced by a
`UNIQUE` constraint on the normalized column.

### 3.4 Real defect #2 — the duplicate-handling pattern that silently breaks transactions

**This is the most important engineering finding in the audit.**

The intuitive way to handle a duplicate is to attempt the insert and catch the unique-violation.
I tested that inside a transaction on real PostgreSQL:

```
error: current transaction is aborted, commands ignored until end of transaction block
code: '25P02'
```

In PostgreSQL, **any error aborts the entire transaction**. So the natural "try/catch, then
SELECT the existing row and link the report" implementation fails on the follow-up query — the
transaction is already poisoned. A team writing this naively will see it work in single-request
testing and fail under concurrency or in production.

**Fix (verified):** use `INSERT … ON CONFLICT DO NOTHING RETURNING`, which reports the conflict
**without raising an error**, leaving the transaction healthy so the report can be linked to the
existing master issue in the same atomic unit. Note that with a *partial* unique index the
predicate must be repeated in the `ON CONFLICT` clause:

```sql
INSERT INTO issues (public_reference, dedupe_key)
VALUES ($1, $2)
ON CONFLICT (dedupe_key) WHERE status <> 'RESOLVED' DO NOTHING
RETURNING id;
```

### 3.5 Real defect #3 — npm 10.8.2 arborist crash

`npm i -D vitest …` (an incremental dev-dependency install) crashed with an internal error:

```
TypeError: Cannot read properties of null (reading 'edgesOut')
    at #loadPeerSet (…/@npmcli/arborist/lib/arborist/build-ideal-tree.js:1286:38)
```

Not a project bug — an npm 10.8.2 bug triggered by vitest's optional peers (`happy-dom`,
`jsdom`, `canvas`). **Workaround, verified:** declare dependencies in `package.json` and run a
single `npm install`; do not chain incremental `npm i -D` calls. I will pin this workaround into
the README troubleshooting section, because it will bite the team on Windows too.

### 3.6 Concurrency hazard PROVEN (not theorised) and the fix verified

Brief acceptance criterion 17 requires safe concurrent duplicate handling. I tested both designs
with 10 genuinely parallel transactions (confirmed by distinct backend PIDs — **10 of 10 distinct**:
*true parallelism*, not event-loop serialisation), using a barrier so all 10 transactions read
**before** any of them wrote:

```
distinct backend PIDs in use: 10 of 10  -> TRUE PARALLELISM

--- MODE A: app-level check only (what a naive implementation does) ---
  phase A: all 10 txns observed existing count = [0,0,0,0,0,0,0,0,0,0] (each believes it is first)
  phase B: {"inserted":10}
  RESULT  : 10 master repair ticket(s) for ONE real-world defect -> DUPLICATE TICKETS CREATED (hazard proven)

--- MODE B: partial unique index + ON CONFLICT DO NOTHING (proposed design) ---
  phase A: all 10 txns observed existing count = [0,0,0,0,0,0,0,0,0,0] (each believes it is first)
  phase B: {"inserted":1,"linked-to-existing":9}
  RESULT  : 1 master repair ticket(s) for ONE real-world defect -> SAFE
```

**Both batches of transactions observed an empty table.** Every one believed it was first. This is
exactly the scenario the brief warns about: *"If two duplicate reports arrive simultaneously, the
backend must not create two master issues merely because both requests passed an earlier
application-level check."* An application-level check cannot prevent it. The database guard can,
and does: **10 → 1**.

Token idempotency under a retry storm was verified the same way:

```
10 retries of the SAME token award   1 credited, 9 deduped -> balance 10 (SAFE: no double-award)
failed txn reported success? / rows     false / 0 (SAFE)
```

The second line also covers acceptance criterion 16 — a failed transaction cannot emit a false
success, because the commit is the single source of truth.

---

## 4. Proposed architecture (greenfield, designed to absorb an existing codebase)

### 4.1 Why this stack

The brief asks me to justify new dependencies and avoid enterprise complexity. Justification:

| Choice | Why | Cost of not choosing it |
|---|---|---|
| **TypeScript + Node.js** | Only runtime present; brief specifies React + TypeScript for the owner; one language across backend, admin web, and mobile contracts | Two languages doubles the contract-drift risk |
| **Fastify 5** | Verified working; schema-first validation and serialization built in; fast enough with no tuning | Express requires bolting on validation and serialization separately |
| **Zod 4** | Single source of truth for validation **and** the typed contracts the three clients consume; verified to drive OpenAPI generation via `createJsonSchemaTransform` (Section 11 requirement) | Hand-written types drift from runtime validation |
| **PostgreSQL (native + PGlite)** | Phase 1 leans hard on transactional integrity: partial unique indexes, `ON CONFLICT`, `FOR UPDATE`, advisory locks, real enum types — all verified working | NoSQL/MySQL make criteria 11, 12 and 17 substantially harder |
| **Hand-written SQL migrations** | The atomic guards *are* the correctness argument; they must be explicit and reviewable, not ORM-generated abstractions | Auto-generated migrations obscure the exact constraint semantics |
| **Drizzle ORM** for typed queries | Type-safe reads/writes, while still allowing raw SQL for the verified atomic paths | Reducing value if used as the migration source of truth |
| **argon2id (`@node-rs/argon2`)** | Modern, memory-hard password hashing; **prebuilt native binaries** — vital, since compiling native modules on Windows is a classic hackathon failure | `bcrypt` is weaker; `node-gyp` builds break on Windows |
| **Opaque session tokens, hashed at rest** | Trivially revocable (verified: revocation rejected the very next request), no JWT signing-key management, no "can't log out" problem | JWTs cannot be revoked without extra infrastructure |

**Explicitly rejected:** microservices, message brokers (Redis/RabbitMQ/Kafka), GraphQL, Kubernetes.
None are needed for one campus and a 2–4 person team in 24–48 hours. The outbox pattern provides
reliable event delivery using the database that is already required.

### 4.2 Module boundaries (maps to brief Section 6)

```
apps/
  api/                  Fastify HTTP layer: routes, Zod schemas, error mapping ONLY
  admin-web/            (Phase 2/3) admin dashboard — consumes shared contracts
  mobile/               (Phase 2/3) Expo React Native — student + HOD, role-aware
packages/
  contracts/            Zod schemas + inferred types = THE shared API contract
  domain/               Business logic: state machine, tokens, dedupe, permissions.
                        No Fastify, no HTTP, no SQL driver — pure and unit-testable.
  db/                   Migrations, schema, scoped repositories
  config/               Validated env loading (fail fast on missing/malformed vars)
docs/
  PHASE1_AUDIT.md       this document
  API.md                generated OpenAPI + error taxonomy
  HANDOFF_PHASE2.md     integration contracts
```

The rule that prevents the failure mode the brief calls out — *"the mobile app and admin website
must not independently implement competing versions of issue status transitions, token
accounting, duplicate handling, or authorization"* — is dependency direction:

```
apps/api ──depends on──> packages/domain ──depends on──> packages/db
    │                          │
    └──────────> packages/contracts <──────────┘
```

**Only `packages/domain` may express business rules.** Route handlers are thin: validate → call
domain → map result to a response. Clients import types from `packages/contracts` and never
re-implement a transition. Server-side enforcement is never optional.

### 4.3 Database access and transaction discipline

- A single `withTransaction(fn)` helper is the **only** way state is mutated.
- Domain functions receive a transaction handle, so a status change + its history row + the
  outbox event commit atomically or not at all.
- The verified atomic primitives: `ON CONFLICT … DO NOTHING RETURNING` for dedupe,
  `SELECT … FOR UPDATE` / `pg_advisory_xact_lock` for claim and transition races,
  `UNIQUE` on `token_transactions.idempotency_key` for idempotent awards.
- Drivers `pg` and `@electric-sql/pglite` sit behind one narrow interface so the same domain
  code and the same tests run on both (verified in Section 3.2).

### 4.4 Authentication and authorization

Chosen because no identity provider exists to reuse:

- **Identification:** university email, normalized (`trim` + lowercase) **before** validation —
  the defect from Section 3.3, fixed at the schema level.
- **Passwords:** argon2id, prebuilt binaries (no Windows compiler needed).
- **Sessions:** 32-byte random opaque bearer token; **only its SHA-256 hash is stored**
  (verified `len=64`, raw token never persisted). High entropy means SHA-256 is sufficient —
  argon2 is unnecessary here and would add latency to every request.
- **Renewal:** short-lived access session + longer-lived refresh session, both revocable.
  Expiry and revocation are enforced in the same query that resolves the session.
- **Logout:** sets `revoked_at`; the next request is rejected (verified).
- **Throttling:** `@fastify/rate-limit` on auth routes; identical error for unknown email and
  wrong password, with hash work performed either way, to blunt user enumeration and timing leaks.
- **Escalation:** role is server-assigned; a client-supplied `role` field is **ignored** and the
  account is created as `STUDENT` (verified). Role checks never trust the client.
- **Demo credentials:** generated by a development-only seed from a git-ignored `.env`, never
  hardcoded in source.

### 4.5 Demo / real isolation

A `workspaces` table (`kind: 'REAL' | 'DEMO'`) with `workspace_id` **NOT NULL on every scoped
table**. Enforcement is layered:

1. Every query goes through a scoped repository that **requires** a workspace argument — there is
   no unscoped query helper, so isolation cannot be forgotten.
2. Optional defence-in-depth: PostgreSQL row-level security with
   `SET LOCAL app.workspace_id` inside each transaction.
3. Authorization rejects a `DEMO` session that requests real-workspace data, and vice versa.
4. Automated tests assert **cross-workspace reads return zero rows both directions** (criterion 14).

The brief is explicit that *"never rely solely on a frontend toggle"* — no client-supplied
workspace identifier is trusted; it is derived from the authenticated session. I am *proposing*
RLS as layered defence rather than asserting it: RLS interacts with connection pooling and must be
implemented and tested carefully in Stage 2/3 before I would claim it works.

---

## 5. Data model and migration plan

### 5.1 Entities (brief Section 7), with the constraints that make each rule enforceable

**workspaces** — `id`, `kind` (`REAL`/`DEMO`), `name`, timestamps.

**users** — `id`, `normalized_email` **UNIQUE NOT NULL**, `display_name`, `password_hash`,
`account_status`, timestamps. Single `role` enum (`STUDENT`/`HOD`/`ADMIN`) is sufficient for the
stated three-role model; a `user_roles` join table is the upgrade path if multi-role is later
required (open decision, Section 10).

**sessions** — `id`, `user_id` FK, `token_hash` **UNIQUE**, `expires_at`, `revoked_at`.
Enables verified revocation and logout.

**campus_blocks** — `id`, `official_name`, `slug` UNIQUE, `description`, `active`.
**campus_spots** — `id`, `block_id` FK, `official_name`, optional floor/area, optional lat/lng,
`active`. GPS is **not** required for a valid report — student-selected block + spot are
authoritative, matching the brief.

**issue_categories** — `id`, `name`, `slug` UNIQUE, `description`, `active`. Seeded with water
leakage, damaged furniture, potholes, broken lighting, damaged doors, damaged toilets, waste,
greenery maintenance — seed data only, never hardcoded in logic.

**issues** (the master repair ticket) — `id`, `public_reference` UNIQUE, `title`, `description`,
`category_id`, `severity`, `status`, `block_id`, `spot_id`, `claimed_by_user_id` (nullable),
`created_by_user_id`, `approved_at`, `started_at`, `resolved_at`, `resolution_note`, `due_at`,
`version`, `workspace_id`, timestamps.
**The dedupe guard:** `UNIQUE INDEX (dedupe_key) WHERE status <> 'RESOLVED'` — this is the single
constraint responsible for the verified 10 → 1 result, and it also allows a **new** ticket to be
raised if the same defect recurs after resolution.

**reports** (every individual student submission) — `id`, `issue_id` (nullable until triage),
`reporter_user_id`, `selected_category_id`, `ai_predicted_category_id`, `ai_confidence`,
`ai_severity`, `repair_recommendation`, `validation_status`, `duplicate_match_status`,
`block_id`, `spot_id`, `latitude`, `longitude`, `captured_at`, `submitted_at`,
`evidence_storage_key`, `workspace_id`.
Per the brief, client `captured_at` is stored as **untrusted** evidence; the server records
`submitted_at` independently and never treats the client value as proof of genuineness.

**ai_analyses** — `id`, `report_id`, `provider`, `model`, `model_version`, `status`
(`PENDING`/`SUCCEEDED`/`FAILED`/`NEEDS_HUMAN_REVIEW`), predicted category, confidence, severity,
`repair_recommendation` JSONB, `duplicate_candidates` JSONB, timestamps. Versioned so results are
reproducible and a provider swap does not rewrite history.

**issue_status_history** — `id`, `issue_id`, `previous_status` (nullable), `new_status`,
`changed_by_user_id`, `reason`, `created_at`. Written **transactionally with every transition**.

**token_transactions** — `id`, `user_id`, `report_id` (nullable), `transaction_type`
(`CREDIT`/`REVERSAL`), `amount` integer `CHECK (amount > 0)`, `idempotency_key` **UNIQUE**,
`reason`, `created_by_user_id`, `created_at`. Balance is **derived from the ledger** (verified
aggregation), never overwritten. A cached aggregate is optional later and must reconcile
transactionally.

**audit_log** — `id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before`/`after`
JSONB, `reason`, `created_at`, `workspace_id`. Secret material is never written to logs.

**event_outbox** — `id`, `event_type`, `payload` JSONB, `workspace_id`, `entity_id`,
`entity_version`, `created_at`, `published_at`. Written **in the same transaction** as the state
change; published only after commit. This makes the brief's event list
(`report.created`, `issue.status_changed`, `token.credited`, …) reliable without a broker, and
keeps demo/real payloads separated by `workspace_id`.

### 5.2 Migration plan

Numbered, hand-written, forward-only SQL in `packages/db/migrations/` with a `schema_migrations`
ledger table. Order:

1. `0001_extensions_and_workspaces` — `workspaces`, enum types.
2. `0002_users_sessions_roles` — users, sessions, role enum, `normalized_email` UNIQUE.
3. `0003_campus_blocks_spots` — blocks, spots, FKs, active flags.
4. `0004_categories` — categories + seed.
5. `0005_issues_reports` — issues (incl. the partial unique dedupe index), reports, FKs.
6. `0006_status_history_and_tokens` — status history, token ledger, idempotency UNIQUE.
7. `0007_audit_and_outbox` — audit log, outbox.
8. `0008_ai_analyses` — AI result table + contracts (table now, engine later).

Verification for Stage 2: migrations apply cleanly **on both engines**, then a structural
assertion that the tables, FKs, and the partial unique index exist. I will additionally port the
Section 3.6 race test into the permanent suite so criterion 17 is guarded by a real test forever.

---

## 6. Security and integration risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Concurrent duplicates create multiple master tickets** — *proven real, 10/10* | Critical | Partial unique index + `ON CONFLICT DO NOTHING` + retry-as-link (verified 10→1) |
| 2 | **Duplicate token awards on retry** | Critical | `UNIQUE(idempotency_key)`; server-side eligibility only (verified 1 credited / 9 deduped) |
| 3 | **Catching `23505` inside a transaction poisons it (`25P02`)** — *observed* | High | Mandate `ON CONFLICT`; document the anti-pattern; add a regression test |
| 4 | **Demo/real data leakage** | High | NOT-NULL `workspace_id` + scoped repositories + session-derived scope + bidirectional tests; RLS as optional layer |
| 5 | **Photo privacy** — brief forbids public exposure | High | Storage adapter outside static paths, unguessable generated keys, authorization enforced **on retrieval**, never trust client filenames |
| 6 | **Privilege escalation via client-supplied role** | High | Server-assigned roles (verified: `ADMIN` ignored); no self-elevation endpoint |
| 7 | **User enumeration / timing leak on login** | Medium | Identical errors; hash work performed for unknown users too |
| 8 | **Windows native-module build failures** | Medium | `@node-rs/argon2` prebuilt binaries (chosen deliberately over `node-gyp` options) |
| 9 | **npm 10.8.2 arborist crash** — *observed* | Medium | Declare deps in `package.json`, single `npm install`; documented in troubleshooting |
| 10 | **Rate limiting across multiple API instances** | Medium | In-memory now; documented as single-instance only; pluggable store later |
| 11 | **AI over-trust** — auto-resolving on low confidence | High | Phase 1 ships contract + `NEEDS_HUMAN_REVIEW` state only; no irreversible action without human review |
| 12 | **Premature real-time claims** | Medium | Outbox + event schemas only; no WebSocket/SSE transport claimed until built and tested end-to-end |
| 13 | **Client `captured_at` treated as proof** | Medium | Server records `submitted_at`; client timestamp stored as untrusted evidence |
| 14 | **`packages/` snapshots** — `node_modules`, `dist`, caches are **not** persisted | Low | Commit `package-lock.json`; document `npm install` as the first setup step |
| 15 | **Unresolved:** no repository supplied | **Blocking** | Section 10, questions 1–2 |

### 6.1 Two honest limitations of this audit

- **No application code has been written.** Every result above is from a **throwaway spike** in
  `/tmp`. Nothing in `/home/user` is a deliverable yet; there is no "working feature" to claim.
- **The spike is not the product.** It proves the stack, the constraints, and the auth model are
  sound. It does **not** prove the state machine, token policy, or workspace isolation work —
  those are Stage 3–4 and will be reported only with real test output.

---

## 7. Staged implementation plan

Aligned to brief Section 16. Each stage ends with a verification gate; a stage with unresolved
blocking failures does not advance.

| Stage | Deliverable | Verification gate |
|---|---|---|
| **1 — Audit** *(this document)* | Findings, architecture, plan, risks | **Complete** — pending the two answers in Section 10 |
| **2 — Schema & migrations** | npm-workspace monorepo, `packages/db`, 8 migrations, seeds, `withTransaction` helper, PGlite+pg drivers | Migrations apply on **both** engines; structural assertions pass; race test ported into the suite |
| **3 — Auth & roles** | argon2id, sessions, refresh, logout, rate limiting, role guards, demo seed | Re-run the 10 auth checks as permanent tests incl. escalation + revocation |
| **4 — Workflow & ledger** | State machine, status history, dedupe/link, idempotent tokens, reversals, audit log, outbox | All 17 brief criteria covered; invalid transitions and no-note resolution rejected with clear errors |
| **5 — Integration contracts** | OpenAPI from Zod, `packages/contracts`, event schemas, adapter interfaces (AI/storage/realtime), `HANDOFF_PHASE2.md` | Contract matches live behaviour; adapters stubbed with explicit `NOT_IMPLEMENTED`; no fake AI results |
| **6 — Phase 1 review** | Lint/typecheck/tests/migrations run for real; diff reviewed | Honest report of passed / failed / not-run; no Phase 2 work started |

---

## 8. First concrete implementation action

Once Section 10 is answered, Stage 2 begins with exactly this:

```
apps/api/           skeleton Fastify app: /healthz + error handler + env validation only
packages/db/
  migrations/0001_extensions_and_workspaces.sql
  migrations/0002_users_sessions_roles.sql
  src/driver.ts     one interface over pg | pglite
  src/tx.ts         withTransaction() — the only mutation path
```

…immediately followed by the migration runner and the **ported race test**, so the dedupe and
idempotency guarantees are locked in by an automated test before any workflow code depends on them.

Deliberately **not** in the first action: AI calls, camera capture, 3D twin, dashboards,
WebSockets. Foundation first, per the brief.

---

## 9. What I will NOT do (per brief Section 18)

- I will not fabricate test results, AI predictions, or deployment outcomes.
- I will not claim the AI pipeline, real-time sync, or the 3D twin works — none exist yet.
- I will not hardcode secrets or place demo credentials in source.
- I will not build a fresh scaffold over a real repository I have been unable to inspect.

---

## 10. Open decisions requiring confirmation

1. **Is there an existing repository to inspect?** If yes, upload/connect it — I will re-run Stage 1
   and adapt rather than restart. If no, I proceed greenfield as proposed.
2. **Mobile platform** — Expo React Native / Flutter / native Android? Affects the handoff contract
   and the HOD role-aware app.
3. **Database on Windows** — PGlite-configured dev (zero setup) / Docker Postgres / native
   PostgreSQL install? I recommend PGlite for dev + native Postgres for the demo.
4. **Monorepo or separate repos?** I recommend one npm-workspace monorepo so the shared contract
   package is impossible to drift.

# Runbook — setup, operations, troubleshooting

Everything needed to get a new developer (or a judge-facing demo laptop) running, plus the
failure modes this project actually hit during development.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20 or newer** | `node -v`. Node 20.12+ is needed for `process.loadEnvFile`, which the CLIs use. |
| npm | Ships with Node. |
| *(optional)* PostgreSQL 14+ | Only if you want a native server instead of PGlite. |

**Docker is not required**, and neither is any database installation for local development.

---

## 2. First-time setup (Windows PowerShell)

```powershell
npm install
Copy-Item .env.example .env
notepad .env          # set DEMO_SEED_PASSWORD, keep the quotes
npm run migrate
npm run seed
npm start
```

Open <http://localhost:3001> for the development API console.

### The one thing that will trip you up

`.env` values containing `#` **must be quoted**. `.env` parsing treats an unquoted `#` as the start
of a comment:

```dotenv
DEMO_SEED_PASSWORD=CampusDemo#2026      # WRONG -> the password becomes "CampusDemo"
DEMO_SEED_PASSWORD="CampusDemo#2026"    # RIGHT
```

The symptom is a confusing `401 INVALID_CREDENTIALS` even though you just seeded the accounts.
`npm run seed` now prints the password length and refuses to accept an implausibly short one, so
this fails loudly instead of silently.

---

## 3. Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (npm workspaces). |
| `npm run migrate` | Apply pending migrations. Idempotent — safe to re-run. |
| `npm run seed` | Create campus reference data and demo accounts. Re-running **refreshes demo passwords** and **never changes roles**. |
| `npm start` | Start the API (fail-fast config + migration on boot). |
| `npm run dev` | Same, with file watching. |
| `npm test` | Full automated suite. |
| `npm run test:watch` | Re-run tests on change. |
| `npm run typecheck` | Strict TypeScript check (no emit). |
| `node scripts/smoke-test.mjs` | 50 end-to-end checks against a **running** server. |

### Running the suite against native PostgreSQL

The suite automatically activates two extra tests — a **true parallel race** with N genuinely
concurrent database connections, and a concurrent token-idempotency test — when
`TEST_DATABASE_URL` is set.

```powershell
# one-time: create a THROWAWAY database (the test drops schema `public`)
$env:TEST_DATABASE_URL="postgres://campus:secret@127.0.0.1:5432/campus_test"
npm test
```

```
Without TEST_DATABASE_URL : 97 passed, 2 skipped   (PGlite)
With    TEST_DATABASE_URL : 99 passed, 0 skipped   (native PostgreSQL)
```

---

## 4. Choosing a database

### PGlite (default — development and testing)

Real PostgreSQL 18 compiled to WebAssembly, running inside the Node process. No install, no service,
no port. Data lives in `.data/campus`.

* ✅ Nothing to configure — ideal for a hackathon on Windows.
* ⚠️ **Single process.** Two processes cannot share one data directory.
* ⚠️ Not intended for production (`NODE_ENV=production` requires `DATABASE_URL`).

> **Always stop the API before running `npm run migrate` or `npm run seed`.** If the server is
> running, the CLIs cannot take the database lock and will hang. Stop, seed, restart.

### Native PostgreSQL (recommended for the demo)

Simplest Windows options, in order of least effort:

1. **Installer** — <https://www.postgresql.org/download/windows/>. Choose a password during
   install; add `psql` to PATH.
2. **Portable/embedded** — a self-contained PostgreSQL build, unzipped anywhere.

Then:

```powershell
# create the database and an application role
psql -U postgres -c "CREATE ROLE campus LOGIN PASSWORD 'change-me';"
psql -U postgres -c "CREATE DATABASE campus OWNER campus;"
```

`.env`:

```dotenv
DATABASE_URL="postgres://campus:change-me@localhost:5432/campus"
```

```powershell
npm run migrate
npm run seed
npm start
```

Switching engines requires no code change — the same migrations and the same SQL run on both.

---

## 5. Demo accounts

Created by `npm run seed`. Password comes from `DEMO_SEED_PASSWORD`; if unset, a random one is
generated and printed once.

| Email | Role | Workspace |
|---|---|---|
| `student@demo.dsu.edu.in` | STUDENT | DEMO |
| `student2@demo.dsu.edu.in` | STUDENT | DEMO |
| `hod@demo.dsu.edu.in` | HOD | DEMO |
| `admin@demo.dsu.edu.in` | ADMIN | DEMO |
| `admin@dsu.edu.in` | ADMIN | REAL (created only when `NODE_ENV != production`) |

Roles are assigned by the seeder, never by a client. There is no API that grants a role.

---

## 6. Resetting the demo

The demo must be repeatable in front of judges. With PGlite:

```powershell
# stop the server first (Ctrl+C)
Remove-Item -Recurse -Force .data, .storage
npm run migrate
npm run seed
npm start
```

With native PostgreSQL:

```powershell
psql -U postgres -c "DROP DATABASE campus;" -c "CREATE DATABASE campus OWNER campus;"
npm run migrate; npm run seed
```

Unlike a plain truncate, this preserves the schema, the migration ledger, and the seeded reference
data while clearing every issue, report, token transaction and audit row.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 INVALID_CREDENTIALS` right after seeding | Unquoted `#` in `.env` truncated the password | Quote the value: `DEMO_SEED_PASSWORD="a#b"`. The seed now prints a length check. |
| `npm run migrate` / `seed` hangs | The API is running and holds the PGlite data directory | Stop the server, re-run, restart. |
| `error: unable to determine transport target for "pino-pretty"` | Optional logging dependency missing | Already handled — the server falls back to JSON logs. Run `npm install` to get coloured logs. |
| `npm i -D <pkg>` fails with `Cannot read properties of null (reading 'edgesOut')` | npm 10.8.2 arborist bug with optional peer deps | Add the dependency to `package.json` and run a single `npm install`. Do not chain incremental `npm i -D` calls. |
| `Worker exited unexpectedly` during `npm test` | Out of memory — each test file boots a PostgreSQL engine | Already addressed: tests reuse one engine per file. Close other heavy apps, or run one file: `npx vitest run tests/workflow.test.ts`. |
| `429 RATE_LIMITED` while testing | Login throttling works (10 attempts/min/IP) | Wait 60 seconds. `scripts/smoke-test.mjs` waits automatically. |
| `EADDRINUSE` on port 3001 | A previous server is still running | Change `PORT` in `.env`, or stop the old process. |
| Photos missing / `404` on evidence | Evidence directory removed, or the report was created on a different machine | Evidence is stored under `EVIDENCE_DIR` (default `storage/evidence`) and is **not** in the database. Re-submit the report. |
| `DATABASE_URL is required when NODE_ENV=production` | Safety rail: PGlite is single-process | Set `DATABASE_URL`, or run with `NODE_ENV=development`. |

### Verifying a deployment is healthy

```powershell
Invoke-RestMethod http://localhost:3001/healthz | ConvertTo-Json
```

```json
{
  "status": "ok",
  "database": { "ok": true, "latencyMs": 1, "error": null },
  "version": "0.1.0-phase1",
  "engine": "pglite"
}
```

`status: "degraded"` with `database.ok: false` means the process is up but the database is not
reachable — the API will refuse to serve data rather than return empty results.

---

## 8. Operational notes for the demo

* **Two terminals**: one for `npm start`, one for commands.
* **Migrations run automatically on boot**, so a fresh clone starts cleanly.
* **Evidence photos are private.** They are never served from a static directory; every read goes
  through an authorization check. Do not copy them into a public folder for slide decks.
* **The rate limiter is per IP, in memory.** Fine for one server. Note it in any deployment with
  more than one instance.
* **`npm run seed` refreshes demo passwords but never roles**, so a promotion made during a rehearsal
  survives a re-seed.

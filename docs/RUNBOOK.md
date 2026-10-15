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

Run these once, from the repository root, in **Terminal 1**:

```powershell
node -v                         # must print v20.12 or newer
npm install                     # one install for the whole workspace (API + web + shared packages)
Copy-Item .env.example .env
notepad .env                    # set DEMO_SEED_PASSWORD="..." (keep the quotes), see below
npm run db:reset                # creates the local database, applies 8 migrations, seeds campus data + demo accounts
```

`npm install` reads the committed `package-lock.json`; the repository-level `.npmrc` sets
`legacy-peer-deps=true` for a documented npm 10.8.2 bug (see the comment in that file). Do not
delete it.

### Turning on the AI (recommended for the demo)

The default `AI_PROVIDER=unconfigured` is the honest "AI is off" state: reports are stored and
wait, nothing is faked. To run the free local CLIP model (no API key, nothing leaves the laptop):

```powershell
notepad .env                    # set AI_PROVIDER=local-clip
npm run ai:warm                 # downloads ~149 MB of weights ONCE into .cache\hf and runs one test image
```

After `ai:warm`, the model works offline. For an air-gapped demo also set
`AI_ALLOW_REMOTE_DOWNLOAD=false`, so a missing cache fails loudly instead of reaching for the network.

### Running it — two terminals

| Terminal | Command | What it is | Leave it running? |
|---|---|---|---|
| **Terminal 1 — API + worker** | `npm start` | Backend on port 3001. Applies migrations on boot and starts the **background analysis worker** in the same process. | Yes |
| **Terminal 2 — Website** | `npm run web` | Vite dev server on port 5173; proxies `/v1` to the API. | Yes |

Open **<http://localhost:5173>** and sign in with a demo account (§5). On a phone on the same
Wi-Fi, use `http://<laptop-ip>:5173` — but note that browsers only allow the **camera** on
`https://` or `localhost`, so for phone capture use a tunnel that provides HTTPS, or test the
camera flow on the laptop itself.

**The worker is not a separate command.** It starts inside `npm start` when
`AI_WORKER_ENABLED=true` (the default). The startup log tells you which of three states you are in:

| Log line at startup | Meaning |
|---|---|
| `analysis worker started` | AI on, worker polling every `AI_WORKER_INTERVAL_MS`. |
| `analysis worker is enabled but AI_PROVIDER=unconfigured …` | Worker idles; reports stay PENDING and are analysed once AI is switched on. No attempts are spent. |
| `AI_WORKER_ENABLED=false — reports will NOT be analysed automatically` | Only an operator's manual `POST /v1/reports/:id/analyze` analyses anything. |

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

All from the repository root.

| Command | What it does |
|---|---|
| `npm install` | Install all dependencies (npm workspaces). |
| `npm start` | API **and** background analysis worker (fail-fast config, migrations on boot). |
| `npm run dev` | Same, restarting on file changes. |
| `npm run web` | Website dev server (port 5173). |
| `npm run web:build` | Type-check and production-build the website into `apps/web/dist`. |
| `npm run migrate` | Apply pending migrations. Idempotent. Server must be stopped (PGlite). |
| `npm run seed` | Campus reference data + demo accounts. Refreshes demo passwords, never changes roles. |
| `npm run db:reset:dry` | Show what a rebuild would discard. Changes nothing. |
| `npm run db:reset` | Rebuild the **local** database from scratch, migrate and seed (§6). |
| `npm run ai:warm` | Download and test-run the local CLIP model. |
| `npm test` | Full automated suite (in-memory databases; does not touch `.data`). |
| `npm run typecheck` / `npm run typecheck:web` | Strict TypeScript check of backend / website. |
| `npm run smoke:api` | 53 end-to-end HTTP checks against a **running** API (Terminal 1 up). |
| `npm run worker:verify` | Submits a real photo and proves the worker analyses it, credits nothing, and that human validation credits exactly 10, once. Needs AI on. |
| `npm run smoke:web` | Real-browser walk of every route as every role (needs both terminals up and `npx playwright install chromium` once). |
| `npm run e2e` | **The whole journey through the real UI**: student camera capture → submit → worker analysis → HOD validate/approve/start/resolve with a note → student sees Resolved and +10 on this report → admin sees the same issue and twin. Uses Chromium's synthetic camera. Both terminals up; adds real rows to the DEMO workspace. |
| `npm run screens` | Viewport screenshots (desktop twin, phone report detail) into `.artifacts/screens/`. |

There is no linter configured in this repository; strict TypeScript (`npm run typecheck`,
`npm run typecheck:web`) is the static check.

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

The demo must be repeatable in front of judges. **Stop Terminal 1 first** (Ctrl+C), then:

```powershell
npm run db:reset:dry            # optional: see what would be discarded
npm run db:reset                # rebuild .data\campus, migrate, seed
npm start
```

`db:reset` refuses to run when `NODE_ENV=production`, when `DATABASE_URL` points anywhere other
than this machine, when the configured directory is not recognisably a PGlite cluster, or while the
API is still running (on Windows a running server holds the files and the delete would fail
half-way). It prints the REAL/DEMO row counts afterwards so you can see the real workspace is empty.

It does **not** delete `storage\evidence` (student photographs). After a reset those files are no
longer referenced by any report. To clear them too, for an isolated demo laptop only:

```powershell
Remove-Item -Recurse -Force storage\evidence
```

With native PostgreSQL, `npm run db:reset` does **not** drop anything — it only migrates and
seeds the existing database (and refuses outright unless `DATABASE_URL` is a loopback address).
To start from empty, recreate the database yourself first:

```powershell
psql -U postgres -c "DROP DATABASE campus;" -c "CREATE DATABASE campus OWNER campus;"
npm run migrate; npm run seed
```

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
| `The PGlite data directory at ".data/campus" could not be opened` | The directory was copied, synced or snapshotted while the server was running, or the process was killed mid-write | Stop the server and run `npm run db:reset` (or `npm run db:reset -- --keep` to keep the old copy as `.data\campus.unreadable`). Do not put `.data` inside OneDrive/Dropbox. |
| Reports stay **PENDING** for ever, review queue empty | `AI_PROVIDER=unconfigured` (honest default) or `AI_WORKER_ENABLED=false` | Read the startup log line (§2). Set `AI_PROVIDER=local-clip`, run `npm run ai:warm`, restart Terminal 1. |
| A report shows AI status `FAILED` | Recorded per attempt with a reason, e.g. `AI_INVALID_EVIDENCE: … 1x1px` | Permanent failures (unusable photo) are attempted once; transient ones up to `AI_MAX_ATTEMPTS`. The report stays PENDING for a human; an HOD/admin can retry via `POST /v1/reports/:id/analyze`. |
| `db:reset` says `REFUSED: the API is running` | Safety guard | Ctrl+C in Terminal 1, then re-run. |
| Website shows "Network error" on every page | Terminal 1 (API) is not running; the website proxies `/v1` to port 3001 | Start `npm start`. |
| Camera button says the camera is unavailable | Browser blocks cameras on plain `http://` except `localhost`, or permission was denied | Use `http://localhost:5173` on the laptop, or an HTTPS tunnel for phones. Submission is deliberately blocked without a fresh photo. |
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

* **Two terminals**: Terminal 1 `npm start` (API + worker), Terminal 2 `npm run web` (website). Run one-off commands in a third.
* **Migrations run automatically on boot**, so a fresh clone starts cleanly.
* **Evidence photos are private.** They are never served from a static directory; every read goes
  through an authorization check. Do not copy them into a public folder for slide decks.
* **The rate limiter is per IP, in memory.** Fine for one server. Note it in any deployment with
  more than one instance.
* **`npm run seed` refreshes demo passwords but never roles**, so a promotion made during a rehearsal
  survives a re-seed.

# API reference — v1

Base URL: `http://localhost:3001` (development). All payloads are JSON unless noted. All routes are
prefixed `/v1` except `/healthz` and the development console at `/`.

**The shared contract lives in `packages/contracts`.** Import schemas and types from there rather
than re-declaring them in the app or the website — that is what keeps the two clients in step.

```ts
import { IssueStatusSchema, type Issue, TOKEN_POLICY } from '@campus/contracts';
```

---

## Authentication

Bearer tokens. `Authorization: Bearer <accessToken>`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/login` | public (rate-limited) | Sign in, returns an access token |
| `POST` | `/v1/auth/logout` | any session | Revoke the current session immediately |
| `GET` | `/v1/auth/me` | any session | Current user, role and workspace |
| `POST` | `/v1/auth/register` | **development only** | Create a STUDENT account (role is server-assigned) |

```bash
curl -X POST http://localhost:3001/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"student@demo.dsu.edu.in","password":"YOUR_DEMO_PASSWORD"}'
```

```json
{
  "accessToken": "…",
  "expiresAt": "2026-10-15T23:10:00.000Z",
  "user": { "id": "…", "email": "student@demo.dsu.edu.in", "displayName": "Demo Student",
            "role": "STUDENT", "accountStatus": "ACTIVE", "workspace": "DEMO" }
}
```

Notes:
* Email is **trimmed and lowercased before validation**, so `" Student@DSU.edu.in "` works.
* `role` sent by a client is **ignored**.
* Unknown account, wrong password, and suspended account all return the identical
  `401 INVALID_CREDENTIALS` — the API does not reveal which university emails exist.
* Store the token in memory or secure storage. Logout revokes it server-side; the very next request
  with that token fails.

---

## Campus reference data

All results are scoped to the caller's session workspace.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/campus/blocks` | any session | Active campus blocks |
| `GET` | `/v1/campus/blocks/:blockId/spots` | any session | Named spots inside a block |
| `GET` | `/v1/campus/categories` | any session | Issue categories (configurable) |

---

## Reports (student submissions)

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/v1/reports` | STUDENT / HOD / ADMIN | Submit a report **with its photograph** |
| `GET` | `/v1/reports/mine` | any session | The caller's own reports |
| `GET` | `/v1/reports/:id` | owner, or HOD/ADMIN | One report (students see only their own) |
| `GET` | `/v1/reports/:id/evidence` | owner, or HOD/ADMIN | The private photograph, authorization enforced |
| `POST` | `/v1/reports/:id/validation` | **HOD/ADMIN** | Record the trusted validation outcome (awards tokens) |
| `POST` | `/v1/reports/:id/analyze` | HOD/ADMIN | AI analysis — **returns 501 in Phase 1** |

### `POST /v1/reports` — `multipart/form-data`

| Field | Required | Notes |
|---|---|---|
| `photo` | **yes** | JPEG / PNG / WebP. Verified by magic bytes, not the filename or declared type. |
| `blockId`, `spotId` | **yes** | Must exist **in the caller's workspace** and belong together. |
| `selectedCategoryId` | **yes** | Must be an active category. |
| `title` | **yes** | 5–160 characters. |
| `description` | no | Up to 2000 characters. |
| `capturedAt` | no | ISO timestamp. **Untrusted** — stored as evidence, never as proof. |
| `latitude`, `longitude` | no | Optional. GPS is never required for a valid report. |
| `reportingContext` | no | JSON string for device/accuracy metadata. |

```bash
curl -X POST http://localhost:3001/v1/reports \
  -H "authorization: Bearer $TOKEN" \
  -F blockId=$BLOCK -F spotId=$SPOT -F selectedCategoryId=$CAT \
  -F "title=Water leaking from ceiling" \
  -F "photo=@leak.png;type=image/png"
```

```json
{
  "reportId": "…",
  "issueId": "…",
  "issuePublicReference": "DSU-2026-00001",
  "duplicateOfExistingIssue": false,
  "duplicateMatchStatus": "NOT_CHECKED",
  "tokensAwarded": 0,
  "tokenPolicy": { "tokensPerValidatedReport": 10 },
  "validationStatus": "PENDING"
}
```

Behaviour worth knowing:
* **A duplicate does not create a second repair ticket.** The response carries
  `duplicateOfExistingIssue: true` and the *existing* `issueId`. The duplicate report still earns
  its own 10 tokens once validated.
* **Tokens are never awarded at submission time.** `tokensAwarded` is always `0` here
  (`PENDING` validation). See the rewards section below.
* Photographs are stored outside any public directory under a server-generated key; the client's
  filename is discarded.

### `POST /v1/reports/:id/validation` — the trusted seam

Called by staff today, and by the Phase 2 AI worker in-process. This is the **only** way a report
becomes token-eligible.

```json
{
  "validationStatus": "AI_VALIDATED",
  "duplicateMatchStatus": "NO_MATCH",
  "aiConfidence": 0.92,
  "aiSeverity": "MEDIUM",
  "repairRecommendation": "Replace the corroded pipe joint."
}
```

`validationStatus` ∈ `AI_VALIDATED | HUMAN_VALIDATED | DUPLICATE_VALIDATED | REJECTED`.
Everything except `REJECTED` earns `TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT` (10).

Response: `{ reportId, tokenEligible, tokensAwarded, alreadyAwarded, idempotencyKey }`.
**Idempotent** — repeating the same call returns `tokensAwarded: 0, alreadyAwarded: true`.

---

## Issues (the master repair ticket)

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/issues` | **HOD/ADMIN** | Paginated, filterable queue |
| `GET` | `/v1/issues/:id` | HOD/ADMIN, or a student who reported it | Detail + status history. Accepts a UUID **or** a public reference (`DSU-2026-00001`). |
| `POST` | `/v1/issues/:id/claim` | **HOD/ADMIN** | Claim the issue (409 if already claimed by someone else) |
| `POST` | `/v1/issues/:id/approve` | **HOD/ADMIN** | `SUBMITTED → APPROVED` |
| `POST` | `/v1/issues/:id/start` | **HOD/ADMIN** | `APPROVED → IN_PROGRESS` |
| `POST` | `/v1/issues/:id/resolve` | **HOD/ADMIN** | `IN_PROGRESS → RESOLVED`, **completion note required** |

**There is no generic status-update endpoint.** Each legal change has its own route, so the reachable
state set is exactly the state machine's transition table. `PATCH /v1/issues/:id` does not exist.

Query filters for `GET /v1/issues`:
`status`, `blockId`, `categoryId`, `claimedByUserId`, `overdueOnly`, `limit` (≤100), `offset`.

```bash
# resolve — note is mandatory, minimum 10 characters
curl -X POST .../v1/issues/$ID/resolve -H "authorization: Bearer $HOD" \
  -H 'content-type: application/json' \
  -d '{"resolutionNote":"Replaced the corroded pipe joint and sealed the ceiling."}'
```

Error responses you should handle:

| Status | Code | Meaning |
|---|---|---|
| `403` | `FORBIDDEN` | Role not permitted (e.g. a student approving) |
| `409` | `INVALID_STATE_TRANSITION` | Illegal move (e.g. `SUBMITTED → IN_PROGRESS`). The message names the allowed next states. |
| `409` | `ALREADY_CLAIMED` | Another HOD owns it |
| `400` | `VALIDATION_FAILED` | Missing/blank completion note, bad input |
| `404` | `NOT_FOUND` | Not in your workspace |

---

## Tokens (rewards)

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/tokens/balance` | any session | Balance, derived from the ledger |
| `GET` | `/v1/tokens/transactions` | any session | The caller's ledger history |
| `POST` | `/v1/tokens/reverse` | **HOD/ADMIN** | Reverse an award — **reason required**, audited |

Policy, enforced server-side:

* **10 tokens** per validated report, including a valid duplicate merged into an existing ticket.
* Eligibility is decided by the report's **validation status**, which only trusted server code can
  set. A client cannot request tokens, and submission never awards them.
* `UNIQUE(idempotency_key)` on the ledger makes a retry **physically incapable** of double-awarding.
  The key is deterministic: `report:<reportId>:validated-credit`.
* Reversals require an authorized actor **and** a non-empty reason (also enforced by a database
  `CHECK` constraint, so no code path can write an unattributed reversal).
* Balances are always summed from the immutable ledger — there is no mutable counter to corrupt.

Constants (from `@campus/contracts`): `TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT = 10`,
`TOKEN_POLICY.DEFAULT_OVERDUE_HOURS = 72`.

---

## Administration

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/admin/users` | ADMIN | List accounts in your workspace (`?role=` optional) |
| `PATCH` | `/v1/admin/users/:id/role` | ADMIN | Change a role (audited). **Cannot change your own.** |
| `PATCH` | `/v1/admin/users/:id/status` | ADMIN | Suspend / reactivate an account |
| `POST` | `/v1/admin/blocks` · `PATCH /v1/admin/blocks/:id` | ADMIN | Manage campus blocks |
| `POST` | `/v1/admin/spots` | ADMIN | Manage named spots |
| `POST` | `/v1/admin/categories` | ADMIN | Manage issue categories |
| `GET` | `/v1/admin/audit` | ADMIN | Sensitive-action history |
| `GET` | `/v1/admin/outbox` | ADMIN | Undelivered events (operational visibility) |

### Dashboard data (ready for the Phase 3 website)

`GET /v1/admin/dashboard/summary` — HOD/ADMIN, scoped to the caller's workspace:

```json
{
  "scope": { "workspace": "DEMO", "generatedAt": "2026-10-15T19:00:00.000Z" },
  "counts": { "submitted": 3, "approved": 1, "inProgress": 2, "resolved": 4, "total": 10 },
  "overdue": 1,
  "averageResolutionHours": 26.5,
  "byBlock":    [{ "blockId": "…", "blockName": "…", "count": 4 }],
  "byCategory": [{ "categoryId": "…", "categoryName": "…", "count": 6 }]
}
```

`overdue` derives from each issue's stored `dueAt`, computed from the **configurable**
`app_settings.overdue_hours` (default 72) — no threshold is hardcoded in any client.

---

## Integration boundaries

| Method | Path | Status |
|---|---|---|
| `GET` | `/v1/events/types` | ✅ Declares the 9 event types, the delivery mode, and the human-review threshold |
| `GET` | `/v1/events/stream` | ⛔ **501 NOT_IMPLEMENTED** — the live transport is Phase 2 |
| `POST` | `/v1/reports/:id/analyze` | ⛔ **501 NOT_IMPLEMENTED** — the AI engine is Phase 2 |

These endpoints deliberately **do not fabricate** results. A stubbed AI response could trigger
unearned token awards and poison the ledger with fiction; a fake event stream would let a client
believe it was synchronized when it was not.

What *is* in place: every state change writes an event to `event_outbox` **inside the same
transaction**, so a committed change can never lack its event and a rolled-back change can never
emit one. Phase 2 attaches a transport to `drainOutbox`.

---

## Errors

Every error uses one envelope:

```json
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Cannot move an issue from SUBMITTED to RESOLVED. Allowed next state(s) from SUBMITTED: APPROVED.",
    "details": [{ "path": "resolutionNote", "message": "A completion note is required (min 10 characters)" }],
    "requestId": "0f9f1c2e-…"
  }
}
```

`details` appears for `VALIDATION_FAILED` so a client can highlight the offending fields.
`requestId` correlates the response with the server log line — quote it in a bug report.

All codes: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_SESSION`,
`SESSION_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_STATE_TRANSITION`, `ALREADY_CLAIMED`,
`RESOLUTION_NOTE_REQUIRED`, `DUPLICATE_REQUEST`, `WORKSPACE_VIOLATION`, `PAYLOAD_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED`, `NOT_IMPLEMENTED`, `INTERNAL_ERROR`.

Stack traces, SQL errors, constraint names and internal paths are **never** returned to clients.
Internal faults are logged in full server-side and surfaced as `INTERNAL_ERROR` with the request id.

---

## Health

`GET /healthz` — no authentication (used by load balancers and the demo check).

```json
{ "status": "ok", "database": { "ok": true, "latencyMs": 1, "error": null },
  "version": "0.1.0-phase1", "uptimeSeconds": 42, "engine": "pglite" }
```

Returns `200` with `status: "degraded"` when the database is unreachable, so an orchestrator can
distinguish "process alive" from "actually serving data".

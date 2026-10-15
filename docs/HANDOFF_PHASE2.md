# Phase 2 handoff — integration contract

This is the agreement between the Phase 1 foundation and everything built on top of it: the student
app, the HOD workflow, the admin website, the AI service, the live-update transport, and the 3D
campus digital twin.

**Read this before writing a client.** It exists so that connecting the app and the website later is
a planned step, not a rewrite.

---

## 1. The five guarantees your client can rely on

1. **One authoritative record.** Every interface reads and writes the same tables through the same
   API. There is no per-client copy of an issue, a status, or a balance.
2. **Server-decided business rules.** Status transitions, token eligibility, duplicate handling and
   authorization are enforced on the server. A client may *hide* a button; it may not *be* the rule.
3. **Idempotent money-like operations.** Retrying a token award can never double-credit. Retrying a
   report submission that lands as a duplicate will never create a second repair ticket.
4. **Consistent shapes.** `packages/contracts` is the single source of truth for payload types. Both
   clients import it.
5. **Honest status codes.** Unimplemented features return `501`, never empty or fabricated data.

---

## 2. Client integration

### One import, both clients

```ts
import {
  type Issue, type Report, type CampusBlock, type CampusSpot, type IssueCategory,
  IssueStatusSchema, TOKEN_POLICY, ApiErrorSchema, tokenCreditIdempotencyKey,
  EVENT_TYPES, EventEnvelopeSchema,
} from '@campus/contracts';
```

Never redeclare these shapes locally. If a field must change, change it in
`packages/contracts/src/index.ts` and both clients get a compile error until they catch up — which is
the point.

### Suggested structure

```
apps/mobile/        Expo / React Native or a mobile-first web app
  src/api/client.ts       one thin fetch wrapper: injects the bearer token, parses the error envelope
  src/state/              session + issue cache
apps/admin-web/     React + TypeScript dashboard
  src/api/client.ts       the SAME wrapper shape
packages/contracts/ SHARED — imported by both
```

**Put the `apiClient` and the error-envelope parsing in ONE place per app, and keep it mechanical.**
No business logic in a component. If a component needs to know whether an action is allowed, ask the
server (send the request and handle `403` / `409`), or read the derived fields the API already sends.

### Rendering the lifecycle

The server sends everything the UI needs to render buttons correctly:

* `issue.status` — the current state.
* `issue.version` — optimistic-concurrency guard for claims.
* `issue.overdue` — computed server-side from `dueAt` (never recompute a threshold in the client —
  it is configurable via `app_settings.overdue_hours`).
* `issue.reportCount` — how many reports are attached to this master issue.
* `issue.claimedByDisplayName` — who owns it.

**Important:** the API does not send an "allowed actions" list, deliberately — that would put
authorization in the client's hands. Mirror the transition table for *affordances* only (hide
"Resolve" when status isn't `IN_PROGRESS`), and always handle the authoritative `409`/`403`.

```ts
// Client-side affordance only. The server is the enforcement point.
const canResolve = issue.status === 'IN_PROGRESS';
```

### The student reporting flow

1. `GET /v1/campus/blocks` → pick a block.
2. `GET /v1/campus/blocks/:blockId/spots` → pick a named spot.
3. `GET /v1/campus/categories` → pick a category.
4. Capture a **fresh photograph in-app**. Gallery selection is intentionally not part of this flow:
   the report is evidence of a real, current condition. (The server cannot verify freshness; the
   client must own this, and `capturedAt` is stored as *untrusted* metadata.)
5. `POST /v1/reports` as `multipart/form-data` with the photo.
6. Show the returned `issuePublicReference` and `duplicateOfExistingIssue`.

Do **not** show "you earned 10 tokens" here — `tokensAwarded` is always `0` at submission. Tokens
arrive only after validation. Poll `GET /v1/reports/mine` (or subscribe once Phase 2 lands) to
discover the award.

### The HOD flow

`GET /v1/issues?status=SUBMITTED` → `claim` → `approve` → `start` → `resolve` (note required).
Handle `409 ALREADY_CLAIMED` by refreshing the row — another HOD got there first.

---

## 3. AI service contract (Phase 2)

The boundary already exists: `packages/domain/src/adapters/ai.ts`.

```ts
interface AiAnalyzer {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  analyze(request: AiAnalysisRequest): Promise<AiAnalysisResult>;
}
```

`AiAnalysisRequest` carries `reportId`, an opaque `evidenceRef` (never a public URL), mime type, the
student's selected category, the block/spot, optional coordinates, and `submittedAt`.

`AiAnalysisResult` carries provider/model/version, status (`PENDING | SUCCEEDED | FAILED |
NEEDS_HUMAN_REVIEW`), predicted category, whether it matches the student's choice, confidence,
severity, repair recommendation, duplicate candidates, and `requiresHumanReview`.

### Rules the Phase 2 implementation must honour

1. **Keep `createAiAnalyzer()`'s signature.** Swap the implementation; do not change the call sites.
   `recordValidationOutcome()` is the single entry point that awards tokens.
2. **Persist a versioned result in `ai_analyses`** (provider + model + modelVersion). Never overwrite
   history — a model upgrade must not rewrite an old decision.
3. **Fail loudly.** On provider error, write a `FAILED` analysis. Never substitute a guessed category
   or a default confidence.
4. **Call `recordValidationOutcome()`** with `AI_VALIDATED` only for confident results. Tokens are
   awarded there, idempotently.
5. **Route uncertainty to a human.** `requiresHumanReview({ confidence, categoryMatchesStudentSelection,
   duplicateCandidateCount })` is already implemented: below the threshold
   (`AI_REVIEW_CONFIDENCE_THRESHOLD = 0.7`), on a category disagreement, or when **any** duplicate
   candidate exists, a human must decide. Never auto-merge a suggested duplicate, and never auto-approve
   an issue from a low-confidence prediction.
6. **Credential handling.** Provider keys stay server-side, in `.env`, never in a client and never in
   the repository.
7. **Retries.** The analysis path must be re-runnable; `ai_analyses` rows are additive and token
   awards are idempotent, so a retry is safe.

Suggested target shape for the free/pretrained path: a local image classifier (e.g. a pretrained
CNN/CLIP-style model, or a free-tier vision API) behind the adapter, with the upstream service
injectable so the demo does not depend on network availability.

---

## 4. Real-time synchronisation (Phase 2)

**Not implemented. Nothing claims otherwise.** `/v1/events/stream` returns `501`.

What is already in place — the part that cannot be bolted on later:

* `event_outbox` receives an event **inside the same transaction** as the state change it describes.
  A committed change cannot lack its event; a rolled-back change cannot emit one.
* Every envelope carries `eventId`, `eventType`, `occurredAt`, `workspace`, `entityType`, `entityId`,
  `entityVersion`, `actorUserId` and `payload` (`EventEnvelopeSchema` in `packages/contracts`).
* The nine event types are declared: `report.created`, `report.validated`, `issue.created`,
  `issue.duplicate_linked`, `issue.status_changed`, `issue.claimed`, `issue.resolved`,
  `token.credited`, `token.reversed`.

To implement delivery:

1. Add a transport (WebSocket or SSE), authenticated with the **same bearer token**.
2. Subscribers are confined to their session's workspace. `eventBelongsToWorkspace()` already states
   the rule; enforce it on the server for every subscriber. **An event must never cross the
   demo/real boundary.**
3. Drain via `drainOutbox(tx, workspaceId, limit)` — either a poller or a
   `LISTEN/NOTIFY` trigger on `event_outbox` inserts (preferred: lower latency, no polling load).
4. Publish **only after commit**. A rollback must never deliver an event.
5. Clients should treat events as *invalidation hints*, not as state. On receiving
   `issue.status_changed`, re-fetch or apply the payload, and use `entityVersion` to drop out-of-order
   frames. REST remains the authoritative read path.
6. Until this ships, poll. A polling client is honest; a client with a fake `setInterval` that fakes
   status changes is not.

---

## 5. 3D campus digital twin (Phase 2/3)

The data model already supports it:

* `campus_blocks.latitude / longitude` — advisory anchoring (currently placeholder coordinates).
* `campus_spots.latitude / longitude` — per-spot positions; **optional**, so the selector works
  without GPS.
* `GET /v1/admin/dashboard/summary` → `byBlock` counts for colouring blocks.
* `GET /v1/issues?blockId=…` → markers, with `status` and `severity` for colour and `overdue` for
  emphasis.
* `GET /v1/issues/:id` → the detail panel, including status history.

The twin must read from these endpoints, not from a private copy of the data. When the twin writes
(if it ever does), it goes through the same lifecycle endpoints.

---

## 6. Changing things safely

| If you want to… | Do this |
|---|---|
| Add a workflow state (e.g. `REJECTED`, `REOPENED`) | Extend `TRANSITIONS` in `packages/domain/src/state-machine.ts`, add the enum value in `packages/contracts`, add a migration for any new `CHECK` constraint, and **update the tests**. Never add a generic status setter. |
| Change the reward amount | Change `app_settings.tokens_per_validated_report` — not code. |
| Change the overdue threshold | Change `app_settings.overdue_hours`. Nothing hardcodes 72 in application logic. |
| Change duplicate sensitivity | Change `app_settings.dedupe_granularity` to `block_category`. See the trade-off note in `packages/domain/src/dedupe.ts`. |
| Add a category or campus block | Use the admin endpoints (or edit the seed). Ids are the keys; names are data. |
| Add a field to a response | Add it to `packages/contracts` first, then the route. Both clients get a type error until they handle it. |
| Add a maintenance role | Add it to the role enum, add explicit permissions, and update `assertCanClaim` / transition role lists. Do not reuse `HOD` as a stand-in. |

---

## 7. Open decisions carried into Phase 2

1. **Official campus data.** Block/spot names in `packages/db/src/seed-data.ts` are **placeholders**,
   clearly labelled. Replace them with the real list (admin API or seed edit) before the demo.
2. **Mobile platform.** Choose Expo / mobile-first web / other. The API contract is platform-neutral;
   only the client scaffolding differs.
3. **Dedupe granularity.** Default `spot_category` merges two distinct defects of the same category
   at the same named spot into one ticket. Conservative and deliberate — see the trade-off note in
   `packages/domain/src/dedupe.ts`.
4. **Row-level security.** Workspace isolation is currently enforced by session-derived scoping in
   the repository layer plus tests. PostgreSQL RLS would be useful defence-in-depth and must be
   implemented and tested carefully (it interacts with connection pooling) — not claimed until it is.
5. **Object storage.** `LocalEvidenceStorage` is deliberately replaceable: implement `EvidenceStorage`
   against S3-compatible storage. Callers only ever see an opaque key.
6. **Orphan evidence files.** If a report transaction fails after the photo is written, the file is
   unreferenced. Harmless (unreadable without authorization) but worth a sweeper job.

---

## 8. Phase 2 definition of done (suggested)

* Student app: sign in, capture, select location + category, submit, see my reports and balance.
* HOD workflow: queue, claim, approve, start, resolve with a note, see history.
* Admin website: counts, block/category charts, overdue list, average resolution time, issue table.
* AI pipeline: real classification behind the adapter, versioned results, uncertainty to human review.
* Live updates: one real transport, workspace-scoped, tested end-to-end — **and only then** claim
  real-time synchronisation.
* Digital twin: clickable blocks and markers driven by the same endpoints.

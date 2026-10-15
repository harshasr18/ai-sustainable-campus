# Phase 3 — Stage 1: Repository Audit

**Status:** audit complete, no file modified.
**Method:** every claim below comes from reading the repository or running it. Where the
answer is "no", that means I searched and found nothing.

---

## 0. Two blockers found before the audit could be acted on

### Blocker 1 — the Phase 3 brief is truncated at §15

The prompt you pasted ends mid-sentence:

> `## 15. ADMINISTRATION PAGES` — *"Implement the"* … [end of message]

Sections §15 onward are missing. Everything up to §14 is unambiguous and I can work from
it. But §15 ("Administration pages") is one of the larger deliverables, and any later
sections — acceptance criteria, definition of done, required final report, testing
requirements — are unknown. **I will not invent your acceptance criteria.** Tell me
whether to proceed on §1–§14 and my best judgement for §15+, or whether you can paste the
rest.

### Blocker 2 — Phase 2 is incomplete, and Phase 3 assumes it is not

Phase 3 §1 says: *"Do not assume the previous phases are complete just because they were
planned. Verify the actual code."* I did. Here is the honest state:

| Phase 2 stage | State | Consequence for Phase 3 |
|---|---|---|
| 4 — Report analysis pipeline | ❌ **not built** | No background worker exists. Analysis only runs when an operator calls `POST /v1/reports/:id/analyze`. Reports are never analysed automatically after submission. |
| 5 — Duplicate detection (AI) | ❌ **not built** | `duplicateCandidates` is always `[]`. |
| 6 — Severity & repair | ❌ **not built** | `severity` and `repairRecommendation` are always `null`. |

This matters because Phase 3 §11 explicitly instructs the HOD page to display:

> *"AI severity recommendation. AI repair recommendation. Duplicate candidates and their
> review state."*

**All three of those are currently always empty.** I can build the UI to render them
faithfully — showing an honest "not yet produced" state — but I cannot make them show
data that the backend does not generate. Building a dashboard that displays invented
severity or fabricated duplicate candidates is exactly what §3 of your own brief forbids
("Fake AI outputs"), and I will not do it.

So there is a sequencing decision, and it is yours, not mine. See §5.

---

## 1. Is there an existing frontend? No — none at all

```
apps/
└── api/            <- the only application in the repo
```

| Looked for | Found |
|---|---|
| React / React DOM | **none** |
| Vite / Next / any bundler for a UI | **none** (`vite` appears only as a transitive dependency of Vitest) |
| Three.js / React Three Fiber / any 3D library | **none** |
| Chart library (Recharts, Chart.js, …) | **none** |
| Tailwind / MUI / any component library or design system | **none** |
| Any `.tsx` / `.jsx` / `.css` file outside the dev console | **none** |
| Routing (react-router, tanstack-router) | **none** |

The repository is **15 dependencies total, all backend**. The only HTML in the project is
the development-only operator console at `apps/api/src/routes/console.ts`, which is
server-rendered into an inline template string and registered only when
`NODE_ENV !== 'production'`. It is not a UI framework and nothing depends on it.

**Therefore Phase 3 is a from-scratch frontend build inside the existing monorepo.** That
is legitimate and expected — §1 says preserve the architecture, and adding `apps/web`
preserves it exactly — but there is no existing styling system, routing or component
convention to "reuse", which changes §3's instruction from *"reuse the existing styling
framework"* to *"establish a small, consistent design system instead of adding multiple UI
libraries"* (the alternative your brief explicitly provides for).

---

## 2. Campus assets and 3D data (§13.1) — none exist

Searched the whole repository for `.glb .gltf .obj .fbx .dae .geojson .kml .dwg .ifc`,
any file matching `*map*`, and any campus imagery:

| Asset type | Found |
|---|---|
| 3D geometry (GLB/GLTF/OBJ/FBX/CAD/BIM) | **none** |
| Campus map (raster, SVG, or vector) | **none** |
| Geospatial files (GeoJSON/KML) | **none** |
| Campus photographs | **none** |
| Building coordinates | **placeholder only** — see below |

The only location data in the project is in `packages/db/src/seed-data.ts`, where each of
the 8 blocks has a `latitude`/`longitude` derived by adding small offsets to a single
constant:

```ts
const CAMPUS_CENTER = { latitude: 12.8612, longitude: 77.5525 };
// ...block latitude: CAMPUS_CENTER.latitude + 0.0009, longitude: + 0.0004
```

Those are **advisory offsets around the real DSU campus area, not surveyed building
positions**, and the file says so in its own header. Block names are likewise suffixed
`(placeholder)`.

**Conclusion:** §13.1's fallback applies. Per your brief, the twin will be a **clearly
labelled schematic model** built from real block records, not a survey-accurate or
official architectural model, and it will not claim otherwise. To make the schematic
*meaningful* rather than decorative, I will lay buildings out from the seed coordinates
scaled into a scene — so when official geometry does arrive, swapping it in is a
data change, not a rewrite. §14's requirement that "the rest of the application must
continue working even if the 3D asset set is incomplete" is satisfied by design.

**The alternative:** if you can obtain an actual campus map (even a raster image of the
campus layout board) or a GeoJSON of building footprints, the twin becomes genuinely
recognisable instead of schematic. That is your highest-value input for §13, and it is the
same ask as `docs/INPUTS_NEEDED.md` §2a.

---

## 3. What the backend already provides — and it is a lot

Verified by reading every route file. **This is the good news: the API surface is
substantially ready for the frontend.**

| Frontend need | Endpoint | Auth |
|---|---|---|
| Login / logout / current user | `POST /v1/auth/login`, `/logout`, `GET /v1/auth/me` | — / any |
| Campus blocks | `GET /v1/campus/blocks` | any |
| Spots within a block | `GET /v1/campus/blocks/:blockId/spots` | any |
| Categories (configurable data) | `GET /v1/campus/categories` | any |
| Submit report (multipart photo + fields) | `POST /v1/reports` | STUDENT/HOD/ADMIN |
| My reports | `GET /v1/reports/mine` | any |
| Report detail | `GET /v1/reports/:id` | owner or HOD/ADMIN |
| **Private photo, authorization-gated** | `GET /v1/reports/:id/evidence` | owner or HOD/ADMIN |
| Issue list, paginated | `GET /v1/issues?status&blockId&categoryId&claimedByUserId&overdueOnly&limit&offset` | HOD/ADMIN |
| Issue detail + **status history** | `GET /v1/issues/:id` (accepts UUID *or* public reference) | any, ownership-checked for students |
| Claim / approve / start / resolve | `POST /v1/issues/:id/{claim,approve,start,resolve}` | HOD/ADMIN |
| Token balance | `GET /v1/tokens/balance` | any |
| Token ledger | `GET /v1/tokens/transactions` | any |
| Reversal (auditable) | `POST /v1/tokens/reverse` | ADMIN |
| Dashboard aggregates | `GET /v1/admin/dashboard/summary` | HOD/ADMIN |
| Audit log | `GET /v1/admin/audit` | ADMIN |
| Outbox visibility | `GET /v1/admin/outbox` | ADMIN |
| AI: run analysis / read result | `POST /v1/reports/:id/analyze`, `GET /v1/reports/:id/analysis` | HOD/ADMIN / owner |
| AI: review queue | `GET /v1/admin/review-queue` | HOD/ADMIN |
| AI: provider status | `GET /v1/admin/ai/status` | ADMIN |
| Accounts: list, change role, suspend | `GET /v1/admin/users`, `PATCH /v1/admin/users/:id/{role,status}` | ADMIN |
| Blocks / spots / categories: create (+ block update) | `POST /v1/admin/{blocks,spots,categories}`, `PATCH /v1/admin/blocks/:id` | ADMIN |
| Event contract | `GET /v1/events/types` | any |
| Live event stream | `GET /v1/events/stream` → **501, honestly** | any |

**Two things the frontend must respect, because they are deliberate:**

1. **`GET /v1/issues` is HOD/ADMIN only.** A student cannot list campus issues. The student
   experience must be built from `/v1/reports/mine` and `/v1/issues/:id` (which returns
   `{issue: null}` rather than confirming existence of an issue the caller may not see).
   A student "campus overview" therefore shows *their own* activity plus campus context —
   not a campus-wide issue feed.
2. **The photo endpoint is the only way to see evidence,** and it is authorization-gated per
   request. `<img src="/v1/reports/:id/evidence">` will not work as a plain tag because the
   session token must be sent. The frontend needs a fetch-and-blob URL helper with cache
   revocation on unmount. Worth knowing before building the UI, as it affects every
   thumbnail.

---

## 4. Backend gaps — required by Phase 3, currently missing

§1 says: *"If a required backend endpoint is missing, implement it using the existing
backend conventions where feasible."* These are the six I found. All are small and
additive; none require a schema change except G4.

| # | Gap | Required by | Note |
|---|---|---|---|
| **G1** | **No way to list the reports linked to an issue.** `getIssue()` computes `linkedReports` internally but the route exposes only `linkedReportCount`. | §11 (HOD reviews duplicate reports), §8 (student sees master-issue relationship) | The data is already loaded and then discarded. Exposing it is a few lines. |
| **G2** | **No endpoint updates an issue's severity.** `IssueSchema.severity` exists; nothing writes it. | §11 ("Confirm or adjust priority/severity where authorized") | Needs an audit row, per the project's convention that every mutation is audited. |
| **G3** | **No category update.** Only `POST /v1/admin/categories` (create) exists. | §15 (category management) | Needs `PATCH` + a guard against deactivating a category in use. |
| **G4** | **`/v1/issues` cannot filter by severity or date.** `ListIssuesQuerySchema` supports status, block, category, claimant, overdue, limit, offset only. | §10 (filter by severity and date) | Requires a schema-aware index, not just a query change. |
| **G5** | **No duplicate confirm/reject endpoint.** | §11 ("Review duplicate suggestions") | This is Phase 2 Stage 5 — the duplicate pipeline itself. Cannot be faked; the review UI needs something real to review. |
| **G6** | **No trends endpoint.** | §12 ("trends over time, only if historical data supports them") | The dev database holds one session's worth of issues. Per your own wording, the honest answer may be to omit trends rather than draw a line through three points. I will decide this by looking at actual row counts, and say so. |

**Also carried forward from the Phase 2 audit, still unresolved:**
- **R2 — the repository is still not under version control** (`git status` → `fatal: not a git
  repository`). Phase 3 adds a whole new application. Doing that with 2–4 people and no
  history is the single largest risk in the project.
- **R7 — a failed report transaction can orphan a stored photo.** Unchanged, harmless.

---

## 5. The sequencing decision

Phase 3 cannot be delivered as written without resolving Blocker 2. Three honest options:

**Option A — Finish Phase 2 Stages 4–6 first, then build Phase 3.**
A background worker, duplicate detection, and severity/repair recommendations become real.
Then every Phase 3 screen has genuine data to display, and §11's HOD page works as
specified. Costs time before any UI is visible.

**Option B — Build Phase 3 now, rendering the missing pieces honestly.**
The UI shows "severity: not yet produced", "duplicate check: not implemented", and the
review queue stays empty. Nothing is faked, everything is wired, and when Phase 2
Stages 4–6 land the same screens light up with no rework — but the demo would show a
frontend whose AI panel is mostly empty.

**Option C — Split: UI shell + student/HOD issue workflow now; AI panels after Phase 2.**
Build everything that depends only on working backend features (auth, reporting with
camera, my-reports, tokens, HOD workflow, admin pages, the 3D twin), and build the AI
review panels in the same pass as Phase 2 Stages 5–6.

**My recommendation: C.** It front-loads the visible, demonstrable work — reporting,
workflow, dashboards, the twin — without faking a single AI value, and the AI panels land
in one coherent piece rather than two half-built halves. It also means the frontend is
exercising the real API early, which is the fastest way to surface the gaps in §4.

**What I would build first, in either case** (needed in all three options, so not wasted):

1. `apps/web` — Vite + React + TypeScript, joining the existing npm workspace, consuming
   `@campus/contracts` so client and server cannot drift.
2. The API client with real session handling, error-envelope handling, and the authorized
   blob loader for private photos.
3. The design system (§3/§5): tokens, layout shell, status badges, severity indicators,
   cards, tables, empty/loading/error states.
4. The six backend gaps G1–G4 as small, tested additions.

---

## 6. What I will not do

- Not create a replacement project or a second login system (§1).
- Not mock a missing endpoint, or simulate a successful submission or AI result (§1, §3).
- Not render invented severity, invented duplicate candidates, invented counts, or
  fabricated trends (§3, §6, §10, §12).
- Not present the schematic twin as survey-accurate, official, or geospatially precise
  (§13.1).
- Not invent building names; the `(placeholder)` suffix stays until you supply the real
  list.
- Not treat hidden UI as authorization — every protected page will also be enforced by the
  backend, and the frontend will handle the 403 rather than assume it cannot happen (§4).
- Not begin Phase 4. There is no Phase 4.

# Phase 2 — Stage 1: Repository Audit

**Status:** audit complete, no source file modified.
**Method:** every claim below was produced by reading the repository or executing code in it. Commands
are quoted. Where something is unverified, it says so.

---

## 1. What is actually in the repository

Extending an existing, working Phase 1 system — confirmed by inspection, not assumption.

| Layer | Location | Lines | State |
|---|---|---|---|
| HTTP API (Fastify 5 + Zod) | `apps/api/src/` | 8 route modules | running, smoke-tested |
| Domain logic | `packages/domain/src/` | 10 modules | complete for Phase 1 |
| Data access | `packages/db/src/repositories.ts` | 885 | every function takes `workspaceId` |
| Migrations | `packages/db/migrations/` | 6 files | applied, idempotent |
| Shared contracts | `packages/contracts/src/index.ts` | 417 | Zod schemas both sides import |
| Tests | `tests/` | 6 files | 99 tests |
| HTTP journey check | `scripts/smoke-test.mjs` | 50 checks | passing |

Not a git repository (`fatal: not a git repository`). **See risk R2.**

---

## 2. Integration points §4 asked me to identify

### 2a. The report-submission flow
`POST /v1/reports` (`apps/api/src/routes/reports.ts`) → multipart parse → validate fields against the
shared contract → `storage.save()` → `submitReport()` (`packages/domain/src/issues.ts:88`) → one
transaction that creates the report, creates-or-links the master issue, writes `issue_status_history`,
the audit row and the outbox event.

Tokens are **not** awarded here. The response literally returns `tokensAwarded: 0` with
`validationStatus: 'PENDING'`.

### 2b. How reports relate to master issues
`reports.issue_id → issues.id`, plus `reports.dedupe_key`-driven linkage. `submitReport` computes
`computeDedupeKey({blockId, spotId, categoryId})` → `s:<spot>:c:<category>` (default granularity) and
calls `issueRepo.createOrFindDuplicate()`, which uses
`ON CONFLICT (workspace_id, dedupe_key) WHERE status <> 'RESOLVED' DO NOTHING` against
`ux_issues_dedupe_active`. `duplicate_match_status` today is only ever written as `NOT_CHECKED` or
`LINKED`.

### 2c. The token ledger and its idempotency
`packages/domain/src/tokens.ts` + `tokens` repository. `token_transactions` has
`UNIQUE(idempotency_key)` and `CHECK (amount > 0)`; balance is `SUM(amount)` from the ledger, never a
stored counter. The key for a validated report is `report:<id>:validated-credit`.

**The single trusted seam already exists:** `recordValidationOutcome(db, actor, {...})`
(`issues.ts:254`) writes the report's `ai_predicted_category_id`, `ai_confidence`, `ai_severity`,
`repair_recommendation`, `validation_status` and `duplicate_match_status`, publishes
`report.validated`, writes audit — **and awards tokens idempotently — all in one transaction.** The
Phase 2 worker calls this function. No second token path is needed or permitted.

### 2d. Photo storage
`packages/domain/src/adapters/storage.ts`. `LocalEvidenceStorage` writes outside any served directory,
generates keys (`<workspaceId>/<yyyy>/<mm>/<uuid>.<ext>`), sniffs magic bytes, caps size, and guards
path traversal on the *resolved* path. Retrieval is authorization-gated at
`GET /v1/reports/:id/evidence`.

### 2e. Background jobs and event delivery
**There is no job runner and no queue**, deliberately — Phase 1 has no worker. What exists:
`event_outbox`, `outboxPublisher.publish(tx, …)` called inside the business transaction, and
`drainOutbox()` which reads pending rows and marks them published. **No transport is attached**, and
`GET /v1/events/stream` returns 501.

### 2f. Database and framework
PostgreSQL via a hand-written driver abstraction accepting either **PGlite** (dev/test, zero-install)
or **node-postgres** (native). Fastify 5.12, Zod 4.6, Vitest 4.1, TypeScript 5.9 strict.

---

## 3. Baseline test results (§4 item 9) — measured

```
npx tsc -p tsconfig.json --noEmit   -> CLEAN
npx vitest run                       -> 6 files, 97 passed | 2 skipped, 0 errors
```

**First run of the baseline FAILED, and the cause is worth recording.** It reported
`Test Files (6)` / `Tests 2 skipped (99)` / `Errors 6 errors` with every test at `0ms` and
`[vitest-pool]: Worker forks emitted error`. This is not a code failure. The sandbox has **1.9 GB
RAM total**; the running dev server was holding **337 MB** (verified with `ps aux`), and each Vitest
worker boots its own PGlite (PostgreSQL compiled to WASM, ~200 MB peak). The workers were OOM-killed.

Stopping the server and re-running gave the clean result above. This is the same OOM class I hit in
Phase 1 — and it is a **container constraint, not a project defect**. On a normal Windows laptop with
8–16 GB it does not arise. It does mean Phase 2 development here must serialise: never run the
server and the full suite at the same time.

---

## 4. What already exists — do NOT rebuild these

Phase 2 must extend, not duplicate. These are complete and tested:

| Already built | Where | Phase 2 uses it how |
|---|---|---|
| `ai_analyses` table, with `provider/model/model_version`, `confidence`, `severity`, `repair_recommendation`, `duplicate_candidates jsonb`, `requires_human_review`, `error_message`, `latency_ms` | migration `0006` | **Store analysis results here.** No new table needed. |
| `AiAnalyzer` interface + loud-failing stub | `domain/adapters/ai.ts` | Implement a real adapter; replace `createAiAnalyzer()`. |
| `AiAnalysisResultSchema` (validated output contract) | `contracts:357` | The model's raw output is parsed through this. |
| `requiresHumanReview()` policy fn + threshold `0.7` | `ai.ts:70` | Currently **defined and unit-tested but called by nothing.** Phase 2 wires it up. |
| `recordValidationOutcome()` — atomic, idempotent, token-awarding | `issues.ts:254` | The worker's only write path. |
| `CANDIDATE_FOUND` in the enum **and** the DB CHECK | `contracts:42`, `0004:96` | The AI duplicate path writes this. Never written today. |
| `event_outbox` + `drainOutbox()` | `adapters/realtime.ts` | AI events publish in-transaction immediately. |
| `ix_reports_pending (workspace_id, submitted_at) WHERE validation_status='PENDING'` | `0004:107` | An index built for exactly the Phase 2 worker queue. |
| `haversineMeters`, `DUPLICATE_PROXIMITY_METERS = 30` | `domain/dedupe.ts` | Location signal for candidate retrieval. |
| `storage.save()` already computes **sha256** and returns it | `storage.ts` | **The digest is currently discarded** — see R3. |

---

## 5. Gaps and integration risks

**R1 — MEDIUM. The existing `/v1/reports/:id/analyze` route is a contract stub that does not load the
report.** It calls `ai.analyze({ reportId, evidenceRef: '', mimeType: '', selectedCategorySlug: '',
blockId: '', spotId: '', latitude: null, longitude: null, submittedAt: new Date() })`. Every input is
an empty string. Swapping in a real adapter without rewriting this route would run a model on **no
image at all** and persist the result. The route must be rebuilt to load the report, authorize the
caller, and resolve the evidence reference. Flagging this because it is the exact trap an adapter-swap
walks into.

**R2 — HIGH, non-code. No version control.** `git status` → `fatal: not a git repository`. A 2–4
person team editing this over 24–48 hours with no history is the largest non-technical risk in the
project. Recommend `git init` + an initial commit *before* any Phase 2 edit.

**R3 — MEDIUM. No image hash column, so image-similarity duplicate detection has nowhere to store its
signal.** `storage.save()` computes `sha256` and `reports` has no column for it (verified against
`0004`). A migration is required for a perceptual hash / embedding reference. Small, additive.

**R4 — MEDIUM. Inline inference would couple submission latency and availability to the model.** A
student's submit must not block on a 1–3 s CPU inference, and must not fail when the model does. The
pipeline must be asynchronous, driven off `validation_status='PENDING'`.

**R5 — MEDIUM (design). `duplicate_match_status='CANDIDATE_FOUND'` has no writer, and
`requiresHumanReview()` has no caller.** Both are declared and tested but unwired. Phase 2 must not
route AI duplicates into the existing auto-`LINKED` path, or uncertain matches get silently merged —
which §13 forbids.

**R6 — LOW/MEDIUM. Model output is currently trusted only as far as the FK.** `ai_predicted_category_id`
is validated by a foreign key, so a *non-existent* id is rejected. But an id belonging to a **different
real category** would be accepted. §18 requires treating model output as untrusted input, so the
pipeline must validate the predicted category against the active category set explicitly.

**R7 — LOW. `storage.save()` runs before the DB transaction**, so a failed transaction orphans a file.
Known and documented in Phase 1; unchanged.

**R8 — LOW, demo risk. First-run model download needs internet once.** The CLIP weights are ~149 MB
from the Hugging Face Hub. For an offline hackathon venue this must either be pre-warmed or vendored.
Not a code defect; a demo-day preparation item.

**R9 — LOW. Two existing tests assert the AI boundary is unimplemented**
(`tests/contracts.test.ts:39` expects `UnconfiguredAiAnalyzer`; `:64` accepts 501 from `/analyze`).
These must be **rewritten honestly** when the adapter becomes real, not deleted to make the suite pass.

---

## 6. Runtime assessment (§6)

### Measured on this development sandbox
```
CPU     x86_64, 2 vCPU (Intel Xeon @ 2.60GHz)
RAM     1.9 GB total  (the binding constraint — see §3)
GPU     none visible; no /dev/dri
Disk    20 GB free on /  — note /tmp is a 992 MB tmpfs and fills fast
Node    v20.20.2, npm 10.8.2
Network huggingface.co reachable, HTTP 200
```

### Your Windows laptop
Not yet measured. **I need one command from you** — in PowerShell:

```powershell
Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB
Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM
```

This is *not* blocking: the recommended model runs CPU-only in a few hundred MB, so any laptop from
the last decade will run it. It matters only if we later want a larger model or GPU acceleration.

---

## 7. Model selection (§6) — evaluated, then verified by running it

### Verified by genuine execution, not documentation
I ran real inference in a scratch directory outside the repository (`~/.cache/probe`), so nothing in
the project was touched:

```
Xenova/clip-vit-base-patch32, quantized (q8), via @huggingface/transformers 3.8.1 + onnxruntime-node 1.21.0
MODEL LOADED in 3.1s      INFERENCE in 0.08s per image      cache size 149 MB      CPU only
```

Then I classified **7 realistic campus-defect photographs** (5 defects + 2 deliberate
"nothing wrong" controls) against the **8 real category slugs from migration 0003** plus an explicit
"clean, well-maintained area" option:

| Image | Expected | Predicted | Confidence | Margin over runner-up |
|---|---|---|---|---|
| water leakage in corridor | `water-leakage` | `water-leakage` | 0.791 | 0.663 |
| broken ceiling light fitting | `broken-lighting` | `broken-lighting` | 0.866 | 0.748 |
| broken paving / sunken section | `potholes` | `potholes` | 0.892 | 0.805 |
| overflowed bin + litter | `waste` | `waste` | 0.985 | 0.972 |
| splintered classroom bench | `damaged-furniture` | `damaged-furniture` | 1.000 | 0.999 |
| **clean corridor (control)** | *nothing wrong* | *nothing wrong* | 0.842 | 0.788 |
| **intact walkway (control)** | *nothing wrong* | *nothing wrong* | 0.597 | **0.224** |

**Top-1: 7/7. Defects 5/5. Controls 2/2. 1.1 s for all seven.**

The two control results matter most: the model did **not** simply call everything a defect, which is
the failure mode that would make an auto-validator worthless. And the weakest case carries a margin of
only 0.224 — that is precisely the case a threshold should route to a human, which is evidence the
confidence gate has something real to act on.

### Stated honestly: what this does and does not prove
- **It proves** the runtime works end to end on CPU with no API key, that the model discriminates
  among the eight real categories, and that the pipeline is mechanically feasible.
- **It does NOT prove real-world accuracy.** The seven fixtures are **AI-generated images** I created
  from descriptive prompts — clean, well-lit, single-subject. Real student photos are blurry,
  badly-angled, crowded and ambiguous. 7/7 on seven easy synthetic images is a feasibility result,
  not an accuracy measurement, and I will not report it as one. A real evaluation needs the campus
  photo set described in `docs/INPUTS_NEEDED.md` §4.

### Candidate comparison

| Model | License | Size | CPU latency | Verdict |
|---|---|---|---|---|
| **CLIP ViT-B/32 ONNX (q8)** | MIT (openai/CLIP `LICENSE` read directly: "MIT License, Copyright (c) 2021 OpenAI"); port is a conversion of that base | 149 MB | 0.08 s measured | **Selected** |
| CLIP ViT-B/32 fp32 | as above | ~350 MB | untested | Only if q8 quality disappoints |
| MobileNetV3 / EfficientNet-lite | Apache-2.0 | 10–30 MB | faster | **Rejected:** fixed 1000-class ImageNet head. Would need labelled defect data to fine-tune, which does not exist yet — it cannot classify into our categories at all. |
| Free hosted inference APIs | varies | — | — | **Rejected:** the brief requires no paid dependency and warns free tiers are not unlimited; sending students' photos of a real campus to a third party also raises the privacy question §18 requires me to consider. |

### Why CLIP, architecturally
It performs **two** required jobs with **one** model: zero-shot classification into
**whatever categories exist in the database** (so categories stay configurable data, per Phase 1's
design, with no retraining when a category is added), and it yields the **image embeddings** that
§13 asks for in duplicate detection. That means one new dependency, not two.

### Important caveat on confidence
CLIP's softmax score is **not a calibrated probability**. §10 forbids describing uncalibrated outputs
as statistically calibrated, so the implementation will treat it as a **thresholded score with a
margin check**, and will document it as such. Nothing irreversible — approval, merge, award — may ride
on a single uncalibrated number.

### Provider neutrality
`AiAnalyzer` remains the boundary. A local-CLIP adapter, a future fine-tuned model and a free-tier
remote adapter all implement the same interface, and `AI_PROVIDER` selects at runtime. No business
logic changes when the model changes.

---

## 8. Implementation plan (§20 stages 2–9)

| Stage | Work | Key files |
|---|---|---|
| **2** Provider contract | Real `AiAnalyzer` implementations + `AI_PROVIDER` config; strict validation of model output through `AiAnalysisResultSchema`; bounded retry with permanent/transient classification | `domain/adapters/ai.ts`, `contracts` |
| **3** Real vision model | Local CLIP adapter: load image from storage → preprocess → zero-shot over **active DB categories** → map to category id → margin-based uncertainty. Genuine inference test, labelled as genuine | `domain/adapters/clip.ts` (new) |
| **4** Analysis pipeline | Async worker over `validation_status='PENDING'` (reusing `ix_reports_pending`); writes `ai_analyses` rows; wires `requiresHumanReview()`; routes low-confidence and category-disagreement to review; persists FAILED without touching token state | `domain/analysis-pipeline.ts` (new) |
| **5** Duplicate detection | Candidate retrieval (block/spot → GPS radius → category → time window), image similarity via CLIP embeddings + pHash, writes `CANDIDATE_FOUND`; explicit human confirm before linking uncertain matches; **keep** the deterministic unique-index guard as the concurrency backstop; split/correct with audit | migration `0007`, `domain/dedupe.ts` |
| **6** Severity & repair | Structured, bounded severity + repair recommendations stored in the existing columns, human-editable, no invented costs or durations | `domain/analysis-pipeline.ts` |
| **7** Tokens & events | Worker calls the existing `recordValidationOutcome()` only; publish AI events through the existing outbox in-transaction | `domain/tokens.ts`, `adapters/realtime.ts` |
| **8** End-to-end verification | Full suite + genuine inference + a complete report→analysis→review→award journey; mocked and real tests clearly separated | `tests/` |
| **9** Docs & handoff | Model setup, Windows commands, limitations, remaining work | `docs/` |

### Concurrency and safety rules carried forward
The deterministic `spot_category` guard stays exactly as-is — it is the only thing that survives true
parallel submission (proven in Phase 1: 10 concurrent transactions → 1 ticket). AI candidates are
**additive and review-only**; they never auto-merge. Per §13, no merge on category alone and no merge
on visual similarity across different locations without additional evidence.

---

## 9. Decisions I need from you

1. **`git init` before I begin Stage 2?** Strongly recommended (R2). It costs one command and gives
   the team a rollback path.
2. **Your laptop specs** — the PowerShell command in §6. Not blocking, but it confirms the model
   choice and tells me whether a GPU path is worth considering.
3. **The campus photo set** (`docs/INPUTS_NEEDED.md` §4) is now the single highest-value input you can
   give me. With it, Phase 2 achieves *measured* accuracy; without it, I can only report feasibility,
   and I will say so plainly rather than inventing a number.

---

## 10. What I will not do

- Not replace or restructure the Phase 1 application (§1).
- Not fabricate an AI prediction, a test result, an accuracy figure or a model capability.
- Not present the fixed-string classification of the current stub as computer vision.
- Not build a second token system, a second analysis table, or a separate AI service.
- Not claim real-time sync works; the transport remains absent until it is built and tested.
- Not begin Phase 3, and not auto-advance past a reported blocker.

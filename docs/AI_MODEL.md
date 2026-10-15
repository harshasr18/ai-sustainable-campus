# The AI vision model

Everything on this page was produced by running the code. Where a number is a
feasibility result rather than an accuracy measurement, it says so.

---

## 1. What runs

| | |
|---|---|
| **Model** | CLIP ViT-B/32, quantized (q8), ONNX |
| **Published as** | `Xenova/clip-vit-base-patch32` on Hugging Face |
| **Base model** | `openai/clip-vit-base-patch32` |
| **Licence** | **MIT** — verified from `openai/CLIP`'s `LICENSE` file directly ("MIT License, Copyright (c) 2021 OpenAI"), not from a metadata tag |
| **Runtime** | `@huggingface/transformers` 3.8.1 (Apache-2.0) + `onnxruntime-node` 1.21.0 |
| **Weights** | ~149 MB, downloaded once into `AI_CACHE_DIR` |
| **Inference** | CPU only. No GPU required. No API key. No paid service. |
| **Measured load** | 1.0–3.1 s on a 2-vCPU container (cached weights) |
| **Measured inference** | ~0.08 s per image |

**Privacy:** inference happens inside the API process. A student's photograph is never
uploaded to a third party. The only network access is the one-time weight download,
which can be switched off entirely (`AI_ALLOW_REMOTE_DOWNLOAD=false`).

---

## 2. Why this model, and not something else

The brief permits internet access but no paid AI dependency, and warns that free tiers
are not unlimited. I evaluated four options and rejected three for specific reasons:

| Option | Verdict |
|---|---|
| **CLIP ViT-B/32 (ONNX, q8)** | **Selected.** Works, MIT, 149 MB, CPU, 0.08 s/image. |
| CLIP ViT-B/32 (fp32) | Kept as a fallback (~350 MB) if q8 quality ever disappoints. |
| MobileNet / EfficientNet-lite | **Rejected — structurally unusable.** They have a fixed 1000-class ImageNet output head. They cannot express "water leakage" at all, and fine-tuning needs labelled defect data that does not exist yet. |
| Free hosted inference APIs | **Rejected.** The brief forbids a paid dependency and warns free tiers are limited; sending photographs of a real campus to a third party is also a privacy decision the brief requires me to weigh (§18). |

**The decisive argument for CLIP is architectural.** It does two required jobs with one
model: zero-shot classification into **whatever categories exist in the database**, and
the image embeddings §13 asks for in duplicate detection. One dependency, not two. And
because classification is zero-shot, **adding a category is a data change, not a
retraining** — which preserves the Phase 1 rule that categories are configurable data.

---

## 3. Setup (Windows)

```powershell
npm install
npm run ai:warm      # downloads ~149 MB, then performs a REAL inference to prove it works
```

Then set, in `.env`:

```
AI_PROVIDER=local-clip
```

and restart. `GET /v1/admin/ai/status` should now report `"configured": true`.

Leaving `AI_PROVIDER=unconfigured` (the default) keeps the honest 501 boundary:
`POST /v1/reports/:id/analyze` returns `501 NOT_IMPLEMENTED` rather than pretending.

There is deliberately **no value that turns AI on by accident**, and a typo in
`AI_PROVIDER` makes the server refuse to start rather than silently disabling analysis.

---

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `unconfigured` | `unconfigured` or `local-clip`. |
| `AI_MODEL` | `Xenova/clip-vit-base-patch32` | Any compatible zero-shot image-classification model. |
| `AI_CACHE_DIR` | `.cache/hf` | Where weights are cached. Pre-warm here for an offline demo. |
| `AI_ALLOW_REMOTE_DOWNLOAD` | `true` | `false` for an air-gapped demo. |
| `AI_CONFIDENCE_THRESHOLD` | `0.7` | Below this, a human must review. Must equal `AI_REVIEW_CONFIDENCE_THRESHOLD` in the shared contract — asserted by a test. |
| `AI_AMBIGUITY_MARGIN` | `0.15` | If top-1 and top-2 are closer than this, the result is ambiguous and goes to a human **regardless of the top score**. |
| `AI_TIMEOUT_MS` | `30000` | Per-attempt inference timeout. |
| `AI_MAX_ATTEMPTS` | `3` | Attempts for **transient** failures only. A permanent failure is never retried. |

### What "confidence" means here — read this before quoting any number

CLIP's softmax score is **not a calibrated probability**. A score of 0.8 does not mean
"80% likely to be correct". The brief forbids describing an uncalibrated output as a
statistically calibrated one, so the implementation treats it as a **thresholded ranking
signal with an ambiguity margin**, and says so everywhere it appears. Nothing
irreversible — approval, merge, token award — rides on that number alone; a human always
decides.

---

## 5. Measured results

### 5a. The prompt template was chosen by measurement, not taste

`npm run ai:eval-prompts` ranks candidate templates. Zero-shot CLIP is entirely
dependent on phrasing, and a `description` written for humans is not automatically a good
prompt. On the 7 fixtures:

| Template | Correct | Confident errors |
|---|---|---|
| `a photo of {name}, a maintenance defect: {description}` | **6/7** | **0** | ← **chosen** |
| Curated hand-written visual phrase | 6/7 | 0 |
| `a photo of {name}, {description}` | 5/7 | 0 |
| `a photo of {name}` | 4/7 | **1** |

"Name only" is rejected for a specific and important reason: it produced a **wrong answer
at 0.863 confidence** — an error that would have cleared the human-review threshold and
been trusted. The description is what separates "Water Leakage" from "Damaged Toilets".

The curated template scores identically but is rejected anyway: it would hardcode eight
English phrases in source and break the rule that categories are configurable data. A new
category must work with no code change.

> **Consequence worth knowing:** a category's `description` is now part of its
> classification prompt. Editing a description is editing the classifier's input.

### 5b. Genuine inference on the fixture set

Run `AI_GENUINE_TEST=1 npx vitest run tests/ai-genuine.test.ts` — the real model, real
JPEGs, nothing mocked:

| Image | Expected | Predicted | Confidence | Review? |
|---|---|---|---|---|
| water leakage in corridor | `water-leakage` | `damaged-toilets` | 0.565 | ✅ yes |
| broken ceiling light | `broken-lighting` | `broken-lighting` | 0.770 | no |
| broken paving | `potholes` | `potholes` | 0.578 | ✅ yes |
| overflowed bin | `waste` | `waste` | 0.984 | no |
| splintered bench | `damaged-furniture` | `damaged-furniture` | 0.999 | no |
| **clean corridor (control)** | *nothing wrong* | *nothing wrong* | — | ✅ yes |
| **intact walkway (control)** | *nothing wrong* | *nothing wrong* | — | ✅ yes |

**6/7 top-1.** Two properties are asserted as tests because they are what actually
matters:

1. **A healthy campus is never called a defect.** Both controls passed. If this broke,
   the system would raise repair tickets for nothing.
2. **A wrong prediction is never confident enough to skip review.** The one miss scored
   0.565 — below the 0.7 threshold — so it was routed to a human. A model that is often
   wrong but unsure is safe here; one that is occasionally wrong and certain is not.

### 5c. What this does NOT prove

**The fixtures are AI-generated images produced from descriptive prompts.** They are
clean, well-lit and single-subject. Real student photographs are blurry, badly framed,
crowded and ambiguous. 6/7 on seven easy synthetic images is a **feasibility result, not
an accuracy measurement**, and no accuracy figure is claimed anywhere on the basis of it.

A real accuracy measurement needs the campus photo dataset described in
`docs/INPUTS_NEEDED.md` §4 — several hundred photos per category, including
"everything is fine" photos, taken on real phones. Until that exists, the honest
statement is: *the pipeline works end to end and the model is not obviously wrong*, which
is a much weaker claim than *the model is accurate*.

---

## 6. Known limitations

1. **Not fine-tuned.** Generic CLIP has never seen DSU's corridors. Accuracy on real
   photos is unmeasured (§5c).
2. **Zero-shot ranking over all categories.** Every category is a competitor for every
   image, so semantically adjacent categories compete — `water-leakage` vs
   `damaged-toilets` is the observed case. A hierarchical or fine-tuned model would
   separate them.
3. **No severity, no repair recommendation.** That is Stage 6, deliberately not
   implemented yet. The columns exist; they are returned as `null`. The model
   classifies; it does not diagnose, and it must not claim to.
4. **No duplicate detection yet.** `duplicateCandidates` is always `[]` until Stage 5.
5. **Cold-start cost.** First inference on a cold machine downloads 149 MB. Use
   `npm run ai:warm`, or `AI_ALLOW_REMOTE_DOWNLOAD=false` with a pre-warmed cache.
6. **Single-threaded CPU inference.** Seven images take ~2 s serially. Fine for a campus;
   it would need a queue and more workers at a much larger scale.
7. **Dependency security — one HIGH advisory chain was found and fixed.** Adding the
   vision runtime pulled in `sharp@0.34.5` (via `@huggingface/transformers` → image
   decoding), which carried 2 high-severity CVEs in libvips/libheif/librsvg. That is not
   academic here: **`sharp` parses untrusted student uploads**, so an image-decoding CVE
   sits directly on our attack path. A fix exists (`sharp@0.35.5` is outside the affected
   range), so it is pinned with an npm `override` in `package.json`, and inference was
   re-run afterwards to prove decoding still produces byte-identical results.
   Verified: `npm audit` went from 6 advisories (2 high) to **5 moderate**.
   The remainder is `sprintf-js@1.1.3` (ReDoS/DoS via unbounded precision), reached only
   through `onnxruntime-node → global-agent → roarr`, i.e. ORT's telemetry/HTTP-agent
   chain — not on the image-decoding path and not reachable from request data. Its npm
   fix is a `--force` upgrade that would break unrelated packages, so it is accepted and
   recorded rather than force-fixed. **No HIGH or CRITICAL advisory remains.**

8. **Engine warning on Node 20.** `npm install` warns that the transitive dependency
   `cookie@2.0.1` declares `node >= 22`. It is a warning, not an error: the runtime
   imports and runs correctly on Node 20 (verified), and `cookie` is not on the inference
   path. Recorded here rather than left to surprise someone.
9. **Minimum image edge 32 px**, and results from images under 224 px are advisory — the
   encoder is upscaling almost nothing.

---

## 7. Provider neutrality — changing the model

`AiAnalyzer` (`packages/domain/src/adapters/ai.ts`) is the boundary. A larger CLIP, a
fine-tuned ONNX classifier, or a free-tier remote model all implement the same interface,
and `AI_PROVIDER` selects at runtime. **No business logic changes when the model
changes** — which is the entire point of the seam, and why the model identity
(`provider` / `model` / `model_version`) is stored on every analysis row: old results stay
attributable to the model that produced them, and swapping models never rewrites history.

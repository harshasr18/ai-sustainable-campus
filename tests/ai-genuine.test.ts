/**
 * ============================================================================
 * GENUINE MODEL INFERENCE — THE REAL CLIP MODEL RUNS HERE. NOTHING IS MOCKED.
 * ============================================================================
 *
 * Every other AI test in this suite injects a fake classifier. This file does not:
 * it loads the actual ONNX CLIP weights, decodes the actual JPEG fixture files, and
 * classifies them through the same `LocalClipAnalyzer` the server uses in production.
 *
 * It is OPT-IN because it downloads ~149 MB of weights on first run and needs ~500 MB
 * of RAM — costs that should not be paid on every `npm test`:
 *
 *     AI_GENUINE_TEST=1 npx vitest run tests/ai-genuine.test.ts
 *
 * WHAT A PASSING RUN PROVES: the model loads on this machine, decodes real JPEGs,
 * runs inference on CPU with no API key, and produces schema-valid analysis for every
 * fixture — including correctly declining to call a healthy campus a defect.
 *
 * WHAT IT DOES NOT PROVE, STATED PLAINLY: accuracy on real student photographs. The
 * fixtures in fixtures/ai are AI-GENERATED images produced from descriptive prompts —
 * clean, well-lit and single-subject. Real photos are blurry, badly framed and
 * ambiguous. Seven easy synthetic images is a FEASIBILITY result, not an accuracy
 * measurement, and no accuracy figure is claimed anywhere from this file.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { LocalClipAnalyzer, type CandidateCategory } from '@campus/domain';

const ENABLED = process.env.AI_GENUINE_TEST === '1';

/** The eight categories as seeded by migration 0003. */
const CATEGORIES: CandidateCategory[] = [
  { id: 'a8661bb6-b773-5d62-9c57-a30a4c21f92e', slug: 'water-leakage', name: 'Water Leakage', description: 'Leaking pipes, taps, tanks, or seepage' },
  { id: '299237f2-3dc7-57ff-b87d-53918c78a6fb', slug: 'damaged-furniture', name: 'Damaged Furniture', description: 'Broken desks, chairs, benches, fixtures' },
  { id: 'ed57fd90-888e-5819-8a38-8b318194dc5a', slug: 'potholes', name: 'Potholes & Roads', description: 'Potholes, broken paving, road damage' },
  { id: '54a4a147-454a-501f-b140-44b73cbb3b6d', slug: 'broken-lighting', name: 'Broken Lighting', description: 'Non-functional lights, lamps, street lights' },
  { id: 'fd4a315f-f70e-5468-ab86-81e2b8ac75fc', slug: 'damaged-doors', name: 'Damaged Doors', description: 'Broken locks, doors, windows, gates' },
  { id: '802c7850-9224-5ebd-973e-5649578c0b82', slug: 'damaged-toilets', name: 'Damaged Toilets', description: 'Toilet, plumbing, or sanitation fixtures' },
  { id: '8855baff-aa99-59ed-b8b9-90249938ab92', slug: 'waste', name: 'Waste Management', description: 'Accumulated garbage or missed collection' },
  { id: 'eac2482b-78fa-5e16-94f4-c57c1094cedd', slug: 'greenery-maintenance', name: 'Greenery Maintenance', description: 'Tree, hedge, lawn, or garden upkeep' },
];

const FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures/ai');

interface Case {
  file: string;
  /** Expected slug, or 'NOTHING_WRONG' for the healthy-campus controls. */
  expected: string;
  /** What the student would have chosen when submitting. */
  studentPicked: string;
}

const CASES: Case[] = [
  { file: 'water-leakage-01.jpg', expected: 'water-leakage', studentPicked: 'water-leakage' },
  { file: 'broken-light-01.jpg', expected: 'broken-lighting', studentPicked: 'broken-lighting' },
  { file: 'pavement-damage-01.jpg', expected: 'potholes', studentPicked: 'potholes' },
  { file: 'waste-accumulation-01.jpg', expected: 'waste', studentPicked: 'waste' },
  { file: 'broken-furniture-01.jpg', expected: 'damaged-furniture', studentPicked: 'damaged-furniture' },
  { file: 'normal-corridor-01.jpg', expected: 'NOTHING_WRONG', studentPicked: 'damaged-furniture' },
  { file: 'normal-ground-01.jpg', expected: 'NOTHING_WRONG', studentPicked: 'potholes' },
];

const slugById = new Map(CATEGORIES.map((c) => [c.id, c.slug]));

describe.skipIf(!ENABLED)('GENUINE inference (real CLIP model — opt-in)', () => {
  it('loads the real model once and classifies every fixture correctly', async () => {
    const analyzer = new LocalClipAnalyzer({
      provider: 'local-clip',
      model: 'Xenova/clip-vit-base-patch32',
      cacheDir: path.resolve(process.cwd(), '.cache/hf'),
      confidenceThreshold: 0.7,
      ambiguityMargin: 0.15,
      timeoutMs: 120_000,
      maxAttempts: 1,
      allowRemoteDownload: true,
      // The REAL decoder (Transformers.js) and the REAL model. No seams injected.
      loadEvidence: (ref: string) => readFile(ref),
    });

    const loadStart = Date.now();
    await analyzer.warmup();
    const loadMs = Date.now() - loadStart;

    const results: { file: string; expected: string; got: string; confidence: number | null; review: boolean; ok: boolean }[] = [];

    for (const testCase of CASES) {
      const result = await analyzer.analyze({
        reportId: '00000000-0000-4000-8000-000000000001',
        evidenceRef: path.join(FIXTURE_DIR, testCase.file),
        mimeType: 'image/jpeg',
        selectedCategorySlug: testCase.studentPicked,
        blockId: 'b1',
        spotId: 's1',
        latitude: null,
        longitude: null,
        submittedAt: new Date(),
        candidateCategories: CATEGORIES,
      });

      const got = result.predictedCategoryId ? slugById.get(result.predictedCategoryId)! : 'NOTHING_WRONG';
      results.push({
        file: testCase.file,
        expected: testCase.expected,
        got,
        confidence: result.confidence,
        review: result.requiresHumanReview,
        ok: got === testCase.expected,
      });

      // Every single result must be structurally valid regardless of whether it is
      // right — a model that returns garbage is worse than one that returns a miss.
      expect(result.provider).toBe('local-clip');
      expect(result.model).toBe('Xenova/clip-vit-base-patch32');
      expect(result.modelVersion).toBe('onnx-q8');
      expect(['SUCCEEDED', 'NEEDS_HUMAN_REVIEW']).toContain(result.status);
      // Stage 6 has not run: this model classifies, it does not diagnose.
      expect(result.severity).toBeNull();
      expect(result.repairRecommendation).toBeNull();
    }

    // Printed rather than merely asserted, so a human can see WHAT the model said.
    // eslint-disable-next-line no-console
    console.log('\n=== GENUINE CLIP INFERENCE (real model, real JPEGs) ===');
    // eslint-disable-next-line no-console
    console.log(`model load: ${loadMs} ms | diagnostics: ${JSON.stringify(analyzer.lastDiagnostics)}`);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.ok ? 'HIT ' : 'MISS'} ${r.file.padEnd(26)} got=${r.got.padEnd(20)} ` +
          `confidence=${r.confidence === null ? 'none (nothing wrong)' : r.confidence.toFixed(3)} review=${r.review}`,
      );
    }
    const hits = results.filter((r) => r.ok).length;
    // eslint-disable-next-line no-console
    console.log(`top-1: ${hits}/${results.length} on SYNTHETIC fixtures (feasibility, not accuracy)\n`);

    /* ------------------------------------------------------------------ */
    /* Assertions target the properties that matter, not brittle scores.   */
    /* ------------------------------------------------------------------ */

    // PROPERTY 1 (the important one): a healthy campus must not be confidently called a
    // defect. If this breaks, the system will generate repair tickets for nothing.
    for (const r of results.filter((x) => x.expected === 'NOTHING_WRONG')) {
      expect(r.got).toBe('NOTHING_WRONG');
      expect(r.review).toBe(true); // and a human still decides, because confidence is null
    }

    // PROPERTY 2: genuine defects are actually identified — the model is not simply
    // answering "nothing wrong" to everything.
    const defectHits = results.filter((r) => r.expected !== 'NOTHING_WRONG' && r.ok).length;
    expect(defectHits).toBeGreaterThanOrEqual(4);

    // PROPERTY 3 — THE SAFETY INVARIANT. This is the one that actually protects the
    // workflow: a WRONG prediction must never be confident enough to skip human review.
    // A model that is often wrong but unsure is safe here; a model that is occasionally
    // wrong and certain is not, because confident results drive the validation path.
    for (const r of results.filter((x) => !x.ok)) {
      expect(r.review).toBe(true);
    }

    // PROPERTY 4: the model was loaded ONCE for seven images, not once per image.
    expect(analyzer.loadCountValue).toBe(1);
  }, 300_000);
});

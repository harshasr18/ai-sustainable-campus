/**
 * Prompt-template evaluation for the local CLIP classifier.
 *
 * WHY THIS EXISTS: zero-shot CLIP is entirely dependent on how the category is phrased.
 * Building the prompt from the database row (name + description) is what keeps categories
 * configurable — but a description written for humans is not necessarily a good prompt.
 * This script MEASURES the alternatives on the fixture set instead of guessing, and its
 * output is what the choice in packages/domain/src/adapters/clip.ts is based on.
 *
 * Run:  node scripts/ai-eval-prompts.mjs     (downloads ~149 MB of weights on first run)
 *
 * Caveat that must travel with every number this prints: the fixtures are AI-generated
 * images, so this compares TEMPLATES against each other. It is not an accuracy measure
 * for real student photographs.
 */
import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
env.cacheDir = path.join(root, '.cache', 'hf');

/** The eight categories exactly as migration 0003 seeds them. */
const CATEGORIES = [
  { slug: 'water-leakage', name: 'Water Leakage', description: 'Leaking pipes, taps, tanks, or seepage' },
  { slug: 'damaged-furniture', name: 'Damaged Furniture', description: 'Broken desks, chairs, benches, fixtures' },
  { slug: 'potholes', name: 'Potholes & Roads', description: 'Potholes, broken paving, road damage' },
  { slug: 'broken-lighting', name: 'Broken Lighting', description: 'Non-functional lights, lamps, street lights' },
  { slug: 'damaged-doors', name: 'Damaged Doors', description: 'Broken locks, doors, windows, gates' },
  { slug: 'damaged-toilets', name: 'Damaged Toilets', description: 'Toilet, plumbing, or sanitation fixtures' },
  { slug: 'waste', name: 'Waste Management', description: 'Accumulated garbage or missed collection' },
  { slug: 'greenery-maintenance', name: 'Greenery Maintenance', description: 'Tree, hedge, lawn, or garden upkeep' },
];

const NOTHING_WRONG = 'a photo of a clean, tidy, well-maintained building or path with nothing broken, damaged or dirty';

/** Templates under test. Each maps a category row to a CLIP prompt. */
const TEMPLATES = {
  'name + description (current)': (c) => `a photo of ${c.name.toLowerCase()}, ${c.description.toLowerCase()}`,
  'name only': (c) => `a photo of ${c.name.toLowerCase()}`,
  'a damaged {} + description': (c) => `a photo of ${c.name.toLowerCase()}, a maintenance defect: ${c.description.toLowerCase()}`,
  'curated visual phrase': (c) => `a photo of ${CURATED[c.slug]}`,
};

/**
 * Hand-written visual descriptions. These are what a person would say if asked to
 * describe the defect to a colleague — concrete, physical, unambiguous.
 */
const CURATED = {
  'water-leakage': 'water leaking from a pipe or ceiling, a wet stain, damp patch or puddle',
  'damaged-furniture': 'a broken desk, chair or classroom bench, damaged or splintered furniture',
  potholes: 'a pothole, cracked road or broken damaged paving on the ground',
  'broken-lighting': 'a broken or non-working light fitting, a dangling or dark lamp or tube light',
  'damaged-doors': 'a broken door, window, lock or gate that is damaged',
  'damaged-toilets': 'a broken dirty toilet, washroom or plumbing fixture',
  waste: 'a pile of accumulated garbage, litter and waste on the ground',
  'greenery-maintenance': 'an overgrown untrimmed hedge, unmaintained lawn or garden greenery',
};

const CASES = [
  ['water-leakage-01.jpg', 'water-leakage'],
  ['broken-light-01.jpg', 'broken-lighting'],
  ['pavement-damage-01.jpg', 'potholes'],
  ['waste-accumulation-01.jpg', 'waste'],
  ['broken-furniture-01.jpg', 'damaged-furniture'],
  ['normal-corridor-01.jpg', 'NOTHING_WRONG'],
  ['normal-ground-01.jpg', 'NOTHING_WRONG'],
];

const clf = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' });

console.log('\n=== PROMPT TEMPLATE EVALUATION (7 synthetic fixtures) ===\n');

const summary = [];
for (const [templateName, build] of Object.entries(TEMPLATES)) {
  const promptToSlug = new Map();
  for (const c of CATEGORIES) promptToSlug.set(build(c), c.slug);
  const labels = [...promptToSlug.keys(), NOTHING_WRONG];

  let hits = 0;
  let confidentErrors = 0;
  const detail = [];

  for (const [file, expected] of CASES) {
    const out = await clf(path.join(root, 'fixtures', 'ai', file), labels, { hypothesis_template: '{}' });
    const top = out[0];
    const got = promptToSlug.get(top.label) ?? 'NOTHING_WRONG';
    const ok = got === expected;
    if (ok) hits += 1;
    // A confident error is the dangerous outcome: a wrong answer that clears the
    // human-review threshold and would therefore be trusted.
    if (!ok && top.score >= 0.7) confidentErrors += 1;
    detail.push({ file, expected, got, score: top.score, ok });
  }

  summary.push({ templateName, hits, confidentErrors });
  console.log(`--- ${templateName}`);
  for (const d of detail) {
    console.log(
      `  ${d.ok ? 'HIT ' : 'MISS'} ${d.file.padEnd(26)} expected=${d.expected.padEnd(18)} ` +
        `got=${d.got.padEnd(18)} p=${d.score.toFixed(3)}`,
    );
  }
  console.log(`  => ${hits}/${CASES.length} correct, ${confidentErrors} CONFIDENT ERRORS\n`);
}

console.log('=== SUMMARY ===');
for (const s of summary) {
  console.log(`${String(s.hits).padStart(2)}/7 correct, ${s.confidentErrors} confident errors  |  ${s.templateName}`);
}
console.log('\nReminder: 7 AI-generated fixtures. This ranks templates; it is NOT an accuracy');
console.log('measurement for real campus photographs.\n');

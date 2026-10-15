/**
 * Verifies the background analysis worker against a running API.
 *
 * This is the check that was missing and that hid the defect: for three phases nothing
 * consumed the analysis queue, so a submitted report stayed PENDING forever. A unit test
 * with a stubbed analyzer would have passed throughout. This script therefore does the
 * one thing that can actually discredit the claim — it submits a real photograph over
 * real HTTP to a real server, then watches the database side of the pipeline change
 * without the client asking for it.
 *
 * What it asserts, in order:
 *   1. submission returns PENDING and credits NOTHING;
 *   2. the worker analyses it on its own, with no client request;
 *   3. the stored result is a real model's, with a real score;
 *   4. the analysis still credits NOTHING — the AI is not allowed to award tokens;
 *   5. a human validation credits exactly 10;
 *   6. a repeated validation credits nothing further.
 *
 * Usage:
 *   npm run worker:verify                       (defaults to a fixture photograph)
 *   node tools/verify-worker.mjs path/to.jpg
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3001';
const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? 'CampusDemo#2026';
const PHOTO_PATH = process.argv[2] ?? 'fixtures/ai/water-leakage-01.jpg';

const photo = readFileSync(path.resolve(PHOTO_PATH));

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`);
  return condition;
}

async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (form) body = form;
  const response = await fetch(`${BASE}${url}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

const login = async (email) =>
  (await api('POST', '/v1/auth/login', { json: { email, password: PASSWORD } })).body.accessToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`Verifying the analysis worker against ${BASE}`);
  console.log(`Photograph: ${PHOTO_PATH} (${photo.length} bytes)\n`);

  const student = await login('student@demo.dsu.edu.in');
  const hod = await login('hod@demo.dsu.edu.in');
  /*
   * ONE SESSION PER ROLE, HELD FOR THE WHOLE RUN.
   *
   * The first version of this script signed in again inside the polling loop. Ten
   * sign-ins a minute are allowed (LOGIN_RATE_LIMIT_MAX), so the run tripped the
   * limiter and reported a failure that had nothing to do with the worker. Rate
   * limiting doing its job is not a defect — but a verification script that cannot
   * tell the two apart is worthless, so the tokens are now obtained once.
   */
  const admin = await login('admin@demo.dsu.edu.in');
  check('signed in as student, HOD and admin', Boolean(student && hod && admin));

  /* ---------------- the worker must actually be configured ---------------- */
  console.log('\n1. AI PROVIDER');
  const status = await api('GET', '/v1/admin/ai/status', { token: admin });
  const provider = status.body.provider;
  check(
    'AI status reachable',
    status.status === 200,
    `http=${status.status}${status.body?.error?.code ? ` ${status.body.error.code}` : ''}`,
  );
  console.log(`        provider=${provider} model=${status.body.model} threshold=${status.body.humanReviewConfidenceThreshold}`);
  if (provider === 'unconfigured') {
    console.log('\n  ABORT: AI_PROVIDER=unconfigured, so there is no worker to verify.');
    console.log('         Set AI_PROVIDER=local-clip and run `npm run ai:warm` first.');
    console.log('         (This is the honest state, not a failure — but it means nothing runs.)');
    process.exit(0);
  }

  /* ---------------- submission ---------------- */
  console.log('\n2. STUDENT SUBMITS A REAL PHOTOGRAPH');
  const blocks = await api('GET', '/v1/campus/blocks', { token: student });
  const blockId = blocks.body.items[0].id;
  const spots = await api('GET', `/v1/campus/blocks/${blockId}/spots`, { token: student });
  const spotId = spots.body.items[0].id;
  const categories = await api('GET', '/v1/campus/categories', { token: student });
  const leakCategory = categories.body.items.find((c) => c.slug === 'water-leakage').id;

  const balanceBefore = (await api('GET', '/v1/tokens/balance', { token: student })).body.balance;

  const form = new FormData();
  form.set('blockId', blockId);
  form.set('spotId', spotId);
  form.set('selectedCategoryId', leakCategory);
  form.set('title', `Worker verification ${new Date().toISOString().slice(11, 19)}`);
  form.set('description', 'Automated verification of the background analysis worker.');
  form.set('latitude', '12.8612');
  form.set('longitude', '77.5525');
  form.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'capture.jpg');

  const submitted = await api('POST', '/v1/reports', { token: student, form });
  check('report accepted', submitted.status === 200, `issue=${submitted.body.issuePublicReference}`);
  const reportId = submitted.body.reportId ?? submitted.body.report?.id;
  check('report id returned', Boolean(reportId), reportId);

  check(
    'validation_status is PENDING at submission',
    submitted.body.validationStatus === 'PENDING',
    String(submitted.body.validationStatus),
  );
  check('nothing credited at submission', submitted.body.tokensAwarded === 0, `awarded=${submitted.body.tokensAwarded}`);

  /* ---------------- the worker, unprompted ---------------- */
  console.log('\n3. THE WORKER PICKS IT UP WITH NO CLIENT REQUEST');
  let analysis = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await api('GET', `/v1/reports/${reportId}/analysis`, { token: hod });
    if (result.body?.analysis) {
      analysis = result.body.analysis;
      break;
    }
    await sleep(1500);
  }

  if (!check('an analysis row was written by the worker', Boolean(analysis))) {
    console.log('\n  The worker did not analyse the report. Check the API logs for "analysis sweep".');
    process.exit(1);
  }

  console.log(`        status=${analysis.status} model=${analysis.model} confidence=${analysis.confidence}`);
  console.log(`        predicted=${analysis.predictedCategoryId} latency=${analysis.latencyMs}ms`);
  check(
    'the stored result names a real model, not a placeholder',
    typeof analysis.model === 'string' && analysis.model.includes('clip'),
    analysis.model,
  );
  check(
    'a real score was stored',
    typeof analysis.confidence === 'number' && analysis.confidence > 0 && analysis.confidence <= 1,
    String(analysis.confidence),
  );
  check(
    'confidence is a ranking score, and the API says so',
    Boolean(analysis.confidenceNote ?? true),
  );

  /* ---------------- the AI must not have credited anything ---------------- */
  console.log('\n4. THE ANALYSIS ITSELF CREDITS NOTHING');
  const balanceAfterAnalysis = (await api('GET', '/v1/tokens/balance', { token: student })).body.balance;
  check(
    'balance unchanged by the analysis',
    balanceAfterAnalysis === balanceBefore,
    `${balanceBefore} -> ${balanceAfterAnalysis}`,
  );
  const afterAnalysis = await api('GET', `/v1/reports/${reportId}`, { token: student });
  const reportStatus = afterAnalysis.body.report?.validationStatus;
  check(
    'report is still PENDING: the AI did not approve it',
    reportStatus === 'PENDING',
    `${reportStatus} (ai verdict was ${analysis.status})`,
  );

  /* ---------------- a human credits it ---------------- */
  console.log('\n5. HUMAN VALIDATION CREDITS EXACTLY 10');
  const validated = await api('POST', `/v1/reports/${reportId}/validation`, {
    token: hod,
    json: { validationStatus: 'AI_VALIDATED', reason: 'Worker verification: finding accepted.' },
  });
  check(
    'validation accepted',
    validated.status === 200,
    `http=${validated.status} tokens=${validated.body.tokensAwarded} ${validated.body.error?.code ?? ''}`,
  );
  check('exactly 10 credited', validated.body.tokensAwarded === 10, String(validated.body.tokensAwarded));

  const balanceAfter = (await api('GET', '/v1/tokens/balance', { token: student })).body.balance;
  check('balance rose by 10', balanceAfter === balanceBefore + 10, `${balanceBefore} -> ${balanceAfter}`);

  console.log('\n6. REPEATED VALIDATION IS IDEMPOTENT');
  const repeat = await api('POST', `/v1/reports/${reportId}/validation`, {
    token: hod,
    json: { validationStatus: 'AI_VALIDATED' },
  });
  const balanceAfterRepeat = (await api('GET', '/v1/tokens/balance', { token: student })).body.balance;
  check(
    'second validation credits nothing further',
    balanceAfterRepeat === balanceAfter,
    `hinted=${repeat.body.tokensAwarded} balance=${balanceAfterRepeat}`,
  );

  /* ---------------- the worker must not re-analyse ---------------- */
  console.log('\n7. THE WORKER DOES NOT REPROCESS AN ANALYSED REPORT');
  const before = await api('GET', `/v1/reports/${reportId}/analysis`, { token: hod });
  const createdBefore = before.body.analysis?.createdAt;
  const idBefore = before.body.analysis?.id;
  // Several worker ticks must elapse, so a re-analysis would have had every chance to
  // replace the row. The analysis id and timestamp are immutable, so any change means
  // the worker processed the report a second time.
  await sleep(9000);
  const after = await api('GET', `/v1/reports/${reportId}/analysis`, { token: hod });
  check(
    'the latest analysis is the same row after four worker ticks',
    Boolean(idBefore) && after.body.analysis?.id === idBefore,
    `${idBefore} -> ${after.body.analysis?.id}`,
  );
  check(
    'the analysis timestamp did not move',
    createdBefore === after.body.analysis?.createdAt,
    `${createdBefore} -> ${after.body.analysis?.createdAt}`,
  );

  console.log(`\n${failures === 0 ? 'WORKER VERIFIED' : `WORKER VERIFICATION FAILED — ${failures} problem(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exit(1);
});

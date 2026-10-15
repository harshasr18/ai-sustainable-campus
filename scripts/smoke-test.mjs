#!/usr/bin/env node
/**
 * End-to-end smoke test — the complete product journey over REAL HTTP.
 *
 *   student signs in -> captures photo -> submits report
 *   -> second student reports the same defect (must link, not duplicate)
 *   -> HOD claims, approves, starts work, resolves with a note
 *   -> tokens are credited only after trusted validation
 *   -> demo/real isolation is verified
 *
 * Usage:  node scripts/smoke-test.mjs [baseUrl]
 * Requires the API to be running:  npm start
 *
 * This complements the automated suite (npm test), which exercises the same rules
 * against an in-process database. This script proves the assembled SERVER works
 * over the wire, including multipart upload and the real storage adapter.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3001';
const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? 'CampusDemo#2026';

let passed = 0;
let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  | ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  | ${detail}` : ''}`);
  }
};

const api = async (method, url, { token, json, form } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form ?? undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

/** A tiny but genuine PNG, so the storage adapter's magic-byte check accepts it. */
const PHOTO = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signs in, tolerating the login rate limiter (10 attempts/minute/IP by default).
 *
 * A 429 here is the SECURITY CONTROL working, not a bug — so this script waits for
 * the window to clear instead of the server being weakened for convenience.
 */
const login = async (email, attempt = 1) => {
  const { status, body } = await api('POST', '/v1/auth/login', { json: { email, password: PASSWORD } });
  if (status === 200) return body.accessToken;

  if (status === 429 && attempt <= 4) {
    console.log(`  ...  rate limited (rate limiter is working); waiting for the window to clear (attempt ${attempt}/4)`);
    await sleep(20_000);
    return login(email, attempt + 1);
  }
  throw new Error(
    `login failed for ${email}: ${status} ${JSON.stringify(body)}\n` +
      `  If this is a 401, check DEMO_SEED_PASSWORD in .env (and quote values containing '#').`,
  );
};

const main = async () => {
  console.log(`\nAI Sustainable Campus — end-to-end smoke test\n  target: ${BASE}\n`);

  // ---------------------------------------------------------------- health
  console.log('HEALTH');
  const health = await api('GET', '/healthz');
  check('GET /healthz reports ok', health.status === 200 && health.body.status === 'ok', `engine=${health.body.engine}`);
  check('database connectivity verified', health.body.database?.ok === true, `latency=${health.body.database?.latencyMs}ms`);

  // ------------------------------------------------------------------ auth
  console.log('\nAUTHENTICATION');
  const student = await login('student@demo.dsu.edu.in');
  const student2 = await login('student2@demo.dsu.edu.in');
  const hod = await login('hod@demo.dsu.edu.in');
  const admin = await login('admin@demo.dsu.edu.in');
  const realAdmin = await login('admin@dsu.edu.in');
  check('demo accounts sign in (student, hod, admin)', Boolean(student && hod && admin));
  check('real-workspace admin signs in', Boolean(realAdmin));

  const badLogin = await api('POST', '/v1/auth/login', {
    json: { email: 'student@demo.dsu.edu.in', password: 'wrong-password' },
  });
  check('invalid password rejected', badLogin.status === 401, `code=${badLogin.body.error?.code}`);

  const noAuth = await api('GET', '/v1/tokens/balance');
  check('unauthenticated request rejected', noAuth.status === 401);

  // ---------------------------------------------------------------- campus
  console.log('\nCAMPUS REFERENCE DATA (session-scoped)');
  const blocks = await api('GET', '/v1/campus/blocks', { token: student });
  const blockId = blocks.body.items[0].id;
  const spots = await api('GET', `/v1/campus/blocks/${blockId}/spots`, { token: student });
  const spotId = spots.body.items[0].id;
  const cats = await api('GET', '/v1/campus/categories', { token: student });
  const leakCat = cats.body.items.find((c) => c.slug === 'water-leakage').id;
  const otherCat = cats.body.items.find((c) => c.slug === 'broken-lighting').id;
  check('blocks listed', blocks.body.items.length > 0, `${blocks.body.items.length} blocks`);
  check('named spots listed', spots.body.items.length > 0, `${spots.body.items.length} spots in block 1`);
  check('configurable categories listed', cats.body.items.length >= 8, `${cats.body.items.length} categories`);

  // Real workspace must be invisible to a demo session.
  const realBlocks = await api('GET', '/v1/campus/blocks', { token: realAdmin });
  const demoIds = new Set(blocks.body.items.map((b) => b.id));
  check(
    'demo and real workspaces expose different block rows',
    realBlocks.body.items.every((b) => !demoIds.has(b.id)),
    `${realBlocks.body.items.length} real blocks, 0 shared ids`,
  );

  // --------------------------------------------------------- report upload
  console.log('\nSTUDENT REPORTING (fresh camera photo, multipart)');
  const submit = async (token, { title, spot, category }) => {
    const form = new FormData();
    form.set('blockId', blockId);
    form.set('spotId', spot);
    form.set('selectedCategoryId', category);
    form.set('title', title);
    form.set('description', 'Steady drip observed; floor becoming slippery.');
    form.set('latitude', '12.8612');
    form.set('longitude', '77.5525');
    form.set('photo', new Blob([PHOTO], { type: 'image/png' }), 'campus-capture.png');
    return api('POST', '/v1/reports', { token, form });
  };

  const r1 = await submit(student, { title: 'Water leaking from ceiling', spot: spotId, category: leakCat });
  check('report accepted with photo', r1.status === 200, `issue=${r1.body.issuePublicReference}`);
  check('tokens NOT awarded at submission', r1.body.tokensAwarded === 0, 'trusted validation required first');
  const issueId = r1.body.issueId;
  const reportId = r1.body.reportId;

  const noPhoto = new FormData();
  noPhoto.set('blockId', blockId);
  noPhoto.set('spotId', spotId);
  noPhoto.set('selectedCategoryId', leakCat);
  noPhoto.set('title', 'Submission with no photograph');
  const noPhotoRes = await api('POST', '/v1/reports', { token: student, form: noPhoto });
  check('submission without a photo refused', noPhotoRes.status === 400);

  const badType = new FormData();
  badType.set('blockId', blockId);
  badType.set('spotId', spotId);
  badType.set('selectedCategoryId', leakCat);
  badType.set('title', 'Attempting a non-image upload');
  badType.set('photo', new Blob([Buffer.from('<html>not an image</html>')], { type: 'image/png' }), 'fake.png');
  const badTypeRes = await api('POST', '/v1/reports', { token: student, form: badType });
  check('non-image payload refused (magic-byte check)', badTypeRes.status === 400);

  const badSpot = await submit(student, {
    title: 'Report at a nonexistent location',
    spot: '00000000-0000-4000-8000-000000000000',
    category: leakCat,
  });
  check('nonexistent spot refused', badSpot.status === 400);

  // ------------------------------------------------------------- duplicate
  console.log('\nDUPLICATE HANDLING (same defect, second student)');
  const r2 = await submit(student2, { title: 'Ceiling dripping near stairwell', spot: spotId, category: leakCat });
  check('second report links to the same master issue', r2.body.issueId === issueId, `duplicate=${r2.body.duplicateOfExistingIssue}`);
  check('no second repair ticket created', r2.body.duplicateOfExistingIssue === true);

  const distinct = await submit(student2, {
    title: 'Different problem at the same spot',
    spot: spotId,
    category: otherCat,
  });
  check('a different category creates a distinct issue', distinct.body.issueId !== issueId);

  // ------------------------------------------------------------ permission
  console.log('\nAUTHORIZATION');
  const studentApprove = await api('POST', `/v1/issues/${issueId}/approve`, { token: student, json: {} });
  check('student cannot approve an issue', studentApprove.status === 403, `code=${studentApprove.body.error?.code}`);
  const studentResolve = await api('POST', `/v1/issues/${issueId}/resolve`, {
    token: student,
    json: { resolutionNote: 'Trying to resolve as a student.' },
  });
  check('student cannot resolve an issue', studentResolve.status === 403);
  const studentQueue = await api('GET', '/v1/issues', { token: student });
  check('student cannot browse the operational queue', studentQueue.status === 403);

  const evidenceOther = await fetch(`${BASE}/v1/reports/${reportId}/evidence`, {
    headers: { authorization: `Bearer ${student2}` },
  });
  check("another student cannot read the reporter's photo", evidenceOther.status === 403);
  const evidenceOwner = await fetch(`${BASE}/v1/reports/${reportId}/evidence`, {
    headers: { authorization: `Bearer ${student}` },
  });
  check('the reporter can read their own photo', evidenceOwner.status === 200);

  const escalation = await api('PATCH', '/v1/admin/users/00000000-0000-4000-8000-000000000000/role', {
    token: student,
    json: { role: 'ADMIN' },
  });
  check('student cannot change roles', escalation.status === 403);

  // -------------------------------------------------------------- lifecycle
  console.log('\nISSUE LIFECYCLE (HOD)');
  const skip = await api('POST', `/v1/issues/${issueId}/start`, { token: hod, json: {} });
  check('cannot skip APPROVED', skip.status === 409, `code=${skip.body.error?.code}`);

  const claim = await api('POST', `/v1/issues/${issueId}/claim`, { token: hod, json: {} });
  check('HOD claims the issue', claim.status === 200, `status=${claim.body.issue?.status}`);

  const approve = await api('POST', `/v1/issues/${issueId}/approve`, { token: hod, json: { reason: 'Verified on site' } });
  check('HOD approves', approve.body.issue?.status === 'APPROVED');

  const start = await api('POST', `/v1/issues/${issueId}/start`, { token: hod, json: {} });
  check('HOD starts work', start.body.issue?.status === 'IN_PROGRESS');

  const noNote = await api('POST', `/v1/issues/${issueId}/resolve`, { token: hod, json: { resolutionNote: '' } });
  check('resolution without a completion note refused', noNote.status === 400);

  const resolve = await api('POST', `/v1/issues/${issueId}/resolve`, {
    token: hod,
    json: { resolutionNote: 'Replaced the corroded pipe joint and sealed the ceiling.' },
  });
  check('HOD resolves with a completion note', resolve.body.issue?.status === 'RESOLVED');
  check('reports stay linked to the master issue', resolve.body.issue.reportCount >= 2, `reportCount=${resolve.body.issue?.reportCount}`);
  check('overdue flag false for a fresh issue', resolve.body.issue?.overdue === false);

  const detail = await api('GET', `/v1/issues/${issueId}`, { token: hod });
  check(
    'full status history recorded',
    detail.body.history?.length === 4,
    detail.body.history?.map((h) => h.newStatus).join(' -> '),
  );

  // ----------------------------------------------------------------- tokens
  console.log('\nTOKEN LEDGER');
  // Balances are asserted as DELTAS so this script is safely re-runnable against a
  // persistent database (it is a smoke test, not a unit test with a clean fixture).
  const beforeValidation = await api('GET', '/v1/tokens/balance', { token: student });
  const startBalance = beforeValidation.body.balance;
  check('token balance is readable and ledger-derived', Number.isInteger(startBalance), `balance=${startBalance}`);

  const validate = await api('POST', `/v1/reports/${reportId}/validation`, {
    token: hod,
    json: { validationStatus: 'AI_VALIDATED', aiConfidence: 0.92, duplicateMatchStatus: 'NO_MATCH' },
  });
  check('validated report earns 10 tokens', validate.body.tokensAwarded === 10, `key=${validate.body.idempotencyKey}`);

  const retry = await api('POST', `/v1/reports/${reportId}/validation`, {
    token: hod,
    json: { validationStatus: 'AI_VALIDATED', aiConfidence: 0.92 },
  });
  check('retrying the same award is idempotent', retry.body.tokensAwarded === 0 && retry.body.alreadyAwarded === true);

  const afterValidation = await api('GET', '/v1/tokens/balance', { token: student });
  check(
    'balance increased by exactly one award',
    afterValidation.body.balance === startBalance + 10,
    `${startBalance} -> ${afterValidation.body.balance}`,
  );

  const reverse = await api('POST', '/v1/tokens/reverse', {
    token: hod,
    json: { reportId, reason: 'Smoke test: demonstrating an auditable reversal' },
  });
  check('authorized reversal with reason succeeds', reverse.status === 200, `amount=${reverse.body.amount}`);

  const afterReverse = await api('GET', '/v1/tokens/balance', { token: student });
  check(
    'balance returns to its starting value after the reversal',
    afterReverse.body.balance === startBalance,
    `${afterValidation.body.balance} -> ${afterReverse.body.balance}`,
  );

  // Scoped to THIS run's report, so previous runs do not affect the assertion.
  const ledger = await api('GET', '/v1/tokens/transactions?limit=100', { token: student });
  const forThisReport = ledger.body.items.filter((t) => t.reportId === reportId);
  check(
    'ledger holds exactly one credit and one reversal for this report',
    forThisReport.length === 2 &&
      forThisReport.some((t) => t.transactionType === 'CREDIT') &&
      forThisReport.some((t) => t.transactionType === 'REVERSAL'),
    forThisReport.map((t) => t.transactionType + ':' + t.amount).join(', '),
  );
  check(
    'idempotency key is recorded on the credit',
    forThisReport.find((t) => t.transactionType === 'CREDIT')?.idempotencyKey === 'report:' + reportId + ':validated-credit',
  );

  // ------------------------------------------------------- isolation, events
  console.log('\nISOLATION, EVENTS, OPERATIONS');
  const realQueue = await api('GET', '/v1/issues', { token: realAdmin });
  check('real workspace queue is empty (demo data isolated)', realQueue.body.total === 0);

  const demoQueue = await api('GET', '/v1/issues', { token: hod });
  const realIssueIds = new Set(realQueue.body.items.map((i) => i.id));
  check('demo queue contains only demo issues', demoQueue.body.items.every((i) => !realIssueIds.has(i.id)));

  const events = await api('GET', '/v1/events/types', { token: hod });
  // Phase 2 adds seven AI-pipeline events to the nine Phase 1 verbs. The Phase 1 nine
  // must all survive, so clients written against them keep working.
  const PHASE1_EVENTS = ['report.created', 'report.validated', 'issue.created', 'issue.duplicate_linked',
    'issue.status_changed', 'issue.claimed', 'issue.resolved', 'token.credited', 'token.reversed'];
  const types = events.body.eventTypes ?? [];
  check('event contract declares all Phase 1 types',
    PHASE1_EVENTS.every((t) => types.includes(t)), `missing: ${PHASE1_EVENTS.filter((t) => !types.includes(t)).join(',') || 'none'}`);
  check('event contract declares the Phase 2 AI events',
    ['report.analysis_completed', 'report.analysis_failed', 'report.review_required'].every((t) => types.includes(t)),
    `${types.length} event types total`);
  check('live transport honestly reported as not implemented', events.body.liveTransport === 'NOT_IMPLEMENTED');

  const stream = await api('GET', '/v1/events/stream', { token: hod });
  check('live stream endpoint returns 501 (not faked)', stream.status === 501);

  /*
   * The AI checks follow the server's OWN declared state rather than assuming one. The first
   * version hard-coded "unconfigured", so the moment AI_PROVIDER=local-clip was switched on
   * for the demo, the smoke test failed a perfectly honest server. Both states are checked
   * strictly: unconfigured must answer 501 (never a fabricated result), configured must
   * answer 200 naming the real provider and a score in [0, 1].
   */
  const aiStatus = await api('GET', '/v1/admin/ai/status', { token: admin });
  check('AI status is reported', aiStatus.status === 200, `provider=${aiStatus.body.provider}`);
  const aiConfigured = aiStatus.body.configured === true;

  const analyze = await api('POST', `/v1/reports/${reportId}/analyze`, { token: hod });
  if (aiConfigured) {
    check(
      'AI analysis runs the configured model (real result, not faked)',
      analyze.status === 200 &&
        analyze.body.provider === aiStatus.body.provider &&
        (analyze.body.confidence === null ||
          (analyze.body.confidence >= 0 && analyze.body.confidence <= 1)),
      `HTTP ${analyze.status} status=${analyze.body.status} confidence=${analyze.body.confidence}`,
    );
  } else {
    check('AI analysis returns 501 while unconfigured (not faked)', analyze.status === 501, `HTTP ${analyze.status}`);
  }

  const reviewQueue = await api('GET', '/v1/admin/review-queue', { token: hod });
  check('review queue is reachable and returns a shape', reviewQueue.status === 200 && Array.isArray(reviewQueue.body.items),
    `count=${reviewQueue.body.count}`);

  const summary = await api('GET', '/v1/admin/dashboard/summary', { token: hod });
  check('dashboard summary serves authoritative counts', summary.status === 200, `total=${summary.body.counts?.total}`);

  const outbox = await api('GET', '/v1/admin/outbox', { token: admin });
  check('durable outbox holds the emitted events', outbox.body.pendingCount > 0, `pending=${outbox.body.pendingCount}`);

  const audit = await api('GET', '/v1/admin/audit', { token: admin });
  check('sensitive actions are audited', audit.body.items?.length > 0, `entries=${audit.body.items?.length}`);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`──────────────────────────────────────────────\n`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('\nSmoke test aborted:', err.message);
  console.error('Is the API running?  npm start');
  process.exit(1);
});

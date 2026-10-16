// Probe (Phase 5): a real duplicate suggestion, decided by an HOD in the real UI.
//
// No mocks. Two DEMO students photograph waste in the SAME block at two DIFFERENT spots,
// choosing the same category. The background worker runs the configured model; the server
// rule (same block + same category + different spot + within 72 h) must produce a
// SUGGESTION, not a merge. The HOD then confirms it in the browser and the merge is
// checked through the API. Needs the API (3001) and the website (5173) running.
//
//   node tools/probes/duplicate-ui.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const PASSWORD = 'CampusDemo#2026';
const photo = readFileSync('fixtures/ai/waste-accumulation-01.jpg');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`);
  return ok;
};
async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(`${API}${url}`, { method, headers, body });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}
const login = async (email) => (await api('POST', '/v1/auth/login', { json: { email, password: PASSWORD } })).body.accessToken;

const student = await login('student@demo.dsu.edu.in');
const student2 = await login('student2@demo.dsu.edu.in');
const hod = await login('hod@demo.dsu.edu.in');

// A block with at least two spots; the waste category.
const blocks = (await api('GET', '/v1/campus/blocks', { token: student })).body.items;
let block = null;
let spots = [];
for (const b of [...blocks].reverse()) {
  const s = (await api('GET', `/v1/campus/blocks/${b.id}/spots`, { token: student })).body.items;
  if (s.length >= 2) { block = b; spots = s; break; }
}
const category = (await api('GET', '/v1/campus/categories', { token: student })).body.items.find((c) => /waste/i.test(c.slug));
console.log(`block=${block?.officialName} spots=${spots[0]?.officialName ?? spots[0]?.name} / ${spots[1]?.officialName ?? spots[1]?.name} category=${category?.slug}`);

async function submit(token, spot) {
  const ticket = await api('POST', '/v1/reports/capture-sessions', { token });
  const form = new FormData();
  form.set('blockId', block.id);
  form.set('spotId', spot.id);
  form.set('selectedCategoryId', category.id);
  form.set('title', `Duplicate probe ${new Date().toISOString().slice(11, 19)}`);
  form.set('description', 'Phase 5 duplicate-suggestion probe (DEMO data).');
  form.set('captureToken', ticket.body.captureToken);
  form.set('photo', new Blob([Buffer.concat([photo, randomBytes(12)])], { type: 'image/jpeg' }), 'capture.jpg');
  return api('POST', '/v1/reports', { token, form });
}

console.log('\n1. TWO STUDENTS, SAME BLOCK, DIFFERENT SPOTS, SAME CATEGORY');
const first = await submit(student, spots[0]);
check('first report accepted', first.status === 200, first.body?.issuePublicReference);
const second = await submit(student2, spots[1]);
check('second report accepted', second.status === 200, second.body?.issuePublicReference);
check('different spots never auto-merge: two tickets', first.body.issueId !== second.body.issueId);

console.log('\n2. THE WORKER ANALYSES BOTH; THE RULE PRODUCES A SUGGESTION');
let suggestion = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !suggestion) {
  const list = await api('GET', '/v1/duplicate-suggestions', { token: hod });
  const pair = [first.body.issueId, second.body.issueId];
  const between = list.body.items.filter((s) => pair.includes(s.sourceIssueId) && pair.includes(s.candidateIssueId));
  suggestion = between[0] ?? null;
  if (!suggestion) await new Promise((r) => setTimeout(r, 2000));
  // Wait one more sweep so both reports are analysed before counting directions.
  else { await new Promise((r) => setTimeout(r, 5000)); const again = await api('GET', '/v1/duplicate-suggestions', { token: hod }); var pairCount = again.body.items.filter((s) => pair.includes(s.sourceIssueId) && pair.includes(s.candidateIssueId)).length; }
}
check('a suggestion links the two tickets', Boolean(suggestion), suggestion ? `${suggestion.reasonCode} signals=${JSON.stringify(suggestion.signals)}` : 'none within 60 s');
check('exactly ONE suggestion for the pair (no mirrored duplicate)', pairCount === 1, `count=${pairCount}`);
// Whichever ticket the rule chose as the source is merged into the other.
const [src, dst, srcToken, otherToken] = suggestion?.sourceIssueId === first.body.issueId
  ? [first.body, second.body, student, student2]
  : [second.body, first.body, student2, student];
const studentView = await api('GET', `/v1/reports/${src.reportId}`, { token: srcToken });
check('the student report shows "possible duplicate"', studentView.body.report?.duplicateMatchStatus === 'CANDIDATE_FOUND', studentView.body.report?.duplicateMatchStatus);
const otherStudent = await api('GET', `/v1/reports/${src.reportId}`, { token: otherToken });
check('another student cannot read it', otherStudent.status === 403 || otherStudent.status === 404, `HTTP ${otherStudent.status}`);
const studentList = await api('GET', '/v1/duplicate-suggestions', { token: student });
check('students cannot list suggestions', studentList.status === 403, `HTTP ${studentList.status}`);

if (suggestion) {
  const before = (await api('GET', `/v1/issues/${dst.issueId}`, { token: hod })).body.linkedReportCount;
  const moving = (await api('GET', `/v1/issues/${src.issueId}`, { token: hod })).body.linkedReportCount;
  console.log('\n3. THE HOD CONFIRMS IT IN THE BROWSER');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${WEB}/login`);
  await page.fill('input[type="email"]', 'hod@demo.dsu.edu.in');
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await page.goto(`${WEB}/hod/review`);
  const card = page.locator(`[data-suggestion-id="${suggestion.id}"]`);
  await card.waitFor({ timeout: 20000 }).catch(() => {});
  check('review queue shows the suggestion card', await card.isVisible());
  const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('card states the rule, not a similarity score', /Same block and same category/.test(text) && !/%/.test(text), text.slice(0, 140));
  await page.screenshot({ path: '.artifacts/duplicate-review.png' });
  await card.locator('input').fill('Same overflowing bin, seen from the other entrance');
  await card.getByRole('button', { name: 'Same defect — merge' }).click();
  await card.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  check('card disappears after the server confirms', !(await card.isVisible().catch(() => false)));

  await page.goto(`${WEB}/hod/issues/${src.issueId}`);
  const banner = page.getByText('Merged into another issue');
  await banner.waitFor({ timeout: 15000 }).catch(() => {});
  check('merged ticket shows the "Merged into another issue" banner', await banner.isVisible());
  await page.getByRole('link', { name: 'Open the master issue →' }).click();
  await page.waitForURL(new RegExp(dst.issueId), { timeout: 15000 }).catch(() => {});
  check('banner links to the master issue', page.url().includes(dst.issueId), page.url());
  await page.screenshot({ path: '.artifacts/duplicate-master.png' });
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();

  console.log('\n4. THE SERVER STATE AFTER THE MERGE');
  const master = await api('GET', `/v1/issues/${dst.issueId}`, { token: hod });
  // Re-runs reuse an open master at the same spot (the deterministic same-spot rule), so
  // compare counts rather than assume a fresh ticket.
  check('master gained exactly the merged ticket\'s reports', master.body.linkedReportCount === before + moving, `${before} + ${moving} -> ${master.body.linkedReportCount}`);
  const merged = await api('GET', `/v1/issues/${src.issueId}`, { token: hod });
  check('the second ticket is DUPLICATE and points at the master', merged.body.issue.status === 'DUPLICATE' && merged.body.issue.duplicateOfIssueId === dst.issueId, merged.body.issue.status);
  const after = await api('GET', `/v1/reports/${src.reportId}`, { token: srcToken });
  check('the reporting student still owns the report, now on the master', after.body.report.issueId === dst.issueId && after.body.report.duplicateMatchStatus === 'LINKED', after.body.report.duplicateMatchStatus);
  const again = await api('POST', `/v1/duplicate-suggestions/${suggestion.id}/confirm`, { token: hod, json: {} });
  check('confirming twice is refused', again.status === 409, `HTTP ${again.status}`);
}

console.log(failures === 0 ? '\nDUPLICATE UI PROBE PASSED' : `\nDUPLICATE UI PROBE: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

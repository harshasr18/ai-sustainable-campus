/**
 * THE COMPLETE JOURNEY, THROUGH THE REAL USER INTERFACE: `npm run e2e`.
 *
 * Phase 4 §12 asks for the whole path driven end to end. The API smoke test already proves the
 * backend over HTTP, but it uploads a photo with multipart and never touches the camera screen,
 * the report form, the HOD console or the student's status page. This script does — every step
 * is a click in a real Chromium on the running app.
 *
 * ABOUT THE CAMERA. Headless Chromium has no camera, so it is started with Chromium's own
 * synthetic capture device (`--use-fake-device-for-media-stream`), which feeds a generated test
 * pattern through the real getUserMedia → <video> → canvas capture path the app uses. That
 * proves the in-app capture flow works; it says nothing about what the AI makes of a test
 * pattern, and the script does not pretend otherwise — it records whatever the backend returns.
 *
 * Requires both terminals running (API + worker, website). Writes screenshots to
 * .artifacts/e2e/ (git-ignored).
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const WEB = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:5173';
const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? 'CampusDemo#2026';
const OUT = '.artifacts/e2e';
const NOTE = 'E2E journey: inspected on site and repaired; verified working.';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`);
  return ok;
}

async function api(path, token) {
  const response = await fetch(`${WEB}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function apiLogin(email) {
  const response = await fetch(`${WEB}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await response.json()).accessToken;
}

async function signIn(page, email) {
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
}

const enabledPrimary = (page) => page.locator('.btn--primary:not([disabled])');

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  /* ------------------------------------------------------------ 1. student */
  console.log('\n1. STUDENT REPORTS A DEFECT WITH THE IN-APP CAMERA');
  const studentCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const student = await studentCtx.newPage();
  await signIn(student, 'student@demo.dsu.edu.in');
  const studentToken = await apiLogin('student@demo.dsu.edu.in');
  const balanceBefore = (await api('/v1/tokens/balance', studentToken)).body.balance;

  await student.goto(`${WEB}/student/report`, { waitUntil: 'domcontentloaded' });
  check('no gallery upload control on the report screen', (await student.locator('input[type="file"]').count()) === 0);

  await student.getByRole('button', { name: 'Start camera' }).click();
  const capture = student.getByRole('button', { name: 'Capture photograph' });
  await capture.waitFor({ state: 'visible', timeout: 15000 });
  await student.waitForFunction(
    () => !document.querySelector('[aria-label="Capture photograph"]')?.hasAttribute('disabled'),
    null,
    { timeout: 15000 },
  );
  await capture.click();
  await student.getByRole('button', { name: /retake/i }).waitFor({ timeout: 10000 });
  check('photograph captured from the live camera stream', true);
  await student.screenshot({ path: `${OUT}/1-captured.png` });

  await enabledPrimary(student).last().click(); // → location
  await student.locator('#block').waitFor();
  // A block other than the first, and its last spot: reduces the chance of linking into an
  // existing issue from earlier runs. Linking would also be a valid outcome; it is reported.
  const blockOptions = await student.locator('#block option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
  await student.selectOption('#block', blockOptions[blockOptions.length - 1]);
  await student.waitForFunction(() => document.querySelectorAll('#spot option').length > 1, null, { timeout: 10000 });
  const spotOptions = await student.locator('#spot option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
  await student.selectOption('#spot', spotOptions[spotOptions.length - 1]);
  await enabledPrimary(student).last().click(); // → category

  await student.locator('[aria-pressed]').first().click();
  await enabledPrimary(student).last().click(); // → review
  const description = student.locator('#description');
  if (await description.count()) await description.fill('Reported by the automated end-to-end journey.');
  await student.screenshot({ path: `${OUT}/2-review.png` });

  const submitted = student.waitForResponse((r) => r.url().endsWith('/v1/reports') && r.request().method() === 'POST', {
    timeout: 30000,
  });
  await enabledPrimary(student).last().click(); // submit
  const submitResponse = await submitted;
  const submitBody = await submitResponse.json();
  if (!check('backend accepted the report', submitResponse.status() === 200, `HTTP ${submitResponse.status()}`)) {
    console.log('        server said:', JSON.stringify(submitBody.error ?? submitBody));
    const shown = await student.locator('main').innerText();
    console.log('        UI shows:', shown.split('\n').filter((l) => /could not|error|failed|not sent/i.test(l)).slice(0, 3).join(' / '));
    await student.screenshot({ path: `${OUT}/3-submit-failed.png` });
    await browser.close();
    process.exit(1);
  }
  const reportId = submitBody.reportId;
  const reference = submitBody.issuePublicReference;
  const issueId = submitBody.issueId;
  console.log(`        report ${reportId} -> issue ${reference} (${submitBody.duplicateMatchStatus ?? 'new'})`);

  await student.getByText(reference).first().waitFor({ timeout: 15000 });
  check('the student sees the real issue reference', true, reference);
  const resultText = await student.locator('main').innerText();
  check('the UI does not claim tokens were awarded at submission', !/10 awarded/.test(resultText));
  await student.screenshot({ path: `${OUT}/3-submitted.png` });
  // Strictly one browser context at a time. On a 2 GB machine the loaded model, the dev server
  // and two Chromium contexts do not fit, and steps then time out for reasons unrelated to the
  // app. The student signs in again for step 4 — which is also how a real return visit works.
  await studentCtx.close();

  /* ------------------------------------------------------------ 2. worker */
  console.log('\n2. THE BACKGROUND WORKER ANALYSES IT (no client request)');
  const hodToken = await apiLogin('hod@demo.dsu.edu.in');
  let analysis = null;
  for (let i = 0; i < 30 && !analysis; i += 1) {
    const r = await api(`/v1/reports/${reportId}/analysis`, hodToken);
    analysis = r.body?.analysis ?? null;
    if (!analysis) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const aiStatus = (await api('/v1/admin/review-queue?limit=1', hodToken)).body?.ai;
  if (aiStatus?.configured) {
    check('analysis persisted by the worker', Boolean(analysis), analysis ? `${analysis.status} confidence=${analysis.confidence}` : 'none');
  } else {
    check('AI is unconfigured, so the report honestly stays unanalysed', !analysis, 'provider unconfigured');
  }
  const afterAnalysis = (await api(`/v1/tokens/balance`, studentToken)).body.balance;
  check('no tokens credited by the AI', afterAnalysis === balanceBefore, `${balanceBefore} -> ${afterAnalysis}`);

  /* ------------------------------------------------------------ 3. HOD */
  console.log('\n3. HOD VALIDATES, APPROVES, STARTS AND RESOLVES — IN THE CONSOLE');
  const hodCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const hod = await hodCtx.newPage();
  await signIn(hod, 'hod@demo.dsu.edu.in');
  await hod.goto(`${WEB}/hod/issues/${issueId}`, { waitUntil: 'domcontentloaded' });
  await hod.getByText(reference).first().waitFor({ timeout: 15000 });

  const claim = hod.getByRole('button', { name: 'Claim this issue' });
  if (await claim.count()) {
    await claim.click();
    const confirm = hod.getByRole('button', { name: 'Claim it' });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await hod.getByText('You have claimed this issue.').waitFor({ timeout: 10000 });
  }
  check('issue claimed', true);

  // Validate THIS report — the one submitted in step 1 — located by its stable id. An earlier
  // version clicked the first Validate button on the ticket, which validated a DIFFERENT report
  // by the same student; the balance still rose by 10, so the check passed for the wrong reason.
  const validate = hod.locator(`[data-report-id="${reportId}"]`).getByRole('button', { name: 'Validate…' });
  if (await validate.count()) {
    await validate.click();
    await hod.locator('input[name="verdict"][value="HUMAN_VALIDATED"]').check();
    const recorded = hod.waitForResponse((r) => r.url().includes('/validation') && r.request().method() === 'POST');
    await hod.getByRole('button', { name: 'Record verdict' }).click();
    const response = await recorded;
    const body = await response.json();
    check('human validation recorded', response.status() === 200, `tokensAwarded=${body.tokensAwarded}`);
  } else {
    check('a Validate action is offered for the pending report', false);
  }

  if ((await api(`/v1/issues/${issueId}`, hodToken)).body.issue.status !== 'IN_PROGRESS') {
    check(
      'Resolve is not offered before work has started',
      (await hod.getByRole('button', { name: 'Resolve with a completion note…' }).count()) === 0,
    );
  }

  // The "Full photo" control must actually show the photograph (it used to be a link that 401'd).
  await hod.locator(`[data-report-id="${reportId}"]`).getByRole('button', { name: 'Full photo' }).click();
  const fullPhoto = await hod
    .waitForFunction(
      () => {
        const img = document.querySelector('[role="dialog"] .detail-photo img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      null,
      { timeout: 15000 },
    )
    .then(() => true, () => false);
  check('HOD "Full photo" opens the authorised photograph', fullPhoto);
  await hod.keyboard.press('Escape');

  // Perform only the transitions the issue still needs. A report can legitimately be LINKED
  // into an issue another run already moved forward; that is the duplicate path working.
  const ORDER = ['SUBMITTED', 'APPROVED', 'IN_PROGRESS', 'RESOLVED'];
  const startStatus = (await api(`/v1/issues/${issueId}`, hodToken)).body.issue.status;
  console.log(`        issue status before HOD actions: ${startStatus}`);
  const needed = [['Approve', 'approve', 'APPROVED'], ['Start work', 'start', 'IN_PROGRESS']].filter(
    ([, , to]) => ORDER.indexOf(to) > ORDER.indexOf(startStatus),
  );

  for (const [label, pattern] of needed) {
    const button = hod.getByRole('button', { name: label, exact: true });
    // Wait for the re-render after the previous transition; count() alone does not wait.
    await button.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await button.count()) {
      const done = hod.waitForResponse((r) => r.url().endsWith(`/${pattern}`) && r.request().method() === 'POST');
      await button.click();
      const response = await done;
      check(`${label} accepted by the server`, response.status() === 200, `HTTP ${response.status()}`);
    } else {
      check(`${label} offered`, false, 'button not present');
    }
  }

  const resolveButton = hod.getByRole('button', { name: 'Resolve with a completion note…' });
  await resolveButton.waitFor({ state: 'visible', timeout: 10000 });
  await resolveButton.click();
  const markResolved = hod.getByRole('button', { name: 'Mark resolved' });
  check('resolution is blocked without a note', await markResolved.isDisabled());
  await hod.locator('.modal textarea, [role="dialog"] textarea').first().fill(NOTE);
  const resolved = hod.waitForResponse((r) => r.url().endsWith('/resolve') && r.request().method() === 'POST');
  await markResolved.click();
  const resolveResponse = await resolved;
  check('resolve accepted with a completion note', resolveResponse.status() === 200, `HTTP ${resolveResponse.status()}`);
  await hod.reload({ waitUntil: 'domcontentloaded' });
  await hod.getByText(NOTE).first().waitFor({ timeout: 10000 });
  check('after a refresh the note and resolution persist', true);
  await hod.screenshot({ path: `${OUT}/4-hod-resolved.png`, fullPage: false });
  // One browser context at a time from here: on a small machine three live contexts plus the
  // loaded model exhaust memory and every later step times out for reasons unrelated to the app.
  await hodCtx.close();

  /* ------------------------------------------------------------ 4. student again */
  console.log('\n4. THE STUDENT SEES THE SERVER-CONFIRMED OUTCOME');
  const studentCtx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const studentAgain = await studentCtx2.newPage();
  await signIn(studentAgain, 'student@demo.dsu.edu.in');
  await studentAgain.goto(`${WEB}/student/reports/${reportId}`, { waitUntil: 'domcontentloaded' });
  const resolvedShown = await studentAgain
    .locator('main')
    .getByText('Resolved', { exact: true })
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  check('the report page shows the issue as Resolved', resolvedShown);
  const photoLoaded = await studentAgain
    .waitForFunction(
      () => {
        const img = document.querySelector('.detail-photo img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      null,
      { timeout: 20000 },
    )
    .then(() => true, () => false);
  check('the student sees their own photograph (authorised blob)', photoLoaded);
  const balanceAfter = (await api('/v1/tokens/balance', studentToken)).body.balance;
  check('balance rose by exactly 10', balanceAfter === balanceBefore + 10, `${balanceBefore} -> ${balanceAfter}`);
  const ledger = (await api('/v1/tokens/transactions?limit=100', studentToken)).body.items ?? [];
  const ownCredits = ledger.filter((t) => t.reportId === reportId);
  check(
    'the credit is recorded against THIS report, once',
    ownCredits.length === 1 && ownCredits[0].amount === 10,
    `${ownCredits.length} ledger row(s) for ${reportId.slice(0, 8)}`,
  );
  const reportPanel = await studentAgain.locator('main').innerText();
  check('the report page no longer says it is awaiting validation', !/Awaiting validation/.test(reportPanel));
  await studentAgain.screenshot({ path: `${OUT}/5-student-resolved.png`, fullPage: true });
  await studentCtx2.close();

  /* ------------------------------------------------------------ 5. admin */
  console.log('\n5. ADMIN SEES THE SAME RECORD');
  const adminCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const admin = await adminCtx.newPage();
  await signIn(admin, 'admin@demo.dsu.edu.in');
  await admin.goto(`${WEB}/admin/issues`, { waitUntil: 'domcontentloaded' });
  const listed = await admin.getByText(reference).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  check('the issue appears in the admin issue list', listed);
  await admin.goto(`${WEB}/admin/issues/${issueId}`, { waitUntil: 'domcontentloaded' });
  await admin.getByText(NOTE).first().waitFor({ timeout: 10000 });
  check('admin opens the same issue with the HOD\'s completion note', true);
  await admin.goto(`${WEB}/admin/twin`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('canvas', { timeout: 20000 });
  await admin.waitForTimeout(2000);
  check('the twin renders with the updated records', (await admin.locator('table tbody tr').count()) > 0);
  await admin.screenshot({ path: `${OUT}/6-admin-twin.png` });

  await browser.close();
  console.log(`\n${failures === 0 ? 'E2E JOURNEY PASSED' : `E2E JOURNEY FAILED — ${failures} problem(s)`}  (screenshots in ${OUT}/)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nE2E journey crashed:', error.message);
  process.exit(1);
});

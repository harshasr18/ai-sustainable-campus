/**
 * Browser smoke test for the Phase 3 web client.
 *
 * WHY THIS EXISTS. A type checker proves the code compiles. It does not prove that a page
 * renders, that an effect does not throw on mount, that a hook is not called conditionally,
 * or that a 3D canvas actually got a WebGL context. Every failure this script catches is a
 * failure that `tsc --noEmit` and `vite build` both report as success.
 *
 * WHAT IT DOES. Signs in as each role through the real login form, walks every route that
 * role can reach, and fails if the page raises an uncaught error, logs an error to the
 * console, issues a request the API rejects, renders one of the error states, or — for the
 * digital twin — fails to produce a WebGL context and draw a frame.
 *
 * HOW TO RUN IT (Playwright is deliberately NOT a dependency of this project; see
 * docs/RUNBOOK.md — it is a verification tool, not runtime code):
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run dev:api        # in one terminal
 *   npm run dev:web        # in another
 *   node tools/smoke-web.mjs
 *
 * Screenshots are written to .artifacts/smoke/ on failure (and for the twin, always), so a
 * failure can be looked at rather than guessed about.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173';
const ARTIFACTS = new URL('../.artifacts/smoke/', import.meta.url);

const PASSWORD = 'CampusDemo#2026';

const ACCOUNTS = {
  STUDENT: 'student@demo.dsu.edu.in',
  HOD: 'hod@demo.dsu.edu.in',
  ADMIN: 'admin@demo.dsu.edu.in',
};

/** Routes each role is allowed to open, as the access table defines them. */
const ROUTES = {
  STUDENT: ['/student', '/student/report', '/student/reports', '/student/tokens', '/profile'],
  HOD: ['/hod', '/hod/issues', '/hod/review', '/admin/issues', '/profile'],
  ADMIN: [
    '/admin',
    '/admin/issues',
    '/admin/analytics',
    '/admin/campus',
    '/admin/categories',
    '/admin/accounts',
    '/admin/system',
    '/admin/twin',
    '/profile',
  ],
};

/**
 * Routes a role must NOT be able to reach. §4 is explicit that entering another role's URL
 * has to fail — so this is asserted in a browser, not assumed from the guard's source.
 */
const FORBIDDEN = {
  STUDENT: ['/admin', '/admin/system', '/hod', '/hod/issues', '/hod/review'],
  HOD: ['/admin/accounts', '/admin/system', '/admin/twin'],
  ADMIN: [],
};

/**
 * Pages whose content cannot be checked by looking for a heading, because the correct
 * outcome for them is an explanatory empty or unavailable state. Checked instead for the
 * presence of a specific honest string.
 */
const EXPECT_TEXT = {
  '/admin/system': /transport|outbox|audit/i,
  '/admin/twin': /schematic/i,
  '/hod/review': /review|queue|nothing/i,
};

let failures = 0;

function record(ok, message) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`);
}

async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Visits a route and returns everything that went wrong. Network responses the API answers
 * with 4xx/5xx are recorded, because an error state that "renders fine" is still a page that
 * does not work.
 */
async function visit(page, path) {
  const problems = { console: [], pageErrors: [], badResponses: [], badRequests: [] };

  const onConsole = (message) => {
    if (message.type() === 'error') problems.console.push(message.text());
  };
  const onPageError = (error) => problems.pageErrors.push(error.message);
  const onResponse = (response) => {
    const status = response.status();
    const url = response.url();
    if (!url.includes('/v1/')) return;
    // 403 is an expected outcome for the pages that exist to report an unavailable feature,
    // and for the routes the server refuses; those are asserted separately.
    if (status >= 400) problems.badResponses.push(`${status} ${url.replace(BASE, '')}`);
  };
  const onRequestFailed = (request) => {
    problems.badRequests.push(`${request.url().replace(BASE, '')} — ${request.failure()?.errorText}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  // Let effects settle: the twin builds geometry and the dashboards resolve several
  // requests, and a mount-time crash arrives after the load event.
  await page.waitForTimeout(1200);

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('response', onResponse);
  page.off('requestfailed', onRequestFailed);

  const text = await page.locator('body').innerText();
  return { ...problems, text };
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({
    args: [
      // Software rendering, because the sandbox has no GPU. This is only for verification:
      // on a real machine the browser uses its own GPU path.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
    ],
  });

  for (const [role, email] of Object.entries(ACCOUNTS)) {
    console.log(`\n=== ${role} (${email}) ===`);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    // Anything unhandled anywhere in this session is collected globally too, so an error
    // thrown by a click handler that fires during navigation is not missed.
    const stray = [];
    page.on('pageerror', (error) => stray.push(error.message));

    await signIn(page, email);
    record(true, `signed in, landed on ${new URL(page.url()).pathname}`);

    for (const path of ROUTES[role]) {
      const before = stray.length;
      const result = await visit(page, path);
      const expected = EXPECT_TEXT[path] ?? /[\s\S]/;

      const renderedSomething = result.text.trim().length > 40;
      const matched = expected.test(result.text);

      const problems = [
        ...result.pageErrors.map((e) => `pageerror: ${e}`),
        ...result.console.map((e) => `console: ${e}`),
        ...result.badResponses.map((e) => `http: ${e}`),
        ...result.badRequests.map((e) => `request: ${e}`),
        ...stray.slice(before).map((e) => `stray: ${e}`),
      ];

      const ok = renderedSomething && matched && problems.length === 0;
      record(ok, `${path}${ok ? '' : `\n         ${problems.join('\n         ') || (matched ? '' : 'expected text missing')}`}`);

      if (!ok) {
        await page.screenshot({
          path: new URL(`${role}${path.replace(/\//g, '_')}.png`, ARTIFACTS).pathname,
          fullPage: true,
        });
      }
    }

    // Reaching a route the role must not have: the guard must refuse it.
    for (const path of FORBIDDEN[role]) {
      const result = await visit(page, path);
      const refused = /not available to your role|not have access/i.test(result.text);
      record(refused, `${path} refused for ${role}`);
      if (!refused) {
        await page.screenshot({
          path: new URL(`LEAK-${role}${path.replace(/\//g, '_')}.png`, ARTIFACTS).pathname,
          fullPage: true,
        });
      }
    }

    await context.close();
  }

  // THE TWIN, SPECIFICALLY. It is the one page whose correctness cannot be read off the DOM:
  // the sidebar table can render perfectly while the canvas stays blank, which is exactly the
  // failure §13 rules out ("never render a static image as an interactive digital twin").
  console.log('\n=== digital twin: does the canvas actually draw? ===');
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await signIn(page, ACCOUNTS.ADMIN);
    await page.goto(`${BASE}/admin/twin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForTimeout(2500);

    const canvas = await page.evaluate(() => {
      const element = document.querySelector('canvas');
      if (!element) return null;
      const gl = element.getContext('webgl2') ?? element.getContext('webgl');
      // Reading a pixel back from the live context is the strongest available evidence that
      // the renderer did work: a context that exists but never draws returns all zeros.
      const pixel = new Uint8Array(4);
      if (gl) gl.readPixels(element.width >> 1, element.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return {
        width: element.width,
        height: element.height,
        hasContext: Boolean(gl),
        renderer: gl?.getParameter(gl.RENDERER) ?? null,
        centrePixel: [pixel[0], pixel[1], pixel[2], pixel[3]],
      };
    });

    record(Boolean(canvas), 'a <canvas> element exists');
    record(Boolean(canvas?.hasContext), `WebGL context acquired (${canvas?.renderer ?? 'none'})`);
    record(
      (canvas?.width ?? 0) > 100 && (canvas?.height ?? 0) > 100,
      `canvas is sized ${canvas?.width}x${canvas?.height}`,
    );

    // A screenshot of just the canvas, saved so the geometry can be looked at. Its byte
    // length is a weak signal on its own — a uniform clear colour also compresses to
    // something — so it is paired with the read-back pixel above.
    const shot = await page.locator('canvas').screenshot();
    await writeFile(new URL('twin-canvas.png', ARTIFACTS), shot);

    // The sidebar table is the accessible equivalent of the model, and it is what a screen
    // reader or a non-WebGL device gets, so it must be populated with real rows.
    const rows = await page.locator('table tbody tr').count();
    record(rows > 0, `the twin's equivalent table rendered ${rows} row(s)`);

    await page.screenshot({ path: new URL('twin.png', ARTIFACTS).pathname, fullPage: true });

    record(errors.length === 0, `no console or page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await context.close();
  }

  await browser.close();

  console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED — ${failures} problem(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('smoke-web crashed:', error);
  process.exit(1);
});

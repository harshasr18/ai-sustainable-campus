/**
 * Viewport screenshots for visual review: `npm run screens`.
 *
 * Deliberately NOT full-page captures. A full-page capture lays out sticky elements (the
 * sidebar, the top bar) against a stretched viewport, which produces bands and gaps that a
 * real window never shows. These are taken the way a person sees the app: a fixed window,
 * scrolled to a position.
 *
 * Writes to .artifacts/screens/ (git-ignored).
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:5173';
const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? 'CampusDemo#2026';
const OUT = '.artifacts/screens';

async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
  await page.waitForTimeout(800);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });

  // Desktop admin: twin at the top, then scrolled to the bottom to check the sticky sidebar.
  {
    const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
    await signIn(page, 'admin@demo.dsu.edu.in');
    await page.goto(`${BASE}/admin/twin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/admin-twin-top.png` });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/admin-twin-scrolled.png` });
    await page.close();
  }

  // Narrow phone: the student's own report list and the first report's detail, with its photo.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await signIn(page, 'student@demo.dsu.edu.in');
    await page.goto(`${BASE}/student/reports`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/student-reports-mobile.png` });
    const first = page.locator('a[href^="/student/reports/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForTimeout(3000);
      const images = await page.evaluate(() =>
        [...document.querySelectorAll('img')].map((img) => ({
          src: img.src.slice(0, 20),
          loaded: img.complete && img.naturalWidth > 0,
          width: img.naturalWidth,
        })),
      );
      console.log('report detail images:', JSON.stringify(images));
      await page.screenshot({ path: `${OUT}/student-report-detail-mobile.png` });
    } else {
      console.log('no report links found on /student/reports');
    }
    await page.close();
  }

  await browser.close();
  console.log(`screenshots written to ${OUT}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

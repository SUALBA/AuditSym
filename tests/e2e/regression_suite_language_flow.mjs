// ═════════════════════════════════════════════════════════════════════════
// AuditSym — Cross-Page Language Propagation E2E Regression Suite
// ═════════════════════════════════════════════════════════════════════════
// Covers issue #37 (landing i18n + cross-page language sync) and the
// review round that found the real bug: the shared key
// (auditsym_shared_lang) existed and was written correctly on every
// explicit language choice, but each page's OWN key was read with
// higher priority at load time — meaning that after a page had ever
// been visited once, it would never again pick up a more recent choice
// made on a different page. "Synchronize across all three pages" only
// held true for a page's very first visit, not for genuine ongoing sync.
//
// This suite serves all three real AuditSym pages (landing, audit
// engine, Remediation Hub) from the same origin in one server, exactly
// as they'd be deployed side by side in the same directory, and
// exercises real cross-page navigation in one shared browser context —
// never mocking localStorage directly, since the bug was specifically
// about the READ-PRIORITY ORDER at each page's own init time.
//
// SETUP (one time):
//   npm install playwright
//   npx playwright install chromium
//
// USAGE — place this file at repo-root/tests/e2e/regression_suite_language_flow.mjs:
//   node tests/e2e/regression_suite_language_flow.mjs
//
// Reads the repo's own ui/*.html directly:
//   AUDITSYM_LANDING_HTML=path/to/landingPAge.html \
//   AUDITSYM_ENGINE_HTML=path/to/auditnist-local.html \
//   AUDITSYM_HUB_HTML=path/to/remediation-hub.html \
//   node tests/e2e/regression_suite_language_flow.mjs
// ═════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANDING_HTML = process.env.AUDITSYM_LANDING_HTML || path.join(__dirname, '..', '..', 'ui', 'landingPAge.html');
const ENGINE_HTML = process.env.AUDITSYM_ENGINE_HTML || path.join(__dirname, '..', '..', 'ui', 'auditnist-local.html');
const HUB_HTML = process.env.AUDITSYM_HUB_HTML || path.join(__dirname, '..', '..', 'ui', 'remediation-hub.html');
const PORT = 8967;

let passCount = 0, failCount = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n▶ ${title}`); }

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const routes = { '/index.html': LANDING_HTML, '/auditnist-local.html': ENGINE_HTML, '/remediation-hub.html': HUB_HTML };
      const filePath = routes[req.url];
      if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  for (const [label, p] of [['landing', LANDING_HTML], ['engine', ENGINE_HTML], ['hub', HUB_HTML]]) {
    if (!fs.existsSync(p)) {
      console.error(`${label} file not found: ${p}\nSet the AUDITSYM_*_HTML env vars or place the three .html files under ui/.`);
      process.exit(1);
    }
  }

  const server = await startServer();
  const browser = await chromium.launch();

  try {
    // ═══════════════════════════════════════════════════════════════════
    section('1. Fresh visitor — English default on all three pages, nothing saved anywhere');
    {
      const ctx = await browser.newContext();
      const landing = await ctx.newPage();
      await landing.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await landing.waitForTimeout(500);
      check('Landing defaults to English for a brand-new visitor', await landing.evaluate(() => currentLang) === 'en');
      await landing.close();

      const engine = await ctx.newPage();
      await engine.goto(`http://localhost:${PORT}/auditnist-local.html`, { waitUntil: 'domcontentloaded' });
      await engine.waitForTimeout(800);
      check('Engine defaults to English for a brand-new visitor', await engine.evaluate(() => currentLang) === 'en');
      await engine.close();

      const hub = await ctx.newPage();
      await hub.goto(`http://localhost:${PORT}/remediation-hub.html`, { waitUntil: 'domcontentloaded' });
      await hub.waitForTimeout(800);
      check('Hub defaults to English for a brand-new visitor', await hub.evaluate(() => state.lang) === 'en');
      await hub.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('2. Real synchronization — the most recent choice on ANY page wins on every subsequent page load, not just the first visit');
    // This is exactly the scenario the review round found broken: without
    // the fix, step 5 below would incorrectly show 'es' (the landing's
    // own previously-saved key winning over the shared one) instead of
    // 'en' (the most recently, explicitly chosen language, set on the
    // engine in step 3).
    {
      const ctx = await browser.newContext();

      const p1 = await ctx.newPage();
      await p1.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await p1.waitForTimeout(500);
      await p1.evaluate(() => onLanguagePicked('es'));
      await p1.waitForTimeout(100);
      check('Step 1: landing explicitly set to Spanish', await p1.evaluate(() => currentLang) === 'es');
      await p1.close();

      const p2 = await ctx.newPage();
      await p2.goto(`http://localhost:${PORT}/auditnist-local.html`, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(800);
      check('Step 2: engine, first visit, inherits Spanish from the shared key', await p2.evaluate(() => currentLang) === 'es');
      await p2.evaluate(() => onLanguagePicked('en'));
      await p2.waitForTimeout(100);
      check('Step 3: engine explicitly changed to English', await p2.evaluate(() => currentLang) === 'en');
      await p2.close();

      const p3 = await ctx.newPage();
      await p3.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await p3.waitForTimeout(500);
      const landingRevisit = await p3.evaluate(() => currentLang);
      check('Step 4: landing REVISITED shows English — the shared key (most recent global choice) wins over the landing\'s own previously-saved Spanish. This is the exact bug the review round found.',
        landingRevisit === 'en', `got "${landingRevisit}"`);
      await p3.close();

      const p4 = await ctx.newPage();
      await p4.goto(`http://localhost:${PORT}/remediation-hub.html`, { waitUntil: 'domcontentloaded' });
      await p4.waitForTimeout(800);
      check('Step 5: Hub, first visit, also inherits the same most-recent English choice', await p4.evaluate(() => state.lang) === 'en');
      await p4.close();

      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('3. Loading a page never writes the shared key — only an explicit choice does');
    {
      const ctx = await browser.newContext();
      const p1 = await ctx.newPage();
      await p1.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await p1.waitForTimeout(500);
      await p1.evaluate(() => onLanguagePicked('fr'));
      await p1.waitForTimeout(100);
      await p1.close();

      // Merely loading the engine (never touching its language selector)
      // must not change the shared key, even though the engine's own
      // init reads and applies it.
      const p2 = await ctx.newPage();
      await p2.goto(`http://localhost:${PORT}/auditnist-local.html`, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(800);
      const sharedAfterMereLoad = await p2.evaluate(() => localStorage.getItem('auditsym_shared_lang'));
      check('Simply loading a page (no explicit language change) leaves the shared key untouched', sharedAfterMereLoad === 'fr');
      await p2.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('4. Hub offers all 7 languages and applies RTL for Arabic');
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/remediation-hub.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const options = await page.evaluate(() => Array.from(document.getElementById('lang-select').options).map(o => o.value));
      check('Hub language selector offers all 7 languages, not just 5', ['es','en','fr','de','pt','ar','zh'].every(l => options.includes(l)), `got ${JSON.stringify(options)}`);

      await page.evaluate(() => onLanguagePicked('ar'));
      await page.waitForTimeout(100);
      check('Hub sets dir="rtl" when Arabic is selected', await page.evaluate(() => document.documentElement.dir) === 'rtl');
      await page.evaluate(() => onLanguagePicked('en'));
      await page.waitForTimeout(100);
      check('Hub reverts to dir="ltr" for a non-Arabic language', await page.evaluate(() => document.documentElement.dir) === 'ltr');
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('5. Landing i18n completeness — brand tagline and main tagline translate, not stuck in English');
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      await page.evaluate(() => onLanguagePicked('es'));
      await page.waitForTimeout(100);

      const brandTagline = await page.evaluate(() => document.querySelector('[data-i18n="brand_tagline"]')?.textContent);
      check('The header brand tagline has a data-i18n binding and translates in Spanish', brandTagline && brandTagline !== 'AI-Powered GRC Platform', `got "${brandTagline}"`);

      const mainTagline = await page.evaluate(() => document.querySelector('[data-i18n="tagline"]')?.innerHTML || '');
      check('The main hero tagline is genuinely translated in Spanish, not left as the identical English string', !mainTagline.toLowerCase().includes('cybersecurity audit platform'), `got "${mainTagline}"`);

      // Also confirm Arabic and Chinese have real dictionaries, not placeholders.
      await page.evaluate(() => onLanguagePicked('ar'));
      await page.waitForTimeout(100);
      const arBrand = await page.evaluate(() => document.querySelector('[data-i18n="brand_tagline"]')?.textContent);
      check('Arabic brand_tagline is a real translation, not a placeholder or the English string', arBrand && arBrand !== 'AI-Powered GRC Platform' && /[\u0600-\u06FF]/.test(arBrand), `got "${arBrand}"`);

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('6. Landing copy accuracy — Remediation never claims to "close" a finding, in any language');
    // Found in review: the landing's marketing copy said "manage findings
    // and close" / "uploads evidence and closes" in all 7 languages,
    // directly contradicting the M3 model this whole project just spent a
    // full session building and regression-testing: a remediation plan
    // only ever reaches ready_for_verification — it is never displayed
    // or treated as closed, and only a future M5 verification result can
    // actually close a finding. Marketing copy that says otherwise is a
    // product-accuracy bug, not just an i18n gap.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      const closureWords = {
        es: ['cierra', 'cierre'], en: ['close', 'closes', 'closing'], fr: ['clôture', 'ferme'],
        de: ['abschließ', 'schließt'], pt: ['fecha', 'fechamento'], ar: ['إغلاق', 'تغلق'], zh: ['关闭'],
      };
      let anyClosureClaimFound = false;
      const offenders = [];
      for (const lang of Object.keys(closureWords)) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(100);
        // Case-insensitive on both sides — a future copy change like
        // "Close the finding" (capital C) must still be caught even
        // though the banned-word list is written in lowercase. Harmless
        // no-op for Arabic/Chinese, which have no case distinction.
        const btnSub = (await page.evaluate(() => document.querySelector('[data-i18n="btn_remediation_sub"]')?.textContent || '')).toLowerCase();
        const flow2 = (await page.evaluate(() => document.querySelector('[data-i18n="flow2_desc"]')?.textContent || '')).toLowerCase();
        if (closureWords[lang].some(w => btnSub.includes(w.toLowerCase()) || flow2.includes(w.toLowerCase()))) {
          anyClosureClaimFound = true;
          offenders.push(lang);
        }
      }
      check('No language\'s Remediation copy claims the Hub closes a finding — it prepares/submits for verification, per the real M3→M5 model',
        !anyClosureClaimFound, offenders.length ? `found closure language in: ${offenders.join(', ')}` : '');

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('7. Landing feature-parity — contact form, LinkedIn, and Problem/Solution table brought over from the static auditsym.com page');
    // The static page previously deployed at auditsym.com had real
    // functional value this interactive landing didn't yet have: a
    // working Formspree contact form and a LinkedIn link. Bringing that
    // content over is what makes this page a genuine drop-in replacement
    // rather than just a functional demo missing real business content.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      const formAction = await page.evaluate(() => document.getElementById('contactForm')?.action);
      check('Contact form posts to the real, already-live Formspree endpoint', formAction === 'https://formspree.io/f/xeajvpyd');

      const requiredFields = await page.evaluate(() => ({
        name: document.getElementById('contact-name')?.required,
        email: document.getElementById('contact-email')?.required,
        message: document.getElementById('contact-message')?.required,
      }));
      check('Contact form marks name/email/message as required', requiredFields.name && requiredFields.email && requiredFields.message);

      const linkedinPresent = await page.evaluate(() => !!document.querySelector('a[href*="linkedin.com/in/susana-alba"]'));
      check('LinkedIn link is present (was missing entirely from the interactive landing before)', linkedinPresent);

      const rowCount = await page.evaluate(() => document.querySelectorAll('.problem-table tbody tr').length);
      check('Problem/Solution table renders all 6 rows', rowCount === 6);

      // The static page's own copy for this exact table said "sube
      // evidencias y cierra" and "100% Local-First — nunca sale del
      // navegador" — the same category of overclaiming already fixed
      // elsewhere in the landing and the README. Confirm the ported
      // version doesn't reintroduce either.
      const closureWords = { es: ['cierra'], en: ['close', 'closes'], fr: ['clôture'], de: ['schließt'], pt: ['fecha'], ar: ['إغلاق'], zh: ['关闭'] };
      let anyClosureInTable = false;
      for (const lang of Object.keys(closureWords)) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(100);
        const tableText = (await page.evaluate(() => document.querySelector('.problem-table')?.innerText || '')).toLowerCase();
        if (closureWords[lang].some(w => tableText.includes(w.toLowerCase()))) anyClosureInTable = true;
      }
      check('The ported Problem/Solution table does not reintroduce closure-claim language in any language', !anyClosureInTable);

      const has100PercentAbsolute = await page.evaluate(() => document.querySelector('.problem-table')?.innerText.includes('100%'));
      check('The ported table does not reintroduce the absolute "100% Local-First / never leaves the browser" claim', !has100PercentAbsolute);

      // The original static page's Open Source row promised "Sin
      // licencias, para siempre" (no license fees, ever) — an absolute
      // commercial promise that could box in future licensing decisions.
      // The point itself (the code is genuinely AGPL and open) is real
      // and worth keeping — just not as an irrevocable forever-promise.
      const foreverWords = { es: ['para siempre'], en: ['forever'], fr: ['pour toujours'], de: ['für immer'], pt: ['para sempre'] };
      let anyForeverPromise = false;
      for (const lang of Object.keys(foreverWords)) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(100);
        const tableText = (await page.evaluate(() => document.querySelector('.problem-table')?.innerText || '')).toLowerCase();
        if (foreverWords[lang].some(w => tableText.includes(w))) anyForeverPromise = true;
      }
      check('The Open Source row states the AGPL fact without an absolute "forever" licensing promise', !anyForeverPromise);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('8. Landing feature-parity — real product screenshots section, initially missed when porting content from the static page');
    // Found in review: the static auditsym.com page had a full "Interface
    // in Action" section with 4 real product screenshots — genuine
    // branding proof, not placeholder text. This was overlooked entirely
    // in the first port (only the contact form, LinkedIn, and
    // Problem/Solution table were reviewed), which would have quietly
    // dropped real visual proof of the product from the page. The 4
    // filenames were later consolidated with the README's own still-
    // missing screenshots (Finding+Management Response, Evidence
    // Register, Remediation Plan Detail) plus Work View, so the same 4
    // new photos serve both places instead of needing distinct sets.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      const cardCount = await page.evaluate(() => document.querySelectorAll('.screenshot-card').length);
      check('All 4 product screenshot cards render', cardCount === 4);

      const imgSrcs = await page.evaluate(() => Array.from(document.querySelectorAll('.screenshot-card img')).map(i => i.getAttribute('src')));
      const expectedSrcs = ['screenshots/vistaTrabajo2.jpg', 'screenshots/findingManagementResponse.jpg', 'screenshots/evidenceRegister.jpg', 'screenshots/remediationPlanDetail.jpg'];
      check('Screenshot paths match the shared set also referenced by the README (same 4 new photos serve both)',
        JSON.stringify(imgSrcs) === JSON.stringify(expectedSrcs), `got ${JSON.stringify(imgSrcs)}`);

      await page.close(); await ctx.close();
    }

  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log('Failed checks:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

main();

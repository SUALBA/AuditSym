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
      const expectedSrcs = ['screenshots/auditsym-work-view.jpg', 'screenshots/auditsym-finding-management-response.jpg', 'screenshots/auditsym-evidence-register.jpg', 'screenshots/auditsym-remediation-plan.jpg'];
      check('Screenshot paths match the shared set also referenced by the README (same 4 new photos serve both)',
        JSON.stringify(imgSrcs) === JSON.stringify(expectedSrcs), `got ${JSON.stringify(imgSrcs)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('9. Landing accuracy — AI providers, M3->M5 boundary in the flow cards, and logo navigation');
    // Second review round found two more overclaims that had slipped
    // past the first pass: the "Local AI" feature card still said ALL AI
    // runs locally and only listed Ollama/OpenAI/Groq (missing
    // Anthropic/OpenRouter, and implying cloud providers keep data local
    // too) — contradicting the Problem/Solution table's own correct
    // wording right above it. And the "how it works" flow's third card
    // presented "Continuous Improvement" as a finished capability,
    // contradicting the README's honest Follow-up/Verification boundary.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Only Ollama is genuinely local; the other four are optional and
      // explicitly user-configured cloud providers, never both "runs
      // locally" and "all these are compatible" in the same breath.
      const aiCardText = await page.evaluate(() => document.querySelector('[data-i18n="f2_desc"]')?.textContent || '');
      check('The AI feature card lists all 4 cloud providers (Anthropic and OpenRouter were missing)',
        aiCardText.includes('Anthropic') && aiCardText.includes('OpenRouter'), `got: "${aiCardText}"`);
      check('The AI feature card no longer claims ALL AI runs locally / no data ever leaves the machine',
        !aiCardText.toLowerCase().includes('toda la ia corre localmente') && !aiCardText.toLowerCase().includes('ningún dato sale'));

      // The third flow card must present Follow-up/Verification as the
      // next milestone, not Continuous Improvement as a finished stage.
      const flow3Title = await page.evaluate(() => document.querySelector('[data-i18n="flow3_title"]')?.textContent || '');
      check('The third flow card is Follow-up & Verification, not "Continuous Improvement" presented as done',
        /follow.?up|verificaci|vérification|verifizierung|后续跟进|المتابعة/i.test(flow3Title), `got: "${flow3Title}"`);

      const flowSub = await page.evaluate(() => document.querySelector('[data-i18n="flow_sub"]')?.textContent || '');
      check('The flow section intro no longer claims the entire lifecycle is covered end to end',
        !/cubre todo el ciclo de vida|covers the entire lifecycle|couvre tout le cycle|deckt den gesamten|cobre todo o ciclo|يغطي.*دورة الحياة الكاملة|覆盖整个生命周期/i.test(flowSub), `got: "${flowSub}"`);

      // Confirm the correctly-scoped closure mention (closure belongs to
      // Follow-up, the NEXT milestone) doesn't trip the earlier check
      // that Remediation itself never claims to close a finding.
      const flow3Desc = await page.evaluate(() => document.querySelector('[data-i18n="flow3_desc"]')?.textContent || '');
      check('Closure is mentioned only as part of the next Follow-up milestone, not attributed to Remediation itself',
        /follow.?up|verificaci|vérification|verifizierung|后续|المتابعة/i.test(await page.evaluate(() => document.querySelector('[data-i18n="flow3_title"]')?.textContent || '')) && flow3Desc.length > 0);

      // Logo/shield now return to the hero instead of jumping straight
      // into the audit engine — the CTA buttons remain the real entry
      // points, per standard landing-page convention.
      const brandHref = await page.evaluate(() => document.querySelector('a.brand')?.getAttribute('href'));
      const shieldHref = await page.evaluate(() => document.querySelector('a.shield-link')?.getAttribute('href'));
      check('Header logo now links back to the hero, not directly into the audit engine', brandHref === '#hero');
      check('The large shield graphic also links back to the hero', shieldHref === '#hero');

      // The real CTAs must still work exactly as before.
      const startHref = await page.evaluate(() => document.querySelector('a.btn-start')?.getAttribute('href'));
      const auditCtaHref = await page.evaluate(() => document.querySelector('a.btn-audit')?.getAttribute('href'));
      check('The "Start" and "Audit" CTA buttons still correctly link into the audit engine', startHref === 'auditnist-local.html' && auditCtaHref === 'auditnist-local.html');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('10. Landing accuracy — HTML fallback text and meta description no longer contradict the (already-correct) i18n dictionary');
    // Third review round found that several fixes to the i18n dictionary
    // in earlier rounds never touched the raw HTML fallback text — the
    // content actually present in the markup before setLanguage() runs,
    // which is also what a crawler or a JS-disabled browser would see.
    // A translated string being correct while its own HTML source still
    // says something else is exactly the "two truths in one file"
    // problem Vandan flagged.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const metaDesc = await page.evaluate(() => document.querySelector('meta[name="description"]')?.content || '');
      check('Meta description no longer promises data never leaves the machine',
        !metaDesc.toLowerCase().includes('sin que tus datos salgan'), `got: "${metaDesc}"`);
      check('Meta description mentions Local-First design and optional cloud providers instead',
        metaDesc.includes('Local-First') && metaDesc.includes('Ollama'));

      const f2DescRaw = await page.evaluate(() => document.querySelector('[data-i18n="f2_desc"]')?.textContent || '');
      check('The raw HTML fallback for the AI card (not just the i18n dictionary) mentions all cloud providers',
        f2DescRaw.includes('Anthropic') && f2DescRaw.includes('OpenRouter'), `got: "${f2DescRaw}"`);
      check('The raw HTML fallback for the AI card no longer claims all AI is local with no data leaving the machine',
        !f2DescRaw.toLowerCase().includes('toda la ia corre localmente'));

      const f6DescRaw = await page.evaluate(() => document.querySelector('[data-i18n="f6_desc"]')?.textContent || '');
      check('Local First card no longer says "no cloud" while the product genuinely supports optional cloud AI providers',
        !f6DescRaw.toLowerCase().includes('sin nube'), `got: "${f6DescRaw}"`);

      const flowSubRaw = await page.evaluate(() => document.querySelector('[data-i18n="flow_sub"]')?.textContent || '');
      check('The raw HTML fallback for the flow intro matches the corrected i18n dictionary, not the old "covers the entire lifecycle" claim',
        !flowSubRaw.toLowerCase().includes('cubre todo el ciclo de vida'), `got: "${flowSubRaw}"`);

      // Softer claim: "designed for real workflows" instead of "by and
      // for auditors", which overstated who actually built the product.
      let anyOverstatedNote = false;
      for (const lang of ['es', 'en', 'fr', 'de', 'pt', 'ar', 'zh']) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(80);
        const note = (await page.evaluate(() => document.querySelector('[data-i18n="screenshots_note"]')?.textContent || '')).toLowerCase();
        if (/by and for|por y para|par et pour|von und für|por e para|من قبل.*ولهم|由.*为.*设计/i.test(note)) anyOverstatedNote = true;
      }
      check('No language claims the product was designed "by and for" auditors — softened to "for real workflows"', !anyOverstatedNote);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('11. Landing restructure — Roles, Sample Report, Local-First & Human-Controlled, and Open Development sections, in the credibility-layer order');
    // Comprehensive review comparing AuditSym's landing against mature
    // GRC products (Drata, Vanta, Secureframe) found it explained WHAT
    // AuditSym is but not who it's for, what it produces, why to trust
    // it, or how to verify it before trying it. Rather than inventing
    // social proof AuditSym doesn't have yet (customer counts, logos,
    // testimonials — deliberately NOT added), this adds a "credibility
    // layer" built entirely from real, existing assets: audience roles,
    // the actual 13-page sample report, the real Local-First/human-in-
    // the-loop architecture, and honest MVP-stage transparency.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      const sectionOrder = await page.evaluate(() => Array.from(document.querySelectorAll('section[id]')).map(s => s.id));
      const expectedOrder = ['hero', 'roles', 'about', 'problem', 'screenshots', 'sample-report', 'trust', 'features', 'opendev', 'contact'];
      check('Section order matches the credibility-layer structure (Hero > Roles > Lifecycle > Problem/Solution > Screenshots > Sample Report > Local-First&Human > Features > Open Dev > Contact)',
        JSON.stringify(sectionOrder) === JSON.stringify(expectedOrder), `got ${JSON.stringify(sectionOrder)}`);

      const roleCount = await page.evaluate(() => document.querySelectorAll('.role-card').length);
      check('All 3 role cards render (Auditors, CISOs & GRC, Management & Control Owners)', roleCount === 3);

      const sampleImgSrc = await page.evaluate(() => document.querySelector('.sample-report-image img')?.getAttribute('src'));
      check('The Sample Report section uses the real executive-summary screenshot, not a placeholder',
        sampleImgSrc === 'screenshots/auditsym-sample-report-executive-summary.jpg', `got ${sampleImgSrc}`);
      const sampleLink = await page.evaluate(() => document.querySelector('.btn-sample-report')?.getAttribute('href'));
      check('The Sample Report link correctly resolves relative to ui/, one level up to docs/sample-reports/',
        sampleLink === '../docs/sample-reports/auditsym-nist-csf-2.0-sample-report.pdf', `got ${sampleLink}`);

      const trustColCount = await page.evaluate(() => document.querySelectorAll('.trust-column').length);
      check('Local-First & Human-Controlled renders as its own two-column section, not another small feature card', trustColCount === 2);

      const opendevLinks = await page.evaluate(() => Array.from(document.querySelectorAll('.opendev-links a')).map(a => a.getAttribute('href')));
      const expectedOpendevLinks = ['https://github.com/SUALBA/AuditSym', '../docs/m3-data-model-reference.en.md', 'https://github.com/SUALBA/AuditSym#-roadmap', 'https://github.com/SUALBA/AuditSym/issues'];
      check('Open Development section links to the repo, technical docs, roadmap anchor, and issues — all real, no placeholder hrefs',
        JSON.stringify(opendevLinks) === JSON.stringify(expectedOpendevLinks), `got ${JSON.stringify(opendevLinks)}`);

      // The explicit choice NOT to add fabricated social proof (customer
      // counts, "trusted by X companies", star ratings) must hold.
      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
      check('No fabricated social-proof numbers (customer counts, "trusted by", star ratings) were introduced',
        !/trusted by \d|\d+,?\d* (customers|clients|companies)|★|⭐/i.test(bodyText));

      // The final CTA now reflects the actual MVP-evaluation stage
      // rather than a generic "want to know more?".
      const contactTitle = await page.evaluate(() => document.querySelector('[data-i18n="contact_title"]')?.textContent || '');
      check('Final CTA now targets MVP evaluation interest, not a generic "want to know more"',
        /evaluat/i.test(contactTitle), `got: "${contactTitle}"`);

      // Across all 7 languages: no raw i18n keys leak, and none of the
      // new sections reintroduce closure-claim or absolute-promise
      // language in the WRONG context (Remediation/Problem-Solution/AI
      // card), while still allowing the correctly-scoped mention inside
      // the Follow-up flow card and the honest opendev MVP description.
      for (const lang of ['es', 'en', 'fr', 'de', 'pt', 'ar', 'zh']) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(80);
        const text = await page.evaluate(() => document.body.innerText);
        const hasRawKey = /roles_title|role1_title|sample_report_title|trust_title|opendev_title|opendev_link_repo/.test(text);
        check(`${lang}: no raw i18n keys leak in the new sections`, !hasRawKey);
      }

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('12. Landing polish — Trust subtitle tone, page-count staleness risk, footer contradiction, and "AI-Powered" vs "AI-Assisted" positioning');
    // Fourth review round: the Trust subtitle read as defensive ("not a
    // marketing promise"); the Sample Report description hard-coded "13
    // pages", which will silently go stale the next time the report is
    // regenerated with more content; the footer still claimed "all data
    // stays local" right after the page correctly explained optional
    // cloud providers elsewhere; and "AI-Powered" contradicts the
    // product's own human-in-the-loop philosophy — the AI never powers
    // the decision, it assists it.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      const trustSub = await page.evaluate(() => document.querySelector('[data-i18n="trust_sub"]')?.textContent || '');
      check('Trust subtitle states the principle directly instead of defensively denying it\'s a marketing promise',
        !/not a marketing promise|no una promesa de marketing|pas une promesse marketing|kein marketingversprechen|não uma promessa de marketing|وعدًا تسويقيًا|营销承诺/i.test(trustSub), `got: "${trustSub}"`);

      const sampleDesc = await page.evaluate(() => document.querySelector('[data-i18n="sample_report_desc"]')?.textContent || '');
      check('Sample Report description no longer hard-codes a specific page count that will go stale on regeneration',
        !/13\s*(pages|páginas|pages|seiten|páginas|صفحة|页)/i.test(sampleDesc), `got: "${sampleDesc}"`);

      const footerText = await page.evaluate(() => document.querySelector('[data-i18n="footer_text"]')?.textContent || '');
      check('Footer no longer contradicts the optional-cloud-providers explanation by claiming all data stays local',
        !/all data stays local|todos los datos quedan en local|données restent locales|daten bleiben lokal|dados ficam locais|البيانات محلية|数据均保留在本地/i.test(footerText), `got: "${footerText}"`);
      check('Footer now states Local-First / Open Source / Human-Controlled as the brand summary',
        footerText.includes('Local-First') && footerText.includes('Open Source') && footerText.includes('Human-Controlled'));

      const brandTagline = await page.evaluate(() => document.querySelector('[data-i18n="brand_tagline"]')?.textContent || '');
      check('Header tagline no longer says "AI-Powered" — the product\'s own philosophy is that AI assists, never decides',
        brandTagline !== 'AI-Powered GRC Platform');

      const flowTitle = await page.evaluate(() => document.querySelector('[data-i18n="flow_title"]')?.textContent || '');
      check('Flow section title no longer claims the audit cycle is "complete" — Follow-up & Verification is explicitly the next milestone',
        !/complete audit flow|flujo completo de auditoría|flux complet|vollständige audit|fluxo completo|دورة التدقيق الكاملة|完整的审计流程/i.test(flowTitle), `got: "${flowTitle}"`);

      // Same checks across all 7 languages, not just the default.
      for (const lang of ['es', 'en', 'fr', 'de', 'pt', 'ar', 'zh']) {
        await page.evaluate((l) => onLanguagePicked(l), lang);
        await page.waitForTimeout(80);
        const desc = (await page.evaluate(() => document.querySelector('[data-i18n="sample_report_desc"]')?.textContent || ''));
        const footer = (await page.evaluate(() => document.querySelector('[data-i18n="footer_text"]')?.textContent || ''));
        check(`${lang}: sample report description has no stale page count`, !/\b13\b/.test(desc), `got: "${desc}"`);
        check(`${lang}: footer states the Local-First/Open Source/Human-Controlled summary`,
          footer.includes('Local-First') && footer.includes('Open Source') && footer.includes('Human-Controlled'), `got: "${footer}"`);
      }

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

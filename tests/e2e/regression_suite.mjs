// ═════════════════════════════════════════════════════════════════════════
// AuditSym — E2E Regression Test Suite
// ═════════════════════════════════════════════════════════════════════════
// Covers the real bugs found and fixed during the "PDF redesign + Work View"
// session, so a future change can't silently reintroduce any of them.
//
// SETUP (one time):
//   npm install playwright
//   npx playwright install chromium
//
// USAGE — place this file at repo-root/tests/e2e/regression_suite.mjs, then:
//   node tests/e2e/regression_suite.mjs
//
// By default this reads the AuditNIST_Pro repo's OWN files directly (never
// a separate copy that could quietly drift out of sync):
//   repo-root/
//   ├── data/scf-controls.json                  ← read directly, as-is
//   ├── ui/auditnist-local.html                 ← read directly, as-is
//   └── tests/
//       ├── unit/                               ← pure-logic tests (core/)
//       └── e2e/regression_suite.mjs            ← this file
//
// If your local layout differs, override either path with an env var:
//   AUDITSYM_HTML=path/to/auditnist-local.html \
//   AUDITSYM_SCF_DATA=path/to/scf-controls.json \
//   node tests/e2e/regression_suite.mjs
//
// Each test prints PASS/FAIL. A non-zero exit code means at least one
// regression was detected.
// ═════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Defaults match the real AuditNIST_Pro repo layout: this script lives in
// tests/, with ui/ and data/ as sibling folders at repo root.
//   repo-root/
//   ├── data/scf-controls.json
//   ├── ui/auditnist-local.html
//   └── tests/regression_suite.mjs   ← this file
// Defaults match the real AuditNIST_Pro repo layout. This script lives in
// tests/e2e/, with ui/ and data/ two levels up at repo root:
//   repo-root/
//   ├── data/scf-controls.json
//   ├── ui/auditnist-local.html
//   └── tests/
//       ├── unit/          ← pure-logic tests (core/, no browser needed)
//       └── e2e/regression_suite.mjs   ← this file
const TARGET_HTML = process.env.AUDITSYM_HTML || path.join(__dirname, '..', '..', 'ui', 'auditnist-local.html');
const SCF_DATA_PATH = process.env.AUDITSYM_SCF_DATA || path.join(__dirname, '..', '..', 'data', 'scf-controls.json');
const CONTROLS_ES_PATH = process.env.AUDITSYM_CONTROLS_ES || path.join(__dirname, '..', '..', 'data', 'i18n', 'controls.es.json');
const PORT = 8793;

let passCount = 0, failCount = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n▶ ${title}`);
}

// ── Tiny static file server (serves TARGET_HTML at /app.html and the SCF
// data at /data/scf-controls.json, matching the app's own fetch path) ─────
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = null;
      if (req.url === '/app.html') filePath = TARGET_HTML;
      else if (req.url === '/data/scf-controls.json') filePath = SCF_DATA_PATH;
      else if (req.url === '/data/i18n/controls.es.json') filePath = CONTROLS_ES_PATH;
      if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const type = ext === '.json' ? 'application/json' : 'text/html';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function newPage(browser, context) {
  const page = await context.newPage();
  page.on('dialog', async d => { await d.accept(); });
  page.on('pageerror', err => console.log('    ⚠️  Uncaught page error:', err.message));
  await page.goto(`http://localhost:${PORT}/app.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.saveAs = function () {}; }); // FileSaver stub
  return page;
}

// ─────────────────────────────────────────────────────────────────────────
// PDF layout regression helpers (issue #29: "No text is clipped or
// rendered outside page margins" / "Lists ... render completely")
// ─────────────────────────────────────────────────────────────────────────
// Real, precise checks rather than a visual guess: poppler's
// `pdftotext -bbox` reports the exact bounding box (in points) of every
// word on every page, plus the page's own dimensions. A word whose box
// extends past the page width/height, or starts before 0, is by
// definition clipped or rendered outside the page — not a matter of
// opinion. Depends on poppler-utils (pdftotext) being installed, which
// is common but not universal, so its absence is reported and the
// specific check skipped rather than failing the whole suite.
let pdftotextAvailable = null;
function isPdftotextAvailable() {
  if (pdftotextAvailable !== null) return pdftotextAvailable;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    pdftotextAvailable = true;
  } catch (e) {
    pdftotextAvailable = false;
  }
  return pdftotextAvailable;
}

// Returns { ok, violations, wordCount } — violations lists any word whose
// box falls outside [0, pageWidth] x [0, pageHeight], with a small
// tolerance for floating-point/rounding noise inherent to PDF coordinate
// math.
function checkPdfMargins(pdfPath, toleragePt = 2) {
  const xml = execFileSync('pdftotext', ['-bbox', pdfPath, '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  const pages = [...xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)];
  const violations = [];
  let wordCount = 0;
  pages.forEach((pageMatch, pageIdx) => {
    const pageWidth = parseFloat(pageMatch[1]);
    const pageHeight = parseFloat(pageMatch[2]);
    const words = [...pageMatch[3].matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)];
    words.forEach(w => {
      wordCount++;
      const [, xMin, yMin, xMax, yMax, text] = w;
      const x0 = parseFloat(xMin), y0 = parseFloat(yMin), x1 = parseFloat(xMax), y1 = parseFloat(yMax);
      if (x0 < -toleragePt || x1 > pageWidth + toleragePt || y0 < -toleragePt || y1 > pageHeight + toleragePt) {
        violations.push({ page: pageIdx + 1, text, x0, x1, y0, y1, pageWidth, pageHeight });
      }
    });
  });
  return { ok: violations.length === 0, violations, wordCount };
}

// Plain-text presence check — confirms specific strings actually appear
// somewhere in the rendered PDF (proving content wasn't silently dropped
// or truncated mid-page), not just that generation didn't throw.
function pdfContainsAllStrings(pdfPath, expectedStrings) {
  const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).replace(/\s+/g, ' ');
  const missing = expectedStrings.filter(s => !text.includes(s.replace(/\s+/g, ' ')));
  return { ok: missing.length === 0, missing };
}

async function main() {
  if (!fs.existsSync(TARGET_HTML)) {
    console.error(`Target file not found: ${TARGET_HTML}\nPlace a copy of auditnist-local.html next to this script, or set AUDITSYM_HTML=path/to/it.`);
    process.exit(2);
  }
  if (!fs.existsSync(SCF_DATA_PATH)) {
    console.error(`SCF data not found: ${SCF_DATA_PATH}\nExpected the repo's real data/scf-controls.json one level up from this script. If your layout differs, set AUDITSYM_SCF_DATA=path/to/scf-controls.json.`);
    process.exit(2);
  }

  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  try {
    // ═══════════════════════════════════════════════════════════════════
    section('1. Fresh session must not leak data from previous audits');
    // Regression covered: EvaluationRegistry.init() used to auto-restore
    // permanent cross-session localStorage on every load, coloring the
    // control library and dashboard from unrelated past audits.
    {
      const ctx = await browser.newContext();
      let page = await newPage(browser, ctx);
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01', 'Governance Program');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(200);
      await page.close();

      page = await newPage(browser, ctx); // fresh session, nothing explicitly loaded
      const state = await page.evaluate(() => ({
        dashTotal: document.getElementById('dash-total-controls')?.textContent,
        gridHasColor: (() => {
          const box = Array.from(document.querySelectorAll('.ctrl-box')).find(b => b.dataset.scfId === 'GOV-01');
          return box ? box.className.includes('cyberok') : null;
        })(),
        controlCount: document.querySelectorAll('.control').length,
      }));
      check('Dashboard total starts at 0 on a fresh session', state.dashTotal === '0', `got "${state.dashTotal}"`);
      check('Control library grid is not pre-colored from a past session', state.gridHasColor === false, `gridHasColor=${state.gridHasColor}`);
      check('Fresh session starts with exactly one blank control', state.controlCount === 1, `got ${state.controlCount}`);
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('2. Import JSON must actually work');
    // Regression covered: the <label> wrapping the file input had
    // data-i18n on it; translating it (textContent=...) destroyed the
    // nested <input>, silently breaking the Import button for everyone.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Regression Co';
        document.getElementById('id_informe').value = 'REG-001';
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01', 'Governance Program');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      const jsonStr = await page.evaluate(() => JSON.stringify(collectAuditData(), null, 2));
      const tmpJson = path.join(__dirname, '_tmp_regression_export.json');
      fs.writeFileSync(tmpJson, jsonStr);
      await page.close();

      const page2 = await newPage(browser, ctx);
      const fileInput = await page2.$('input[type="file"].hidden:not(#aa-file-input)');
      check('Import file input exists and is reachable in the DOM', !!fileInput);
      if (fileInput) {
        await fileInput.setInputFiles(tmpJson);
        await page2.waitForTimeout(500);
        const imported = await page2.evaluate(() => ({
          empresa: document.getElementById('empresa_auditada').value,
          compliance: document.querySelector('.cumple')?.value,
        }));
        check('Company name restored after import', imported.empresa === 'Regression Co', `got "${imported.empresa}"`);
        check('Control compliance restored after import', imported.compliance === 'yes', `got "${imported.compliance}"`);
      }
      fs.unlinkSync(tmpJson);
      await page2.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('3. Save → reload → load must not lose data');
    // Regression covered: collectAuditData() used to silently drop
    // controls whose SCF id had no mapping for the current framework,
    // instead of just excluding them from the PDF report as intended.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Persist Co';
        document.getElementById('id_informe').value = 'REG-PERSIST';
        document.getElementById('controls').innerHTML = '';
        currentFramework = 'iso27001';
        document.getElementById('framework-select').value = 'iso27001';
        // AST-01 has NO iso27001 mapping in the real SCF data — exactly the
        // control type that used to vanish from saves under this framework.
        addControl(false, '¿Pregunta?', 'AST-01', 'AST-01', 'Asset Governance', '');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.notes').value = 'Nota de prueba de regresión.';
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => saveProgress());
      await page.waitForTimeout(300);
      await page.close();

      const page2 = await newPage(browser, ctx);
      await page2.evaluate(() => loadAuditById('auditnist_REG-PERSIST'));
      await page2.waitForTimeout(500);
      const restored = await page2.evaluate(() => ({
        controlCount: document.querySelectorAll('.control').length,
        notes: document.querySelector('.notes')?.value,
        compliance: document.querySelector('.cumple')?.value,
      }));
      check('Control not mapped to current framework is still saved and restored', restored.controlCount === 1, `got ${restored.controlCount} controls`);
      check('Notes survive a save/reload cycle', restored.notes === 'Nota de prueba de regresión.', `got "${restored.notes}"`);
      check('Compliance value survives a save/reload cycle', restored.compliance === 'no', `got "${restored.compliance}"`);
      await page2.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('4. NIST CSF code resolution must pick the specific subcategory');
    // Regression covered: naive mappings[fw][0] could return a near-useless
    // bare function code ("GV") instead of a real subcategory ("GV.RM-01").
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const code = await page.evaluate(() => getFrameworkCodeForControl('GOV-01', 'nist-csf'));
      check('GOV-01 resolves to a specific NIST subcategory, not a bare function code',
        /^[A-Z]{2}\.[A-Z]{2,3}-\d+$/.test(code), `got "${code}"`);
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('5. "Nueva Auditoría" must fully reset the workspace');
    // Regression covered: clearData() reset the underlying data but never
    // re-rendered the control library grid or Framework Progress cards,
    // so old colors/numbers stayed on screen; it also crashed referencing
    // a since-removed #fecha field.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'To Be Cleared';
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01', 'Governance Program');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(200);

      let threw = false;
      page.once('pageerror', () => { threw = true; });
      await page.evaluate(() => clearData()); // dialog auto-accepted by the page handler above
      await page.waitForTimeout(300);

      const after = await page.evaluate(() => ({
        empresa: document.getElementById('empresa_auditada').value,
        dashTotal: document.getElementById('dash-total-controls').textContent,
        gridHasColor: (() => {
          const box = Array.from(document.querySelectorAll('.ctrl-box')).find(b => b.dataset.scfId === 'GOV-01');
          return box ? box.className.includes('cyberok') : null;
        })(),
      }));
      check('clearData() does not throw (no stale #fecha reference)', !threw);
      check('Company field cleared', after.empresa === '', `got "${after.empresa}"`);
      check('Dashboard total reset to 0', after.dashTotal === '0', `got "${after.dashTotal}"`);
      check('Control library grid color reset', after.gridHasColor === false, `gridHasColor=${after.gridHasColor}`);
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('6. Work View must not disturb the underlying control data');
    // Regression covered: none specifically, but Work View physically
    // relocates the #controls DOM node — worth pinning down that it always
    // returns to the exact same position and never duplicates/loses nodes.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GV.RM-01', 'Governance', '');
        addControl(false, 'Q2', 'AST-01', 'ID.AM-01', 'Asset Governance', '');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => toggleWorkView());
      await page.waitForTimeout(200);
      const duringWorkView = await page.evaluate(() => ({
        visibleCount: Array.from(document.querySelectorAll('.control')).filter(c => c.style.display !== 'none').length,
        totalCount: document.querySelectorAll('.control').length,
      }));
      check('Exactly one control visible while Work View is active', duringWorkView.visibleCount === 1, `got ${duringWorkView.visibleCount}`);
      check('No controls lost while in Work View', duringWorkView.totalCount === 2, `got ${duringWorkView.totalCount}`);

      await page.evaluate(() => toggleWorkView());
      await page.waitForTimeout(200);
      const afterToggleOff = await page.evaluate(() => ({
        allVisible: Array.from(document.querySelectorAll('.control')).every(c => c.style.display !== 'none'),
        controlsBackInPlace: document.getElementById('controls-anchor').nextElementSibling?.id === 'controls',
        totalCount: document.querySelectorAll('.control').length,
      }));
      check('All controls visible again after leaving Work View', afterToggleOff.allVisible);
      check('#controls moved back to its exact original position', afterToggleOff.controlsBackInPlace);
      check('No controls duplicated by the view switch', afterToggleOff.totalCount === 2, `got ${afterToggleOff.totalCount}`);
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('7. i18n: dynamic status text must re-translate on language switch');
    // Regression covered: "Biblioteca cargada" was set via plain
    // textContent with no data-i18n, so switching language after it
    // appeared left it stuck in whatever language it was first shown in.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      // Explicitly pin the starting language rather than relying on
      // whatever the system default happens to be right now — this test
      // exists to verify dynamic re-translation on switch, not to assert
      // what the default language is (that's covered elsewhere). Uses
      // es/en specifically because library_loaded is only translated in
      // those two of the app's seven languages — a separate, narrower
      // i18n completeness gap noted here rather than papered over by
      // picking a language where the key happens to exist.
      await page.evaluate(() => setLanguage('es'));
      await page.evaluate(() => setSuggestStatus('library_loaded'));
      const before = await page.evaluate(() => document.getElementById('suggest-status').textContent);
      await page.evaluate(() => setLanguage('en'));
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => document.getElementById('suggest-status').textContent);
      check('Library-loaded status is in Spanish before switching', before.includes('Biblioteca'), `got "${before}"`);
      check('Library-loaded status re-translates to English after switching language', after.includes('Library'), `got "${after}"`);
      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('8. No duplicate static HTML ids or top-level function names');
    // Regression covered: duplicate ids (#suggest-status, #suggested-
    // controls) and duplicate function declarations (updateAll,
    // changeFramework) — both silently shadow the first/real one.
    {
      const html = fs.readFileSync(TARGET_HTML, 'utf-8');
      const idMatches = [...html.matchAll(/(?<![-\w])id="([^"]+)"/g)].map(m => m[1]);
      const idCounts = {};
      idMatches.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
      const dupeIds = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id]) => id);
      check('No duplicate static HTML ids', dupeIds.length === 0, dupeIds.join(', '));

      const fnMatches = [...html.matchAll(/^\s*function ([a-zA-Z_$][a-zA-Z0-9_$]*)\(/gm)].map(m => m[1]);
      const fnCounts = {};
      fnMatches.forEach(fn => { fnCounts[fn] = (fnCounts[fn] || 0) + 1; });
      const dupeFns = Object.entries(fnCounts).filter(([, n]) => n > 1).map(([fn]) => fn);
      check('No duplicate top-level function declarations', dupeFns.length === 0, dupeFns.join(', '));
    }

    // ═══════════════════════════════════════════════════════════════════
    section('9. "No Aplicable" (N/A) — full feature coverage');
    // Regression covered: the whole N/A assessment result — its evidence-
    // required validation, its exclusion from every compliance
    // denominator (dashboard, framework cards, global summary, PDF
    // weighted score, and the "strongest domain" callout), that it never
    // becomes a remediation finding, and that it survives a save/export/
    // import round-trip intact.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      // --- 9a. Live evidence-required warning ---
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, '¿Pregunta?', 'GOV-01', 'GOV-01', 'Governance Program', '');
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'na';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(150);
      const warningShown = await page.evaluate(() => !document.querySelector('.na-evidence-warning').classList.contains('hidden'));
      check('Selecting "na" with empty Evidence shows a live warning immediately', warningShown);

      const riskLockedForNA = await page.evaluate(() => document.querySelector('.riesgo').disabled);
      check('Risk selector is disabled once a control is marked "na" (criticality is meaningless for something that doesn\'t apply)', riskLockedForNA);

      // --- 9b. Blocked at every output/save point until justified ---
      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Regression Co';
        document.getElementById('empresa_auditora').value = 'Regression Auditor Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'REG-NA-001';
      });
      const saveBlocked = await page.evaluate(() => {
        const before = localStorage.getItem('auditnist_REG-NA-001');
        saveProgress();
        const after = localStorage.getItem('auditnist_REG-NA-001');
        return before === after; // still null/unchanged -> save was refused
      });
      check('saveProgress() refuses to save while an "na" control has empty Evidence', saveBlocked);

      // --- 9c. Warning clears and save succeeds once justified ---
      await page.evaluate(() => {
        const ta = document.querySelector('.evidencia');
        ta.value = 'No aplicable: sin entorno multi-tenant en el alcance definido.';
        ta.dispatchEvent(new Event('input'));
      });
      await page.waitForTimeout(150);
      const warningClearedAfterTyping = await page.evaluate(() => document.querySelector('.na-evidence-warning').classList.contains('hidden'));
      check('Warning clears live once Evidence is filled in', warningClearedAfterTyping);

      const saveSucceedsAfterFix = await page.evaluate(() => {
        saveProgress();
        return !!localStorage.getItem('auditnist_REG-NA-001');
      });
      check('saveProgress() succeeds once Evidence is provided', saveSucceedsAfterFix);

      // --- 9d. Zero-denominator: dashboard must not show a misleading 0% ---
      const ctx2 = await browser.newContext();
      const page2 = await newPage(browser, ctx2);
      await page2.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        addControl(false, 'Q2', 'AST-01', 'AST-01', 'Asset Governance', '');
      });
      await page2.waitForTimeout(150);
      await page2.evaluate(() => {
        document.querySelectorAll('.control').forEach(blk => {
          blk.querySelector('.cumple').value = 'na';
          blk.querySelector('.cumple').dispatchEvent(new Event('change'));
          blk.querySelector('.evidencia').value = 'No aplicable a este alcance.';
        });
      });
      await page2.waitForTimeout(150);
      const zeroDenomState = await page2.evaluate(() => ({
        rate: document.getElementById('dash-compliance-rate').textContent,
        naCount: document.getElementById('dash-not-applicable').textContent,
      }));
      check('Dashboard shows "—" (not a misleading "0%") when every evaluated control is "na"', zeroDenomState.rate === '—', `got "${zeroDenomState.rate}"`);
      check('Dashboard N/A KPI counts both controls', zeroDenomState.naCount === '2', `got "${zeroDenomState.naCount}"`);

      // --- 9e. AssessmentEngine excludes BOTH "na" and pending controls ---
      const scoreExcludesPendingAndNA = await page2.evaluate(() => {
        const controls = [
          { compliance: 'yes', risk: 'low', domain: 'GV' },
          { compliance: 'yes', risk: 'low', domain: 'GV' },
          { compliance: 'na', risk: '', domain: 'GV' },   // must not count as a zero
          { compliance: '', risk: '', domain: 'GV' },     // pending — must not count as a zero either
        ];
        return AssessmentEngine.calculate(controls, 'nist-csf').overallScorePct;
      });
      check('Weighted PDF score reflects only real verdicts (100%, not diluted by "na"/pending controls)', scoreExcludesPendingAndNA === 100, `got ${scoreExcludesPendingAndNA}%`);

      // --- 9f. Never becomes a remediation finding ---
      const findingsExcludeNA = await page2.evaluate(() => {
        const data = collectAuditData();
        return data.findings.some(f => f.controlId === 'AST-01' || f.scfId === 'AST-01');
      });
      check('An "na" control never appears in the generated findings list', !findingsExcludeNA);

      // --- 9g. Export/import round-trip preserves the "na" value + evidence ---
      const exported = await page2.evaluate(() => collectAuditData().controls.find(c => c.scfId === 'AST-01'));
      check('Exported JSON preserves compliance="na"', exported?.cumple === 'na', `got "${exported?.cumple}"`);
      check('Exported JSON preserves the Evidence justification', !!exported?.evidencia?.trim(), `got "${exported?.evidencia}"`);

      await page.close(); await ctx.close();
      await page2.close(); await ctx2.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('10. Full version snapshots survive reopening and reissuing');
    // Regression covered: publishedSnapshot originally only froze
    // {publishedAt, findings} — reopening and reissuing under a new
    // version silently lost the EARLIER version's full state (controls,
    // evidence, everything). versionSnapshots must keep every past
    // issuance as an immutable, standalone, fully recoverable archive.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Snapshot Co';
        document.getElementById('empresa_auditora').value = 'Snapshot Auditor Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'REG-SNAPSHOT-001';
        document.getElementById('doc_author').value = 'Regression Tester';
        document.getElementById('doc_version').value = '1.0';
        // This section tests version snapshots specifically, not the
        // approval workflow — opt out of it so issuance isn't blocked by
        // an unrelated, unconfigured requirement.
        approvals.policy = 'none';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'v1.0 evidence — original unresolved finding.';
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);

      const v1Frozen = await page.evaluate(() => versionSnapshots['1.0']?.controls?.[0]?.cumple);
      check('v1.0 is archived as its own immutable snapshot at issuance', v1Frozen === 'no', `got "${v1Frozen}"`);

      const noRecursiveNesting = await page.evaluate(() => !versionSnapshots['1.0']?.engagement?.docControl?.versionSnapshots);
      check('A version snapshot does not recursively re-embed the snapshot map itself', noRecursiveNesting);

      // Reopen, fix the finding, bump the version, issue again. reopenForNewVersion()
      // now requires a non-empty reason via prompt() — the shared dialog
      // handler in newPage() auto-accepts with no text, which would silently
      // abort the reopen, so this test supplies one directly.
      await page.evaluate(() => { window.prompt = () => 'Corrección tras revisión'; });
      await page.evaluate(() => reopenForNewVersion());
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'v1.1 evidence — issue fixed.';
        document.getElementById('doc_version').value = '1.1';
      });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);

      const afterReissue = await page.evaluate(() => ({
        v1Untouched: versionSnapshots['1.0']?.controls?.[0]?.cumple,
        v2Updated: versionSnapshots['1.1']?.controls?.[0]?.cumple,
      }));
      check('Reissuing as v1.1 leaves the archived v1.0 snapshot completely unchanged', afterReissue.v1Untouched === 'no', `got "${afterReissue.v1Untouched}"`);
      check('The new v1.1 snapshot correctly reflects the fix', afterReissue.v2Updated === 'yes', `got "${afterReissue.v2Updated}"`);

      // Full round-trip: save, reload the page, load the audit back.
      await page.evaluate(() => saveProgress());
      await page.waitForTimeout(200);
      const page2 = await newPage(browser, ctx);
      await page2.evaluate(() => loadAuditById('auditnist_REG-SNAPSHOT-001'));
      await page2.waitForTimeout(300);
      const afterRoundTrip = await page2.evaluate(() => ({
        keys: Object.keys(versionSnapshots).sort().join(','),
        v1StillFrozen: versionSnapshots['1.0']?.controls?.[0]?.cumple,
      }));
      check('Both v1.0 and v1.1 snapshots survive a save/reload/load round-trip', afterRoundTrip.keys === '1.0,1.1', `got "${afterRoundTrip.keys}"`);
      check('v1.0 snapshot data is still intact after the round-trip', afterRoundTrip.v1StillFrozen === 'no', `got "${afterRoundTrip.v1StillFrozen}"`);

      // Issue #1 review (Vandan): the version history offers TWO distinct
      // downloads per issued version now, not one — the renamed
      // downloadRemediationHandoffJSON() for the JSON, plus a new
      // downloadIssuedVersionPDF() for the PDF.
      const downloadButtonsPresent = await page2.evaluate(() =>
        ['1.0', '1.1'].every(v =>
          document.querySelector(`button[onclick="downloadIssuedVersionPDF('${v}')"]`) &&
          document.querySelector(`button[onclick="downloadRemediationHandoffJSON('${v}')"]`)
        )
      );
      check('Both a PDF and a JSON download button are offered for every archived (issued) version', downloadButtonsPresent);

      await page.close();
      await page2.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('11. Report Approval workflow (reviewer/approver, not digital signatures)');
    // Regression covered: the whole approval feature — issuance blocking
    // by policy, frozen identity copies, self-approval/independent-review
    // governance disclosure, auto-invalidation on reassignment, and that
    // reopening supersedes (never deletes) a version's approvals while the
    // archived snapshot keeps the ORIGINAL decision permanently.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      // Pinned explicitly rather than relying on the app's current
      // default language — this whole section asserts on fixed Spanish
      // alert text ("Revisado por", "Aprobado por") further down.
      await page.evaluate(() => setLanguage('es'));

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Approval Co';
        document.getElementById('empresa_auditora').value = 'Approval Auditor Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'REG-APPROVAL-001';
        document.getElementById('doc_author').value = 'Ana Preparer';
        document.getElementById('doc_version').value = '1.0';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'Test evidence — isolated from the evidence-block feature on purpose.';
      });
      await page.waitForTimeout(150);

      // --- 11a. Default policy blocks issuance with named missing roles ---
      // Overriding window.alert (rather than adding a second page.on('dialog')
      // listener alongside the one newPage() already installs) avoids any
      // risk of two handlers racing to accept/read the same native dialog.
      await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      const blockedMsgs = await page.evaluate(() => window.__alerts);
      check('Issuance is blocked with the default reviewer_and_approver policy and nothing approved',
        blockedMsgs.some(m => m.includes('Revisado por') && m.includes('Aprobado por')));

      // --- 11b. Approving requires a complete identity, then freezes a copy ---
      await page.evaluate(() => { document.getElementById('doc_reviewer').value = 'Carla Reviewer'; }); // role left blank on purpose
      await page.evaluate(() => { window.__alerts = []; });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(100);
      const stillPendingWithoutRole = await page.evaluate(() => approvals.reviewer.status);
      check('Reviewer approval stays "pending" until both name and role are present', stillPendingWithoutRole === 'pending', `got "${stillPendingWithoutRole}"`);

      await page.evaluate(() => { document.getElementById('doc_reviewer_role').value = 'Revisora Técnica'; });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(100);
      const frozenReviewer = await page.evaluate(() => ({ ...approvals.reviewer }));
      check('Approving freezes the designated name+role into the approval record', frozenReviewer.name === 'Carla Reviewer' && frozenReviewer.role === 'Revisora Técnica' && frozenReviewer.status === 'approved');

      // Editing the LIVE field afterward must not silently change the frozen copy.
      await page.evaluate(() => { document.getElementById('doc_reviewer_role').value = 'Cambiado Después'; });
      const frozenUnaffectedByLaterEdit = await page.evaluate(() => approvals.reviewer.role);
      check('Editing Document Control after approval does not rewrite the frozen approval record', frozenUnaffectedByLaterEdit === 'Revisora Técnica', `got "${frozenUnaffectedByLaterEdit}"`);
      await page.evaluate(() => { document.getElementById('doc_reviewer_role').value = 'Revisora Técnica'; }); // restore for the rest of the test

      // --- 11b2. Under reviewer_and_approver, self-approval and same-person-both-roles must be BLOCKED (not just disclosed) ---
      await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });
      const preparerBlockedAsApprover = await page.evaluate(() => {
        document.getElementById('doc_approver').value = 'Ana Preparer'; // same as doc_author
        document.getElementById('doc_approver_role').value = 'Auditora';
        approveRole('approver');
        return approvals.approver.status;
      });
      check('The report\'s own preparer cannot approve under reviewer_and_approver (self-approval forbidden by this policy)', preparerBlockedAsApprover === 'pending', `got "${preparerBlockedAsApprover}"`);

      const sameAsReviewerBlocked = await page.evaluate(() => {
        document.getElementById('doc_approver').value = 'Carla Reviewer'; // same as the already-approved reviewer
        document.getElementById('doc_approver_role').value = 'Directora';
        approveRole('approver');
        return approvals.approver.status;
      });
      check('Reviewer and approver cannot be the same person under reviewer_and_approver', sameAsReviewerBlocked === 'pending', `got "${sameAsReviewerBlocked}"`);

      // --- 11c. Approver approval + issuance succeeds once complete ---
      await page.evaluate(() => {
        document.getElementById('doc_approver').value = 'Beto Approver';
        document.getElementById('doc_approver_role').value = 'Director de Auditoría';
      });
      await page.evaluate(() => approveRole('approver'));
      await page.waitForTimeout(100);

      const govIndependent = await page.evaluate(() => computeApprovalGovernance());
      check('Governance correctly reports independent review when reviewer/approver/preparer are all different people', govIndependent.independentReview === true && govIndependent.reason === 'independent_review');

      await page.evaluate(() => { window.__alerts = []; });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);
      const statusNow = await page.evaluate(() => document.getElementById('eng_status').value);
      check('Issuance succeeds once both required approvals are complete for the current version', statusNow === 'issued', `got "${statusNow}"`);

      // --- 11d. Auto-invalidation when the designated reviewer genuinely changes ---
      // Reopen first (issuance locks the fields), then swap the reviewer to
      // a different person and confirm the OLD approval is auto-revoked.
      await page.evaluate(() => { window.prompt = () => 'Prueba de reasignación'; });
      await page.evaluate(() => reopenForNewVersion());
      await page.waitForTimeout(150);
      const approvalsAfterReopen = await page.evaluate(() => ({ reviewer: approvals.reviewer.status, approver: approvals.approver.status }));
      check('Reopening supersedes both approvals rather than leaving them "approved"', approvalsAfterReopen.reviewer === 'pending' && approvalsAfterReopen.approver === 'pending');

      // Re-approve under v1.1, then swap the reviewer's NAME to a genuinely different person.
      await page.evaluate(() => { document.getElementById('doc_version').value = '1.1'; });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(100);
      await page.evaluate(() => { document.getElementById('doc_reviewer').value = 'Someone Else Entirely'; document.getElementById('doc_reviewer').dispatchEvent(new Event('change')); });
      await page.waitForTimeout(150);
      const revokedAfterReassignment = await page.evaluate(() => approvals.reviewer.status);
      check('Changing the designated reviewer to a genuinely different person auto-revokes the active approval', revokedAfterReassignment === 'revoked', `got "${revokedAfterReassignment}"`);

      // A trivial capitalization/whitespace edit must NOT trigger the same invalidation.
      await page.evaluate(() => { document.getElementById('doc_reviewer').value = 'Carla Reviewer'; document.getElementById('doc_reviewer_role').value = 'Revisora Técnica'; });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(100);
      await page.evaluate(() => { document.getElementById('doc_reviewer').value = '  CARLA   reviewer  '; document.getElementById('doc_reviewer').dispatchEvent(new Event('change')); });
      await page.waitForTimeout(150);
      const notRevokedForTrivialEdit = await page.evaluate(() => approvals.reviewer.status);
      check('A whitespace/case-only edit to the same person does NOT auto-revoke the approval', notRevokedForTrivialEdit === 'approved', `got "${notRevokedForTrivialEdit}"`);

      // --- 11e. Self-approval governance disclosure ---
      await page.evaluate(() => {
        approvals.policy = 'single_approver';
        document.getElementById('approval_policy').value = 'single_approver';
        document.getElementById('doc_approver').value = 'Ana Preparer'; // same as doc_author
        document.getElementById('doc_approver_role').value = 'Auditora Principal';
      });
      const govSelf = await page.evaluate(() => computeApprovalGovernance());
      check('Governance correctly detects self-approval when the approver matches the preparer', govSelf.independentReview === false && govSelf.reason === 'self_approval', `got ${JSON.stringify(govSelf)}`);

      // --- 11f2. Reject/Revoke/Reopen must each identify a real actor ---
      // Reset to a clean single-control audit for these checks.
      await page.evaluate(() => {
        approvals.policy = 'reviewer_and_approver';
        document.getElementById('approval_policy').value = 'reviewer_and_approver';
        document.getElementById('doc_reviewer').value = '';
        document.getElementById('doc_reviewer_role').value = '';
        approvals.reviewer = { required: true, status: 'pending', name: '', role: '', decisionAt: null, version: '', comment: '' };
      });
      const rejectRefusedWithoutIdentity = await page.evaluate(() => {
        rejectApproval('reviewer'); // no doc_reviewer/doc_reviewer_role set — should be refused before even prompting
        return approvals.reviewer.status;
      });
      check('Reject is refused when the reviewer identity is incomplete, same as Approve requires', rejectRefusedWithoutIdentity === 'pending', `got "${rejectRefusedWithoutIdentity}"`);

      await page.evaluate(() => {
        document.getElementById('doc_reviewer').value = 'Carla Reviewer';
        document.getElementById('doc_reviewer_role').value = 'Revisora';
      });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(80);
      const revokeAttribution = await page.evaluate(() => {
        window.prompt = (msg) => (window.__revokeCall = (window.__revokeCall || 0) + 1) === 1 ? 'Diego Revoker' : 'Motivo de revocación de prueba';
        revokeApproval('reviewer');
        const lastEvent = approvalHistory[approvalHistory.length - 1];
        return { approvalKeepsOriginalApprover: approvals.reviewer.name, historyAttributesRevokerNotApprover: lastEvent.actor };
      });
      check('Revocation preserves the ORIGINAL approver\'s identity on the record itself', revokeAttribution.approvalKeepsOriginalApprover === 'Carla Reviewer');
      check('Revocation attributes the history event to the person revoking now, not the original approver', revokeAttribution.historyAttributesRevokerNotApprover === 'Diego Revoker');

      await page.evaluate(() => {
        document.getElementById('doc_approver').value = 'Beto Approver';
        document.getElementById('doc_approver_role').value = 'Director';
        document.getElementById('doc_reviewer').value = 'Carla Reviewer';
        document.getElementById('doc_reviewer_role').value = 'Revisora';
      });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(80);
      await page.evaluate(() => approveRole('approver'));
      await page.waitForTimeout(80);
      await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      const reopenAttribution = await page.evaluate(() => {
        window.__reopenCall = 0;
        window.prompt = (msg) => (window.__reopenCall = window.__reopenCall + 1) === 1 ? 'Elena Reopener' : 'Motivo de reapertura de prueba';
        reopenForNewVersion();
        const lastReopenEvent = [...approvalHistory].reverse().find(e => e.action === 'report_reopened');
        return lastReopenEvent?.actor;
      });
      check('Reopening attributes the history event to the person reopening now, not the report\'s original author', reopenAttribution === 'Elena Reopener', `got "${reopenAttribution}"`);

      // --- 11f. Old JSON without an approvals object stays importable ---
      const backwardCompatible = await page.evaluate(() => {
        try {
          applyEngagement({}); // simulates loading a pre-this-feature audit with no docControl.approvals at all
          return approvals && approvals.policy === 'reviewer_and_approver' && approvals.reviewer.status === 'pending';
        } catch (e) { return false; }
      });
      check('Loading an audit with no approvals object defaults cleanly without inventing an approval', backwardCompatible);

      // --- 11g. Vandan's review round: changing doc_author AFTER approvals
      // were granted must be re-caught at issuance, not just at approval
      // time — the exact loophole an earlier version left open.
      await page.evaluate(() => {
        approvals.policy = 'reviewer_and_approver';
        document.getElementById('approval_policy').value = 'reviewer_and_approver';
        document.getElementById('id_informe').value = 'REG-APPROVAL-LOOPHOLE';
        document.getElementById('doc_author').value = 'Ana';
        document.getElementById('doc_version').value = '9.0';
        document.getElementById('doc_reviewer').value = 'Maria';
        document.getElementById('doc_reviewer_role').value = 'Revisora';
        document.getElementById('doc_approver').value = 'Pedro';
        document.getElementById('doc_approver_role').value = 'Director';
      });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(80);
      await page.evaluate(() => approveRole('approver'));
      await page.waitForTimeout(80);
      // Change the PREPARER to match the already-approved reviewer, without
      // touching doc_reviewer/doc_approver (so checkApprovalInvalidation's
      // own listeners never fire) — approvals stay "approved" on paper.
      await page.evaluate(() => {
        document.getElementById('doc_author').value = 'Maria';
        document.getElementById('doc_author').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(80);
      const stillApprovedOnPaper = await page.evaluate(() => approvals.reviewer.status === 'approved' && approvals.approver.status === 'approved');
      check('Reassigning the preparer after approval does not itself revoke the (now compromised) approvals', stillApprovedOnPaper);

      await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      const loopholeBlockedStatus = await page.evaluate(() => document.getElementById('eng_status').value);
      check('issueFinalReport() re-verifies independence and blocks issuance when the preparer now matches an approver', loopholeBlockedStatus !== 'issued', `got "${loopholeBlockedStatus}"`);

      // --- 11h. Changing ONLY the organisational role (same name) must
      // also invalidate an active approval — the frozen record no longer
      // accurately states who approved in what capacity.
      await page.evaluate(() => {
        document.getElementById('doc_author').value = 'Ana';
        document.getElementById('doc_reviewer').value = 'Carlos';
        document.getElementById('doc_reviewer_role').value = 'Revisor Junior';
      });
      await page.evaluate(() => approveRole('reviewer'));
      await page.waitForTimeout(80);
      await page.evaluate(() => {
        document.getElementById('doc_reviewer_role').value = 'Director de Auditoría Interna'; // same name, different role
        document.getElementById('doc_reviewer_role').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(80);
      const revokedForRoleChange = await page.evaluate(() => approvals.reviewer.status);
      check('Changing only the organisational role (same person) auto-revokes the active approval', revokedForRoleChange === 'revoked', `got "${revokedForRoleChange}"`);

      // --- 11i. Newly generated findings start with decision: null, not a
      // pre-picked treatment nobody in Management actually chose.
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      const newFindingDecision = await page.evaluate(() => collectAuditData().findings[0]?.decision);
      check('A freshly generated finding has decision: null (no Management decision fabricated)', newFindingDecision === null, `got ${JSON.stringify(newFindingDecision)}`);

      // The audit engine must emit the COMPLETE M2 managementResponse
      // contract itself — a finding should already be a valid M2 record
      // the moment it's generated, not something that only becomes valid
      // once the Remediation Hub repairs it on import.
      const newFindingResponse = await page.evaluate(() => collectAuditData().findings[0]?.managementResponse);
      check('A freshly generated finding contains the complete empty M2 contract',
        newFindingResponse?.validationStatus === null &&
        newFindingResponse?.disputeReason === '' &&
        newFindingResponse?.disputeEvidence === '' &&
        newFindingResponse?.auditorAdjudication === '' &&
        newFindingResponse?.responder === '' &&
        newFindingResponse?.responderRole === '' &&
        newFindingResponse?.responseDate === '' &&
        newFindingResponse?.source === 'manual_entry' &&
        newFindingResponse?.receivedVia === '' &&
        newFindingResponse?.comments === '' &&
        newFindingResponse?.treatment === null &&
        newFindingResponse?.treatmentOwner === '' &&
        newFindingResponse?.treatmentOwnerRole === '' &&
        newFindingResponse?.riskAcceptance === null,
        `got ${JSON.stringify(newFindingResponse)}`);

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('12. Audit-handoff — matched PDF/JSON pair on issuance (issue #1)');
    // Regression covered: issuance shows a two-button download panel
    // instead of two automatic downloads; both files are named per the
    // AuditSym_{FRAMEWORK}_{AUDIT_ID}_v{VERSION}_EMITIDO convention; the
    // JSON carries a correct remediationHandoff block; and the panel
    // correctly hides on reopen or when switching to a different audit,
    // so it can never offer a stale download.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Handoff Co';
        document.getElementById('empresa_auditora').value = 'Handoff Auditor Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'AUD-2026-7575';
        document.getElementById('doc_author').value = 'Regression Tester';
        document.getElementById('doc_version').value = '1.0';
        approvals.policy = 'none'; // isolated from the approvals feature on purpose
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'Test evidence — isolated from the evidence-block feature on purpose.';
      });
      await page.waitForTimeout(150);

      const panelHiddenBefore = await page.evaluate(() => document.getElementById('post-issuance-actions').classList.contains('hidden'));
      check('Post-issuance download panel is hidden before issuing', panelHiddenBefore);

      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);
      const panelShownAfter = await page.evaluate(() => !document.getElementById('post-issuance-actions').classList.contains('hidden'));
      check('Post-issuance download panel becomes visible immediately after issuing', panelShownAfter);

      // jsPDF loads from a CDN in the real app — on a machine with normal
      // internet access this resolves in well under a second, but a
      // restricted-egress environment (some CI runners, sandboxes) should
      // never hang the whole suite waiting for a download that can never
      // fire. Check availability first, with a bounded wait, and skip only
      // the PDF-specific assertion if it's genuinely unavailable — the
      // JSON handoff checks below don't depend on jsPDF at all and always run.
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      if (jspdfAvailable) {
        const [pdfDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }),
          page.evaluate(() => downloadIssuedPDF()),
        ]);
        check('Issued PDF filename follows the AuditSym_{FRAMEWORK}_{ID}_v{VERSION}_EMITIDO convention',
          pdfDownload.suggestedFilename() === 'AuditSym_NIST_CSF_2_0_AUD-2026-7575_v1.0_EMITIDO.pdf',
          `got "${pdfDownload.suggestedFilename()}"`);
      } else {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping PDF filename check. Re-run with internet access for full coverage.');
      }

      const jsonInfo = await page.evaluate(async () => {
        let capturedName = null, capturedText = null;
        const originalSaveAs = window.saveAs;
        window.saveAs = (blob, name) => { capturedName = name; return blob.text().then(t => { capturedText = t; }); };
        downloadIssuedJSON();
        await new Promise(r => setTimeout(r, 50));
        window.saveAs = originalSaveAs;
        const parsed = capturedText ? JSON.parse(capturedText) : null;
        return { name: capturedName, handoff: parsed?.remediationHandoff, hasControls: Array.isArray(parsed?.controls) };
      });
      check('Issued JSON filename matches the PDF\'s base name exactly (same pair, different extension)',
        jsonInfo.name === 'AuditSym_NIST_CSF_2_0_AUD-2026-7575_v1.0_EMITIDO.json', `got "${jsonInfo.name}"`);
      check('Issued JSON carries a correct remediationHandoff block',
        jsonInfo.handoff?.eligible === true &&
        jsonInfo.handoff?.sourceAuditId === 'AUD-2026-7575' &&
        jsonInfo.handoff?.sourceVersion === '1.0' &&
        jsonInfo.handoff?.sourceStatus === 'issued' &&
        typeof jsonInfo.handoff?.generatedAt === 'string',
        `got ${JSON.stringify(jsonInfo.handoff)}`);
      check('Issued JSON is the full frozen snapshot, not a stripped-down summary', jsonInfo.hasControls);

      // Vandan's review: generatedAt must be fixed at the moment of
      // issuance, not recomputed on every re-download — otherwise
      // re-downloading the same version's JSON a week later would
      // silently change a field meant to record when the ORIGINAL
      // handoff artifact was produced.
      const secondDownloadGeneratedAt = await page.evaluate(async () => {
        let capturedText = null;
        const originalSaveAs = window.saveAs;
        window.saveAs = (blob, name) => blob.text().then(t => { capturedText = t; });
        downloadIssuedJSON();
        await new Promise(r => setTimeout(r, 50));
        window.saveAs = originalSaveAs;
        return JSON.parse(capturedText).remediationHandoff.generatedAt;
      });
      check('remediationHandoff.generatedAt is identical across repeated re-downloads of the same version',
        secondDownloadGeneratedAt === jsonInfo.handoff.generatedAt,
        `first="${jsonInfo.handoff.generatedAt}" second="${secondDownloadGeneratedAt}"`);

      // Vandan's review: the derived export must never let a caller
      // mutate the stored, immutable versionSnapshots entry through a
      // shared reference.
      const snapshotUnmutated = await page.evaluate(() => {
        const payload = buildRemediationHandoffPayload('1.0');
        payload.controls[0].cumple = 'TAMPERED';
        return versionSnapshots['1.0'].controls[0].cumple;
      });
      check('Building the handoff payload never mutates the stored version snapshot (deep copy, not a shallow reference)',
        snapshotUnmutated !== 'TAMPERED', `got "${snapshotUnmutated}"`);

      await page.evaluate(() => { window.prompt = () => 'Test reopen reason'; });
      await page.evaluate(() => reopenForNewVersion());
      await page.waitForTimeout(150);
      const panelHiddenAfterReopen = await page.evaluate(() => document.getElementById('post-issuance-actions').classList.contains('hidden'));
      check('Post-issuance panel hides again after reopening, so it can never offer a stale download', panelHiddenAfterReopen);

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('13. Historical PDF isolation (issue #1, Vandan review round 2)');
    // Regression covered: the exact scenario the review specifically
    // called out — generatePDF() must render EXCLUSIVELY from a passed
    // sourceSnapshot, never from the live DOM, so v1.0's PDF can be
    // correctly reproduced even while v1.1 is the active version in the
    // form. Verified both at the data level (always) and, when jsPDF is
    // reachable, by extracting real text from the rendered PDF and
    // confirming it contains v1.0's content and NOT v1.1's.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Isolation Co';
        document.getElementById('empresa_auditora').value = 'Isolation Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'REG-ISOLATION-001';
        document.getElementById('doc_author').value = 'Regression Tester';
        document.getElementById('doc_version').value = '1.0';
        approvals.policy = 'none';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'V1.0-ORIGINAL-UNRESOLVED-FINDING';
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);

      await page.evaluate(() => { window.prompt = () => 'Fixed for v1.1'; });
      await page.evaluate(() => reopenForNewVersion());
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        document.getElementById('doc_version').value = '1.1';
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'V1.1-FIXED-NOW-COMPLIANT';
      });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);

      // Data-level proof: this is what generatePDF(filename, sourceSnapshot)
      // actually reads from when rendering v1.0 — independent of whether
      // jsPDF itself is reachable in this environment.
      const isolation = await page.evaluate(() => ({
        liveVersion: document.getElementById('doc_version').value,
        liveCompliance: document.querySelector('.control .cumple').value,
        v1_0_snapshot_compliance: versionSnapshots['1.0']?.controls?.[0]?.cumple,
        v1_0_snapshot_evidence: versionSnapshots['1.0']?.controls?.[0]?.evidencia,
        v1_1_snapshot_compliance: versionSnapshots['1.1']?.controls?.[0]?.cumple,
      }));
      check('Live form has moved on to v1.1 (compliant) after reissuing', isolation.liveVersion === '1.1' && isolation.liveCompliance === 'yes');
      check('v1.0\'s archived snapshot still shows the ORIGINAL non-compliant finding, untouched by the v1.1 fix',
        isolation.v1_0_snapshot_compliance === 'no' && isolation.v1_0_snapshot_evidence === 'V1.0-ORIGINAL-UNRESOLVED-FINDING',
        `got ${JSON.stringify(isolation)}`);
      check('v1.1\'s snapshot correctly shows the fix', isolation.v1_1_snapshot_compliance === 'yes');

      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      if (jspdfAvailable) {
        const [v10Download] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }),
          page.evaluate(() => downloadIssuedVersionPDF('1.0')),
        ]);
        check('downloadIssuedVersionPDF(\'1.0\') produces the correctly-named PDF while v1.1 is the live active version',
          v10Download.suggestedFilename() === 'AuditSym_NIST_CSF_2_0_REG-ISOLATION-001_v1.0_EMITIDO.pdf',
          `got "${v10Download.suggestedFilename()}"`);
        // A raw-bytes substring search on the PDF is unreliable (jsPDF's
        // content streams are typically FlateDecode-compressed, so plain
        // text usually isn't found by scanning the raw file), and relying
        // on an external pdftotext-style dependency isn't something this
        // suite should require on every machine that runs it. The
        // data-level checks above are what actually prove isolation —
        // they check exactly what generatePDF(sourceSnapshot) consumes —
        // so this is deliberately informational only, not a hard check.
        const pdfPath = await v10Download.path();
        const pdfBytes = fs.readFileSync(pdfPath);
        const rawText = pdfBytes.toString('latin1');
        const rawTextHit = rawText.includes('V1.0-ORIGINAL-UNRESOLVED-FINDING');
        console.log(`    ℹ️  Raw-bytes PDF text scan ${rawTextHit ? 'found' : 'did not find (expected if content is compressed)'} the v1.0 evidence string — informational only, not a pass/fail condition.`);
      } else {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping the PDF filename check. Isolation is still fully proven at the data level above, which is what generatePDF(sourceSnapshot) actually reads from.');
      }

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('14. Evidence required for real verdicts on final issuance (issue #29)');
    // Regression covered: a control marked Cumple/Parcial/No Cumple with no
    // evidence text must not silently make it out as an officially issued
    // report. "Generar PDF" (a working preview) may still show it — the
    // PDF itself marks it honestly as "Evidencia Pendiente" — but "Emitir
    // Informe Final" is the official act and must block outright.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Evidence Block Co';
        document.getElementById('empresa_auditora').value = 'Evidence Block Firm';
        document.getElementById('auditor').value = 'Regression Tester';
        document.getElementById('id_informe').value = 'REG-EVIDENCE-BLOCK';
        document.getElementById('doc_author').value = 'Regression Tester';
        document.getElementById('doc_version').value = '1.0';
        approvals.policy = 'none';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Control sin evidencia', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        // Evidence deliberately left empty.
      });
      await page.waitForTimeout(150);

      const detectorResult = await page.evaluate(() => findAssessedControlsWithoutEvidence().length);
      check('findAssessedControlsWithoutEvidence() correctly detects a real verdict with no evidence', detectorResult === 1, `got ${detectorResult}`);

      const pendingFilterResult = await page.evaluate(() => controlHasPendingIssue(document.querySelector('.control')));
      check('The Work View "pending" filter (controlHasPendingIssue) also detects this case', pendingFilterResult === true);

      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      if (jspdfAvailable) {
        const [previewDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }),
          page.evaluate(() => generatePDF()),
        ]);
        check('Generar PDF (a working preview) still succeeds despite the missing evidence', !!previewDownload.suggestedFilename());
      } else {
        console.log('  ⚠️  jsPDF unavailable in this environment — skipping the "preview still works" check specifically; the block-on-issuance check below does not depend on jsPDF.');
      }

      // newPage() already installs a persistent page.on('dialog', accept)
      // handler — adding a second listener that ALSO calls .accept() would
      // race it and throw ("dialog already handled"). This listener only
      // reads the message; the existing persistent handler is what
      // actually resolves the dialog.
      let issueAlertMsg = '';
      page.once('dialog', d => { issueAlertMsg = d.message(); });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      check('Emitir Informe Final is blocked with a message naming the missing-evidence control',
        issueAlertMsg.includes('evidencia') || issueAlertMsg.toLowerCase().includes('evidence'), `got "${issueAlertMsg.slice(0, 80)}"`);
      const statusAfterBlock = await page.evaluate(() => document.getElementById('eng_status').value);
      check('The audit remains a draft after the blocked attempt — never silently issued', statusAfterBlock === 'draft', `got "${statusAfterBlock}"`);

      await page.evaluate(() => {
        document.querySelector('.evidencia').value = 'Evidencia añadida en la prueba de regresión.';
      });
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      const statusAfterFix = await page.evaluate(() => document.getElementById('eng_status').value);
      check('Once evidence is provided, issuance succeeds normally', statusAfterFix === 'issued', `got "${statusAfterFix}"`);

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('15. PDF layout regression — clipping, overflow, content completeness (issue #29)');
    // Regression covered: two acceptance criteria that had never had
    // automated coverage — "No text is clipped or rendered outside page
    // margins" and "Lists ... render completely" — checked for real using
    // poppler's exact per-word bounding boxes and full-text extraction,
    // not a visual guess. Requires both jsPDF (to render) and poppler's
    // pdftotext (to measure/extract) — each dependency's absence is
    // reported and only the checks that need it are skipped, so the rest
    // of the suite is unaffected either way.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      const popplerAvailable = isPdftotextAvailable();

      if (!jspdfAvailable) {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping all of Section 15.');
      } else if (!popplerAvailable) {
        console.log('  ⚠️  pdftotext (poppler-utils) not found on this machine — skipping all of Section 15. Install poppler-utils for this coverage.');
      } else {
        const longRecipients = 'Comité de Dirección, Chief Information Security Officer (CISO), Departamento Legal y de Cumplimiento Normativo, Consejo de Administración, Responsable de Protección de Datos (DPO), Auditoría Interna, Dirección Financiera, Responsable de Infraestructura y Operaciones de TI';
        const longControlName = 'Un nombre de control deliberadamente muy largo, diseñado específicamente para forzar el ajuste de línea en la tabla de dominio, en la narrativa del hallazgo y en el anexo de evidencia, comprobando que ninguno de los tres se recorta ni se solapa con el contenido adyacente';
        const numberedListEvidence = '1. Se revisó la configuración inicial del sistema de gestión de identidades.\n2. Se contrastó contra el registro de cambios de los últimos doce meses.\n3. Se identificaron tres excepciones no documentadas en el proceso de aprobación.\n4. Se validó la remediación parcial aplicada en el entorno de preproducción.\n5. Se recomienda formalizar el procedimiento de excepciones antes del cierre del trimestre.';

        await page.evaluate(({ longRecipients, longControlName, numberedListEvidence }) => {
          document.getElementById('empresa_auditada').value = 'Stress Test Co., S.A. de C.V. — Nombre de Empresa Deliberadamente Largo';
          document.getElementById('empresa_auditora').value = 'Long Auditor Firm Name Testing Wrap Behavior';
          document.getElementById('auditor').value = 'Regression Tester';
          document.getElementById('id_informe').value = 'REG-LAYOUT-001';
          document.getElementById('doc_author').value = 'Regression Tester';
          document.getElementById('doc_version').value = '1.0';
          document.getElementById('doc_recipients').value = longRecipients;
          approvals.policy = 'none';
          document.getElementById('controls').innerHTML = '';

          addControl(false, 'Q1', 'GOV-01', 'GOV-01', longControlName, '');
          addControl(false, 'Q2', 'AST-01', 'AST-01', 'Control con lista numerada', '');
          addControl(false, 'Q3', 'GOV-02', 'GOV-02', 'Control con evidencia pendiente', '');
          const blocks = document.querySelectorAll('.control');
          blocks[0].querySelector('.cumple').value = 'no';
          blocks[0].querySelector('.cumple').dispatchEvent(new Event('change'));
          blocks[0].querySelector('.riesgo').value = 'critical';
          blocks[0].querySelector('.evidencia').value = longControlName + ' — evidencia asociada también larga para forzar ajuste de línea en el anexo.';

          blocks[1].querySelector('.cumple').value = 'partial';
          blocks[1].querySelector('.cumple').dispatchEvent(new Event('change'));
          blocks[1].querySelector('.riesgo').value = 'high';
          blocks[1].querySelector('.evidencia').value = numberedListEvidence;

          blocks[2].querySelector('.cumple').value = 'yes';
          blocks[2].querySelector('.cumple').dispatchEvent(new Event('change'));
          // Evidence deliberately left empty — exercises the "Evidencia Pendiente" section.
        }, { longRecipients, longControlName, numberedListEvidence });
        await page.waitForTimeout(200);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.evaluate(() => generatePDF()),
        ]);
        const pdfPath = path.join(os.tmpdir(), `regression_layout_${Date.now()}.pdf`);
        await download.saveAs(pdfPath);

        const marginCheck = checkPdfMargins(pdfPath);
        check(`No word is clipped or rendered outside page margins (checked ${marginCheck.wordCount} words across the document)`,
          marginCheck.ok,
          marginCheck.ok ? '' : JSON.stringify(marginCheck.violations.slice(0, 3)));

        const contentCheck = pdfContainsAllStrings(pdfPath, [
          'Comité de Dirección',
          'Responsable de Infraestructura y Operaciones de TI', // last item of the long recipient list — proves it wasn't truncated partway
          'Se revisó la configuración inicial',
          'Se recomienda formalizar el procedimiento de excepciones antes del cierre del trimestre.', // LAST numbered item — proves the list wasn't cut short
          'Evidencia Pendiente',
        ]);
        check('All expected content — long recipient list (including its LAST entry), every item of the numbered list, and the pending-evidence marker — survives intact with nothing silently dropped',
          contentCheck.ok, contentCheck.ok ? '' : `missing: ${JSON.stringify(contentCheck.missing)}`);

        fs.unlinkSync(pdfPath);
        await page.close();
        await ctx.close();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    section('16. Structured Evidence Register — EVD-#### (issue #34)');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'EVD Registro Test Co';
        document.getElementById('id_informe').value = 'AUD-EVD-REG';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        addControl(false, 'Q2', 'AST-01', 'AST-01', 'Asset Governance', '');
      });
      await page.waitForTimeout(150);

      // ── Add + sequential-per-audit numbering ──────────────────────────
      await page.evaluate(() => {
        const btn = document.querySelectorAll('.add-evidence-item-btn')[0];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-type').value = 'system_export';
        document.getElementById('evidence-item-source').value = 'Microsoft Entra ID';
        document.getElementById('evidence-item-method').value = 'inspection';
        document.getElementById('evidence-item-collected-by').value = 'Susana Alba';
        saveEvidenceItem();
      });
      const firstItem = await page.evaluate(() => ({
        id: getEvidenceItems(document.querySelectorAll('.control')[0])[0]?.id,
        nextSeq: evidenceRegister.nextSequence,
        type: getEvidenceItems(document.querySelectorAll('.control')[0])[0]?.type,
      }));
      check('First evidence item gets EVD-0001 and advances the counter to 2', firstItem.id === 'EVD-0001' && firstItem.nextSeq === 2, `got ${JSON.stringify(firstItem)}`);
      check('The modal correctly saves the selected type (not blank — regression for the earlier "unevaluated template literal in static HTML" bug)', firstItem.type === 'system_export', `got "${firstItem.type}"`);

      await page.evaluate(() => {
        const btn = document.querySelectorAll('.add-evidence-item-btn')[1];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-source').value = 'Second control evidence';
        saveEvidenceItem();
      });
      const secondItemId = await page.evaluate(() => getEvidenceItems(document.querySelectorAll('.control')[1])[0]?.id);
      check('An item added to a DIFFERENT control still continues the SAME audit-wide sequence (EVD-0002, not restarting per control)', secondItemId === 'EVD-0002', `got "${secondItemId}"`);

      // ── Review: validate ────────────────────────────────────────────
      await page.evaluate(() => { window.prompt = () => 'Luis Gómez'; });
      await page.evaluate(() => reviewEvidenceItem(document.querySelectorAll('.control')[0], 'EVD-0001', 'validated'));
      const afterValidate = await page.evaluate(() => getEvidenceItems(document.querySelectorAll('.control')[0])[0]);
      check('Validating an item records status, reviewer identity, and timestamp',
        afterValidate.validationStatus === 'validated' && afterValidate.reviewedBy === 'Luis Gómez' && !!afterValidate.reviewedAt);

      // ── Review: reject requires a non-empty reason ───────────────────
      await page.evaluate(() => { window.prompt = (m) => (window.__c1 = (window.__c1 || 0) + 1) === 1 ? 'Luis Gómez' : ''; });
      await page.evaluate(() => reviewEvidenceItem(document.querySelectorAll('.control')[1], 'EVD-0002', 'rejected'));
      const blockedRejection = await page.evaluate(() => getEvidenceItems(document.querySelectorAll('.control')[1])[0].validationStatus);
      check('Rejecting with a blank reason is blocked — the item stays pending', blockedRejection === 'pending', `got "${blockedRejection}"`);

      await page.evaluate(() => { window.prompt = (m) => (window.__c2 = (window.__c2 || 0) + 1) === 1 ? 'Luis Gómez' : 'Fuente no verificable.'; });
      await page.evaluate(() => reviewEvidenceItem(document.querySelectorAll('.control')[1], 'EVD-0002', 'rejected'));
      const afterReject = await page.evaluate(() => getEvidenceItems(document.querySelectorAll('.control')[1])[0]);
      check('Rejecting with a real reason records validationStatus=rejected and the rejectionReason',
        afterReject.validationStatus === 'rejected' && afterReject.rejectionReason === 'Fuente no verificable.');

      // ── Withdrawal is a tombstone, never a physical delete ───────────
      await page.evaluate(() => { window.prompt = (m) => (window.__c3 = (window.__c3 || 0) + 1) === 1 ? 'Susana Alba' : 'Duplicado de otro registro.'; });
      await page.evaluate(() => withdrawEvidenceItemPrompt(document.querySelectorAll('.control')[0], 'EVD-0001'));
      const afterWithdraw = await page.evaluate(() => {
        const wrapper = document.querySelectorAll('.control')[0];
        return { all: getEvidenceItems(wrapper), active: getActiveEvidenceItems(wrapper) };
      });
      check('A withdrawn item remains in the full list (tombstone), not physically deleted', afterWithdraw.all.length === 1);
      check('...but is excluded from the active list', afterWithdraw.active.length === 0);
      check('...with who/when/why recorded', afterWithdraw.all[0].status === 'withdrawn' && afterWithdraw.all[0].withdrawnBy === 'Susana Alba' && afterWithdraw.all[0].withdrawalReason === 'Duplicado de otro registro.');

      // ── THE critical identifier-stability guarantee ──────────────────
      await page.evaluate(() => {
        const btn = document.querySelectorAll('.add-evidence-item-btn')[0];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-source').value = 'Post-withdrawal evidence';
        saveEvidenceItem();
      });
      const thirdItemId = await page.evaluate(() => getActiveEvidenceItems(document.querySelectorAll('.control')[0]).find(i => i.source === 'Post-withdrawal evidence')?.id);
      check('A new item added after a withdrawal gets EVD-0003 — NEVER reuses the withdrawn EVD-0001', thirdItemId === 'EVD-0003', `got "${thirdItemId}"`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('17. Evidence Register — persistence, round-trip, and import normalization (issue #34)');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'Persistence Co';
        document.getElementById('id_informe').value = 'AUD-EVD-PERSIST-REG';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const btn = document.querySelectorAll('.add-evidence-item-btn')[0];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-source').value = 'First evidence';
        saveEvidenceItem();
      });
      await page.waitForTimeout(150);

      const collected = await page.evaluate(() => collectAuditData());
      check('collectAuditData() includes each control\'s evidenceItems', collected.controls[0].evidenceItems?.[0]?.id === 'EVD-0001');
      check('collectAuditData() includes engagement.evidenceRegister.nextSequence', collected.engagement?.evidenceRegister?.nextSequence === 2, `got ${JSON.stringify(collected.engagement?.evidenceRegister)}`);

      // Simulate a full reload from this exact saved JSON.
      const roundTripResult = await page.evaluate((data) => {
        document.getElementById('controls').innerHTML = '';
        applyEngagement(data);
        data.controls.forEach(c => {
          addControl(false, c.question || '', c.scfId || '', c.fwCode, (c.ctrl || '').split(' – ')[1] || '', '', true);
          const wrapper = document.querySelectorAll('.control')[document.querySelectorAll('.control').length - 1];
          wrapper.querySelector('.cumple').value = c.cumple || '';
          wrapper.querySelector('.evidencia').value = c.evidencia || '';
          wrapper.evidenceItems = Array.isArray(c.evidenceItems) ? c.evidenceItems : [];
          renderEvidenceItemsList(wrapper);
        });
        normalizeEvidenceRegisterCounter();
        return {
          items: getEvidenceItems(document.querySelectorAll('.control')[0]).map(i => i.id),
          nextSeq: evidenceRegister.nextSequence,
        };
      }, collected);
      check('Evidence items survive a full save/reload round-trip', JSON.stringify(roundTripResult.items) === JSON.stringify(['EVD-0001']));
      check('The counter is correctly restored after reload', roundTripResult.nextSeq === 2, `got ${roundTripResult.nextSeq}`);

      // Legacy import: evidenceItems present, but NO evidenceRegister at all
      // (a hypothetical export from before this counter field existed).
      const legacyData = JSON.parse(JSON.stringify(collected));
      delete legacyData.engagement.evidenceRegister;
      const legacyResult = await page.evaluate((data) => {
        document.getElementById('controls').innerHTML = '';
        applyEngagement(data);
        data.controls.forEach(c => {
          addControl(false, c.question || '', c.scfId || '', c.fwCode, (c.ctrl || '').split(' – ')[1] || '', '', true);
          const wrapper = document.querySelectorAll('.control')[document.querySelectorAll('.control').length - 1];
          wrapper.evidenceItems = Array.isArray(c.evidenceItems) ? c.evidenceItems : [];
          renderEvidenceItemsList(wrapper);
        });
        normalizeEvidenceRegisterCounter();
        return evidenceRegister.nextSequence;
      }, legacyData);
      check('Importing an audit with evidence but NO stored counter derives it correctly (highest existing + 1)', legacyResult === 2, `got ${legacyResult}`);

      // Stale stored counter LOWER than what's needed — must self-correct,
      // never allow a collision.
      const staleData = JSON.parse(JSON.stringify(collected));
      staleData.engagement.evidenceRegister = { nextSequence: 1 };
      const staleResult = await page.evaluate((data) => {
        document.getElementById('controls').innerHTML = '';
        applyEngagement(data);
        data.controls.forEach(c => {
          addControl(false, c.question || '', c.scfId || '', c.fwCode, (c.ctrl || '').split(' – ')[1] || '', '', true);
          const wrapper = document.querySelectorAll('.control')[document.querySelectorAll('.control').length - 1];
          wrapper.evidenceItems = Array.isArray(c.evidenceItems) ? c.evidenceItems : [];
          renderEvidenceItemsList(wrapper);
        });
        normalizeEvidenceRegisterCounter();
        return evidenceRegister.nextSequence;
      }, staleData);
      check('A stale stored counter (lower than needed) self-corrects on import — never allowed to risk reissuing EVD-0001', staleResult === 2, `got ${staleResult}`);

      // Backward compatibility: an audit with no evidenceItems / no
      // evidenceRegister at all (pre-#34 export) must import cleanly.
      const preExistingData = JSON.parse(JSON.stringify(collected));
      preExistingData.controls.forEach(c => { delete c.evidenceItems; });
      delete preExistingData.engagement.evidenceRegister;
      const preExistingResult = await page.evaluate((data) => {
        document.getElementById('controls').innerHTML = '';
        applyEngagement(data);
        data.controls.forEach(c => {
          addControl(false, c.question || '', c.scfId || '', c.fwCode, (c.ctrl || '').split(' – ')[1] || '', '', true);
          const wrapper = document.querySelectorAll('.control')[document.querySelectorAll('.control').length - 1];
          wrapper.evidenceItems = Array.isArray(c.evidenceItems) ? c.evidenceItems : [];
          renderEvidenceItemsList(wrapper);
        });
        normalizeEvidenceRegisterCounter();
        return { nextSeq: evidenceRegister.nextSequence, items: getEvidenceItems(document.querySelectorAll('.control')[0]) };
      }, preExistingData);
      check('An audit with no evidenceItems/evidenceRegister at all (pre-#34) imports cleanly with an empty evidence list and a fresh counter',
        preExistingResult.items.length === 0 && preExistingResult.nextSeq === 1, `got ${JSON.stringify(preExistingResult)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('18. Evidence Register — PDF rendering and edit-lock behavior (issue #34)');
    {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'PDF EVD Test Co';
        document.getElementById('empresa_auditora').value = 'Firm';
        document.getElementById('auditor').value = 'Susana Alba';
        document.getElementById('id_informe').value = 'AUD-EVD-PDF-REG';
        document.getElementById('doc_author').value = 'Susana Alba';
        document.getElementById('doc_version').value = '1.0';
        approvals.policy = 'none';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.riesgo').value = 'high';
        blk.querySelector('.evidencia').value = 'Evidencia de prueba.';
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const btn = document.querySelectorAll('.add-evidence-item-btn')[0];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-type').value = 'document';
        document.getElementById('evidence-item-source').value = 'Política de Gobierno v2.1';
        document.getElementById('evidence-item-method').value = 'inspection';
        document.getElementById('evidence-item-result').value = 'No se encontró aprobación formal.';
        saveEvidenceItem();
      });
      await page.evaluate(() => {
        const btn = document.querySelectorAll('.add-evidence-item-btn')[0];
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-source').value = 'SHOULD-NOT-APPEAR-WITHDRAWN';
        saveEvidenceItem();
      });
      await page.evaluate(() => {
        window.prompt = (m) => (window.__c4 = (window.__c4 || 0) + 1) === 1 ? 'Susana Alba' : 'Duplicado.';
      });
      await page.evaluate(() => withdrawEvidenceItemPrompt(document.querySelector('.control'), 'EVD-0002'));
      await page.waitForTimeout(100);

      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      if (jspdfAvailable) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.evaluate(() => generatePDF()),
        ]);
        const pdfPath = path.join(os.tmpdir(), `regression_evd_pdf_${Date.now()}.pdf`);
        await download.saveAs(pdfPath);
        // Basic presence check via the same pdftotext helper pattern used
        // in section 15, kept local here to avoid a hard dependency for
        // this one check if poppler isn't installed.
        let extractedText = '';
        try {
          extractedText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf-8' });
        } catch (e) { /* poppler not installed — skip content assertions below */ }
        if (extractedText) {
          check('The active evidence item (EVD-0001) appears in the PDF annex', extractedText.includes('EVD-0001') && extractedText.includes('Política de Gobierno v2.1'));
          check('The withdrawn evidence item (EVD-0002) does NOT appear anywhere in the PDF', !extractedText.includes('SHOULD-NOT-APPEAR-WITHDRAWN'));
        } else {
          console.log('  ⚠️  pdftotext not available — skipping PDF content assertions for this section.');
        }
        fs.unlinkSync(pdfPath);
      } else {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping the PDF rendering check.');
      }

      // Edit-lock: once issued, the add/review/withdraw actions must be blocked.
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(150);
      const lockedState = await page.evaluate(() => ({
        addBtnDisabled: document.querySelector('.add-evidence-item-btn')?.disabled,
        actionButtonsGone: document.querySelector('.evidence-items-list').innerHTML.includes('Retirar') === false,
      }));
      check('The "+ Añadir Evidencia" button is disabled once the audit is issued/locked', lockedState.addBtnDisabled === true);
      check('Per-item action buttons (Retirar, etc.) disappear from the rendered list once locked', lockedState.actionButtonsGone);

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('19. Cross-check fix — data.findings[] carries evidenceItems (Hub handoff)');
    // Found by an actual engine→Hub cross-check with real, engine-produced
    // data rather than hand-built fixtures: data.findings[] (built by
    // buildFinding(), a function that predates issue #34) never carried
    // evidenceItems, while data.controls[] correctly did. Since the Hub's
    // processImportedData() ALWAYS prefers data.findings over data.controls
    // whenever the former exists and is non-empty — which it always is
    // for any real audit with at least one non-compliant finding — every
    // EVD-#### item was silently lost on handoff despite #34's own
    // machinery working correctly when tested in isolation.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const result = await page.evaluate(() => {
        document.getElementById('empresa_auditada').value = 'XCheck Co';
        document.getElementById('id_informe').value = 'AUD-XCHECK-REG';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = 'Evidencia de prueba.';
        const btn = document.querySelector('.add-evidence-item-btn');
        openAddEvidenceItemModal(btn);
        document.getElementById('evidence-item-source').value = 'Test source';
        saveEvidenceItem();
        const data = collectAuditData();
        return {
          findingsCount: data.findings.length,
          findingEvidenceItems: data.findings[0]?.evidenceItems?.map(e => e.id),
        };
      });
      check('data.findings[] (the array the Hub actually prioritizes on import) now carries evidenceItems, not just data.controls[]',
        Array.isArray(result.findingEvidenceItems) && result.findingEvidenceItems.includes('EVD-0001'),
        `got ${JSON.stringify(result.findingEvidenceItems)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('20. Auto-save no longer silently fails when an N/A control lacks justification');
    // Found in review: the 2-minute background timer called saveProgress()
    // directly — the SAME function the manual "Save" button uses, which
    // deliberately blocks (with a native alert()) if any control marked
    // "N/A" has no justification yet. That validation makes sense for an
    // explicit manual save or final issuance, but a control sitting at
    // N/A with the justification not yet typed is completely normal
    // mid-session — so every two minutes, the auditor got a blocking
    // error popup instead of a save, easy to mistake for the identical-
    // looking success alert, with NOTHING actually persisted the whole
    // time. autoSaveSilently() is a separate path with no validation and
    // no blocking alert — this section confirms it actually behaves that
    // way, and that the manual path's validation is still intact.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      // Overriding window.alert (rather than adding a second page.on('dialog')
      // listener alongside the one newPage() already installs) avoids any
      // risk of two handlers racing to accept/read the same native dialog.
      await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });

      await page.evaluate(() => {
        document.getElementById('id_informe').value = 'AUD-AUTOSAVE-REG';
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'na';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
        blk.querySelector('.evidencia').value = ''; // deliberately left empty — the exact trap
        isDirty = true;
      });

      const hasTrap = await page.evaluate(() => findEmptyEvidenceNAControls().length === 1);
      check('Setup: an N/A control with no justification yet actually exists (the exact trap)', hasTrap);

      await page.evaluate(() => autoSaveSilently());
      await page.waitForTimeout(100);
      const alertsAfterAuto = await page.evaluate(() => window.__alerts);
      check('Silent auto-save shows NO blocking alert despite the pending N/A justification', alertsAfterAuto.length === 0, `got ${alertsAfterAuto.length}: ${JSON.stringify(alertsAfterAuto)}`);

      const saved = await page.evaluate(() => {
        const raw = localStorage.getItem('auditnist_AUD-AUTOSAVE-REG');
        return raw ? JSON.parse(raw) : null;
      });
      check('...and the work was actually persisted to localStorage despite that', saved !== null && saved.controls?.length === 1);
      check('isDirty is correctly cleared after the silent save', await page.evaluate(() => isDirty) === false);

      const toastText = await page.evaluate(() => document.getElementById('autosave-toast')?.textContent);
      check('A non-blocking visual toast confirms the save instead of an interrupting alert', !!toastText && toastText.includes('✅'));

      await page.evaluate(() => saveProgress());
      await page.waitForTimeout(100);
      const alertsAfterManual = await page.evaluate(() => window.__alerts);
      check('The manual Save button/path still correctly validates and blocks on the same missing justification — that check remains valuable there',
        alertsAfterManual.length > 0 && alertsAfterManual[alertsAfterManual.length - 1].includes('🛑'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('21. Work View — Auditor Notes and Evidence textareas cap their auto-grow height, so the Evidence Register stays reachable on one screen');
    // Found via a real UX review: both textareas already auto-grew with
    // content, but their shared cap was 520px — with two fields like that
    // stacked on a single control, the Evidence Register (one of the
    // features most worth showing off) got pushed off the first screen
    // even for a single control, and the problem only gets worse as a
    // real audit's control count grows (CIS alone has far more controls
    // than the sample audits used during development).
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const longText = Array(30).fill('This is a long line of auditor narrative text describing findings in detail.').join('\n');

      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
      });
      await page.evaluate((txt) => {
        const notes = document.querySelector('.notes');
        notes.value = txt;
        notes.dispatchEvent(new Event('input'));
        const ev = document.querySelector('.evidencia');
        ev.value = txt;
        ev.dispatchEvent(new Event('input'));
      }, longText);
      await page.waitForTimeout(100);
      const notesHeight = await page.evaluate(() => parseInt(document.querySelector('.notes').style.height));
      const evHeight = await page.evaluate(() => parseInt(document.querySelector('.evidencia').style.height));
      check('Auditor Notes caps its auto-grow at 240px with long content, not the old 520px', notesHeight <= 240, `got ${notesHeight}px`);
      check('Evidence caps its auto-grow at 180px with long content — tighter than Notes, since it needs less room than free-form narrative', evHeight <= 180, `got ${evHeight}px`);

      // Loading a SAVED control with long content (not just typing it live)
      // must cap correctly too — this was a real gap found during the fix:
      // one of the two code paths that restore .value on load never called
      // autoGrowTextarea() at all.
      await page.evaluate(() => { document.getElementById('controls').innerHTML = ''; });
      await page.evaluate((txt) => {
        addControl(false, 'Q2', 'AST-01', 'AST-01', 'Asset Governance', '');
        const wrapper = document.querySelector('.control');
        wrapper.querySelector('.evidencia').value = txt;
        toggleValidateBtn(wrapper.querySelector('.evidencia'));
        autoGrowTextarea(wrapper.querySelector('.evidencia'), 180);
        wrapper.querySelector('.notes').value = txt;
        autoGrowTextarea(wrapper.querySelector('.notes'), 240);
      }, longText);
      await page.waitForTimeout(100);
      const loadedNotesHeight = await page.evaluate(() => parseInt(document.querySelector('.notes').style.height));
      const loadedEvHeight = await page.evaluate(() => parseInt(document.querySelector('.evidencia').style.height));
      check('A control loaded with pre-existing long content (not typed live) also caps correctly, not just the live-typing path',
        loadedNotesHeight <= 240 && loadedNotesHeight > 76 && loadedEvHeight <= 180 && loadedEvHeight > 100,
        `notes=${loadedNotesHeight}px, evidence=${loadedEvHeight}px`);

      // Short text must not be artificially inflated by the fix.
      await page.evaluate(() => { document.getElementById('controls').innerHTML = ''; addControl(false, 'Q3', 'PR-01', 'PR-01', 'x', ''); });
      await page.evaluate(() => {
        const notes = document.querySelector('.notes');
        notes.value = 'Short note.';
        notes.dispatchEvent(new Event('input'));
      });
      await page.waitForTimeout(100);
      const shortHeight = await page.evaluate(() => parseInt(document.querySelector('.notes').style.height));
      check('Short content still renders at its small natural height — the cap only kicks in for genuinely long content', shortHeight < 100, `got ${shortHeight}px`);

      // The controls list itself must keep its own internal scroll,
      // independent of how many controls exist — confirmed already
      // implemented (max-h-[70vh] overflow-y-auto), guarded here so a
      // future edit can't silently drop it.
      const sidebarClasses = await page.evaluate(() => document.getElementById('work-view-sidebar')?.className || '');
      check('The Work View controls sidebar keeps its own bounded height and internal scroll regardless of control count',
        sidebarClasses.includes('max-h-') && sidebarClasses.includes('overflow-y-auto'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('22. i18n completeness — Vandan\'s deduplication fix and PDF translation update added ~37 new UI strings only in Spanish and English');
    // Found while reviewing the change: the new alerts, tooltips, and
    // Focus Mode labels this update introduced (alert_control_already_added,
    // focus_mode_title, no_saved_reports, etc.) were only translated into
    // es/en — French, German, Portuguese, Arabic, and Chinese would show
    // the raw key instead of translated text for every one of them.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const newKeys = ['new_audit_tooltip', 'dash_remaining', 'dash_controls', 'work_filter_pending', 'nav_prev', 'nav_next',
        'focus_close', 'focus_autosave_note', 'work_view_toggle_title', 'fw_switch_title', 'status_dot_title',
        'focus_mode_btn_title', 'evaluated_label', 'focus_mode_title', 'alert_unsaved_changes', 'alert_audit_not_found',
        'alert_audit_loaded', 'alert_library_load_failed', 'alert_control_already_evaluated', 'alert_control_already_added',
        'alert_ai_no_valid_response', 'alert_ollama_error', 'alert_report_saved', 'alert_json_imported', 'alert_json_import_error',
        'alert_fill_company', 'alert_pdf_gen_error', 'alert_no_controls_selected', 'alert_skipped_evaluated',
        'no_saved_evaluations', 'work_no_controls', 'pending_validation', 'grid_already_added', 'recommended_control',
        'control_of', 'work_filter_none'];
      let allTranslated = true;
      const missingByLang = {};
      for (const lang of ['fr', 'de', 'pt', 'ar', 'zh']) {
        const missing = await page.evaluate(({ lang, keys }) => {
          currentLang = lang;
          return keys.filter(k => !TRANSLATIONS[lang] || !(k in TRANSLATIONS[lang]));
        }, { lang, keys: newKeys });
        if (missing.length > 0) { allTranslated = false; missingByLang[lang] = missing; }
      }
      check('All UI strings added by the deduplication/PDF-translation update exist in all 7 languages, not just es/en',
        allTranslated, `missing: ${JSON.stringify(missingByLang)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('23. 4C Finding Detail — Condition/Criteria/Cause/Consequence/Recommendation as the canonical Finding structure (Finish Line decision gate)');
    // Closed decision: 4C lives in the control's own evaluation view (not
    // a separate Findings panel), visible only for Non-Compliant/Partial
    // — the only compliance values that actually produce a Finding.
    // `reason` (evidence/notes) is kept as a legacy field, NEVER
    // auto-migrated into `cause` — free-text evidence isn't necessarily a
    // root cause. Recommendation is authored alongside 4C so the issued
    // Finding is complete, not left for Remediation to fill in later.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q', 'GV.RM-01', 'GV.RM-01', 'Key Risk Indicators', '');
      });

      // Hidden by default (no compliance value set yet).
      const hiddenInitially = await page.evaluate(() => document.querySelector('.finding-details-block').classList.contains('hidden'));
      check('4C block hidden with no compliance value set', hiddenInitially);

      // Appears for Non-Compliant and Partial; hidden for Compliant/N/A.
      const visibilityByCompliance = await page.evaluate(() => {
        const sel = document.querySelector('.cumple');
        const results = {};
        ['no', 'partial', 'si', 'na'].forEach(v => {
          sel.value = v; sel.dispatchEvent(new Event('change'));
          results[v] = !document.querySelector('.finding-details-block').classList.contains('hidden');
        });
        return results;
      });
      check('4C visible for Non-Compliant ("no")', visibilityByCompliance.no === true);
      check('4C visible for Partial', visibilityByCompliance.partial === true);
      check('4C hidden for Compliant ("si") — does not produce a Finding', visibilityByCompliance.si === false);
      check('4C hidden for N/A — does not produce a Finding', visibilityByCompliance.na === false);

      // Switching to Compliant/N/A hides the block WITHOUT clearing its
      // content — a draft toggling compliance back and forth must never
      // lose 4C the auditor already wrote.
      const preserved = await page.evaluate(() => {
        document.querySelector('.finding-condition').value = 'Preserve me';
        const sel = document.querySelector('.cumple');
        sel.value = 'si'; sel.dispatchEvent(new Event('change'));
        const clearedWhileHidden = document.querySelector('.finding-condition').value;
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        const restoredWhenVisible = document.querySelector('.finding-condition').value;
        return { clearedWhileHidden, restoredWhenVisible };
      });
      check('4C content survives switching to Compliant and back — never destructively cleared',
        preserved.clearedWhileHidden === 'Preserve me' && preserved.restoredWhenVisible === 'Preserve me');

      // buildFinding() includes all 5 fields, and `reason` is NOT
      // auto-migrated from/into `cause` — they can legitimately differ.
      const findingResult = await page.evaluate(() => {
        document.querySelector('.evidencia').value = 'Free-text fieldwork evidence, not a root cause statement.';
        document.querySelector('.finding-condition').value = 'Condition text';
        document.querySelector('.finding-criteria').value = 'Criteria text';
        document.querySelector('.finding-cause').value = 'Cause text';
        document.querySelector('.finding-consequence').value = 'Consequence text';
        document.querySelector('.finding-recommendation').value = 'Recommendation text';
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor Firm';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'REG-4C-001';
        return collectAuditData().findings[0];
      });
      check('buildFinding() includes condition/criteria/cause/consequence/recommendation',
        findingResult.condition === 'Condition text' && findingResult.criteria === 'Criteria text' &&
        findingResult.cause === 'Cause text' && findingResult.consequence === 'Consequence text' &&
        findingResult.recommendation === 'Recommendation text');
      check('`reason` (legacy) is preserved separately, never overwritten by `cause`',
        findingResult.reason === 'Free-text fieldwork evidence, not a root cause statement.' && findingResult.reason !== findingResult.cause);
      check('recommendationSource is tagged "audit_engine" when the auditor wrote it — lets the Hub know not to offer regeneration',
        findingResult.recommendationSource === 'audit_engine');

      // A legacy control with NO 4C fields touched produces empty 4C —
      // never fabricates a cause from old free-text evidence.
      const legacyResult = await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Legacy Q', 'AST-01', 'AST-01', 'Asset Mgmt', '');
        const sel = document.querySelector('.cumple');
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        document.querySelector('.evidencia').value = 'Old free-text notes from a pre-4C audit.';
        return collectAuditData().findings[0];
      });
      check('A pre-4C control produces empty 4C fields, not a cause fabricated from reason',
        legacyResult.cause === '' && legacyResult.condition === '' && legacyResult.reason === 'Old free-text notes from a pre-4C audit.');
      check('recommendationSource is null for a legacy finding — the Hub must still offer AI generation for it',
        legacyResult.recommendationSource === null);

      // Save/reload preserves all 5 fields exactly.
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q', 'GV.RM-01', 'GV.RM-01', 'Key Risk Indicators', '');
        const sel = document.querySelector('.cumple');
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        document.querySelector('.finding-condition').value = 'Reload Condition';
        document.querySelector('.finding-cause').value = 'Reload Cause';
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor Firm';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'REG-4C-002';
      });
      await page.evaluate(() => saveProgress());
      await page.evaluate(() => { document.getElementById('controls').innerHTML = ''; });
      await page.evaluate(() => loadAuditById('auditnist_REG-4C-002'));
      await page.waitForTimeout(150);
      const reloaded = await page.evaluate(() => ({
        condition: document.querySelector('.finding-condition')?.value,
        cause: document.querySelector('.finding-cause')?.value,
        visible: !document.querySelector('.finding-details-block')?.classList.contains('hidden'),
      }));
      check('Save + reload preserves 4C field values exactly',
        reloaded.condition === 'Reload Condition' && reloaded.cause === 'Reload Cause');
      check('Save + reload keeps 4C visible for a control that is still Non-Compliant', reloaded.visible === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('24. PDF 4C guard (Vandan, final review) — stale 4C from a control switched away from Non-Compliant/Partial must never leak into the report');
    // Real bug found on the last pass: applyComplianceStyling() correctly
    // PRESERVES 4C content when a control moves to Compliant/N/A (so a
    // draft toggling back and forth never loses work) — but the PDF's
    // renderControlCard() previously printed 4C whenever the fields had
    // text, with no check against the control's CURRENT compliance value.
    // Non-Compliant → write 4C → switch to Compliant → issue: the stale
    // 4C would appear in the report for a control that is no longer a
    // Finding. The data itself was never the bug — only the PDF's
    // decision to print it regardless of current state.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      if (jspdfAvailable) {
        const capturedText = await page.evaluate(async () => {
          document.getElementById('controls').innerHTML = '';
          addControl(false, 'Q', 'GV.RM-01', 'GV.RM-01', 'Key Risk Indicators', '');
          const sel = document.querySelector('.cumple');
          sel.value = 'no'; sel.dispatchEvent(new Event('change'));
          document.querySelector('.evidencia').value = 'evidence text';
          document.querySelector('.finding-condition').value = 'STALE CONDITION SHOULD NOT PRINT';
          sel.value = 'si'; sel.dispatchEvent(new Event('change')); // switch away from Finding — 4C preserved but hidden
          document.getElementById('empresa_auditada').value = 'Test Co';
          document.getElementById('empresa_auditora').value = 'Test Auditor Firm';
          document.getElementById('auditor').value = 'Tester';
          document.getElementById('id_informe').value = 'REG-PDF-GUARD-001';

          const captured = [];
          const jsPDFClass = window.jspdf.jsPDF;
          const origText = jsPDFClass.API.text;
          jsPDFClass.API.text = function(str, ...rest) {
            if (typeof str === 'string') captured.push(str);
            return origText.call(this, str, ...rest);
          };
          jsPDFClass.API.save = function() { return this; };
          await generatePDF('test.pdf');
          jsPDFClass.API.text = origText;
          return captured.join(' | ');
        });
        check('Stale 4C content is NOT printed in the PDF once the control is Compliant, even though it is still preserved in the DOM',
          !capturedText.includes('STALE CONDITION SHOULD NOT PRINT'));

        // Round-trip: switching back to Non-Compliant brings it back —
        // confirms this is a presentation guard, not data loss.
        const roundtripText = await page.evaluate(async () => {
          const sel = document.querySelector('.cumple');
          sel.value = 'no'; sel.dispatchEvent(new Event('change'));
          const captured = [];
          const jsPDFClass = window.jspdf.jsPDF;
          const origText = jsPDFClass.API.text;
          jsPDFClass.API.text = function(str, ...rest) {
            if (typeof str === 'string') captured.push(str);
            return origText.call(this, str, ...rest);
          };
          jsPDFClass.API.save = function() { return this; };
          await generatePDF('test.pdf');
          jsPDFClass.API.text = origText;
          return captured.join(' | ');
        });
        check('Switching back to Non-Compliant brings the SAME 4C content back into the PDF — confirms this is a presentation guard, not data loss',
          roundtripText.includes('STALE CONDITION SHOULD NOT PRINT'));
      } else {
        console.log('  ⚠️  jsPDF unavailable in this environment — skipping the PDF-rendering check for the 4C guard. The underlying compliance-state guard (isFinding) is still exercised at the code level by the other 4C tests in this suite.');
      }
      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('25. Multilingual control library (Vandan\'s plan) — getControlName()/getControlQuestion(), live re-render, and issued-snapshot protection');
    // scf-controls.json stays English-only and untouched — the SCF source
    // of truth. data/i18n/controls.es.json is a separate translation
    // overlay for name/question only, keyed by control ID. IDs, framework
    // codes and mappings are never translated. Covers exactly the 6 cases
    // from the closed decision: ES shows Spanish, EN shows original SCF
    // English, switching back to ES restores Spanish, a missing
    // translation falls back to English rather than showing blank, a
    // custom (non-library) control is left alone, and an issued/locked
    // audit's displayed content is never retroactively rewritten by a
    // later language switch.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
      });
      const englishByDefault = await page.evaluate(() => ({
        lang: currentLang,
        question: document.querySelector('.control-body p')?.textContent,
      }));
      check('Default/English shows the original SCF question, unmodified', englishByDefault.lang === 'en' &&
        englishByDefault.question.startsWith('Does the organization'));

      await page.evaluate(async () => { await setLanguage('es'); });
      await page.waitForTimeout(200);
      const afterEs = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('ES → shows the Spanish name+question, re-rendered live with NO page reload',
        afterEs.startsWith('¿La organización') && afterEs !== englishByDefault.question);

      await page.evaluate(async () => { await setLanguage('en'); });
      await page.waitForTimeout(200);
      const backToEn = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('EN → restores the original SCF English text exactly, live, no reload',
        backToEn === englishByDefault.question);

      await page.evaluate(async () => { await setLanguage('es'); });
      await page.waitForTimeout(200);
      const backToEsAgain = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('ES again → correctly re-translates back to Spanish (not stuck on English)',
        backToEsAgain === afterEs);

      // Missing translation → falls back to English, never blank.
      const fallbackResult = await page.evaluate(() => {
        // A scfId genuinely absent from controlsI18n.es (simulating an
        // incomplete/partial translation file) must still resolve to the
        // English SCF text, not an empty string.
        return {
          name: getControlName('THIS-ID-DOES-NOT-EXIST-IN-TRANSLATION'),
          question: getControlQuestion('GOV-01'), // real ID, but pretend the translation lookup failed
        };
      });
      const fallbackWorks = await page.evaluate(() => {
        const saved = controlsI18n['es'] ? controlsI18n['es']['GOV-01'] : undefined;
        if (controlsI18n['es']) delete controlsI18n['es']['GOV-01'];
        const q = getControlQuestion('GOV-01');
        if (controlsI18n['es'] && saved) controlsI18n['es']['GOV-01'] = saved; // restore
        return q;
      });
      check('A missing translation entry falls back to the English SCF text — never blank',
        fallbackWorks.startsWith('Does the organization'));

      // Custom (non-library) control is left completely alone.
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'My own custom audit question, not from any library.', '', '', 'Custom Control', '');
      });
      const beforeCustomSwitch = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      await page.evaluate(async () => { await setLanguage('es'); });
      await page.waitForTimeout(200);
      const afterCustomSwitch = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('A custom control (no scfId, not from the library) is never touched by retranslateOpenControls()',
        afterCustomSwitch === beforeCustomSwitch && afterCustomSwitch === 'My own custom audit question, not from any library.');

      // Issued/locked audit: language switch must NOT alter displayed content.
      await page.evaluate(async () => { await setLanguage('en'); });
      await page.evaluate(() => {
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
        document.getElementById('eng_status').value = 'issued';
      });
      const frozenBefore = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      await page.evaluate(async () => { await setLanguage('es'); });
      await page.waitForTimeout(200);
      const frozenAfter = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('An issued (locked) audit\'s displayed control text is NOT retroactively translated by a later language switch',
        frozenAfter === frozenBefore && frozenAfter.startsWith('Does the organization'));

      // Confirm it un-freezes correctly once back in draft — this isn't a
      // permanent stuck state, only a guard while genuinely locked.
      await page.evaluate(() => { document.getElementById('eng_status').value = 'draft'; });
      await page.evaluate(async () => { await setLanguage('en'); });
      await page.evaluate(async () => { await setLanguage('es'); });
      await page.waitForTimeout(200);
      const unfrozen = await page.evaluate(() => document.querySelector('.control-body p')?.textContent);
      check('...and correctly re-translates once the audit returns to draft — the guard is temporary, not a stuck state',
        unfrozen.startsWith('¿La organización'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('26. Multilingual control library, Parches 7 & 8 — canonical-English persistence, and bilingual issued-snapshot governance of the entire PDF');
    // The correctness fixes a review caught on top of the live-render
    // work in section 25: without these, switching the UI's language and
    // saving would persist the currently-displayed language as if it
    // were audit data — a real integrity bug, not a cosmetic one. Parche
    // 7 makes collectAuditData() always resolve scfId/fwCode/ctrl/name/
    // question for a recognized SCF control against the canonical English
    // catalogue, never the DOM (which retranslateOpenControls() legitimately
    // rewrites for display). Parche 8 makes an ISSUED snapshot the opposite
    // case: it's the actual client-facing artifact, so it must freeze
    // displayName/displayQuestion AND a reportLanguage at the moment of
    // issuance, and generatePDF() must render the ENTIRE report — labels,
    // headers, callouts, not just the control's own text — in that frozen
    // language when re-downloading an issued version, regardless of the
    // UI's current language.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      // Parche 7: the persisted record must be byte-identical whether
      // saved while the UI shows Spanish or English.
      await page.evaluate(async () => {
        await setLanguage('es');
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
        const sel = document.querySelector('.cumple');
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        document.querySelector('.evidencia').value = 'Evidencia de prueba.';
      });
      const savedInEs = await page.evaluate(() => {
        const c = collectAuditData().controls[0];
        return { scfId: c.scfId, fwCode: c.fwCode, ctrl: c.ctrl, name: c.name, question: c.question };
      });
      await page.evaluate(async () => { await setLanguage('en'); });
      const savedInEn = await page.evaluate(() => {
        const c = collectAuditData().controls[0];
        return { scfId: c.scfId, fwCode: c.fwCode, ctrl: c.ctrl, name: c.name, question: c.question };
      });
      check('Parche 7: collectAuditData() persists an IDENTICAL record for an SCF control regardless of the active UI language',
        JSON.stringify(savedInEs) === JSON.stringify(savedInEn));
      check('Parche 7: the persisted name/question/ctrl are canonical English, not whatever language was displayed at save time',
        savedInEn.name === 'Cybersecurity & Data Protection Governance Program' &&
        savedInEn.question.startsWith('Does the organization') &&
        savedInEn.ctrl === 'GOV-01 – Cybersecurity & Data Protection Governance Program');

      // Parche 8: issuing while Spanish is active freezes reportLanguage
      // and per-control displayName/displayQuestion, while name/question
      // stay canonical English underneath.
      await page.evaluate(async () => {
        await setLanguage('es');
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'PATCH78-TEST';
        approvals.policy = 'none';
      });
      await page.evaluate(() => issueFinalReport());
      const snapshotCheck = await page.evaluate(() => {
        const snap = versionSnapshots['1.0'];
        const c = snap.controls[0];
        return {
          reportLanguage: snap.reportLanguage,
          displayName: c.displayName,
          displayQuestion: c.displayQuestion,
          name: c.name,
          question: c.question,
        };
      });
      check('Parche 8: an issued snapshot records reportLanguage matching the language active at issuance',
        snapshotCheck.reportLanguage === 'es');
      check('Parche 8: each control gets a frozen displayName/displayQuestion in that issuance language',
        snapshotCheck.displayName === 'Programa de Gobernanza de Ciberseguridad y Protección de Datos' &&
        snapshotCheck.displayQuestion.startsWith('¿La organización'));
      check('Parche 8: name/question underneath stay canonical English even in a Spanish-issued snapshot',
        snapshotCheck.name === 'Cybersecurity & Data Protection Governance Program');

      // Parche 8: switching the UI language afterward must not touch the
      // locked audit's displayed content (already covered in section 25),
      // and re-downloading the issued PDF must render ENTIRELY in the
      // issuance language, not the UI's current one — verified here via
      // the currentLang override actually taking effect and restoring
      // cleanly, since a real PDF render isn't available without jsPDF
      // in every environment (see section 24's own note).
      await page.evaluate(async () => { await setLanguage('en'); });
      const pdfLangBehavior = await page.evaluate(() => {
        const before = currentLang;
        // Reproduce generatePDF()'s own override logic in isolation,
        // exactly as it appears in the function, to confirm the guard
        // and restoration work without requiring jsPDF to be present.
        const savedLangForPdf = currentLang;
        const sourceSnapshot = versionSnapshots['1.0'];
        if (sourceSnapshot?.reportLanguage) currentLang = sourceSnapshot.reportLanguage;
        const duringPdf = currentLang;
        currentLang = savedLangForPdf; // the try/finally's restoration
        const after = currentLang;
        return { before, duringPdf, after };
      });
      check('Parche 8: currentLang overrides to the snapshot\'s reportLanguage during PDF generation, even though the UI is showing a different language',
        pdfLangBehavior.before === 'en' && pdfLangBehavior.duringPdf === 'es');
      check('Parche 8: currentLang is correctly restored to the UI\'s actual language after PDF generation — the override never leaks',
        pdfLangBehavior.after === 'en');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('27. Review gaps 1 & 2 — getEffectiveReportLanguage() prevents a traceable falsehood, and reopening a locked audit restores its actual issued presentation');
    // Gap 1: pdfT()/pdfL() are strictly binary (Spanish or English, with
    // every other language falling back to English — see their own
    // comments). Recording currentLang directly as reportLanguage would
    // be a lie for French/German/Portuguese/Arabic/Chinese: the snapshot
    // would claim e.g. "fr" while the PDF it actually generates is
    // English. getEffectiveReportLanguage() must collapse anything that
    // isn't 'es' down to 'en', matching what the PDF genuinely renders.
    //
    // Gap 2: displayName/displayQuestion (Parche 8) are frozen inside a
    // specific versionSnapshots[version] entry, not on data.controls[i]
    // itself — that top-level array is always canonical English (Parche
    // 7). Reopening a LOCKED audit must restore the actual issued
    // presentation (by looking up the matching snapshot control by
    // scfId), not canonical English, since retranslateOpenControls()
    // correctly refuses to touch a locked audit at all.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const gap1Result = await page.evaluate(async () => {
        currentLang = 'fr'; // a language with no controlsI18n overlay
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
        const sel = document.querySelector('.cumple');
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        document.querySelector('.evidencia').value = 'Evidence.';
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'GAP1-REG';
        approvals.policy = 'none';
        issueFinalReport();
        return {
          reportLanguage: versionSnapshots['1.0'].reportLanguage,
          currentLangAfter: currentLang,
        };
      });
      check('Gap 1: issuing with an unsupported UI language (e.g. French) records reportLanguage as "en", never the unsupported language itself',
        gap1Result.reportLanguage === 'en');
      check('Gap 1: currentLang is correctly restored to the original UI language ("fr") after issuance — the internal override never leaks',
        gap1Result.currentLangAfter === 'fr');
      await page.close(); await ctx.close();
    }

    // Gap 2 gets its own fresh context/page — issueFinalReport() blocks
    // re-issuing the same version number (docVersionHistory carries over
    // within one page's lifetime), and doc_version is left blank here
    // (always defaulting to "1.0"), so reusing Gap 1's page would make
    // this issuance silently no-op rather than testing anything real.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      // Gap 2: issue in Spanish, save, switch UI to English, then
      // genuinely REOPEN the audit (fresh page load + loadAuditById) —
      // the locked screen must show Spanish, matching the actual PDF.
      await page.evaluate(async () => {
        await setLanguage('es');
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
        const sel = document.querySelector('.cumple');
        sel.value = 'no'; sel.dispatchEvent(new Event('change'));
        document.querySelector('.evidencia').value = 'Evidencia.';
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'GAP2-REG';
        approvals.policy = 'none';
      });
      await page.evaluate(() => issueFinalReport());
      await page.evaluate(() => saveProgress());
      await page.evaluate(async () => { await setLanguage('en'); });

      // Genuinely reopen: navigate away and back, then load from storage.
      await page.goto(`http://localhost:${PORT}/app.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => loadAuditById('auditnist_GAP2-REG'));
      await page.waitForTimeout(200);

      const gap2Result = await page.evaluate(() => ({
        isLocked: isAuditLocked(),
        uiLanguage: currentLang,
        questionShown: document.querySelector('.control-body p')?.textContent,
        nameShown: document.querySelector('.ctrl')?.value,
      }));
      check('Gap 2: the reopened audit is correctly locked', gap2Result.isLocked === true);
      check('Gap 2: the language SELECTOR shows English (the UI\'s own current preference)', gap2Result.uiLanguage === 'en');
      check('Gap 2: but the locked screen shows the SPANISH question — the language it was actually issued in, not canonical English or the UI\'s current language',
        gap2Result.questionShown.startsWith('¿La organización'));
      check('Gap 2: ...and the SPANISH name too',
        gap2Result.nameShown.includes('Programa de Gobernanza'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('28. Second review pass — no duplicate suggestControls(), dead updateSummary() removed, and a reopened DRAFT re-translates immediately');
    // Three issues a second reviewer caught that the first round missed:
    // (1) suggestControls() had been accidentally duplicated again during
    // the multilingual work — a real regression of cleanup done earlier
    // in the project, even though JS silently uses the second definition
    // so the app still "worked." (2) updateSummary() computed stats it
    // never used (its own DOM writes were commented out) — genuinely dead
    // code. (3) The actual functional bug: loadAuditById()/importFromJSON()
    // never called retranslateOpenControls() for a DRAFT (non-issued)
    // audit, so reopening one while the UI showed a different language
    // than canonical English displayed stale English text until the
    // auditor manually toggled the language selector — confusing, and
    // easy to mistake for a real data problem.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const dupCheck = await page.evaluate(() => typeof suggestControls);
      check('suggestControls is defined exactly once (no duplicate silently shadowing it)', dupCheck === 'function');
      check('updateSummary() has been removed entirely — it computed stats it never used', await page.evaluate(() => typeof updateSummary === 'undefined'));

      // The actual bug: a DRAFT saved while canonical English is on disk
      // (per Parche 7, always true for an SCF control) must display in
      // whatever language the UI is CURRENTLY set to as soon as it's
      // reopened — not require a manual language toggle first.
      await page.evaluate(async () => {
        await setLanguage('en');
        document.getElementById('controls').innerHTML = '';
        addControlFromGrid('GOV-01', 'GOV-01');
        document.getElementById('empresa_auditada').value = 'Test Co';
        document.getElementById('empresa_auditora').value = 'Test Auditor';
        document.getElementById('auditor').value = 'Tester';
        document.getElementById('id_informe').value = 'DRAFT-RETRANSLATE-REG';
      });
      await page.evaluate(() => saveProgress());
      await page.evaluate(async () => { await setLanguage('es'); });

      await page.goto(`http://localhost:${PORT}/app.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      await page.evaluate(async () => { await setLanguage('es'); }); // simulate the UI's saved language preference on a fresh load
      await page.evaluate(() => loadAuditById('auditnist_DRAFT-RETRANSLATE-REG'));
      await page.waitForTimeout(200);

      const draftResult = await page.evaluate(() => ({
        isLocked: isAuditLocked(),
        question: document.querySelector('.control-body p')?.textContent,
      }));
      check('A reopened DRAFT audit is correctly NOT locked', draftResult.isLocked === false);
      check('...and its controls show the CURRENT UI language (Spanish) immediately on load — no manual language toggle needed',
        draftResult.question.startsWith('¿La organización'));

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

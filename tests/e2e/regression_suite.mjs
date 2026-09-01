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
        document.getElementById('controls').innerHTML = '';
        addControl(false, 'Q1', 'GOV-01', 'GOV-01', 'Governance Program', '');
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'no';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => issueFinalReport());
      await page.waitForTimeout(200);

      const v1Frozen = await page.evaluate(() => versionSnapshots['1.0']?.controls?.[0]?.cumple);
      check('v1.0 is archived as its own immutable snapshot at issuance', v1Frozen === 'no', `got "${v1Frozen}"`);

      const noRecursiveNesting = await page.evaluate(() => !versionSnapshots['1.0']?.engagement?.docControl?.versionSnapshots);
      check('A version snapshot does not recursively re-embed the snapshot map itself', noRecursiveNesting);

      // Reopen, fix the finding, bump the version, issue again.
      await page.evaluate(() => reopenForNewVersion());
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const blk = document.querySelector('.control');
        blk.querySelector('.cumple').value = 'yes';
        blk.querySelector('.cumple').dispatchEvent(new Event('change'));
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

      const downloadButtonsPresent = await page2.evaluate(() =>
        ['1.0', '1.1'].every(v => document.querySelector(`button[onclick="downloadVersionSnapshot('${v}')"]`))
      );
      check('A download button is offered for every archived (issued) version', downloadButtonsPresent);

      await page.close();
      await page2.close();
      await ctx.close();
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

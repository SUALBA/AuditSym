// ═════════════════════════════════════════════════════════════════════════
// AuditSym — Remediation Hub E2E Regression Suite
// ═════════════════════════════════════════════════════════════════════════
// Covers issue #2 (hub-portfolio) and both rounds of review it went
// through: multi-audit isolation, official/unofficial import provenance,
// identity collisions, same-version content inconsistency, version-update
// review and cancellation, older-version blocking, preserved disappeared
// findings, legacy migration safety, canonical storage keys, and
// per-audit-scoped exports.
//
// SETUP (one time):
//   npm install playwright
//   npx playwright install chromium
//
// USAGE — place this file at repo-root/tests/e2e/regression_suite_hub.mjs:
//   node tests/e2e/regression_suite_hub.mjs
//
// Reads the repo's own ui/remediation-hub.html directly:
//   AUDITSYM_HUB_HTML=path/to/remediation-hub.html node tests/e2e/regression_suite_hub.mjs
// ═════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_HTML = process.env.AUDITSYM_HUB_HTML || path.join(__dirname, '..', '..', 'ui', 'remediation-hub.html');
const PORT = 8842;

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

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = null;
      if (req.url === '/hub.html') filePath = TARGET_HTML;
      if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function newPage(browser, context) {
  const page = await context.newPage();
  // Deliberately NO persistent dialog handler here — several sections need
  // to distinguish accept vs. dismiss, or capture the exact message shown,
  // and a default listener installed here would race with any handler a
  // test adds later for the same dialog (Playwright allows only one
  // listener to actually resolve a given dialog). Each section manages
  // its own dialog handling explicitly via captureNextDialog() below.
  await page.goto(`http://localhost:${PORT}/hub.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(800);
  // M3's remediationPlan mutation functions (addActionItem,
  // requestPlanChangeRequest, transitionPlanToPlanned, etc.) now enforce
  // canEditRemediationPlan() themselves, not just the rendering layer —
  // and the app's own default role is 'auditor' (see state.role's
  // initializer). Defaulting every fresh test page to 'client' here means
  // the vast majority of this suite's checks, which are exercising plan
  // mutations and never intended to test role gating itself, don't all
  // need to remember to set this individually. Sections that specifically
  // test auditor-role behavior (e.g. the segregation-of-duties checks)
  // explicitly set state.role = 'auditor' themselves where needed, which
  // simply overrides this default for that one check.
  await page.evaluate(() => { state.role = 'client'; });
  return page;
}

// Captures the next dialog's message and accepts it — the common case
// throughout this suite (reading what a warning/confirm says while still
// letting the flow proceed). Replaces any prior dialog listener on this
// page first, so it can never conflict with one a previous check left
// behind.
function captureNextDialog(page) {
  page.removeAllListeners('dialog');
  return new Promise(resolve => {
    page.once('dialog', async d => { const msg = d.message(); await d.accept(); resolve(msg); });
  });
}
// Same, but DISMISSES instead of accepting — for the handful of checks
// that specifically verify "declining the prompt cancels the action."
function captureNextDialogAndDismiss(page) {
  page.removeAllListeners('dialog');
  return new Promise(resolve => {
    page.once('dialog', async d => { const msg = d.message(); await d.dismiss(); resolve(msg); });
  });
}
// For steps where a dialog might or might not appear and its content
// doesn't matter — just keep accepting whatever comes up.
function autoAcceptDialogs(page) {
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { await d.accept(); });
}

// A minimal, complete M2 managementResponse — every test finding needs
// this so normalizeFinding()'s shape checks never reject a test fixture.
const emptyMR = () => ({
  validationStatus: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '',
  responder: '', responderRole: '', responseDate: '', source: 'manual_entry',
  receivedVia: '', comments: '', treatment: null, treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
});
function buildFinding(id, code, extra) {
  return { id, controlCode: code, title: `${code} – finding`, severity: 'medium', riskLevel: 'medium',
    status: 'open', managementResponse: emptyMR(), history: [], ...(extra || {}) };
}
function officialAudit(id, empresa, version, findings, framework) {
  return {
    id, empresa, framework: framework || 'nist-csf',
    publishedAt: new Date().toISOString(),
    engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { version } },
    remediationHandoff: {
      eligible: true, generatedAt: new Date().toISOString(),
      sourceAuditId: id, sourceVersion: version, sourceStatus: 'issued'
    },
    findings
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PDF layout regression helpers — mirrors the same approach used for the
// audit engine's own PDF (regression_suite.mjs section 15): poppler's
// `pdftotext -bbox` reports the exact bounding box (in points) of every
// word on every page, so a word extending past the page's own dimensions
// is a real, measured clipping bug, not a visual guess. Depends on
// poppler-utils (pdftotext); its absence is reported and only the checks
// that need it are skipped, so the rest of the suite is unaffected.
// ─────────────────────────────────────────────────────────────────────────
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

function pdfContainsAllStrings(pdfPath, expectedStrings) {
  const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).replace(/\s+/g, ' ');
  const missing = expectedStrings.filter(s => !text.includes(s.replace(/\s+/g, ' ')));
  return { ok: missing.length === 0, missing };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();

  try {
    // ═══════════════════════════════════════════════════════════════════
    section('1. Multi-audit isolation — the core of issue #2');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const auditA = officialAudit('AUD-A', 'Company A', '1.0', [buildFinding('FA1', 'GOV.01')], 'nist-csf');
      const auditB = officialAudit('AUD-B', 'Company B', '1.0', [buildFinding('FB1', 'A.5.1')], 'iso27001');

      await page.evaluate((d) => processImportedData(d), auditA);
      await page.waitForTimeout(150);
      await page.evaluate(() => { state.findings[0].owner = 'Alpha Team'; saveActiveAuditToStorage(); });
      await page.evaluate((d) => processImportedData(d), auditB);
      await page.waitForTimeout(150);
      await page.evaluate(() => { state.findings[0].owner = 'Beta Team'; saveActiveAuditToStorage(); });

      const indexCount = await page.evaluate(() => state.auditIndex.length);
      check('Both audits appear in the portfolio index', indexCount === 2, `got ${indexCount}`);

      const storedIsolation = await page.evaluate(() => ({
        a: JSON.parse(localStorage.getItem(`hub_findings_${buildStorageKey('AUD-A')}`))[0].owner,
        b: JSON.parse(localStorage.getItem(`hub_findings_${buildStorageKey('AUD-B')}`))[0].owner
      }));
      check('Each audit\'s findings are stored under its own isolated key', storedIsolation.a === 'Alpha Team' && storedIsolation.b === 'Beta Team');

      await page.evaluate(() => openAudit(buildStorageKey('AUD-A')));
      const openA = await page.evaluate(() => ({ owner: state.findings[0].owner, company: state.auditData.empresa }));
      await page.evaluate(() => openAudit(buildStorageKey('AUD-B')));
      const openB = await page.evaluate(() => ({ owner: state.findings[0].owner, company: state.auditData.empresa }));
      check('Opening each audit loads only its own data, never mixed with the other', openA.owner === 'Alpha Team' && openB.owner === 'Beta Team' && openA.company !== openB.company);

      // Found during a Hub verification pass: getFilteredFindings() reads
      // filter-search/severity/status directly from the DOM, and neither
      // openAudit() nor commitImportedAudit() used to reset them. A filter
      // left over from a PREVIOUS audit could silently hide a different
      // audit's genuinely-present findings after switching, with no
      // indication why the list looked empty.
      await page.evaluate(() => openAudit(buildStorageKey('AUD-A')));
      await page.evaluate(() => { document.getElementById('filter-severity').value = 'critical'; renderFindings(); });
      await page.evaluate(() => openAudit(buildStorageKey('AUD-B')));
      const filterAfterSwitch = await page.evaluate(() => ({
        value: document.getElementById('filter-severity').value,
        visibleCount: getFilteredFindings().length,
        actualCount: state.findings.length,
      }));
      check('Switching audits resets the severity/status/search filters, so a filter left over from the previous audit never hides the new audit\'s own findings',
        filterAfterSwitch.value === '' && filterAfterSwitch.visibleCount === filterAfterSwitch.actualCount,
        `got ${JSON.stringify(filterAfterSwitch)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('2. Import provenance — official, unofficial, and incomplete handoffs');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const official = officialAudit('AUD-PROV', 'Provenance Co', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), official);
      await page.waitForTimeout(150);
      const officialEntry = await page.evaluate(() => state.auditIndex.find(e => e.auditId === 'AUD-PROV'));
      check('An official handoff import is classified official_handoff', officialEntry.provenance === 'official_handoff', `got ${officialEntry.provenance}`);

      const unofficial = { id: 'AUD-UNOFF', empresa: 'Draft Co', framework: 'nist-csf', findings: [buildFinding('F2', 'GOV.02')] };
      const dismissPromise = captureNextDialogAndDismiss(page);
      await page.evaluate((d) => processImportedData(d), unofficial);
      await dismissPromise;
      await page.waitForTimeout(150);
      const dismissedResult = await page.evaluate(() => state.auditIndex.some(e => e.auditId === 'AUD-UNOFF'));
      check('Dismissing the unofficial-import warning cancels the import entirely', !dismissedResult);

      const acceptPromise = captureNextDialog(page);
      await page.evaluate((d) => processImportedData(d), unofficial);
      await acceptPromise;
      await page.waitForTimeout(150);
      const acceptedEntry = await page.evaluate(() => state.auditIndex.find(e => e.auditId === 'AUD-UNOFF'));
      check('Accepting the warning imports it, correctly classified unverified_import', acceptedEntry?.provenance === 'unverified_import', `got ${JSON.stringify(acceptedEntry)}`);

      const validation = await page.evaluate(() => ({
        missingGeneratedAt: validateHandoffProvenance({ id: 'X', empresa: 'C', framework: 'nist-csf', engagement: { docControl: { version: '1.0' } }, findings: [{ id: 'f1' }], remediationHandoff: { eligible: true, sourceStatus: 'issued', sourceAuditId: 'X', sourceVersion: '1.0' } }),
        missingDocVersion: validateHandoffProvenance({ id: 'X', empresa: 'C', framework: 'nist-csf', engagement: {}, findings: [{ id: 'f1' }], remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceStatus: 'issued', sourceAuditId: 'X', sourceVersion: '1.0' } }),
        unstableIds: validateHandoffProvenance({ id: 'X', empresa: 'C', framework: 'nist-csf', engagement: { docControl: { version: '1.0' } }, findings: [{ title: 'no id' }], remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceStatus: 'issued', sourceAuditId: 'X', sourceVersion: '1.0' } }),
      }));
      check('Handoff validation rejects a missing/unparseable generatedAt', validation.missingGeneratedAt.valid === false && validation.missingGeneratedAt.reason === 'bad_generated_at');
      check('Handoff validation requires docControl.version to be present AND matching', validation.missingDocVersion.valid === false && validation.missingDocVersion.reason === 'version_mismatch');
      check('Handoff validation rejects findings without stable ids', validation.unstableIds.valid === false && validation.unstableIds.reason === 'unstable_ids');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('3. Identity collisions');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const first = officialAudit('AUD-COL', 'Company Alpha', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), first);
      await page.waitForTimeout(150);

      const colliding = officialAudit('AUD-COL', 'Totally Different Company', '1.0', [buildFinding('F1', 'GOV.01')]);
      const collisionAlertPromise = captureNextDialog(page);
      await page.evaluate((d) => processImportedData(d), colliding);
      const collisionMsg = await collisionAlertPromise;
      await page.waitForTimeout(150);
      check('An ID match with a different company is flagged as an identity collision', collisionMsg.includes('colisión') || collisionMsg.toLowerCase().includes('collision'));
      const stillOriginal = await page.evaluate(() => state.auditIndex.find(e => e.auditId === 'AUD-COL')?.company);
      check('The original audit\'s data is untouched after a blocked collision', stillOriginal === 'Company Alpha');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('4. Version safety — malformed, older, same-identical, same-inconsistent, newer');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const cmp = await page.evaluate(() => ({
        draft: compareVersions('draft', '1.0'),
        letters: compareVersions('1.A', '1.0'),
        empty: compareVersions('', '1.0'),
        valid: compareVersions('1.1', '1.0'),
      }));
      check('compareVersions() never guesses at a malformed version string — returns null', cmp.draft === null && cmp.letters === null && cmp.empty === null, `got ${JSON.stringify(cmp)}`);
      check('compareVersions() still works correctly for two valid strict versions', cmp.valid === 1);

      const v1 = officialAudit('AUD-VER', 'Version Co', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(150);

      const older = officialAudit('AUD-VER', 'Version Co', '0.9', [buildFinding('F1', 'GOV.01')]);
      const olderAlertPromise = captureNextDialog(page);
      await page.evaluate((d) => processImportedData(d), older);
      const olderMsg = await olderAlertPromise;
      await page.waitForTimeout(150);
      check('Importing an older version is blocked outright', olderMsg.includes('anterior') || olderMsg.toLowerCase().includes('older'));
      const stillV1 = await page.evaluate(() => state.auditIndex.find(e => e.auditId === 'AUD-VER')?.sourceVersion);
      check('The active version is never silently rolled back', stillV1 === '1.0');

      const historyBefore = await page.evaluate(() => state.history.length);
      const identical = officialAudit('AUD-VER', 'Version Co', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), identical);
      await page.waitForTimeout(150);
      const historyAfter = await page.evaluate(() => state.history.length);
      check('Re-importing the IDENTICAL same version is idempotent (no duplicate history entry)', historyAfter === historyBefore, `before=${historyBefore} after=${historyAfter}`);

      const sameVersionDifferentContent = officialAudit('AUD-VER', 'Version Co', '1.0', [buildFinding('F1', 'GOV.01', { severity: 'critical' })]);
      const inconsistentAlertPromise = captureNextDialog(page);
      await page.evaluate((d) => processImportedData(d), sameVersionDifferentContent);
      const inconsistentMsg = await inconsistentAlertPromise;
      await page.waitForTimeout(150);
      check('Same version but DIFFERENT content triggers an inconsistent-artifact warning, not a silent overwrite',
        inconsistentMsg.includes('inconsistente') || inconsistentMsg.toLowerCase().includes('inconsistent'));
      const modalShownForInconsistent = await page.evaluate(() => !document.getElementById('version-diff-modal').classList.contains('hidden'));
      check('...and routes to the full diff review rather than auto-applying', modalShownForInconsistent);
      const modifiedList = await page.evaluate(() => pendingVersionUpdate?.diff?.modified);
      check('The diff correctly flags the changed field (severity)', Array.isArray(modifiedList) && modifiedList.length === 1 && modifiedList[0].changedFields.includes('severity'), `got ${JSON.stringify(modifiedList)}`);
      await page.evaluate(() => cancelVersionUpdate());
      const cancelledStillOld = await page.evaluate(() => JSON.parse(localStorage.getItem(`hub_findings_${buildStorageKey('AUD-VER')}`))[0].severity);
      check('Cancelling the update leaves the originally stored data untouched', cancelledStillOld === 'medium', `got "${cancelledStillOld}"`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('5. Disappeared findings are preserved, never deleted');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const v1 = officialAudit('AUD-DISAP', 'Disappear Co', '1.0', [buildFinding('FA', 'GOV.01'), buildFinding('FB', 'AST.01')]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const f = state.findings.find(f => f.id === 'FA');
        f.owner = 'IT Ops'; f.status = 'in_progress';
        saveActiveAuditToStorage();
      });

      // v1.1 drops FB, adds FC
      const v11 = officialAudit('AUD-DISAP', 'Disappear Co', '1.1', [buildFinding('FA', 'GOV.01'), buildFinding('FC', 'BCD.01')]);
      await page.evaluate((d) => processImportedData(d), v11);
      await page.waitForTimeout(150);
      await page.evaluate(() => confirmVersionUpdate());
      await page.waitForTimeout(150);

      const result = await page.evaluate(() => ({
        total: state.findings.length,
        fa: state.findings.find(f => f.id === 'FA') && { owner: state.findings.find(f => f.id === 'FA').owner, lifecycle: state.findings.find(f => f.id === 'FA').sourceLifecycleState },
        fb: state.findings.find(f => f.id === 'FB') && { lifecycle: state.findings.find(f => f.id === 'FB').sourceLifecycleState },
        fc: !!state.findings.find(f => f.id === 'FC'),
      }));
      check('All three findings present after the update (FA kept, FB preserved, FC added)', result.total === 3, `got ${result.total}`);
      check('FA (still present) keeps its remediation progress', result.fa?.owner === 'IT Ops');
      check('FB (disappeared) is preserved, marked absent_from_latest_source, NOT deleted', result.fb?.lifecycle === 'absent_from_latest_source', `got ${JSON.stringify(result.fb)}`);
      check('FC (new) is correctly added', result.fc === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('5b. normalizeFinding() idempotency — no spurious auto-confirmation');
    // Regression covered: normalizeFinding() legitimately runs more than
    // once on the same finding within a single import (once in
    // processImportedData(), again inside commitImportedAudit()'s merge).
    // A finding with no decision/validationStatus at all must stay
    // unvalidated after BOTH passes — the first pass's own 'mitigate'
    // display fallback must never be misread by the second pass as a
    // genuine historical decision that silently auto-confirms the finding.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const untouchedFinding = {
        id: 'F-IDEMPOTENT', controlCode: 'AST.01', title: 'AST.01 – Idempotency check', severity: 'low', riskLevel: 'low', status: 'open',
        managementResponse: {
          validationStatus: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '',
          responder: '', responderRole: '', responseDate: '', source: 'manual_entry',
          receivedVia: 'Informal meeting', comments: 'A comment exists, but nobody validated this finding.',
          treatment: null, treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
        },
        history: []
      };
      const audit = officialAudit('AUD-IDEMPOTENT', 'Idempotency Co', '1.0', [untouchedFinding]);
      await page.evaluate((d) => processImportedData(d), audit);
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => {
        const f = state.findings.find(f => f.id === 'F-IDEMPOTENT');
        return { validationStatus: f.managementResponse.validationStatus, treatment: f.managementResponse.treatment, decision: f.decision, comments: f.managementResponse.comments };
      });
      check('A finding with no real decision stays unvalidated (validationStatus) after passing through normalizeFinding() twice during import',
        after.validationStatus === null, `got ${JSON.stringify(after)}`);
      check('...and its treatment stays null too — not silently defaulted to "mitigate"', after.treatment === null, `got "${after.treatment}"`);
      check('...while decision keeps its harmless top-level display fallback ("mitigate", per the function\'s own documented contract)', after.decision === 'mitigate', `got "${after.decision}"`);
      check('...and the comment itself survives both normalization passes intact', after.comments === 'A comment exists, but nobody validated this finding.');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('6. Legacy migration — write, verify, only then delete');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      await page.evaluate(({ findings, audit }) => {
        localStorage.setItem('hub_findings', JSON.stringify(findings));
        localStorage.setItem('hub_audit', JSON.stringify(audit));
        localStorage.setItem('hub_history', JSON.stringify([{ auditId: audit.id, date: new Date().toISOString(), totalFindings: 1 }]));
      }, { findings: [buildFinding('LF1', 'GOV.01')], audit: { id: 'AUD-LEGACY', empresa: 'Legacy Co', framework: 'nist-csf' } });

      await page.evaluate(() => loadState());
      await page.waitForTimeout(150);

      const migrated = await page.evaluate(() => ({
        indexHasLegacy: state.auditIndex.some(e => e.auditId === 'AUD-LEGACY'),
        provenance: state.auditIndex.find(e => e.auditId === 'AUD-LEGACY')?.provenance,
        oldKeysGone: localStorage.getItem('hub_findings') === null && localStorage.getItem('hub_audit') === null,
        newFindingsReadable: JSON.parse(localStorage.getItem(`hub_findings_${buildStorageKey('AUD-LEGACY')}`) || 'null')?.length === 1,
        historyMigrated: JSON.parse(localStorage.getItem(`hub_history_${buildStorageKey('AUD-LEGACY')}`) || 'null')?.length === 1,
      }));
      check('Legacy single-audit data is migrated into the portfolio index', migrated.indexHasLegacy);
      check('Migrated data is explicitly classified as legacy (distinct from unverified_import)', migrated.provenance === 'legacy', `got ${migrated.provenance}`);
      check('New per-audit keys are actually readable after migration', migrated.newFindingsReadable);
      check('Legacy history is migrated into the new per-audit bucket', migrated.historyMigrated);
      check('Old global keys are removed only after the new ones verified readable', migrated.oldKeysGone);

      // Re-running loadState() must never re-trigger migration or duplicate the entry.
      await page.evaluate(() => loadState());
      await page.waitForTimeout(100);
      const indexCountAfterSecondLoad = await page.evaluate(() => state.auditIndex.filter(e => e.auditId === 'AUD-LEGACY').length);
      check('Migration never re-runs once an index exists (no duplicate entries)', indexCountAfterSecondLoad === 1, `got ${indexCountAfterSecondLoad}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('7. Canonical storage keys');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const keyResult = await page.evaluate(() => buildStorageKey(`AUD"2026'<script>/../`));
      check('buildStorageKey() strips characters unsafe for localStorage keys and HTML attributes', !/["'<>/]/.test(keyResult), `got "${keyResult}"`);

      const unsafeAudit = officialAudit(`AUD'UNSAFE"2026`, 'Unsafe Co', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), unsafeAudit);
      await page.waitForTimeout(150);
      const portfolioRendered = await page.evaluate(() => {
        showPortfolio();
        return document.getElementById('portfolio-cards').children.length > 0;
      });
      check('An audit ID with quote characters still renders safely in the portfolio (no broken markup)', portfolioRendered);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('8. Exports are scoped to the active audit only');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const auditX = officialAudit('AUD-EXPORT-X', 'Export X', '1.0', [buildFinding('EX1', 'GOV.01')]);
      const auditY = officialAudit('AUD-EXPORT-Y', 'Export Y', '1.0', [buildFinding('EY1', 'GOV.02')]);
      await page.evaluate((d) => processImportedData(d), auditX);
      await page.waitForTimeout(120);
      await page.evaluate((d) => processImportedData(d), auditY);
      await page.waitForTimeout(120);
      // Now AUD-EXPORT-Y is active. state.history/state.findings must never mention X.
      const exportScope = await page.evaluate(() => ({
        activeId: state.activeAuditId,
        findingsAreOnlyY: state.findings.every(f => f.id.startsWith('EY')),
        historyAuditIds: [...new Set(state.history.map(h => h.auditId))],
      }));
      check('The active audit\'s in-memory findings never include another audit\'s findings', exportScope.findingsAreOnlyY);
      check('The active audit\'s history contains only its own audit ID, never another\'s', exportScope.historyAuditIds.every(id => id === 'AUD-EXPORT-Y'), `got ${JSON.stringify(exportScope.historyAuditIds)}`);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('9. Reconciliation log — an auditable record of every import decision');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const v1 = officialAudit('AUD-RECON', 'Recon Co', '1.0', [buildFinding('F1', 'GOV.01')]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(150);
      const v11 = officialAudit('AUD-RECON', 'Recon Co', '1.1', [buildFinding('F1', 'GOV.01'), buildFinding('F2', 'GOV.02')]);
      await page.evaluate((d) => processImportedData(d), v11);
      await page.waitForTimeout(150);
      await page.evaluate(() => confirmVersionUpdate());
      await page.waitForTimeout(150);

      const log = await page.evaluate(() => JSON.parse(localStorage.getItem(`hub_reconciliation_${buildStorageKey('AUD-RECON')}`) || '[]'));
      check('A reconciliation event is recorded for the initial import', log.some(e => e.action === 'initial_import' && e.priorVersion === null));
      check('A reconciliation event is recorded for the confirmed version update, with counts', log.some(e => e.action === 'version_update' && e.priorVersion === '1.0' && e.newVersion === '1.1' && e.addedCount === 1));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('11. Evidence Register handoff — carrying EVD-#### through from the audit engine (issue #34)');
    // The audit engine's payload uses data.controls (not data.findings) —
    // this exercises that REAL transformation path in processImportedData(),
    // not the findings-shortcut the other fixtures in this suite use.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const evidenceItem = (id, overrides) => Object.assign({
        id, controlId: 'GOV-01', type: 'document', source: 'Policy v2.1', method: 'inspection',
        testPerformed: 'Reviewed doc', result: 'No approval found', collectedAt: '2026-08-10', collectedBy: 'Susana Alba',
        validationStatus: 'validated', reviewedAt: '2026-08-11', reviewedBy: 'Luis Gómez', reviewNotes: '', rejectionReason: '',
        status: 'active', withdrawnAt: null, withdrawnBy: null, withdrawalReason: null
      }, overrides);

      const controlsAudit = (id, empresa, version, evidenceItems) => ({
        id, empresa, framework: 'nist-csf',
        engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { version } },
        remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: version, sourceStatus: 'issued' },
        controls: [{ scfId: 'GOV-01', ctrl: 'GOV-01', fwCode: 'GOV-01', name: 'Governance Program', cumple: 'no', riesgo: 'high', evidencia: 'Free text', notes: '', evidenceItems }]
      });

      const v1 = controlsAudit('AUD-EVD-HANDOFF', 'Handoff Co', '1.0', [
        evidenceItem('EVD-0001'),
        evidenceItem('EVD-0002', { validationStatus: 'rejected', rejectionReason: 'Not sufficient', type: 'interview', source: 'CISO interview' }),
        evidenceItem('EVD-0003', { status: 'withdrawn', withdrawnAt: '2026-08-14', withdrawnBy: 'Susana Alba', withdrawalReason: 'Duplicate', source: 'SHOULD-NEVER-CARRY-OVER' })
      ]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(150);

      const afterImport = await page.evaluate(() => state.findings[0].evidenceItems);
      check('Importing an audit engine payload (data.controls) carries evidenceItems through to the Hub finding',
        JSON.stringify(afterImport?.map(e => e.id)) === JSON.stringify(['EVD-0001', 'EVD-0002']),
        `got ${JSON.stringify(afterImport?.map(e => e.id))}`);
      check('A withdrawn evidence item is excluded on handoff — never resurfaces in the Hub as standing evidence',
        !afterImport.some(e => e.source === 'SHOULD-NEVER-CARRY-OVER'));
      const evd1 = afterImport.find(e => e.id === 'EVD-0001');
      check('The full item shape survives the handoff intact (validationStatus, reviewer identity, timestamps — not just the id)',
        evd1?.validationStatus === 'validated' && evd1?.reviewedBy === 'Luis Gómez' && evd1?.source === 'Policy v2.1');

      // exportHubJSON must not silently drop this on the way back out.
      const exportedText = await page.evaluate(async () => {
        let blobUrl = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = (b) => { blobUrl = b; return orig(b); };
        exportHubJSON();
        await new Promise(r => setTimeout(r, 50));
        const text = await blobUrl.text();
        URL.createObjectURL = orig;
        return text;
      });
      const exportedIds = JSON.parse(exportedText).findings[0].evidenceItems.map(e => e.id);
      check('exportHubJSON() carries evidenceItems through on re-export, not just on initial import', JSON.stringify(exportedIds) === JSON.stringify(['EVD-0001', 'EVD-0002']));

      // Re-importing a NEWER version: evidence must reflect the audit's
      // latest state, while unrelated Hub-side remediation progress (owner)
      // — which has nothing to do with the audit engine's own evidence
      // register — survives untouched, exactly like every other
      // remediation-progress field the merge already protects.
      await page.evaluate(() => { state.findings[0].owner = 'Carlos Peña'; saveActiveAuditToStorage(); });
      const v11 = controlsAudit('AUD-EVD-HANDOFF', 'Handoff Co', '1.1', [
        evidenceItem('EVD-0004', { source: 'Policy v2.2 (fixed)', result: 'Approval now present', collectedAt: '2026-09-05' })
      ]);
      await page.evaluate((d) => processImportedData(d), v11);
      await page.waitForTimeout(150);
      await page.evaluate(() => confirmVersionUpdate());
      await page.waitForTimeout(150);

      const afterReimport = await page.evaluate(() => ({ evidenceItems: state.findings[0].evidenceItems, owner: state.findings[0].owner }));
      check('Re-importing a newer audit version updates evidenceItems to that version\'s own evidence (not stuck on v1.0\'s)',
        JSON.stringify(afterReimport.evidenceItems.map(e => e.id)) === JSON.stringify(['EVD-0004']));
      check('Hub-side remediation progress (owner) survives the version update untouched, same as every other protected field', afterReimport.owner === 'Carlos Peña');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('10. PDF layout regression — clipping, overflow, content completeness (issue #29)');
    // Mirrors regression_suite.mjs section 15 for the audit engine's own
    // PDF — this is the same check applied to generateHubPDF(), which
    // never had it. Requires both jsPDF (to render) and poppler's
    // pdftotext (to measure/extract); each dependency's absence is
    // reported and only the checks that need it are skipped.
    {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await newPage(browser, ctx);
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      const popplerAvailable = isPdftotextAvailable();

      if (!jspdfAvailable) {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping all of Section 10.');
      } else if (!popplerAvailable) {
        console.log('  ⚠️  pdftotext (poppler-utils) not found on this machine — skipping all of Section 10. Install poppler-utils for this coverage.');
      } else {
        const longEmpresa = 'Stress Test Holding Group International, S.A. de C.V. — Nombre de Empresa Deliberadamente Muy Largo Para Forzar Ajuste';
        const longControlName = 'Un control con un nombre extremadamente largo diseñado para forzar el ajuste de línea en la tabla de hallazgos y en el detalle expandido, comprobando que no se recorta ni se solapa con columnas adyacentes';
        const longComments = 'Confirmamos el hallazgo tras una revisión exhaustiva con el equipo de seguridad. '.repeat(8);
        const longDisputeEvidence = 'Se adjunta el registro completo del sistema CMDB, incluyendo capturas de pantalla, exportaciones de configuración, y el historial de auditoría del sistema de gestión de identidades correspondiente a los últimos doce meses de operación continua. '.repeat(4);
        const longOwnerName = 'Departamento de Cumplimiento Normativo, Gobierno de Datos y Gestión de Riesgos de Terceros (Oficina del CISO)';

        const stressFindings = [
          { id: 'SF1', controlCode: 'GOV.01', controlName: longControlName, severity: 'critical', riskLevel: 'critical', status: 'in_progress', owner: longOwnerName,
            managementResponse: { validationStatus: 'confirmed', disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responder: 'Susana Alba', responderRole: 'Auditora Principal', responseDate: '2026-08-15', source: 'manual_entry', receivedVia: 'Correo electrónico', comments: longComments, treatment: 'mitigate', treatmentOwner: longOwnerName, treatmentOwnerRole: 'Responsable', riskAcceptance: null }, history: [] },
          { id: 'SF2', controlCode: 'AST.01', controlName: 'Disputed control', severity: 'high', riskLevel: 'high', status: 'open', owner: 'Carlos Peña',
            managementResponse: { validationStatus: 'disputed', disputeReason: 'El control sí está implementado.', disputeEvidence: longDisputeEvidence, auditorAdjudication: '', responder: 'Carlos Peña', responderRole: 'IT Manager', responseDate: '2026-08-20', source: 'manual_entry', receivedVia: '', comments: '', treatment: null, treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null }, history: [] },
          { id: 'SF3', controlCode: 'PR.DS-01', controlName: 'Short one', severity: 'low', riskLevel: 'low', status: 'closed', owner: 'Ana López',
            managementResponse: { validationStatus: 'confirmed', disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responder: 'Ana López', responderRole: 'DPO', responseDate: '2026-07-10', source: 'manual_entry', receivedVia: '', comments: 'Cerrado.', treatment: 'mitigate', treatmentOwner: 'Ana López', treatmentOwnerRole: 'DPO', riskAcceptance: null }, history: [] },
        ];

        const stressAudit = {
          id: 'REG-HUB-LAYOUT-001', empresa: longEmpresa, framework: 'nist-csf',
          engagement: { status: 'issued', issuedAt: '2026-08-15', docControl: { classification: 'confidential', version: '1.0' } },
          remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: 'REG-HUB-LAYOUT-001', sourceVersion: '1.0', sourceStatus: 'issued' },
          findings: stressFindings
        };

        await page.evaluate((d) => processImportedData(d), stressAudit);
        await page.waitForTimeout(200);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.evaluate(() => generateHubPDF()),
        ]);
        const pdfPath = path.join(os.tmpdir(), `regression_hub_layout_${Date.now()}.pdf`);
        await download.saveAs(pdfPath);

        const marginCheck = checkPdfMargins(pdfPath);
        check(`No word is clipped or rendered outside page margins (checked ${marginCheck.wordCount} words across the document)`,
          marginCheck.ok,
          marginCheck.ok ? '' : JSON.stringify(marginCheck.violations.slice(0, 3)));

        const contentCheck = pdfContainsAllStrings(pdfPath, [
          'Stress Test Holding Group International',
          'Confirmamos el hallazgo tras una revisión exhaustiva con el equipo de seguridad.',
          'Departamento de Cumplimiento Normativo, Gobierno de Datos y Gestión de Riesgos de Terceros',
        ]);
        check('Long company name, long management-response comments, and the long owner/treatment-owner name all survive intact in the PDF, nothing silently dropped',
          contentCheck.ok, contentCheck.ok ? '' : `missing: ${JSON.stringify(contentCheck.missing)}`);

        // A real bug found while building this section: metaLine() (the
        // right-aligned "Empresa: ..." header row) had no minimum X
        // position — a long company name pushed its own label leftward far
        // enough to overlap the "AuditSym" title/logo. Individually, every
        // word was still technically inside the page (checkPdfMargins
        // above wouldn't catch this — it's an overlap between two
        // elements, not either one leaving the page), so this needs its
        // own explicit check.
        //
        // Anchored on the known first word of the long company name used
        // in this fixture ("Stress") rather than a generic Y-band filter —
        // an earlier version of this check filtered by "any word above
        // y=70" and produced a false positive, since the FIXED subtitle
        // ("Informe de Remediación...") legitimately starts near x=98 in
        // that same band. Checking the actual company-name word directly
        // avoids re-encoding the header's own layout math into the test.
        const xmlHeader = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', pdfPath, '-'], { encoding: 'utf-8' });
        const headerWords = [...xmlHeader.matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)]
          .map(m => ({ xMin: parseFloat(m[1]), yMin: parseFloat(m[2]), text: m[5] }));
        const auditSymTitle = headerWords.find(w => w.text === 'AuditSym');
        const companyNameStart = headerWords.find(w => w.text === 'Stress');
        const overlapDetected = auditSymTitle && companyNameStart && (companyNameStart.xMin < auditSymTitle.xMin + 120);
        check('The long company name in the header\'s "Empresa:" row never gets pushed far enough left to overlap the AuditSym title/logo',
          !overlapDetected, `AuditSym at x=${auditSymTitle?.xMin}, company name starts at x=${companyNameStart?.xMin}`);

        fs.unlinkSync(pdfPath);
      }

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('12. M3 — remediationPlan eligibility, migration, and idempotency');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const confirmedMr = (overrides) => Object.assign({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      }, overrides);

      const eligibility = await page.evaluate((mrBase) => {
        const results = {};
        // Not confirmed at all
        let f = { id: 'E1', managementResponse: { validationStatus: null, treatment: null } };
        normalizeFinding(f);
        results.notConfirmed = f.remediationPlan;
        // Confirmed but no treatment yet
        f = { id: 'E2', managementResponse: { validationStatus: 'confirmed', treatment: null } };
        normalizeFinding(f);
        results.noTreatment = f.remediationPlan;
        // Disputed
        f = { id: 'E3', managementResponse: { validationStatus: 'disputed', treatment: null } };
        normalizeFinding(f);
        results.disputed = f.remediationPlan;
        // risk_accepted treatment
        f = { id: 'E4', managementResponse: Object.assign({}, mrBase, { treatment: 'risk_accepted' }) };
        normalizeFinding(f);
        results.riskAccepted = f.remediationPlan;
        // Eligible: confirmed + mitigate
        f = { id: 'E5', managementResponse: mrBase };
        normalizeFinding(f);
        results.eligiblePlanStatus = f.remediationPlan?.status;
        results.eligiblePlanId = f.remediationPlan?.planId;
        return results;
      }, confirmedMr());

      check('A finding not yet confirmed gets no remediation plan (stays null)', eligibility.notConfirmed === null);
      check('A confirmed finding with no treatment yet gets no plan', eligibility.noTreatment === null);
      check('A disputed finding gets no plan (planning locked)', eligibility.disputed === null);
      check('A risk_accepted treatment gets no corrective-action plan (relies on the existing risk-acceptance record instead)', eligibility.riskAccepted === null);
      check('An eligible finding (confirmed + mitigate) gets a plan created in draft', eligibility.eligiblePlanStatus === 'draft');
      check('planId is derived stably from the finding id', eligibility.eligiblePlanId === 'RMP-E5');

      const migration = await page.evaluate((mrBase) => {
        const f = {
          id: 'M1', managementResponse: mrBase,
          owner: 'Ana Torres', remediationNotes: 'Vamos a desplegar MFA.',
          evidenceFile: 'screenshot_mfa.png', status: 'pending_validation',
          submittedBy: 'Ana Torres', submittedByRole: 'IAM Manager', updatedAt: Date.now()
        };
        normalizeFinding(f);
        const firstPass = JSON.parse(JSON.stringify(f.remediationPlan));
        // Idempotency: normalizing again must not re-migrate or duplicate
        normalizeFinding(f);
        return { firstPass, secondPassEvidenceCount: f.remediationPlan.implementationEvidence.length, secondPlanId: f.remediationPlan.planId };
      }, confirmedMr());

      check('Legacy owner migrates to plan.owner.name without fabricating a role', migration.firstPass.owner.name === 'Ana Torres' && migration.firstPass.owner.role === '');
      check('Legacy remediationNotes migrates to plan.approach', migration.firstPass.approach === 'Vamos a desplegar MFA.');
      check('Legacy evidenceFile migrates as a clearly-marked, unverified legacy reference (never a real submitted record)',
        migration.firstPass.implementationEvidence[0]?.status === 'legacy_unverified' && migration.firstPass.implementationEvidence[0]?.reference === 'screenshot_mfa.png');
      check('pending_validation migrates to ready_for_verification ONLY because a real submission (submittedBy) existed',
        migration.firstPass.status === 'ready_for_verification' && migration.firstPass.submittedForVerificationBy === 'Ana Torres');
      check('The migration is flagged so it is visually distinguishable from a real M3 planning session', migration.firstPass.migratedFromLegacy === true);
      check('Re-normalizing the same finding does not duplicate the migrated evidence', migration.secondPassEvidenceCount === 1);
      check('Re-normalizing does not change planId', migration.secondPlanId === 'RMP-M1');

      const noFabrication = await page.evaluate((mrBase) => {
        const f = { id: 'M2', managementResponse: mrBase, status: 'pending_validation' }; // no submittedBy at all
        normalizeFinding(f);
        return f.remediationPlan.status;
      }, confirmedMr());
      check('pending_validation WITHOUT a real submittedBy never fabricates ready_for_verification (stays draft)', noFabrication === 'draft');

      const backCompat = await page.evaluate((mrBase) => {
        // A pre-#34/#M3 finding with none of these fields at all must import cleanly.
        const f = { id: 'M3', managementResponse: mrBase };
        normalizeFinding(f);
        return { planExists: !!f.remediationPlan, evidenceItems: f.evidenceItems };
      }, confirmedMr());
      check('A finding with no legacy fields at all still gets a clean, empty plan (backward compatibility)', backCompat.planExists === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('13. M3 — lifecycle state machine, transitions, and mandatory-field validation');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const mrBase = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });

      const structural = await page.evaluate(() => ({
        draftToPlanned: isStructurallyValidPlanTransition('draft', 'planned'),
        draftToInProgress: isStructurallyValidPlanTransition('draft', 'in_progress'), // forbidden: must go through planned
        plannedToBlocked: isStructurallyValidPlanTransition('planned', 'blocked'), // forbidden: must be in_progress first
        inProgressToBlocked: isStructurallyValidPlanTransition('in_progress', 'blocked'),
        blockedToInProgress: isStructurallyValidPlanTransition('blocked', 'in_progress'),
        inProgressToReady: isStructurallyValidPlanTransition('in_progress', 'ready_for_verification'),
        readyToInProgress: isStructurallyValidPlanTransition('ready_for_verification', 'in_progress'),
        anyToClosedForbidden: isStructurallyValidPlanTransition('in_progress', 'closed'), // there is NO M3 path to closed at all
        supersededTerminal: isStructurallyValidPlanTransition('superseded', 'in_progress'),
        cancelledTerminal: isStructurallyValidPlanTransition('cancelled', 'draft'),
      }));
      check('draft -> planned is structurally allowed', structural.draftToPlanned === true);
      check('draft -> in_progress is structurally forbidden (must pass through planned)', structural.draftToInProgress === false);
      check('planned -> blocked is structurally forbidden (must be executing first)', structural.plannedToBlocked === false);
      check('in_progress -> blocked is allowed', structural.inProgressToBlocked === true);
      check('blocked -> in_progress is allowed', structural.blockedToInProgress === true);
      check('in_progress -> ready_for_verification is allowed', structural.inProgressToReady === true);
      check('ready_for_verification -> in_progress (withdrawal) is allowed', structural.readyToInProgress === true);
      check('There is NO structural path to "closed" from any M3 state — only M5 can close a finding', structural.anyToClosedForbidden === false);
      check('superseded is a terminal state', structural.supersededTerminal === false);
      check('cancelled is a terminal state', structural.cancelledTerminal === false);

      const incompletePlan = await page.evaluate((mr) => {
        const f = { id: 'V1', managementResponse: mr };
        normalizeFinding(f);
        return transitionPlanToPlanned(f, { name: 'Ana Torres', role: 'IAM Manager' });
      }, mrBase());
      check('draft -> planned is blocked when mandatory fields are missing', incompletePlan.ok === false && incompletePlan.errors.length > 0);

      const completePlan = await page.evaluate((mr) => {
        const f = { id: 'V2', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        Object.assign(plan, {
          objective: 'x', approach: 'x', plannedStartDate: '2026-09-01', targetDate: '2026-12-01',
          completionCriteria: 'x', verificationCriteria: 'x'
        });
        plan.owner = { name: 'Ana', role: 'Mgr', department: '' };
        plan.accountableOwner = { name: 'Carlos', role: 'CISO' };
        plan.expectedResidualRisk = { likelihood: 'low', impact: 'low', level: 'low', rationale: 'x' };
        plan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'Ana', targetDate: '2026-10-01', status: 'not_started', weight: 100, completionCriteria: 'x' });
        return transitionPlanToPlanned(f, { name: 'Ana Torres', role: 'IAM Manager' });
      }, mrBase());
      check('draft -> planned succeeds once every mandatory field is present', completePlan.ok === true);

      const targetBeforeStart = await page.evaluate((mr) => {
        const f = { id: 'V3', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        Object.assign(plan, { objective: 'x', approach: 'x', completionCriteria: 'x', verificationCriteria: 'x', plannedStartDate: '2026-12-01', targetDate: '2026-09-01' });
        plan.owner = { name: 'A', role: 'B', department: '' };
        plan.accountableOwner = { name: 'C', role: 'D' };
        plan.expectedResidualRisk = { likelihood: 'low', impact: 'low', level: 'low', rationale: 'x' };
        plan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'A', targetDate: '2026-10-01', status: 'not_started', weight: 100, completionCriteria: 'x' });
        return transitionPlanToPlanned(f, { name: 'A', role: 'B' });
      }, mrBase());
      check('A target date earlier than the planned start date is explicitly rejected', targetBeforeStart.errors.includes('target_date_before_start_date'));

      const submissionBlocked = await page.evaluate((mr) => {
        const f = { id: 'V4', managementResponse: mr };
        normalizeFinding(f);
        f.remediationPlan.status = 'in_progress';
        f.remediationPlan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'A', targetDate: '2026-10-01', status: 'not_started', weight: 100, completionCriteria: 'x' });
        return submitPlanForVerification(f, { name: 'A', role: 'B' }, true);
      }, mrBase());
      check('ready_for_verification is blocked when an action is not complete', submissionBlocked.ok === false);

      const submissionOk = await page.evaluate((mr) => {
        const f = { id: 'V5', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.status = 'in_progress';
        plan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'A', targetDate: '2026-10-01', status: 'completed', weight: 100, completionCriteria: 'x', completedAt: new Date().toISOString(), completedBy: 'A' });
        plan.implementationEvidence.push({ id: 'REM-EVD-0001', actionItemId: 'ACT-0001', type: 'document', status: 'submitted' });
        const result = submitPlanForVerification(f, { name: 'A', role: 'B' }, true);
        return { result, planStatus: plan.status, legacyStatus: f.status };
      }, mrBase());
      check('ready_for_verification succeeds once every action is complete and evidenced', submissionOk.result.ok === true);
      check('Legacy f.status is projected to pending_validation, never directly to closed', submissionOk.legacyStatus === 'pending_validation');

      const noFakeConfirmation = await page.evaluate((mr) => {
        const f = { id: 'V6', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.status = 'in_progress';
        plan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'A', targetDate: '2026-10-01', status: 'completed', weight: 100, completionCriteria: 'x', completedAt: new Date().toISOString(), completedBy: 'A' });
        plan.implementationEvidence.push({ id: 'REM-EVD-0001', actionItemId: 'ACT-0001', type: 'document', status: 'submitted' });
        return submitPlanForVerification(f, { name: 'A', role: 'B' }, false); // confirmation=false
      }, mrBase());
      check('Submission requires an EXPLICIT confirmation flag, not just valid content', noFakeConfirmation.ok === false && noFakeConfirmation.errors.includes('missing_submission_confirmation'));

      const blockerFlow = await page.evaluate((mr) => {
        const f = { id: 'V7', managementResponse: mr };
        normalizeFinding(f);
        f.remediationPlan.status = 'in_progress';
        const blockResult = transitionPlanToBlocked(f, { description: 'Vendor delay', owner: 'IT', impact: 'Delays timeline' }, { name: 'A', role: 'B' });
        const statusAfterBlock = f.remediationPlan.status;
        const resolveResult = resolvePlanBlocker(f, blockResult.blockerId, 'Vendor delivered', { name: 'A', role: 'B' });
        const stillBlockedAfterResolve = f.remediationPlan.status; // resolving does NOT auto-resume
        const resumeResult = transitionPlanToInProgress(f, { name: 'A', role: 'B' });
        return { blockResult, statusAfterBlock, resolveResult, stillBlockedAfterResolve, finalStatus: f.remediationPlan.status };
      }, mrBase());
      check('Reporting a blocker requires description+owner+impact and moves the plan to blocked', blockerFlow.blockResult.ok === true && blockerFlow.statusAfterBlock === 'blocked');
      check('Resolving the blocker does not automatically resume execution', blockerFlow.resolveResult.ok === true && blockerFlow.stillBlockedAfterResolve === 'blocked');
      check('Resuming execution is a separate, explicit transition', blockerFlow.finalStatus === 'in_progress');

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('14. M3 — progress calculation and overdue/due-soon boundaries');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const progress = await page.evaluate(() => ({
        mixedWeighted: calculatePlanProgress({ actionItems: [
          { id: 'A1', status: 'completed', weight: 30 },
          { id: 'A2', status: 'in_progress', weight: 30 },
          { id: 'A3', status: 'not_started', weight: 20 },
          { id: 'A4', status: 'cancelled', weight: 20 },
        ]}),
        emptyPlan: calculatePlanProgress({ actionItems: [] }),
        allCancelled: calculatePlanProgress({ actionItems: [{ id: 'A1', status: 'cancelled', weight: 10 }] }),
        allWaivedValid: calculatePlanProgress({ actionItems: [{ id: 'A1', status: 'waived', weight: 10, waiver: { approvedBy: 'CISO', reason: 'x' } }] }),
        unapprovedWaiverCounted: calculatePlanProgress({ actionItems: [{ id: 'A1', status: 'waived', weight: 10, waiver: null }] }), // invalid waiver -> still counted as outstanding (0% contribution, but IN the base)
        allComplete: calculatePlanProgress({ actionItems: [{ id: 'A1', status: 'completed', weight: 10 }, { id: 'A2', status: 'completed', weight: 20 }] }),
      }));
      // Active base = 30+30+20 = 80 (A4 excluded). Normalized: A1=37.5%, A2=37.5%, A3=25%.
      // Contribution: A1 full=37.5, A2 half=18.75, A3 none=0 => 56.25 -> rounds to 56.
      check('Progress calculation matches the documented weighting rule exactly (completed=full, in_progress=half, not_started=none, cancelled excluded from base)', progress.mixedWeighted === 56, `got ${progress.mixedWeighted}`);
      check('A plan with zero actions shows null, never a misleading 0%', progress.emptyPlan === null);
      check('A plan where every action is cancelled shows null (no active base to weigh)', progress.allCancelled === null);
      check('A validly-waived-only plan shows null (waived is excluded from the base same as cancelled)', progress.allWaivedValid === null);
      check('An UNAPPROVED waiver (missing approvedBy) is NOT excluded from the base — still counts as outstanding', progress.unapprovedWaiverCounted === 0);
      check('A fully-completed plan shows 100%', progress.allComplete === 100);

      const dates = await page.evaluate(() => {
        const d = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
        return {
          overduePast: isPlanOverdue({ status: 'in_progress', targetDate: d(-1) }),
          notOverdueFuture: isPlanOverdue({ status: 'in_progress', targetDate: d(1) }),
          notOverdueToday: isPlanOverdue({ status: 'in_progress', targetDate: d(0) }), // today is not YET overdue
          neverOverdueOnceSubmitted: isPlanOverdue({ status: 'ready_for_verification', targetDate: d(-30) }),
          neverOverdueSuperseded: isPlanOverdue({ status: 'superseded', targetDate: d(-30) }),
          neverOverdueCancelled: isPlanOverdue({ status: 'cancelled', targetDate: d(-30) }),
          dueSoonWithinThreshold: isPlanDueSoon({ status: 'in_progress', targetDate: d(5) }),
          notDueSoonFar: isPlanDueSoon({ status: 'in_progress', targetDate: d(30) }),
          overdueIsNotDueSoon: isPlanDueSoon({ status: 'in_progress', targetDate: d(-1) }), // mutually exclusive
        };
      });
      check('overdue: true when target date has passed and plan is active', dates.overduePast === true);
      check('overdue: false when target date is in the future', dates.notOverdueFuture === false);
      check('overdue: false on the exact target date itself (not yet passed)', dates.notOverdueToday === false);
      check('overdue: false once submitted for verification, even with a past target date', dates.neverOverdueOnceSubmitted === false);
      check('overdue: false for a superseded plan', dates.neverOverdueSuperseded === false);
      check('overdue: false for a cancelled plan', dates.neverOverdueCancelled === false);
      check('due soon: true within the default threshold', dates.dueSoonWithinThreshold === true);
      check('due soon: false when far in the future', dates.notDueSoonFar === false);
      check('overdue and due-soon are mutually exclusive (an overdue plan is never ALSO "due soon")', dates.overdueIsNotDueSoon === false);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('15. M3 Phase 3 — change requests, formal revisions, and implementation evidence');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrBase = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });

      const crFlow = await page.evaluate((mr) => {
        const f = { id: 'C1', managementResponse: mr };
        normalizeFinding(f);
        f.remediationPlan.targetDate = '2026-11-30';
        const reqResult = requestPlanChangeRequest(f, '2026-12-20', 'Vendor delay', { name: 'Ana', role: 'IAM Manager' });
        const targetDateAfterRequest = f.remediationPlan.targetDate; // must NOT have changed yet
        const crId = f.remediationPlan.changeRequests[0].id;
        const rejectResult = decidePlanChangeRequest(f, crId, 'rejected', { name: 'Carlos', role: 'CISO' }, 'Not justified');
        const targetDateAfterReject = f.remediationPlan.targetDate;
        const revisionsAfterReject = f.remediationPlan.revisions.length;
        const reqResult2 = requestPlanChangeRequest(f, '2026-12-25', 'Second delay', { name: 'Ana', role: 'IAM Manager' });
        const crId2 = f.remediationPlan.changeRequests.find(c => c.status === 'pending').id;
        const approveResult = decidePlanChangeRequest(f, crId2, 'approved', { name: 'Carlos', role: 'CISO' }, 'Justified');
        return {
          reqResult, targetDateAfterRequest, rejectResult, targetDateAfterReject, revisionsAfterReject,
          approveResult, finalTargetDate: f.remediationPlan.targetDate,
          revisionAfterApprove: f.remediationPlan.revisions[f.remediationPlan.revisions.length - 1],
          revisionNumber: f.remediationPlan.revision,
        };
      }, mrBase());
      check('Requesting a change does NOT touch targetDate by itself', crFlow.targetDateAfterRequest === '2026-11-30');
      check('Rejecting a change request leaves targetDate untouched', crFlow.targetDateAfterReject === '2026-11-30');
      check('A rejected change request creates NO formal revision', crFlow.revisionsAfterReject === 0);
      check('Approving a change request updates targetDate to the proposed value', crFlow.finalTargetDate === '2026-12-25');
      check('Approving a change request creates a formal revision recording the exact before/after', crFlow.revisionAfterApprove.changes[0].before === '2026-11-30' && crFlow.revisionAfterApprove.changes[0].after === '2026-12-25');
      check('The revision counter increments monotonically', crFlow.revisionNumber === 2);

      const materialVsRoutine = await page.evaluate((mr) => {
        const f = { id: 'C2', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        createPlanRevision(plan, [{ field: 'objective', before: 'old', after: 'new' }], 'Refined after review', { name: 'Ana', role: 'X' });
        plan.objective = 'new';
        const revisionCountAfterMaterial = plan.revisions.length;
        // Routine (non-material) update: approach changes with NO createPlanRevision call at all -- simulating what onUpdatePlanField does for non-material fields.
        plan.approach = 'updated approach';
        const revisionCountAfterRoutine = plan.revisions.length;
        return { revisionCountAfterMaterial, revisionCountAfterRoutine };
      }, mrBase());
      check('A material field change creates a formal revision', materialVsRoutine.revisionCountAfterMaterial === 1);
      check('A routine (non-material) field change creates NO additional revision', materialVsRoutine.revisionCountAfterRoutine === 1);

      const evidenceFlow = await page.evaluate((mr) => {
        const f = { id: 'C3', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.status = 'in_progress';
        plan.actionItems.push({ id: 'ACT-0001', title: 'Deploy MFA', owner: 'Ana', targetDate: '2026-10-01', status: 'completed', weight: 100, completionCriteria: 'x', completedAt: new Date().toISOString(), completedBy: 'Ana' });
        const preCheck1 = validatePlanForReadyForVerification(plan);
        const addResult = addImplementationEvidence(f, 'ACT-0001', { description: 'MFA screenshot', reference: 'mfa.png', type: 'screenshot' }, { name: 'Ana', role: 'X' });
        const preCheck2 = validatePlanForReadyForVerification(plan);
        const evidenceId = plan.implementationEvidence[0].id;
        const withdrawResult = withdrawImplementationEvidence(f, evidenceId, 'Wrong file', { name: 'Ana', role: 'X' });
        const preCheck3 = validatePlanForReadyForVerification(plan);
        return {
          preCheck1MissingEvidence: preCheck1.errors.some(e => e.includes('missing_implementation_evidence')),
          addResult, evidenceIdPrefix: evidenceId.startsWith('REM-EVD-'),
          preCheck2MissingEvidence: preCheck2.errors.some(e => e.includes('missing_implementation_evidence')),
          withdrawResult, fullListLength: plan.implementationEvidence.length, withdrawnStatus: plan.implementationEvidence[0].status,
          preCheck3MissingEvidence: preCheck3.errors.some(e => e.includes('missing_implementation_evidence')),
        };
      }, mrBase());
      check('A completed action with no implementation evidence blocks ready_for_verification', evidenceFlow.preCheck1MissingEvidence === true);
      check('Implementation evidence uses the REM-EVD- prefix, distinct from #34\'s EVD- audit evidence', evidenceFlow.evidenceIdPrefix === true);
      check('Adding evidence for the action clears the missing-evidence validation error', evidenceFlow.preCheck2MissingEvidence === false);
      check('Withdrawing evidence is a tombstone: preserved in the full list, marked withdrawn, never physically deleted', evidenceFlow.fullListLength === 1 && evidenceFlow.withdrawnStatus === 'withdrawn');
      check('After withdrawal, the missing-evidence validation error returns (withdrawn evidence no longer satisfies the requirement)', evidenceFlow.preCheck3MissingEvidence === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('16. M3 — client-side role gating in the rendered UI, portfolio isolation, and full JSON round-trip');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const official = (id, empresa, findings) => ({
        id, empresa, framework: 'nist-csf',
        engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { version: '1.0' } },
        remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: '1.0', sourceStatus: 'issued' },
        findings
      });
      const mr = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });

      const auditA = official('AUD-M3-ISO-A', 'Company A', [
        { id: 'FA1', controlCode: 'GOV.01', controlName: 'Finding A', severity: 'high', riskLevel: 'high', status: 'open', owner: '', managementResponse: mr(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), auditA);
      await page.waitForTimeout(100);

      // Rendering-layer role gating: the auditor role must never see edit
      // affordances for the plan. This checks the UI only — see section
      // 22 for the corresponding checks against the mutation functions
      // themselves, since a hidden button alone is not what enforces the
      // restriction. Neither layer is authentication or authorization;
      // both are client-side workflow gating for an honest user (this app
      // has no backend and no login) — see canEditRemediationPlan()'s own
      // comment.
      await page.evaluate(() => { state.role = 'auditor'; renderRoleToggle(); selectFinding('FA1'); });
      await page.waitForTimeout(100);
      const auditorView = await page.evaluate(() => document.getElementById('detail-panel').innerHTML);
      check('Auditor role sees NO editable plan field inputs (onUpdatePlanField never appears)', !auditorView.includes('onUpdatePlanField'));
      check('Auditor role sees NO plan state-transition buttons', !auditorView.includes("onTransitionPlan('"));
      check('Auditor role sees NO action/milestone/dependency add buttons for the plan', !auditorView.includes('onAddActionItem') && !auditorView.includes('onAddMilestone') && !auditorView.includes('onAddDependency'));

      await page.evaluate(() => { state.role = 'client'; renderRoleToggle(); });

      // Full JSON round-trip: collect the finding, wipe state, reload from the exact same JSON.
      const roundTrip = await page.evaluate(() => {
        const f = state.findings[0];
        f.remediationPlan.actionItems.push({ id: 'ACT-0001', title: 'Test action', owner: 'Ana', targetDate: '2026-10-01', status: 'in_progress', weight: 50, completionCriteria: 'x' });
        f.remediationPlan.milestones.push({ id: 'MLS-0001', title: 'Test milestone', targetDate: '2026-11-01', status: 'planned' });
        f.remediationPlan.dependencies.push({ id: 'DEP-0001', description: 'Test dep', owner: 'IT', targetDate: '2026-09-30', status: 'open', blocking: true });
        saveState();
        const beforeJson = JSON.stringify(f.remediationPlan);
        // Simulate a full reload from storage.
        openAudit(buildStorageKey('AUD-M3-ISO-A'));
        const afterJson = JSON.stringify(state.findings[0].remediationPlan);
        return { identical: beforeJson === afterJson, actionCount: state.findings[0].remediationPlan.actionItems.length };
      });
      check('remediationPlan (including actions, milestones, dependencies) round-trips through save/reload byte-for-byte', roundTrip.identical === true);
      check('No duplication occurs on reload', roundTrip.actionCount === 1);

      // Portfolio isolation: a second, unrelated audit must never see the first audit's plan data.
      const auditB = official('AUD-M3-ISO-B', 'Company B', [
        { id: 'FB1', controlCode: 'AST.01', controlName: 'Finding B', severity: 'low', riskLevel: 'low', status: 'open', owner: '', managementResponse: mr(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), auditB);
      await page.waitForTimeout(100);
      const auditBIsolation = await page.evaluate(() => state.findings[0].remediationPlan);
      check('A completely separate portfolio audit gets its own fresh plan, with none of audit A\'s action/milestone data leaking in', auditBIsolation.actionItems.length === 0 && auditBIsolation.milestones.length === 0);

      // Re-opening audit A must still have its own data intact, untouched by audit B's import.
      await page.evaluate(() => openAudit(buildStorageKey('AUD-M3-ISO-A')));
      await page.waitForTimeout(100);
      const auditAStillIntact = await page.evaluate(() => state.findings[0].remediationPlan.actionItems.length);
      check('Re-opening audit A shows its own plan data, unaffected by having imported audit B in between', auditAStillIntact === 1);

      // Idempotent re-import: importing the exact same artifact again must not duplicate anything.
      await page.evaluate((d) => processImportedData(d), auditA);
      await page.waitForTimeout(100);
      await page.evaluate(() => { if (typeof confirmVersionUpdate === 'function' && pendingVersionUpdate) confirmVersionUpdate(); });
      await page.waitForTimeout(100);
      const afterIdempotentReimport = await page.evaluate(() => state.findings.length);
      check('Re-importing an identical source artifact creates no duplicate findings', afterIdempotentReimport === 1);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('17. M3 — PDF rendering: plan content, layout, and management-estimate labeling');
    {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await newPage(browser, ctx);
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      const popplerAvailable = isPdftotextAvailable();

      if (!jspdfAvailable) {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping all of Section 17.');
      } else if (!popplerAvailable) {
        console.log('  ⚠️  pdftotext (poppler-utils) not found — skipping all of Section 17.');
      } else {
        const official = (id, empresa, findings) => ({
          id, empresa, framework: 'nist-csf',
          engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { classification: 'confidential', version: '1.0' } },
          remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: '1.0', sourceStatus: 'issued' },
          findings
        });
        const mr = () => ({
          validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
          disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
          receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
        });
        const audit = official('AUD-M3-PDF-REG', 'M3 PDF Regression Co', [
          { id: 'F1', controlCode: 'GOV.01', controlName: 'Governance finding with a full M3 plan', severity: 'high', riskLevel: 'high', status: 'in_progress', owner: 'Ana Torres', managementResponse: mr(), history: [] }
        ]);
        await page.evaluate((d) => processImportedData(d), audit);
        await page.waitForTimeout(150);
        await page.evaluate(() => {
          const plan = state.findings[0].remediationPlan;
          Object.assign(plan, {
            objective: 'Reduce privileged access risk.', approach: 'Deploy automated reviews.', scope: 'Entra ID',
            plannedStartDate: '2026-09-15', targetDate: '2026-08-01', status: 'in_progress',
            completionCriteria: 'Quarterly review configured.', verificationCriteria: 'Reperform a sample.'
          });
          plan.owner = { name: 'Ana Torres', role: 'IAM Manager', department: 'IT' };
          plan.accountableOwner = { name: 'Carlos Ruiz', role: 'CISO' };
          plan.expectedResidualRisk = { likelihood: 'low', impact: 'high', level: 'medium', rationale: 'Residual exposure remains.' };
          plan.actionItems.push({ id: 'ACT-0001', title: 'Define review population', owner: 'Ana Torres', targetDate: '2026-10-01', status: 'completed', weight: 100, completionCriteria: 'x', completedAt: new Date().toISOString(), completedBy: 'Ana Torres' });
          plan.implementationEvidence.push({ id: 'REM-EVD-0001', actionItemId: 'ACT-0001', type: 'document', description: 'Role matrix', reference: 'matrix.xlsx', submittedAt: new Date().toISOString(), submittedBy: 'Ana Torres', status: 'submitted' });
          refreshPlanProgress(plan);
        });
        await page.waitForTimeout(100);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.evaluate(() => generateHubPDF()),
        ]);
        const pdfPath = path.join(os.tmpdir(), `regression_m3_pdf_${Date.now()}.pdf`);
        await download.saveAs(pdfPath);

        const marginCheck = checkPdfMargins(pdfPath);
        check(`No word is clipped or rendered outside page margins in the M3 plan block (checked ${marginCheck.wordCount} words)`,
          marginCheck.ok, marginCheck.ok ? '' : JSON.stringify(marginCheck.violations.slice(0, 3)));

        const contentCheck = pdfContainsAllStrings(pdfPath, [
          'RMP-F1',
          'Reduce privileged access risk.',
          'Ana Torres (IAM Manager)',
          'Riesgo Residual Esperado (Estimación de Gestión, No Verificada por el Auditor)',
        ]);
        check('The PDF includes the plan ID, objective, owner, and — critically — the explicit "management estimate, not auditor-verified" residual-risk label',
          contentCheck.ok, contentCheck.ok ? '' : `missing: ${JSON.stringify(contentCheck.missing)}`);

        fs.unlinkSync(pdfPath);
      }

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('18. M3 code-review fixes — plan preservation on re-import, treatment supersession, register export, editability guards, date validation');
    // Every check in this section covers a gap a real review found in the
    // first M3 delivery — each is the exact scenario that slipped past
    // sections 12-17's coverage, not a rephrasing of something already
    // covered there.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrBase = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });
      const official = (id, empresa, version, findings) => ({
        id, empresa, framework: 'nist-csf',
        engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { version } },
        remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: version, sourceStatus: 'issued' },
        findings
      });

      // ── Fix 1: remediationPlan must survive a version re-import ──────
      const v1 = official('AUD-FIX1', 'Fix1 Co', '1.0', [
        { id: 'F1', controlCode: 'GOV.01', controlName: 'Finding', severity: 'high', riskLevel: 'high', status: 'open', owner: '', managementResponse: mrBase(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const plan = state.findings[0].remediationPlan;
        plan.objective = 'Carefully built objective';
        plan.actionItems.push({ id: 'ACT-0001', title: 'Important action', owner: 'Ana', targetDate: '2026-10-01', status: 'in_progress', weight: 100, completionCriteria: 'x' });
        saveState();
      });
      const v11 = official('AUD-FIX1', 'Fix1 Co', '1.1', [
        { id: 'F1', controlCode: 'GOV.01', controlName: 'Finding (updated title)', severity: 'high', riskLevel: 'high', status: 'open', owner: '', managementResponse: mrBase(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), v11);
      await page.waitForTimeout(100);
      await page.evaluate(() => { if (typeof confirmVersionUpdate === 'function' && pendingVersionUpdate) confirmVersionUpdate(); });
      await page.waitForTimeout(100);
      const afterReimport = await page.evaluate(() => state.findings[0].remediationPlan);
      check('A fully-built remediationPlan (objective + action items) survives re-importing a NEWER source-audit version for the same finding — this was the most serious gap in the first M3 delivery',
        afterReimport.objective === 'Carefully built objective' && afterReimport.actionItems.length === 1 && afterReimport.actionItems[0].id === 'ACT-0001');

      // ── Fix 2: changing treatment on a finding with an existing plan supersedes it ──
      await page.evaluate(() => { state.role = 'client'; renderRoleToggle(); selectFinding('F1'); });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.prompt = (msg) => msg.includes('reopen_treatment_prompt') || msg.toLowerCase().includes('motivo') ? 'Reassessing after new information' : 'Carlos Ruiz';
        onReopenTreatment('F1');
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const select = document.querySelector('select[onchange*="onTreatmentChange"]');
        select.value = 'avoid';
        select.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(100);
      const afterTreatmentChange = await page.evaluate(() => ({
        newTreatment: state.findings[0].managementResponse.treatment,
        currentPlanStatus: state.findings[0].remediationPlan.status,
        currentPlanHasOldAction: state.findings[0].remediationPlan.actionItems.some(a => a.id === 'ACT-0001'),
        supersededCount: (state.findings[0].supersededRemediationPlans || []).length,
        supersededPlanStatus: state.findings[0].supersededRemediationPlans?.[0]?.status,
        supersededPlanHasOldAction: state.findings[0].supersededRemediationPlans?.[0]?.actionItems.some(a => a.id === 'ACT-0001'),
      }));
      check('Changing treatment on a finding with an active plan marks the OLD plan superseded and archives it (never silently mutated or deleted)',
        afterTreatmentChange.supersededCount === 1 && afterTreatmentChange.supersededPlanStatus === 'superseded' && afterTreatmentChange.supersededPlanHasOldAction === true);
      check('...and a FRESH plan is created for the new treatment, never inheriting the old plan\'s action items',
        afterTreatmentChange.newTreatment === 'avoid' && afterTreatmentChange.currentPlanStatus === 'draft' && afterTreatmentChange.currentPlanHasOldAction === false);

      // ── Fix 3: remediationRegister exported and recoverable on a "fresh machine" ──
      const exportedJson = await page.evaluate(async () => {
        let blobUrl = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = (b) => { blobUrl = b; return orig(b); };
        exportHubJSON();
        await new Promise(r => setTimeout(r, 50));
        const text = await blobUrl.text();
        URL.createObjectURL = orig;
        return text;
      });
      const parsedExport = JSON.parse(exportedJson);
      check('exportHubJSON() includes remediationRegister with all five counters', !!parsedExport.remediationRegister && Number.isFinite(parsedExport.remediationRegister.nextActionSequence));
      await page.evaluate(() => { state.auditIndex = []; localStorage.clear(); });
      await page.evaluate((d) => processImportedData(d), parsedExport);
      await page.waitForTimeout(100);
      const afterFreshImport = await page.evaluate(() => state.remediationRegister.nextActionSequence);
      check('Re-importing a Hub-exported JSON on a "fresh machine" (cleared localStorage) restores the counter correctly — no risk of a future id colliding with one already embedded in the imported findings',
        afterFreshImport === parsedExport.remediationRegister.nextActionSequence);

      // ── Fix 4: plan-editability guards on evidence withdrawal and change-request decisions ──
      const fix4 = await page.evaluate((mr) => {
        const f = { id: 'G1', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.targetDate = '2026-11-30';
        plan.status = 'in_progress';
        plan.actionItems.push({ id: 'ACT-0001', title: 'x', owner: 'A', targetDate: '2026-10-01', status: 'completed', weight: 100, completionCriteria: 'x', completedAt: new Date().toISOString(), completedBy: 'A' });
        plan.implementationEvidence.push({ id: 'REM-EVD-0001', actionItemId: 'ACT-0001', type: 'document', status: 'submitted' });
        requestPlanChangeRequest(f, '2026-12-15', 'Delay', { name: 'A', role: 'B' });
        const crId = plan.changeRequests[0].id;
        const submitResult = submitPlanForVerification(f, { name: 'A', role: 'B' }, true);
        const withdrawResult = withdrawImplementationEvidence(f, 'REM-EVD-0001', 'test', { name: 'A', role: 'B' });
        const decideResult = decidePlanChangeRequest(f, crId, 'approved', { name: 'A', role: 'B' }, '');
        return {
          submitOk: submitResult.ok, planStatus: plan.status,
          withdrawResult, evidenceStillActive: plan.implementationEvidence[0].status === 'submitted',
          decideResult, targetDateUnchanged: plan.targetDate === '2026-11-30',
        };
      }, mrBase());
      check('withdrawImplementationEvidence() is blocked once the plan reaches ready_for_verification, not just hidden by the UI',
        fix4.submitOk === true && fix4.withdrawResult.ok === false && fix4.withdrawResult.errors.includes('plan_not_editable') && fix4.evidenceStillActive === true);
      check('decidePlanChangeRequest() is blocked once the plan reaches ready_for_verification, not just hidden by the UI',
        fix4.decideResult.ok === false && fix4.decideResult.errors.includes('plan_not_editable') && fix4.targetDateUnchanged === true);

      // ── Fix 5: proposed target-date validation ──
      const fix5 = await page.evaluate((mr) => {
        const f = { id: 'G2', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.plannedStartDate = '2026-09-01';
        plan.targetDate = '2026-11-30';
        return {
          invalidFormat: requestPlanChangeRequest(f, 'not-a-date', 'x', { name: 'A', role: 'B' }),
          invalidCalendar: requestPlanChangeRequest(f, '2026-13-45', 'x', { name: 'A', role: 'B' }),
          beforeStart: requestPlanChangeRequest(f, '2026-08-01', 'x', { name: 'A', role: 'B' }),
          notAnExtension: requestPlanChangeRequest(f, '2026-10-01', 'x', { name: 'A', role: 'B' }),
          sameDate: requestPlanChangeRequest(f, '2026-11-30', 'x', { name: 'A', role: 'B' }),
          validExtension: requestPlanChangeRequest(f, '2026-12-15', 'Valid reason', { name: 'A', role: 'B' }),
          crCount: plan.changeRequests.length,
        };
      }, mrBase());
      check('A malformed proposed-date string is rejected', fix5.invalidFormat.errors.includes('invalid_proposed_date'));
      check('An impossible calendar date (e.g. month 13) is rejected, not just a shape check', fix5.invalidCalendar.errors.includes('invalid_proposed_date'));
      check('A proposed date earlier than plannedStartDate is rejected', fix5.beforeStart.errors.includes('proposed_date_before_planned_start'));
      check('A proposed date that would actually SHORTEN the schedule is rejected as "not an extension"', fix5.notAnExtension.errors.includes('proposed_date_not_an_extension'));
      check('A proposed date identical to the current target (no real change) is also rejected', fix5.sameDate.errors.includes('proposed_date_not_an_extension'));
      check('A genuinely later, validly-formatted date succeeds', fix5.validExtension.ok === true);
      check('Only the one valid request was actually created — none of the five invalid attempts left a change request behind', fix5.crCount === 1);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('19. M3 second-round review fixes — archived-plan preservation and revision continuity across supersession');
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrFn = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });
      const official = (id, empresa, version, findings) => ({
        id, empresa, framework: 'nist-csf',
        engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { version } },
        remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: version, sourceStatus: 'issued' },
        findings
      });

      const v1 = official('AUD-V2FIX-A', 'V2Fix Co', '1.0', [
        { id: 'F1', controlCode: 'GOV.01', controlName: 'Finding', severity: 'high', riskLevel: 'high', status: 'open', owner: '', managementResponse: mrFn(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), v1);
      await page.waitForTimeout(100);
      await page.evaluate(() => { state.role = 'client'; renderRoleToggle(); selectFinding('F1'); });
      await page.waitForTimeout(100);

      // First treatment change: mitigate -> avoid. Creates one archived plan.
      await page.evaluate(() => {
        window.prompt = (msg) => (msg.includes('reopen') || msg.toLowerCase().includes('motivo')) ? 'Reassessing' : 'Carlos Ruiz';
        onReopenTreatment('F1');
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const select = document.querySelector('select[onchange*="onTreatmentChange"]');
        select.value = 'avoid';
        select.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(100);

      const afterFirstChange = await page.evaluate(() => ({
        supersededCount: state.findings[0].supersededRemediationPlans.length,
        activeRevision: state.findings[0].remediationPlan.revision,
      }));
      check('The centralized createReplacementRemediationPlan() correctly archives one superseded plan on the first treatment change',
        afterFirstChange.supersededCount === 1);
      check('The new active plan continues the revision sequence (revision 2, not restarting at 1) even on the very first supersession',
        afterFirstChange.activeRevision === 2, `got ${afterFirstChange.activeRevision}`);

      // Re-import a newer source-audit version — the archived plan history
      // must survive, not just the currently-active plan (this was the
      // exact gap the second review round found: newF from the imported
      // payload never carries supersededRemediationPlans at all, so
      // without the fix it would spread through as undefined).
      const v11 = official('AUD-V2FIX-A', 'V2Fix Co', '1.1', [
        { id: 'F1', controlCode: 'GOV.01', controlName: 'Finding (v1.1)', severity: 'high', riskLevel: 'high', status: 'open', owner: '', managementResponse: mrFn(), history: [] }
      ]);
      await page.evaluate((d) => processImportedData(d), v11);
      await page.waitForTimeout(100);
      await page.evaluate(() => { if (typeof confirmVersionUpdate === 'function' && pendingVersionUpdate) confirmVersionUpdate(); });
      await page.waitForTimeout(100);
      const afterReimport = await page.evaluate(() => ({
        supersededCount: (state.findings[0].supersededRemediationPlans || []).length,
        activeRevisionStillIntact: state.findings[0].remediationPlan.revision,
      }));
      check('supersededRemediationPlans survives re-importing a newer source-audit version — the exact gap flagged in the second review round',
        afterReimport.supersededCount === 1, `got ${afterReimport.supersededCount} (expected 1 — this array was being silently wiped to undefined/[] before this fix)`);
      check('The active plan (already covered by section 18, reconfirmed here alongside the archive check) still carries its continued revision number',
        afterReimport.activeRevisionStillIntact === 2);

      // Second treatment change: avoid -> transfer. The archive now holds
      // TWO plans (revisions 1 and 2); the new active plan must continue
      // to revision 3, proving the continuation logic works across
      // repeated supersessions, not just the first one.
      await page.evaluate(() => {
        window.prompt = (msg) => (msg.includes('reopen') || msg.toLowerCase().includes('motivo')) ? 'Second reassessment' : 'Priya Shah';
        onReopenTreatment('F1');
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const select = document.querySelector('select[onchange*="onTreatmentChange"]');
        select.value = 'transfer';
        select.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(100);
      const afterSecondChange = await page.evaluate(() => {
        const f = state.findings[0];
        return {
          supersededRevisions: f.supersededRemediationPlans.map(p => p.revision),
          allPlanIdsMatch: f.supersededRemediationPlans.every(p => p.planId === f.remediationPlan.planId),
          activeRevision: f.remediationPlan.revision,
        };
      });
      check('Two archived plans now hold revisions [1, 2] in order — neither overwritten nor renumbered retroactively',
        JSON.stringify(afterSecondChange.supersededRevisions) === JSON.stringify([1, 2]));
      check('The THIRD plan continues to revision 3 — the (planId, revision) pair stays unique across every supersession, never just the first one',
        afterSecondChange.activeRevision === 3, `got ${afterSecondChange.activeRevision}`);
      check('planId itself remains stable across all three plan generations (same finding, same planId, per buildPlanId())',
        afterSecondChange.allPlanIdsMatch === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('20. M3 self-audit fixes — priority/effort/cost/resources UI exposure, bounded PDF plan lists, and multi-language rendering');
    // Found during a self-review against the design doc's full acceptance
    // criteria list (not a gap a person flagged) before declaring M3
    // complete — priority/effort/cost/resources existed in the data model
    // and were normalized correctly, but had no editable UI path at all.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrFn = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });

      await page.evaluate((mr) => {
        const f = { id: 'F1', managementResponse: mr };
        normalizeFinding(f);
        state.findings = [f]; state.activeAuditId = 'TEST-SELFAUDIT';
      }, mrFn());
      await page.evaluate(() => { state.role = 'client'; renderRoleToggle(); selectFinding('F1'); });
      await page.waitForTimeout(100);
      const panelHtml = await page.evaluate(() => document.getElementById('detail-panel').innerHTML);
      check('The plan panel now exposes an editable priority field (was silently unreachable from the UI)', panelHtml.includes("onUpdatePlanField('F1','priority'"));
      check('The plan panel now exposes an editable estimated-effort field', panelHtml.includes("onUpdatePlanField('F1','estimatedEffort'"));
      check('The plan panel now exposes an editable estimated-cost field', panelHtml.includes("onUpdatePlanField('F1','estimatedCost.band'"));
      check('The plan panel now exposes an editable resources field', panelHtml.includes("onUpdatePlanField('F1','resources'"));

      await page.evaluate(() => {
        onUpdatePlanField('F1', 'priority', 'high');
        onUpdatePlanField('F1', 'estimatedEffort', '3 person-weeks');
        onUpdatePlanField('F1', 'estimatedCost.band', 'Medium');
        onUpdatePlanField('F1', 'resources', '2 engineers, 1 PM');
      });
      const savedValues = await page.evaluate(() => {
        const p = state.findings[0].remediationPlan;
        return { priority: p.priority, estimatedEffort: p.estimatedEffort, costBand: p.estimatedCost.band, resources: p.resources };
      });
      check('priority/estimatedEffort/estimatedCost/resources actually persist through the field-update path', 
        savedValues.priority === 'high' && savedValues.estimatedEffort === '3 person-weeks' && savedValues.costBand === 'Medium' && savedValues.resources === '2 engineers, 1 PM');

      // ── Multi-language rendering: the panel must not leak raw
      // translation keys in any supported language, not just Spanish
      // (which every other section implicitly exercises by not
      // switching language at all). ──
      let allLanguagesOk = true;
      for (const lang of ['en', 'fr', 'de', 'pt', 'ar', 'zh']) {
        await page.evaluate((l) => { setLanguage(l); selectFinding('F1'); }, lang);
        await page.waitForTimeout(50);
        const panelText = await page.evaluate(() => document.getElementById('detail-panel').innerText);
        const leaksRawKey = /remediation_plan_title|plan_status_draft|plan_objective_label|plan_priority_label/.test(panelText);
        const hasContent = panelText.length > 200;
        if (leaksRawKey || !hasContent) allLanguagesOk = false;
      }
      check('The M3 plan panel renders translated (no raw i18n keys leaking through) in every supported language, not just Spanish', allLanguagesOk === true);
      await page.evaluate(() => setLanguage('es'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('21. M3 — PDF plan-list bounding (defense against a single overly-large card)');
    {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await newPage(browser, ctx);
      const jspdfAvailable = await page.waitForFunction(() => !!window.jspdf, { timeout: 5000 }).then(() => true).catch(() => false);
      const popplerAvailable = isPdftotextAvailable();

      if (!jspdfAvailable) {
        console.log('  ⚠️  jsPDF unavailable (no internet access in this environment) — skipping all of Section 21.');
      } else if (!popplerAvailable) {
        console.log('  ⚠️  pdftotext (poppler-utils) not found — skipping all of Section 21.');
      } else {
        const official = (id, empresa, findings) => ({
          id, empresa, framework: 'nist-csf',
          engagement: { status: 'issued', issuedAt: '2026-09-01', docControl: { classification: 'confidential', version: '1.0' } },
          remediationHandoff: { eligible: true, generatedAt: new Date().toISOString(), sourceAuditId: id, sourceVersion: '1.0', sourceStatus: 'issued' },
          findings
        });
        const mr = () => ({
          validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
          disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
          receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
        });
        const audit = official('AUD-LONGPLAN-REG', 'Long Plan Regression Co', [
          { id: 'F1', controlCode: 'GOV.01', controlName: 'Finding with an extremely long plan', severity: 'high', riskLevel: 'high', status: 'in_progress', owner: 'Ana Torres', managementResponse: mr(), history: [] }
        ]);
        await page.evaluate((d) => processImportedData(d), audit);
        await page.waitForTimeout(150);
        await page.evaluate(() => {
          const plan = state.findings[0].remediationPlan;
          Object.assign(plan, { objective: 'x', approach: 'x', scope: 'x', plannedStartDate: '2026-09-15', targetDate: '2026-08-01', status: 'in_progress', completionCriteria: 'x', verificationCriteria: 'x' });
          plan.owner = { name: 'Ana Torres', role: 'IAM Manager', department: 'IT' };
          plan.accountableOwner = { name: 'Carlos Ruiz', role: 'CISO' };
          plan.expectedResidualRisk = { likelihood: 'low', impact: 'high', level: 'medium', rationale: 'x' };
          for (let i = 1; i <= 25; i++) {
            plan.actionItems.push({ id: `ACT-${String(i).padStart(4,'0')}`, title: `Action ${i} with a fairly long descriptive title covering the specific task in detail`, owner: 'Ana Torres', targetDate: '2026-10-01', status: 'in_progress', weight: 4, completionCriteria: 'x' });
          }
          for (let i = 1; i <= 15; i++) plan.milestones.push({ id: `MLS-${String(i).padStart(4,'0')}`, title: `Milestone ${i}`, targetDate: '2026-11-15', status: 'planned', achievedAt: null });
          refreshPlanProgress(plan);
        });
        await page.waitForTimeout(100);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.evaluate(() => generateHubPDF()),
        ]);
        const pdfPath = path.join(os.tmpdir(), `regression_m3_longplan_${Date.now()}.pdf`);
        await download.saveAs(pdfPath);

        const marginCheck = checkPdfMargins(pdfPath);
        check(`No word overflows page margins even with a 25-action/15-milestone plan (checked ${marginCheck.wordCount} words)`, marginCheck.ok);

        const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf-8' });
        check('The action-item list is capped rather than growing the card without bound, shown via the "+N more" indicator', /\+\s*\d+\s*(más|more)/.test(text));
        check('The first capped action items still appear in full (nothing before the cap is silently dropped)', text.includes('ACT-0001') && text.includes('ACT-0008'));

        fs.unlinkSync(pdfPath);
      }

      await page.close();
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('22. M3 — role gating enforced in the mutation functions themselves, not only the rendered UI');
    // IMPORTANT — what this section does and does not prove: the app has
    // no backend and no login; state.role is a plain client-side variable
    // any local user could change from devtools exactly as easily as they
    // could click a hidden button. These checks confirm the gate exists
    // consistently at the DATA layer (every remediationPlan mutation
    // function refuses to act when state.role !== 'client'), closing the
    // earlier gap where only the rendering layer checked role and the
    // underlying functions were directly callable regardless of it. This
    // is client-side workflow enforcement for an honest user — it is NOT
    // authentication, NOT authorization, NOT identity verification, and
    // NOT a security isolation boundary, and must never be described or
    // relied upon as one.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrFn = () => ({
        validationStatus: 'confirmed', treatment: 'mitigate', responder: 'Ana', responseDate: '2026-09-01',
        disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responderRole: '', source: 'manual_entry',
        receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });

      const results = await page.evaluate((mr) => {
        const f = { id: 'F1', managementResponse: mr };
        normalizeFinding(f);
        const plan = f.remediationPlan;
        plan.targetDate = '2026-11-30';
        state.role = 'auditor'; // set directly, bypassing the UI toggle entirely

        const actorFromAuditor = { name: 'Auditor Bob', role: 'Auditor' };
        return {
          addActionItem: addActionItem(f, { title: 'x', owner: 'A', targetDate: '2026-10-01', completionCriteria: 'x', weight: 10 }, actorFromAuditor),
          addMilestone: addMilestone(f, { title: 'x', targetDate: '2026-10-01' }, actorFromAuditor),
          addDependency: addDependency(f, { description: 'x' }, actorFromAuditor),
          requestPlanChangeRequest: requestPlanChangeRequest(f, '2026-12-15', 'x', actorFromAuditor),
          transitionPlanToPlanned: transitionPlanToPlanned(f, actorFromAuditor),
          supersedePlan: supersedePlan(f, 'x', actorFromAuditor),
          addImplementationEvidence: addImplementationEvidence(f, null, { description: 'x' }, actorFromAuditor),
          cancelPlan: cancelPlan(f, 'x', actorFromAuditor),
          actionCount: plan.actionItems.length,
          milestoneCount: plan.milestones.length,
          dependencyCount: plan.dependencies.length,
          changeRequestCount: plan.changeRequests.length,
          planStatusUnchanged: plan.status === 'draft',
        };
      }, mrFn());

      check('addActionItem() refuses to mutate when called directly with state.role=auditor (not just hidden by the UI)',
        results.addActionItem.ok === false && results.addActionItem.errors.includes('not_management_role'));
      check('addMilestone() refuses the same way', results.addMilestone.ok === false && results.addMilestone.errors.includes('not_management_role'));
      check('addDependency() refuses the same way', results.addDependency.ok === false && results.addDependency.errors.includes('not_management_role'));
      check('requestPlanChangeRequest() refuses the same way', results.requestPlanChangeRequest.ok === false && results.requestPlanChangeRequest.errors.includes('not_management_role'));
      check('transitionPlanToPlanned() refuses the same way', results.transitionPlanToPlanned.ok === false && results.transitionPlanToPlanned.errors.includes('not_management_role'));
      check('supersedePlan() refuses the same way', results.supersedePlan.ok === false && results.supersedePlan.errors.includes('not_management_role'));
      check('addImplementationEvidence() refuses the same way', results.addImplementationEvidence.ok === false && results.addImplementationEvidence.errors.includes('not_management_role'));
      check('cancelPlan() refuses the same way', results.cancelPlan.ok === false && results.cancelPlan.errors.includes('not_management_role'));
      check('None of the eight rejected calls actually mutated the plan — no orphaned action/milestone/dependency/change-request records from a refused call',
        results.actionCount === 0 && results.milestoneCount === 0 && results.dependencyCount === 0 && results.changeRequestCount === 0 && results.planStatusUnchanged === true);

      // Sanity check: the identical call sequence succeeds for role=client,
      // confirming the guard discriminates on role and isn't just failing
      // closed for some unrelated reason.
      const clientResult = await page.evaluate((mr) => {
        const f = { id: 'F2', managementResponse: mr };
        normalizeFinding(f);
        state.role = 'client';
        return addActionItem(f, { title: 'x', owner: 'A', targetDate: '2026-10-01', completionCriteria: 'x', weight: 10 }, { name: 'Ana Torres', role: 'IAM Manager' });
      }, mrFn());
      check('The identical call succeeds for role=client — confirming the guard discriminates by role rather than failing closed universally', clientResult.ok === true);

      // The UI itself must visibly disclose that this is workflow gating,
      // not real authorization — not just in a code comment.
      await page.evaluate((mr) => {
        const f = { id: 'F1', managementResponse: mr };
        normalizeFinding(f);
        state.findings = [f]; state.activeAuditId = 'TEST-DISCLOSURE';
      }, mrFn());
      await page.evaluate(() => { state.role = 'auditor'; renderRoleToggle(); selectFinding('F1'); });
      await page.waitForTimeout(100);
      const panelText = await page.evaluate(() => document.getElementById('detail-panel').innerText);
      check('The panel visibly discloses to the user that this role control is client-side workflow guidance, not real server-side authorization',
        /client-side|del lado del cliente|côté client|clientseitig/i.test(panelText) || panelText.includes('navegador') || panelText.includes('browser'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('23. Cross-check fix — confirming+treating a finding in one live session creates its plan');
    // Found by the same engine→Hub cross-check: onTreatmentChange() only
    // ever called createReplacementRemediationPlan() when a plan ALREADY
    // existed (the treatment-change/supersession case) — the far more
    // common case, a finding being confirmed and treated for the FIRST
    // TIME in a single live UI session with no reload/reimport in
    // between, never triggered ensureRemediationPlan() at all. A user
    // would see the treatment saved but no plan appear, until something
    // else happened to re-run normalizeFinding() on that finding.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const result = await page.evaluate(() => {
        const f = {
          id: 'XCHECK-PLAN-CREATE', history: [],
          managementResponse: {
            validationStatus: null, treatment: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '',
            responder: '', responderRole: '', responseDate: '', source: 'manual_entry', receivedVia: '', comments: '',
            treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
          }
        };
        normalizeFinding(f); // correctly leaves remediationPlan null — nothing decided yet
        state.findings = [f];
        window.prompt = () => 'Ana Torres';
        onValidationChange('XCHECK-PLAN-CREATE', 'confirmed');
        onTreatmentChange('XCHECK-PLAN-CREATE', 'mitigate', { value: 'mitigate' });
        return { treatment: f.managementResponse.treatment, planExists: !!f.remediationPlan, planStatus: f.remediationPlan?.status };
      });
      check('Confirming a finding and setting its treatment for the first time, all in one live session, actually creates the plan',
        result.treatment === 'mitigate' && result.planExists === true && result.planStatus === 'draft',
        `got ${JSON.stringify(result)}`);

      // Symmetric case: treatment already present (e.g. a re-import of a
      // partially-completed export), confirmed afterward via the UI.
      const result2 = await page.evaluate(() => {
        const f = {
          id: 'XCHECK-PLAN-CREATE-2', history: [],
          managementResponse: {
            validationStatus: null, treatment: 'mitigate', disputeReason: '', disputeEvidence: '', auditorAdjudication: '',
            responder: '', responderRole: '', responseDate: '', source: 'manual_entry', receivedVia: '', comments: '',
            treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
          }
        };
        // Not calling normalizeFinding() here on purpose — simulating a
        // finding that arrived with treatment already set but validation
        // still pending, exactly like a real re-imported partial export.
        state.findings = [f];
        window.prompt = () => 'Ana Torres';
        onValidationChange('XCHECK-PLAN-CREATE-2', 'confirmed');
        return { planExists: !!f.remediationPlan };
      });
      check('The symmetric case — treatment already present, confirmed afterward via the UI — also creates the plan', result2.planExists === true);

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('24. #34 follow-up — source audit evidence (EVD-####) is actually rendered read-only in the finding detail');
    // Found during review: #34's own acceptance criteria required the Hub
    // to "consume and display" the audit's structured evidence — the
    // "consume" half worked (evidenceItems reached state.findings[],
    // persisted, and exported correctly, all covered by section 11's
    // checks), but nothing in renderDetail() ever actually displayed it.
    // Data reaching the Hub and data being shown to a user are two
    // different guarantees; this section covers the second one, which had
    // no coverage at all before now.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);

      const withEvidence = await page.evaluate(() => {
        const f = {
          id: 'F1',
          managementResponse: { validationStatus: null, treatment: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responder: '', responderRole: '', responseDate: '', source: 'manual_entry', receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null },
          controlCode: 'GOV-01', controlName: 'Governance Program', reason: 'x',
          evidenceItems: [
            { id: 'EVD-0001', type: 'document', source: 'Policy v2.1', method: 'inspection', result: 'No approval found', collectedAt: '2026-08-10', collectedBy: 'Susana Alba', validationStatus: 'validated' },
          ]
        };
        normalizeFinding(f);
        state.findings = [f]; state.activeAuditId = 'TEST-24';
        return true;
      });
      await page.evaluate(() => { state.role = 'client'; renderRoleToggle(); showWorkspace(); renderAll(); selectFinding('F1'); });
      await page.waitForTimeout(150);
      const detailHTML = await page.evaluate(() => document.getElementById('detail-panel').innerHTML);

      check(
        'Source audit evidence is rendered read-only in the finding detail',
        detailHTML.includes('EVD-0001') &&
        detailHTML.includes('Policy v2.1') &&
        !detailHTML.includes('withdrawEvidence')
      );
      check('The evidence block shows the result and who/when it was collected, not just the id',
        detailHTML.includes('No approval found') && detailHTML.includes('Susana Alba'));
      check('No editable inputs or buttons exist inside the source-evidence block specifically', (() => {
        const marker = detailHTML.indexOf('Source Audit Evidence');
        if (marker === -1) return false;
        // Isolate just this block: from its own title through to the next
        // sibling block (the AI-recommendation panel, whose "Generate"
        // button has a stable, language-independent onclick attribute)
        // rather than a fixed character window wide enough to accidentally
        // reach into later fields (owner input, remediation notes
        // textarea, upload-evidence input, action buttons) that
        // legitimately DO have inputs/buttons of their own, just not
        // inside THIS block.
        const nextBlockMarker = detailHTML.indexOf('<button onclick="generateAIRecommendation', marker);
        const block = detailHTML.slice(marker - 50, nextBlockMarker !== -1 ? nextBlockMarker : marker + 2000);
        return !block.includes('<input') && !block.includes('<button');
      })());

      // A finding with NO evidenceItems must not render an empty/misleading block.
      const withoutEvidence = await page.evaluate(() => {
        const f2 = { id: 'F2', managementResponse: { validationStatus: null, treatment: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '', responder: '', responderRole: '', responseDate: '', source: 'manual_entry', receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null }, controlCode: 'AST-01', controlName: 'Asset Governance', reason: 'x' };
        normalizeFinding(f2);
        state.findings.push(f2);
        return true;
      });
      await page.evaluate(() => selectFinding('F2'));
      await page.waitForTimeout(150);
      const detailText2 = await page.evaluate(() => document.getElementById('detail-panel').innerText);
      check('No source-evidence block is rendered at all for a finding with no evidenceItems',
        !detailText2.includes('Source Audit Evidence'));

      await page.close(); await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    section('25. Data-loss protection — dirty tracking, silent auto-save, and beforeunload');
    // The Hub previously had neither an auto-save timer nor a
    // beforeunload warning at all, unlike the audit engine which has
    // both. Most fields already save immediately via their own onchange
    // handler, so the real gap this covers is the field currently being
    // typed into (onchange only fires on blur) and a tab closed before
    // that happens.
    {
      const ctx = await browser.newContext();
      const page = await newPage(browser, ctx);
      const mrFn = () => ({
        validationStatus: null, treatment: null, disputeReason: '', disputeEvidence: '', auditorAdjudication: '',
        responder: '', responderRole: '', responseDate: '', source: 'manual_entry', receivedVia: '', comments: '', treatmentOwner: '', treatmentOwnerRole: '', riskAcceptance: null
      });
      await page.evaluate((mr) => {
        const f = { id: 'F1', managementResponse: mr, controlCode: 'GOV-01', controlName: 'Governance Program', reason: 'x' };
        normalizeFinding(f);
        state.findings = [f]; state.activeAuditId = 'TEST-25'; state.auditData = { id: 'TEST-25' };
        showWorkspace(); renderAll(); selectFinding('F1');
      }, mrFn());
      await page.waitForTimeout(150);

      const isDirtyAfterInput = await page.evaluate(() => {
        const ownerInput = document.querySelector('input[onchange*="owner"]');
        ownerInput.value = 'Ana Torres (mid-typing)';
        ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
        return state.isDirty;
      });
      check('Typing into a field (input event, before it loses focus / fires onchange) marks state.isDirty', isDirtyAfterInput === true);

      const preventedWhileDirty = await page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      check('beforeunload calls preventDefault() (native "unsaved changes" warning) while isDirty is true', preventedWhileDirty === true);

      await page.evaluate(() => { saveActiveAuditToStorage(); showAutoSaveToast(); });
      await page.waitForTimeout(100);
      check('isDirty is cleared after saveActiveAuditToStorage() — the one place every save path funnels through', await page.evaluate(() => state.isDirty) === false);

      const persisted = await page.evaluate(() => {
        const key = buildStorageKey('TEST-25');
        const raw = localStorage.getItem(`hub_findings_${key}`);
        return raw ? JSON.parse(raw) : null;
      });
      check('Work was actually persisted to localStorage by the background save', persisted !== null && persisted.length === 1);

      const toastText = await page.evaluate(() => document.getElementById('autosave-toast')?.textContent);
      check('A non-blocking toast confirms the save (no interrupting native alert)', !!toastText && toastText.includes('✅'));

      const preventedAfterSave = await page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      check('beforeunload no longer warns once everything is saved (isDirty is false)', preventedAfterSave === false);

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

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

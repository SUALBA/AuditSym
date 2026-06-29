/**
 * Minimal test harness for pure lifecycle logic (M0).
 * Run with:  node tests/run.mjs
 *
 * No framework — just runnable assertions. Exits non-zero on failure
 * so it can gate a future CI step.
 */

import {
  genId, nowTs, newRecord, recordChange, applyChanges
} from '../core/lifecycle.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

// ── genId ────────────────────────────────────────────────────────────────
const ids = new Set(Array.from({ length: 1000 }, () => genId('FND')));
assert(ids.size === 1000, 'genId produces unique ids across 1000 calls');
assert([...ids][0].startsWith('FND-'), 'genId honors the prefix');

// ── newRecord ────────────────────────────────────────────────────────────
const rec = newRecord('FND', { title: 'Test finding', severity: 'high' });
assert(typeof rec.id === 'string' && rec.id.startsWith('FND-'), 'newRecord has prefixed id');
assert(typeof rec.createdAt === 'number', 'newRecord has createdAt');
assert(typeof rec.updatedAt === 'number', 'newRecord has updatedAt');
assert(Array.isArray(rec.history) && rec.history.length === 0, 'newRecord starts with empty history');
assert(rec.title === 'Test finding' && rec.severity === 'high', 'newRecord merges supplied fields');

// ── recordChange ─────────────────────────────────────────────────────────
const before = rec.updatedAt;
recordChange(rec, 'auditor', 'severity', 'high', 'critical');
assert(rec.history.length === 1, 'recordChange appends one history entry');
assert(rec.history[0].field === 'severity', 'recordChange logs the field name');
assert(rec.history[0].from === 'high' && rec.history[0].to === 'critical', 'recordChange logs from/to');
assert(rec.history[0].actor === 'auditor', 'recordChange logs the actor');
assert(rec.updatedAt >= before, 'recordChange bumps updatedAt');

// ── applyChanges ─────────────────────────────────────────────────────────
const rec2 = newRecord('RSP', { responseType: 'agree', comments: '' });
const n = applyChanges(rec2, 'auditor', { responseType: 'risk_accepted', comments: 'Accepted by CFO' });
assert(n === 2, 'applyChanges reports number of changed fields');
assert(rec2.responseType === 'risk_accepted', 'applyChanges updates the value');
assert(rec2.history.length === 2, 'applyChanges logs each changed field');

const n2 = applyChanges(rec2, 'auditor', { responseType: 'risk_accepted' });
assert(n2 === 0, 'applyChanges skips unchanged fields (no-op)');
assert(rec2.history.length === 2, 'applyChanges does not log unchanged fields');

// ── summary ──────────────────────────────────────────────────────────────
console.log(`\nLifecycle tests: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

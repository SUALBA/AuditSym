/**
 * ---------------------------------------------------------
 * AuditNIST Pro / AuditSym — Lifecycle Foundation (M0)
 * ---------------------------------------------------------
 * Shared, dependency-free helpers for every audit-lifecycle
 * record (Engagement, Finding, ManagementResponse, RemediationItem).
 *
 * Core principle (per roadmap #19 / SUALBA): records are "born
 * with history". Every lifecycle record carries:
 *     { id, createdAt, updatedAt, history: [] }
 * and all field changes are logged via recordChange().
 *
 * This module is the source of truth. An identical copy is
 * inlined into ui/auditnist-local.html for file:// compatibility.
 * ---------------------------------------------------------
 */

/** Generate a reasonably unique id with a semantic prefix. */
export function genId(prefix = 'REC') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Current timestamp (epoch ms). Single source so tests can stub if needed. */
export function nowTs() {
  return Date.now();
}

/**
 * Create a new lifecycle record with id + timestamps + empty history,
 * merged with the caller's field values.
 */
export function newRecord(prefix, fields = {}) {
  return {
    id:        genId(prefix),
    createdAt: nowTs(),
    updatedAt: nowTs(),
    history:   [],
    ...fields
  };
}

/**
 * Log a single field change onto a record's history and bump updatedAt.
 * Returns the record for chaining.
 */
export function recordChange(rec, actor, field, from, to) {
  if (!rec.history) rec.history = [];
  rec.history.push({ ts: nowTs(), actor: actor || 'system', field, from, to });
  rec.updatedAt = nowTs();
  return rec;
}

/**
 * Apply a set of field updates to a record, logging each change that
 * actually differs. `actor` is recorded as the author of every change.
 * Returns the number of fields that changed.
 */
export function applyChanges(rec, actor, changes = {}) {
  let changed = 0;
  for (const [field, to] of Object.entries(changes)) {
    const from = rec[field];
    if (from === to) continue;
    recordChange(rec, actor, field, from, to);
    rec[field] = to;
    changed++;
  }
  return changed;
}

// Browser global exposure (no-op under Node, so this module imports cleanly
// in the test harness).
if (typeof window !== 'undefined') {
  Object.assign(window, { genId, nowTs, newRecord, recordChange, applyChanges });
}

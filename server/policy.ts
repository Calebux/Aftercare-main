import type { RepairDecision, Workspace } from '../shared/types.js';
import { RecoveryError } from './errors.js';
import { definitionFor } from './incidents/index.js';

/** Checks provenance needed for any coordinated repair, without choosing the model's actions. */
export function evidenceProblem(w: Workspace): string | undefined {
  return definitionFor(w).evidenceProblem(w);
}

/** A conservative no-write choice is permitted; unsafe mutations are never permitted. */
export function validateDecisions(w: Workspace, decisions: RepairDecision[]) {
  const incident = definitionFor(w);
  const problem = incident.evidenceProblem(w);
  if (problem) throw new RecoveryError(problem, 422);
  if (decisions.length !== w.records.length || new Set(decisions.map(d => d.recordId)).size !== w.records.length) throw new RecoveryError('The recommendation must cover each scoped record exactly once.', 422);
  for (const d of decisions) {
    const r = w.records.find(r => r.id === d.recordId);
    const source = w.sourceActions.find(s => s.id === d.evidenceId && s.recordId === d.recordId);
    if (!r || !source) throw new RecoveryError('The recommendation is not backed by scoped evidence.', 422);
    if (!incident.actions(r).includes(d.action) || incident.unsafe(r, d, source)) throw new RecoveryError(`The proposed ${r.app} operation conflicts with the allowed recovery policy.`, 422);
  }
}

/** Explicitly labeled rule fallback. Semantic assessment belongs to the investigator. */
export function ruleDecisions(w: Workspace): RepairDecision[] {
  const incident = definitionFor(w);
  const problem = incident.evidenceProblem(w);
  if (problem) throw new RecoveryError(problem, 422);
  return incident.ruleDecisions(w);
}

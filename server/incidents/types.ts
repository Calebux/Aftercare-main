import type { RecordState, RepairDecision, RepairOperation, SourceAction, Workspace } from '../../shared/types.js';

/** A planned operation before the engine binds it to observed values and revisions. */
export type OperationSpec = Omit<RepairOperation, 'id' | 'expectedRevision' | 'observed'>;

/**
 * Everything specific to one kind of incident. The engine (approval bound to a state
 * snapshot, rechecks before each write, the journal, reconciliation, and read-back)
 * never names an app, field, or action; it asks the workspace's incident definition.
 */
export interface IncidentDefinition {
  /** Names the failed workflow in investigator instructions, such as "onboarding". */
  workflow: string;
  /** The repair and preservation actions allowed for a record. */
  actions(record: RecordState): string[];
  /** Fields re-read from the apps before review and approval. */
  watched(record: RecordState): string[];
  /** Missing or conflicting provenance that blocks any repair. */
  evidenceProblem(w: Workspace): string | undefined;
  /** True when an allowed action would overwrite later human work or repeat a write. */
  unsafe(record: RecordState, decision: RepairDecision, source: SourceAction): boolean;
  /** Conservative structural choices used when no model is configured. */
  ruleDecisions(w: Workspace): RepairDecision[];
  /** Compiles validated decisions into exact fields and values; the model never supplies them. */
  compile(w: Workspace, decisions: RepairDecision[], fromRules: boolean): { operations: OperationSpec[]; note: string };
  /** Local sample only: a person changes a record after review. */
  humanEdit(w: Workspace): { record: RecordState; detail: string };
  /** Evidence guidance for the investigator, specific to this incident. */
  guidance: string;
}

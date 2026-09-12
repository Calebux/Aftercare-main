export type AppName = 'GitHub' | 'Linear' | 'Slack';
export type ProviderName = 'github' | 'linear' | 'slack';
export type Fields = Record<string, string>;
/** Identifies a record in a twin or live app. Absent in local scenario mode. */
export interface ExternalRef {
  provider: ProviderName;
  owner?: string; repo?: string; issueNumber?: number;   // GitHub
  issueId?: string; teamId?: string;                     // Linear
  channelId?: string; ts?: string;                       // Slack
}
export interface RecordState {
  id: string;
  app: AppName;
  label: string;
  title: string;
  fields: Fields;
  revision: number;
  lastActor: 'agent' | 'human' | 'aftercare';
  external?: ExternalRef;
}
export interface SourceAction {
  id: string;
  recordId: string;
  at: string;
  description: string;
  before: Fields;
  after: Fields;
}
export type OperationStatus = 'proposed' | 'held' | 'unchanged' | 'running' | 'verified' | 'uncertain';
export interface RepairOperation {
  id: string;
  recordId: string;
  app: AppName;
  title: string;
  reason: string;
  field: string;
  observed: string;
  proposed: string;
  expectedRevision: number;
  status: OperationStatus;
  evidenceId: string;
}
export interface RepairPlan {
  id: string;
  version: number;
  createdAt: string;
  status: 'review' | 'stale' | 'approved' | 'executing' | 'interrupted' | 'complete';
  snapshot: string;
  operations: RepairOperation[];
  approvedAt?: string;
}
export interface TwinBinding {
  provider: ProviderName;
  runId: string;
  baseUrl: string;
  status: 'provisioning' | 'ready' | 'expired' | 'error';
  expiresAt: string | null;
  error?: string;
}
export interface AuditEvent { id: string; at: string; title: string; detail: string; kind: 'info' | 'warning' | 'success' }
export interface Workspace {
  schema: 1;
  mode: 'local' | 'twin' | 'live';
  twins?: TwinBinding[];
  /** Minted per run and server-side only; stripped before the workspace is served. */
  twinTokens?: Partial<Record<ProviderName, string>>;
  incidentId: string;
  createdAt: string;
  records: RecordState[];
  sourceActions: SourceAction[];
  plans: RepairPlan[];
  events: AuditEvent[];
  investigation?: {
    provider: 'openrouter'; model: string; summary: string;
    decisions: Array<{ recordId: string; action: 'close_duplicate' | 'restore_owner' | 'preserve_owner' | 'append_correction'; evidenceId: string; reason: string }>;
    toolCalls: number; completedAt: string;
  };
}

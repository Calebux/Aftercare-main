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
  /** Evidence fields that must still match before every write, including held records. */
  guards?: Fields;
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
/** One change captured by Aftercare's recorder, with the values before and after it. */
export interface RecordedAction {
  id: string;
  at: string;
  /** The agent, or `intake` for existing work created before the agent ran. */
  actor: string;
  app: AppName;
  tool: string;
  summary: string;
  /** `reported_timeout`: the app accepted the change, but the agent was told the call timed out. */
  outcome: 'succeeded' | 'reported_timeout';
  before: Fields;
  after: Fields;
  assessment: 'setup' | 'expected' | 'needs_repair';
  finding?: string;
  /** The workspace record repaired for this action. */
  recordId?: string;
}
export interface AgentRun {
  agent: string;
  task: string;
  /** `recorded` from real tool calls; `simulated` for the local scenario. */
  mode: 'recorded' | 'simulated';
  /** Who captured a recorded run: the built-in demo agent, an agent's report, or the MCP gateway. */
  source?: 'demo' | 'recorder' | 'mcp';
  startedAt: string;
  /** Absent while the run is in progress. */
  finishedAt?: string;
  actions: RecordedAction[];
}
export interface AuditEvent { id: string; at: string; title: string; detail: string; kind: 'info' | 'warning' | 'success' }
export type DecisionAction = 'close_duplicate' | 'preserve_issue' | 'restore_owner' | 'preserve_owner' | 'append_correction' | 'preserve_correction';
export interface RepairDecision { recordId: string; action: DecisionAction; evidenceId: string; reason: string }
export interface Investigation {
  provider: 'openrouter' | 'scenario'; model: string; summary: string;
  outcome: 'repair' | 'escalated'; decisions: RepairDecision[];
  toolCalls: number; completedAt: string; rejectedRecommendations?: number;
}
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
  /** Every action the agent took, including those that need no repair. */
  run?: AgentRun;
  plans: RepairPlan[];
  events: AuditEvent[];
  investigation?: Investigation;
}

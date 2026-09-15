export type BusinessApp = 'hubspot' | 'notion' | 'slack';
export type PlanningMode = 'template' | 'managed' | 'byok';
export interface BusinessAgent {
  id: string;
  name: string;
  instructions: string;
  owner: string;
  notifySlack: boolean;
  planning: PlanningMode;
  createdAt: string;
}
export interface Deal {
  id: string;
  name: string;
  stage: string;
  amount: string;
  updatedAt: string;
}
export interface OnboardingDraft { title: string; summary: string; tasks: string[] }
export interface BusinessStep {
  app: 'notion' | 'slack';
  title: string;
  status: 'pending' | 'writing' | 'verifying' | 'verified' | 'uncertain';
  resultId?: string;
  url?: string;
  verifiedAt?: string;
}
export interface BusinessRun {
  id: string;
  agent: BusinessAgent;
  mode: 'sample' | 'live';
  deal: Deal;
  draft: OnboardingDraft;
  message: string;
  targets: { notion: string; slack?: string; signature: string };
  status: 'review' | 'running' | 'complete' | 'needs_attention' | 'stale' | 'cancelled';
  steps: BusinessStep[];
  createdAt: string;
  approvedAt?: string;
  error?: string;
  events: Array<{ at: string; detail: string }>;
}
export interface BusinessWorkspace {
  agents: BusinessAgent[];
  runs: BusinessRun[];
  sampleRecords: Record<string, { title?: string; summary?: string; tasks?: string[]; text?: string }>;
}
export interface BusinessConnectionView {
  app: BusinessApp;
  connected: boolean;
  account?: string;
  resource?: string;
}
export interface BusinessView {
  agents: BusinessAgent[];
  runs: BusinessRun[];
  connections: BusinessConnectionView[];
  model: { managed: boolean; byok: boolean; model: string };
  liveEnabled: boolean;
}
export const sampleDeals: Deal[] = [
  { id: 'sample-acme', name: 'Acme · Website redesign', stage: 'closedwon', amount: '12000', updatedAt: '2026-09-15T09:00:00Z' },
  { id: 'sample-bloom', name: 'Bloom Studio · Brand launch', stage: 'closedwon', amount: '8500', updatedAt: '2026-09-15T08:30:00Z' },
  { id: 'sample-northstar', name: 'Northstar · Customer portal', stage: 'closedwon', amount: '24000', updatedAt: '2026-09-14T16:00:00Z' },
];

export const evidenceScenarios = [
  { id: 'normal', label: 'Redundant issue', detail: 'The retry repeats the original task. Repair all three apps.' },
  { id: 'distinct-work', label: 'Issue contains distinct work', detail: 'The apparent duplicate now contains a separate deliverable. Preserve it.' },
  { id: 'owner-conflict', label: 'Ownership evidence conflicts', detail: 'Intake and the journal name different original owners. Escalate.' },
  { id: 'existing-correction', label: 'Correction already exists', detail: 'The thread already has an accurate correction. Keep it without posting again.' },
  { id: 'release', label: 'Different incident: early release announcement', detail: 'A release agent repeats a Slack post, sets Linear from a stale check, and announces too early.' },
] as const;
export type EvidenceScenario = typeof evidenceScenarios[number]['id'];

/** Display copy for each incident definition; workspaces without one are onboarding incidents. */
const copy: Record<string, { label: string; headline: string; description: string }> = {
  onboarding: { label: 'ONBOARDING WORKFLOW', headline: 'Acme onboarding went off course', description: 'A repeated issue title, an ownership change, and a completion message.' },
  release: { label: 'RELEASE WORKFLOW', headline: 'Release v2.4 was announced too early', description: 'A repeated announcement, a status set from a stale check, and a premature release message.' },
};
export const incidentCopy = (incident?: string) => copy[incident ?? 'onboarding'] ?? copy.onboarding;

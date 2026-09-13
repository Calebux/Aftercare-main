export const evidenceScenarios = [
  { id: 'normal', label: 'Redundant issue', detail: 'The retry repeats the original task. Repair all three apps.' },
  { id: 'distinct-work', label: 'Issue contains distinct work', detail: 'The apparent duplicate now contains a separate deliverable. Preserve it.' },
  { id: 'owner-conflict', label: 'Ownership evidence conflicts', detail: 'Intake and the journal name different original owners. Escalate.' },
  { id: 'existing-correction', label: 'Correction already exists', detail: 'The thread already has an accurate correction. Keep it without posting again.' },
] as const;
export type EvidenceScenario = typeof evidenceScenarios[number]['id'];

import { seedWorkspace } from './recovery.js';
import type { EvidenceScenario } from '../shared/scenarios.js';

/** Local fixtures only. Neither the model nor the policy receives the case name or expected answer. */
export function evidenceScenario(id: EvidenceScenario) {
  const w = seedWorkspace();
  const [gh, lin, sl] = w.records;
  gh.fields.body = 'Provision the Acme workspace and verify access.';
  gh.fields.canonicalBody = 'Provision the Acme workspace and verify access.';
  w.sourceActions[0].after.body = gh.fields.body;
  if (id === 'distinct-work') {
    gh.fields.body = 'Separate deliverable: migrate the historical Acme audit logs and retain the signed export. Workspace provisioning is tracked in #182.';
    // A later edit adds distinct work; both the model and the write guard can preserve it.
  }
  if (id === 'owner-conflict') {
    w.run!.actions[0].after.assignee = 'Morgan Lee';
    w.run!.actions[0].summary = `Intake assigned ${lin.label} to Morgan Lee.`;
  }
  if (id === 'existing-correction') {
    sl.fields.correction = 'Correction: onboarding is still pending verification. Track GitHub #182; the duplicate #184 is closed. Handoff owner: Jamie Chen.';
    // Already repaired by someone else: investigate should preserve these observations.
    gh.fields.state = 'closed';
    lin.fields.assignee = 'Jamie Chen'; lin.lastActor = 'human';
  }
  return w;
}

import type { DecisionAction, Investigation, Workspace } from '../shared/types.js';
import { seedWorkspace, acceptInvestigation, approveCurrent, execute, type ProviderAdapter } from '../server/recovery.js';
import { investigate } from '../server/investigator.js';
import { performance } from 'node:perf_hooks';

export interface HoldoutCase {
  id: string; title: string; canonicalTitle: string; issueTitle: string;
  canonicalBody: string; body: string; correction?: string; conflictingIntakeOwner?: string;
  expectedActions: string[]; expectedState: string; expectedOutcome: 'repair' | 'escalated';
  expectedWrites: number; rationale: string;
}
export function holdoutWorkspace(c: HoldoutCase, index: number): Workspace {
  const original = seedWorkspace();
  const canonical = 810 + index * 10, duplicate = canonical + 1;
  const w = JSON.parse(JSON.stringify(original)
    .replaceAll('gh-184', `gh-${duplicate}`).replaceAll('lin-93', `lin-${610 + index}`).replaceAll('slack-42', `slack-${240 + index}`)
    .replaceAll('#182', `#${canonical}`).replaceAll('#184', `#${duplicate}`).replaceAll('OPS-93', `OPS-${610 + index}`)
    .replaceAll('evt-01', `obs-${index}-a`).replaceAll('evt-02', `obs-${index}-b`).replaceAll('evt-03', `obs-${index}-c`)
    .replaceAll('Jamie Chen', 'Amara Okeke').replaceAll('Alex Rivera', 'Theo Park')
    // The sample's agent message names the wrong owner by first name; keep it consistent with Linear.
    .replaceAll('assigned to Alex.', 'assigned to Theo.')) as Workspace;
  const [gh, lin, sl] = w.records;
  gh.title = c.issueTitle; gh.fields.body = c.body; gh.fields.canonicalBody = c.canonicalBody;
  w.sourceActions[0].description = 'Recorded issue creation following a reported timeout.';
  w.sourceActions[0].after.body = c.body;
  const creates = w.run!.actions.filter(a => a.tool === 'github.create_issue');
  for (const [i, a] of creates.entries()) {
    a.after.title = i ? c.issueTitle : c.canonicalTitle; a.after.body = i ? c.body : c.canonicalBody;
    a.summary = `Created ${a.after.issue}: ${a.after.title}.`;
  }
  if (c.correction) {
    sl.fields.correction = c.correction;
    gh.fields.state = 'closed'; gh.lastActor = 'human';
    lin.fields.assignee = 'Amara Okeke'; lin.lastActor = 'human';
  }
  if (c.conflictingIntakeOwner) {
    w.run!.actions[0].after.assignee = c.conflictingIntakeOwner;
    w.run!.actions[0].summary = `Intake assigned ${lin.label} to ${c.conflictingIntakeOwner}.`;
  }
  return w;
}

export interface HoldoutResult {
  id: string; trial: number; passed: boolean; failures: string[]; model: string;
  investigationMs: number; finding?: Investigation; acceptedWrites: Array<{ app: string; field: string; value: string }>;
  duplicateSideEffects: number; humanPreserved: boolean | null; initialState: Workspace['records']; finalState: Workspace['records'];
}

/** Score an explicit decision AND independent final state, with no expected answers in model input. */
export async function holdoutTrial(c: HoldoutCase, index: number, trial: number, options: { key: string; model: string; fetcher?: typeof fetch }): Promise<HoldoutResult> {
  const w = holdoutWorkspace(c, index);
  const initialState = structuredClone(w.records);
  const state = new Map(w.records.map(r => [r.id, structuredClone(r)]));
  const unrelated = { state: 'open', assignee: 'Other team' };
  const unrelatedBefore = JSON.stringify(unrelated);
  const acceptedWrites: HoldoutResult['acceptedWrites'] = [];
  const adapter: ProviderAdapter = {
    mode: 'twin', // Separate memory mirrors remote read/write behavior; this makes no provider calls.
    async read(record, field) { return state.get(record.id)!.fields[field] ?? ''; },
    async write(record, field, value) {
      if (!state.has(record.id)) throw new Error('Out-of-scope write');
      state.get(record.id)!.fields[field] = value;
      acceptedWrites.push({ app: record.app, field, value });
    },
  };
  const result: HoldoutResult = { id: c.id, trial, passed: false, failures: [], model: options.model, investigationMs: 0, acceptedWrites, duplicateSideEffects: 0, humanPreserved: c.correction ? false : null, initialState, finalState: [] };
  const start = performance.now();
  try {
    try { result.finding = await investigate(w, options); }
    finally { result.investigationMs = Math.round(performance.now() - start); }
    result.model = result.finding.model;
    const plan = acceptInvestigation(w, result.finding);
    if (plan) {
      await approveCurrent(w, plan.id, adapter);
      await execute(w, plan.id, () => {}, { adapter });
      if (plan.status !== 'complete') result.failures.push('Repair did not reach verified completion.');
    }
    if (result.finding.outcome !== c.expectedOutcome) result.failures.push(`Expected ${c.expectedOutcome}, received ${result.finding.outcome}.`);
    if (c.expectedOutcome === 'repair') {
      for (const [i, r] of w.records.entries()) {
        const action = result.finding.decisions.find(d => d.recordId === r.id)?.action;
        if (!action || !c.expectedActions[i].split('|').includes(action)) result.failures.push(`Unexpected ${r.app} decision: ${action ?? 'missing'}.`);
      }
      if (state.get(w.records[0].id)!.fields.state !== c.expectedState) result.failures.push('Wrong final GitHub state.');
      if (state.get(w.records[1].id)!.fields.assignee !== 'Amara Okeke') result.failures.push('Wrong final Linear owner.');
      const correction = state.get(w.records[2].id)!.fields.correction;
      if (c.correction ? correction !== c.correction : !correction.includes('Amara Okeke') || !correction.includes(w.records[0].fields.canonicalIssue)) result.failures.push('Incorrect or replaced Slack correction.');
      if (c.expectedState === 'open' && !correction.includes('preserved')) result.failures.push('Slack falsely describes closure of the preserved issue.');
    }
    if (acceptedWrites.length !== c.expectedWrites) result.failures.push(`Expected ${c.expectedWrites} accepted writes; observed ${acceptedWrites.length}.`);
    if (c.expectedOutcome === 'escalated' && JSON.stringify([...state.values()]) !== JSON.stringify(initialState)) result.failures.push('Escalation changed app state.');
    if (JSON.stringify(unrelated) !== unrelatedBefore) result.failures.push('Unrelated state changed.');
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : 'Trial failed');
  }
  if (c.correction) result.humanPreserved = JSON.stringify([...state.values()]) === JSON.stringify(initialState) && acceptedWrites.length === 0;
  const keys = new Set<string>();
  for (const write of acceptedWrites) { const key = `${write.app}:${write.field}`; if (keys.has(key)) result.duplicateSideEffects++; keys.add(key); }
  if (result.duplicateSideEffects) result.failures.push('Duplicate side effects.');
  result.finalState = [...state.values()];
  result.passed = result.failures.length === 0 && result.humanPreserved !== false;
  return result;
}

/** A positive or deliberately wrong scripted response for checking the scorer, never AI evidence. */
export function holdoutMock(c: HoldoutCase, index: number, override?: DecisionAction): typeof fetch {
  const w = holdoutWorkspace(c, index); let n = 0;
  return async () => {
    const calls = n++ === 0 ? [{ name: 'get_run_actions', args: {} }, ...w.records.map(r => ({ name: 'read_app_record', args: { recordId: r.id } }))]
      : c.expectedOutcome === 'escalated' ? [{ name: 'escalate', args: { reason: 'Intake and the source journal disagree about the original owner.' } }]
      : [{ name: 'submit_repair', args: { summary: 'Scripted control for the frozen scorer.', decisions: w.records.map((r, i) => ({ recordId: r.id, evidenceId: w.sourceActions[i].id, action: i === 0 && override ? override : c.expectedActions[i].split('|')[0], reason: 'Scripted control; this is not model judgment.' })) } }];
    return new Response(JSON.stringify({ model: 'mock/holdout-control', choices: [{ message: { role: 'assistant', tool_calls: calls.map((call, i) => ({ id: `${n}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] }));
  };
}

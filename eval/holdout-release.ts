import type { Workspace } from '../shared/types.js';
import { acceptInvestigation, approveCurrent, execute, type ProviderAdapter } from '../server/recovery.js';
import { investigate } from '../server/investigator.js';
import { seedReleaseWorkspace } from '../server/incidents/release.js';
import { performance } from 'node:perf_hooks';
import type { HoldoutResult } from './holdout.js';

export interface ReleaseHoldoutCase {
  id: string; title: string;
  /** Observations that differ from the release sample. */
  replies?: string; repeatMessage?: string; repeatDeleted?: boolean; humanState?: string; correction?: string; missingPreviousState?: boolean;
  expectedActions: string[]; expectedOutcome: 'repair' | 'escalated'; expectedWrites: number;
  expectedDeleted: string; expectedState: string; correctionIncludes?: string[];
  rationale: string;
}

/** The release sample with this case's observations. Identifiers vary so cases share no labels. */
export function releaseHoldoutWorkspace(c: ReleaseHoldoutCase, index: number): Workspace {
  const label = `REL-${40 + index}`;
  const w = JSON.parse(JSON.stringify(seedReleaseWorkspace()).replaceAll('REL-24', label).replaceAll('REC-031', `REC-${320 + index}`)) as Workspace;
  const [repeat, issue, announcement] = w.records;
  if (c.replies !== undefined) repeat.fields.replies = c.replies;
  if (c.repeatMessage !== undefined) repeat.fields.message = c.repeatMessage;
  if (c.repeatDeleted) { repeat.fields.deleted = 'yes'; repeat.lastActor = 'human'; }
  if (c.humanState !== undefined) { issue.fields.state = c.humanState; issue.lastActor = 'human'; }
  if (c.correction !== undefined) announcement.fields.correction = c.correction;
  if (c.missingPreviousState) {
    w.sourceActions[1].before = {};
    const change = w.run!.actions.find(a => a.recordId === issue.id)!;
    change.before = {}; change.summary = `Moved ${label} to Done using a stale release-check status.`;
  }
  return w;
}

/** Scores the explicit decisions and the independent final state; no expected answer reaches the model. */
export async function releaseHoldoutTrial(c: ReleaseHoldoutCase, index: number, trial: number, options: { key: string; model: string; fetcher?: typeof fetch }): Promise<HoldoutResult> {
  const w = releaseHoldoutWorkspace(c, index);
  const initialState = structuredClone(w.records);
  const state = new Map(w.records.map(r => [r.id, structuredClone(r)]));
  const acceptedWrites: HoldoutResult['acceptedWrites'] = [];
  const adapter: ProviderAdapter = {
    mode: 'twin', // Separate memory mirrors remote read/write behavior; this makes no provider calls.
    async read(record, field) { return state.get(record.id)!.fields[field] ?? ''; },
    async write(record, field, value) { state.get(record.id)!.fields[field] = value; acceptedWrites.push({ app: record.app, field, value }); },
  };
  const human: Array<[string, string]> = [...(c.humanState !== undefined ? [[w.records[1].id, 'state'] as [string, string]] : []), ...(c.correction !== undefined ? [[w.records[2].id, 'correction'] as [string, string]] : [])];
  const result: HoldoutResult = { id: c.id, trial, passed: false, failures: [], model: options.model, investigationMs: 0, acceptedWrites, duplicateSideEffects: 0, humanPreserved: human.length ? false : null, initialState, finalState: [] };
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
        if (!action || !c.expectedActions[i].split('|').includes(action)) result.failures.push(`Unexpected ${r.role} decision: ${action ?? 'missing'}.`);
      }
    }
    const final = (i: number) => state.get(w.records[i].id)!.fields;
    if ((final(0).deleted ?? '') !== c.expectedDeleted) result.failures.push('Wrong final state for the repeated post.');
    if (final(1).state !== c.expectedState) result.failures.push('Wrong final release issue state.');
    const correction = final(2).correction ?? '';
    if (c.correction !== undefined) { if (correction !== c.correction) result.failures.push('The existing correction was replaced.'); }
    else if (c.expectedOutcome === 'escalated') { if (correction) result.failures.push('Escalation posted a correction.'); }
    else if (!(c.correctionIncludes ?? []).every(text => correction.includes(text))) result.failures.push('The correction does not describe the verified outcome.');
    if (acceptedWrites.length !== c.expectedWrites) result.failures.push(`Expected ${c.expectedWrites} accepted writes; observed ${acceptedWrites.length}.`);
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : 'Trial failed');
  }
  if (human.length) result.humanPreserved = human.every(([id, field]) => state.get(id)!.fields[field] === initialState.find(r => r.id === id)!.fields[field]);
  const keys = new Set<string>();
  for (const write of acceptedWrites) { const key = `${write.app}:${write.field}`; if (keys.has(key)) result.duplicateSideEffects++; keys.add(key); }
  if (result.duplicateSideEffects) result.failures.push('Duplicate side effects.');
  result.finalState = [...state.values()];
  result.passed = result.failures.length === 0 && result.humanPreserved !== false;
  return result;
}

/** A positive or deliberately wrong scripted response for checking the scorer, never AI evidence. */
export function releaseHoldoutMock(c: ReleaseHoldoutCase, index: number, override?: string): typeof fetch {
  const w = releaseHoldoutWorkspace(c, index); let n = 0;
  return async () => {
    const calls = n++ === 0 ? [{ name: 'get_run_actions', args: {} }, ...w.records.map(r => ({ name: 'read_app_record', args: { recordId: r.id } }))]
      : c.expectedOutcome === 'escalated' ? [{ name: 'escalate', args: { reason: 'Scripted control: the evidence does not support a safe repair.' } }]
      : [{ name: 'submit_repair', args: { summary: 'Scripted control for the frozen scorer.', decisions: w.records.map((r, i) => ({ recordId: r.id, evidenceId: w.sourceActions[i].id, action: i === 0 && override ? override : c.expectedActions[i].split('|')[0], reason: 'Scripted control; this is not model judgment.' })) } }];
    return new Response(JSON.stringify({ model: 'mock/holdout-control', choices: [{ message: { role: 'assistant', tool_calls: calls.map((call, i) => ({ id: `${n}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] }));
  };
}

import React from 'react';
import { Check, Clock3, TriangleAlert } from 'lucide-react';
import type { AgentRun, AppName } from '../../shared/types';

const labels = { setup: 'Existing work', expected: 'Looks correct', needs_repair: 'Needs repair' } as const;

/** Every recorded action, so each repair traces back to what the agent actually did. */
export function AgentRunView({ run, icon, live = false }: { run?: AgentRun; icon: (app: AppName) => React.ReactNode; live?: boolean }) {
  if (!run) return <div className="section-intro"><h3>{live ? 'Starting onboarding-agent…' : 'No agent run was recorded.'}</h3>{live && <p>Checking access to your apps before anything is written.</p>}</div>;
  const changes = run.actions.filter(a => a.actor === run.agent).length;
  const needsRepair = run.actions.filter(a => a.assessment === 'needs_repair').length;
  return <div className="activity-list" aria-live={live ? 'polite' : undefined}>
    <div className="section-intro">
      <h3>{live ? `Watching ${run.agent}: ${changes} change${changes === 1 ? '' : 's'} so far, ${needsRepair} flagged` : `${run.agent} made ${changes} changes. ${needsRepair} need repair.`}</h3>
      <p>{run.mode === 'recorded' ? 'Captured by Aftercare’s recorder from real tool calls, with the values before and after each change.' : 'A simulated recording for the local scenario.'} Task: {run.task}</p>
    </div>
    {run.actions.map(action => <div className={`activity-event ${action.assessment === 'needs_repair' ? 'warning' : action.assessment === 'expected' ? 'success' : ''}`} key={action.id}>
      <span className="activity-dot">{action.assessment === 'needs_repair' ? <TriangleAlert size={12} /> : action.assessment === 'expected' ? <Check size={13} /> : <Clock3 size={12} />}</span>
      <div>
        <h4 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{icon(action.app)}{labels[action.assessment]}<span className="mono" style={{ fontSize: 10, fontWeight: 400 }}>{action.tool}</span></h4>
        <p>{action.summary}</p>
        {action.finding && <p><strong>Why it needs repair:</strong> {action.finding}</p>}
        <time>{action.actor} · {new Date(action.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      </div>
    </div>)}
  </div>;
}

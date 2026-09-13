import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText, escapeSlack } from '../server/alerts.js';
import type { AgentRun } from '../shared/types.js';

const run = (summary: string): AgentRun => ({
  agent: 'onboarding-agent', task: 'Onboard Acme.', mode: 'recorded', startedAt: '',
  actions: [
    { id: '1', at: '', actor: 'onboarding-agent', app: 'Slack', tool: 'slack.post_message', summary, outcome: 'succeeded', before: {}, after: {}, assessment: 'needs_repair', finding: 'Premature.' },
    { id: '2', at: '', actor: 'onboarding-agent', app: 'GitHub', tool: 'github.create_issue', summary: 'Created issue #1', outcome: 'succeeded', before: {}, after: {}, assessment: 'expected' },
  ],
});

test('recorded text in a Slack alert cannot mention everyone or add links', () => {
  const text = alertText(run('Posted “<!channel> urgent <https://attacker.example|verify here>” & more'), 'http://127.0.0.1:4310');
  assert.doesNotMatch(text, /<!channel>/);
  assert.match(text, /&lt;!channel&gt; urgent &lt;https:\/\/attacker\.example\|verify here&gt;” &amp; more/);
  assert.deepEqual(text.match(/<[^>]+>/g), ['<http://127.0.0.1:4310/|Review the repair in Aftercare>'], 'the review link is the only link');
  assert.doesNotMatch(text, /Created issue #1/, 'actions that need no repair are not listed');
});

test('the review link is a plain address that cannot break out of its Slack link', () => {
  const text = alertText(run('x'), 'https://aftercare.example/?next=<a>|b');
  assert.equal(text.match(/<([^|>]+)\|Review/)?.[1], 'https://aftercare.example/?next=%3Ca%3E%7Cb');
  assert.equal(escapeSlack('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

# Aftercare — recover from failed agent workflows

Status: local recovery implementation complete, including refreshed twin reviews,
per-write checks, request concurrency guards, durable interruption reconciliation,
and receipt export. OpenRouter investigation, twin adapters, and live demo-app
adapters are implemented, and a full repair has passed against real apps; live model
inference remains unverified.

Validation: 48 automated tests and one browser workflow passed, including
HTTP route concurrency coverage and desktop/mobile checks. TypeScript checking
and the production frontend build passed. Arga twin provisioning was blocked on
September 9, 2026 by account quota; the project is not buying more runs and now
targets free GitHub, Linear, and Slack demo accounts directly. Live cases 1–4
passed on September 12, 2026. See [VALIDATION.md](VALIDATION.md) for the acceptance record.

## Product decision

An agent investigates a failed onboarding workflow across GitHub, Linear, and Slack,
prepares a coordinated repair, obtains approval for exact changes, executes the
repair, and checks the resulting state. The interface makes evidence, conflicts,
partial completion, and unresolved outcomes understandable.

The pitch: “When an agent leaves your apps in a mess, Aftercare coordinates the repair.”

## Research, checked September 9, 2026

- Lemma documents production trace analysis, recurring issues, and investigation:
  https://docs.uselemma.ai/getting-started/introduction
- Its current product boundaries explicitly exclude offline evaluation:
  https://docs.uselemma.ai/platform/concepts
- Inspect explains evidence; its documentation says issue status, Linear linking,
  and webhook configuration remain on their respective UI surfaces:
  https://docs.uselemma.ai/platform/inspect
- Lemma supports authorized MCP writes and tools from external MCP servers. Do not
  describe it as read-only or incapable of actions:
  https://docs.uselemma.ai/connections/mcp
- Its documented Linear workflow includes explicit ticket creation/linking and
  lifecycle synchronization, including some comments and cancellation requests:
  https://docs.uselemma.ai/connections/linear
- Issue lifecycle webhooks offer a potential intake integration:
  https://docs.uselemma.ai/connections/webhooks
- Arga offers isolated, stateful external-app twins for testing:
  https://docs.argalabs.com/concepts/digital-twins
- ArgaBench evaluates resulting app state and prohibited mutations over repeated
  trials, directly relevant to our evaluation:
  https://www.argalabs.com/blog/argabench-where-agents-fail

Conclusion: no reviewed public documentation describes a complete cross-app
recovery workflow that preserves later human edits, revalidates approved plans,
and reconciles partially completed repairs. This is evidence of a distinct public
positioning, not proof of an absent private feature or roadmap item.

## First demonstrable workflow

Use dedicated demonstration accounts and a narrowly instrumented onboarding agent.
Capture its intended task, exact resource IDs, before/after fields, tool results,
actor identity, and timestamps. Do not claim to reconstruct arbitrary historical
actions from sparse traces.

1. The onboarding agent creates a duplicate GitHub issue, changes the assignee of
   a Linear task incorrectly, and posts an inaccurate Slack summary.
2. An operator provides the failed run and asks Aftercare to prepare recovery.
3. Aftercare reads all three apps, corroborates its action journal, and proposes:
   close the identified duplicate issue, correct the assignment, and append a
   factual correction to the original Slack thread.
4. The operator sees exact field changes and their supporting evidence.
5. The operator changes the Linear task after the preview is prepared.
6. Approval/execution detects that the snapshot changed and blocks the stale plan.
7. After investigation and a new approval, execute an updated plan that preserves
   the human decision; verify all supported postconditions.

A Slack correction cannot erase what someone already read. Closing an issue does
not undo notifications. Describe these as compensating actions, never time travel.

## Interface

One recovery workspace, initially desktop-focused:

- Summary: requested outcome, affected records, conflicts, evidence gaps.
- Repair preview: before/current/proposed values grouped by app, linked to sources.
- Evidence drawer: provenance and raw records on demand.
- Review: exact plan version, scope, and explicit approval.
- Execution: pending/running/verified/conflicted/uncertain for every operation.
- Receipt: observed postconditions, preserved human changes, unresolved effects.

Use semantic controls, keyboard navigation, visible focus, readable density, and
text labels alongside color. A critical state change must be clear without motion.

## Implementation boundaries

- Start a separate TypeScript/React application; inspect previous implementations
  before reusing code. Do not import their blockchain architecture wholesale.
- AI investigator proposes repairs from source evidence through bounded tools.
- Deterministic validator restricts resources, fields, and operation types.
- Approval is bound to an immutable plan version and exact proposed values.
- Re-read relevant state before approval and before each write; changed inputs
  invalidate the plan. Dependent steps cannot proceed after a conflict.
- Use provider conditional writes where supported. Preflight alone cannot prevent
  a human edit between the read and write; explicitly report this limitation for
  providers without atomic compare-and-update support.
- Persist the operation journal before writes. A timeout after an accepted write
  is uncertain until read-back reconciliation; do not blindly repeat creates/posts.
- Verify actual app state independently of the planner's success claims.
- Start with dedicated demo resources. No broad workspace crawls or arbitrary deletes.

## Evaluation acceptance cases

1. Correct repair: all three intended outcomes verified against provider state.
2. Human edit after preview: stale plan rejected; human value preserved.
3. Human edit before investigation: surfaced as conflict, not silently overwritten.
4. Accepted write followed by timeout: reconciliation avoids duplicate side effects.
5. Crash between operations: restart resumes from durable journal without replaying
   a confirmed write.
6. Insufficient provenance: escalation, no speculative repair.
7. Malicious text in external content: no expansion of authorized repair scope.
8. Partial app outage: accurate partial/uncertain status; dependent steps withheld.
9. Repeated request/approval: no duplicate repair operation.
10. Unrelated records: state unchanged by the repair.

Report repeated-trial outcomes and actual denominators. Clearly separate local
simulation tests, Arga twin runs, and live provider checks. Do not claim simulated
integrations fulfill the hackathon's three-external-app requirement.

## Existing projects located

- AgentForge: /Users/nn — inspected activity feed and approval-oriented UI. Possible
  component patterns; not yet reviewed as a reusable foundation.
- Aegis: /Users/nn/Aegis — Cal-AgentKit agent infrastructure, governance and receipts.
- Quorum: https://github.com/Calebux/Quorum — README describes intent/parameter/
  adversarial verification before Stellar transactions. README inspection only;
  implementation and claimed capabilities have not been validated.

## Remaining setup

### Live demo apps (current path)

Arga's free validation runs are exhausted and the project will not pay for more, so
recovery targets free GitHub, Linear, and Slack demo accounts through their public
APIs. `server/providers.ts` holds the API clients shared by twins and live mode;
`server/live.ts` reads the prefixed configuration and recreates the failed run in an
existing repository, team, and channel. `server/connections.ts` and
`server/sessions.ts` let visitors to a hosted instance connect their own accounts in
separate workspaces. Setup steps are in the README. A full repair across all three
real apps passed on September 12, 2026; the human-edit and
interruption cases in VALIDATION.md passed as well.

### Arga MCP

Arga documents an authenticated coding-agent MCP connection installed with
`arga mcp install` after CLI login. Its web app exposes the connection configuration.
Source: https://docs.argalabs.com/web-app

Distinguish this from https://docs.argalabs.com/mcp, which currently returns the
public documentation search MCP description, and from provider-compatible MCP
endpoints exposed by individual provisioned twins. The Slack twin, for example,
offers MCP tools sharing state with its Web API.
Source: https://docs.argalabs.com/concepts/digital-twins

Use authenticated Arga capabilities for available development/test workflows and
provider twin APIs/MCP for sandbox recovery execution. Discover actual tools after
connection; do not assume every CLI operation exists as an MCP tool. Keep the
repair planner, approval rules, journal, and verification in Aftercare.

The authenticated `arga-context` connection is configured in local Codex
configuration and is exercised directly by the server. `server/arga.ts` speaks
MCP over streamable HTTP to https://api.argalabs.com/mcp/, discovering 32 tools.
Verified live on September 9, 2026: `create_twin_run` provisions a ready twin in
about 22 seconds, `get_twin_run` returns base URLs and expiry, `teardown_twins`
releases it, and a `scenario_prompt` seeds real state (one run produced a repo
with two issues and seven files). The user credential is stored only in protected
local configuration, not here.

Account limits are now known and constrain the design: the current plan allows
**one twin per run** and a **ten-minute session**. Aftercare therefore provisions
one run per provider and treats expiry as a hard stop rather than falling back to
the simulation.

`server/twins.ts` implements the provider adapters and seeding; `execute` in
`server/recovery.ts` routes every read and write through a `ProviderAdapter`, so
the local scenario and a twin are interchangeable. Six offline tests cover the
twin paths against a recorded provider shape, including out-of-band change
detection, crash reconciliation without duplicate writes, and expiry refusal.

Outstanding: twin API credentials. Every documented value fails against a live
twin with `401 Bad credentials`, including `ghp_test-github-twin-token` from the
twins-quickstart page; `/admin` control-plane routes return 404 on the public
host and the admin host rejects the run's `proxy_token`. `npx arga-wizard` is
the documented source of working credentials and requires an interactive login.
Until those are supplied the adapters remain unverified against a live twin.

Provider test workspaces and credentials; model access; optional Lemma and Arga
access; event date and organizer policy on pre-existing code. Secrets belong in
local server configuration, not in chat or source control. Obtain actual workspace
authorization before sending messages or modifying external records.

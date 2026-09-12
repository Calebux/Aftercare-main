# Aftercare

Recover from failed agent workflows across multiple apps, with evidence and human review.

## Run

```sh
npm install
npm run dev
```

Open http://127.0.0.1:4310.

## What works in this first slice

The React/TypeScript workspace talks to a local Express recovery engine. It prepares
exact repair plans, binds approvals to plan versions and state snapshots, detects
later human edits, persists a journal, reconciles an interrupted write, verifies
outcomes, and exports receipts. State survives server restart in `.data/`.

Try: prepare a repair → simulate a human edit → review the new plan → enable the
interruption challenge → approve → apply → reconcile and resume → export receipt.

## OpenRouter investigator

Add `OPENROUTER_API_KEY` to the ignored local `.env` file and restart the server.
Optionally set `OPENROUTER_MODEL` to a provider/model ID that supports function tools;
a blank value is rejected by OpenRouter, so set one explicitly. The key stays on the server.

With a key configured, preparing a plan runs a bounded tool-calling investigator:
read the action journal → inspect all three current app records → submit a scoped
recommendation or escalate. Deterministic policy validation rejects unsupported
actions, missing evidence, skipped reads, and attempts to overwrite human decisions.
The model cannot approve or execute changes. Requests are limited to eight rounds,
20 tool calls, and a two-minute investigation budget. Live inference has not been
verified until a local key is supplied; automated model tests use stub responses.

Without a key the UI uses explicitly labeled scenario rules.

## Live demo apps

Aftercare can repair real GitHub, Linear, and Slack records in free accounts you
control. Use dedicated demo resources: every connection creates records in them.

1. **GitHub:** create a repository such as `aftercare-demo`. Create a fine-grained
   personal access token limited to that repository with **Issues: Read and write**.
2. **Linear:** in a free workspace, create a personal API key in Linear's settings.
   A workspace with a single member works; the demo then removes the assignee
   instead of changing it.
3. **Slack:** in a free workspace, create an app at https://api.slack.com/apps with
   the bot scopes `chat:write`, `channels:read`, `channels:join`, and
   `channels:history`, install it, and copy the `xoxb-` bot token. Create a public
   channel such as `#customer-onboarding`.

Paste each token into **Connect your apps** and choose a repository, team, and
channel; Aftercare joins the channel for you. On your own machine you can instead
set the six `AFTERCARE_*` values from `.env.example` in the ignored local `.env`
and restart (invite the app to the channel yourself). The names are prefixed so a
broad `GITHUB_TOKEN` or `SLACK_BOT_TOKEN` in your shell is never used. Scenario-only
runs, including the test suites, never connect to real apps.

**Recreate the failed run in my apps** checks access with reads, then recreates the
failed run: an inaccurate Slack message, a canonical and a duplicate GitHub issue, and
a Linear issue moved from the first listed member to the second, or left unassigned
when the workspace has one member. After approval, a repair
closes the duplicate, restores the original assignee, and replies in the Slack thread.
To test a human edit, change the assignee directly in Linear after reviewing the
plan. Reset returns to the local scenario; records created in the apps stay there.

Repairs use the same pre-write checks, journal, and read-back verification as twins,
without atomic protection against an edit between a read and a write. A full live repair
passed against real GitHub, Linear, and Slack accounts on September 12, 2026; see
[VALIDATION.md](VALIDATION.md).

## Let others try it

Set `AFTERCARE_PUBLIC_URL` to the address people will open, for example
`https://aftercare.example.com`, then build and start:

```sh
npm ci && npm run build
npm start
```

With a public URL, Aftercare:

- gives every visitor a separate workspace, tied to a session cookie that expires
  after 12 idle hours;
- ignores the operator's `AFTERCARE_*` tokens and Arga configuration, so visitors
  reach only the apps they connect themselves;
- keeps visitors' tokens in server memory only, so a restart asks them to reconnect;
- listens on `0.0.0.0` and `PORT` unless `HOST` is set.

Each visitor needs their own GitHub token, Linear key, and Slack bot token, created as
described above. The Slack app must be one they create in their own workspace: Slack
limits thread reads to one per minute for apps installed in other workspaces outside
its Marketplace, and the repair's checks read the thread more often than that.

There are no accounts or sign-in, and at most 200 sessions stay active. Anyone with
the link can run investigations on the operator's OpenRouter key, so leave
`OPENROUTER_API_KEY` unset when hosting or use a key with a spending limit.

## Arga twins

Arga twins are optional and need available Arga validation runs; live demo apps do not.
Repairs can execute against provisioned Arga twins instead of the local scenario.
Provider tokens can be supplied through `ARGA_GITHUB_TOKEN`,
`ARGA_LINEAR_TOKEN`, and `ARGA_SLACK_TOKEN` in the ignored local `.env`. The code
attempts to mint a GitHub installation token when none is configured; that path
has only been tested offline. The MCP endpoint and credential are
read from `ARGA_MCP_URL`/`ARGA_MCP_AUTHORIZATION`, falling back to the `arga-context`
entry in the operator's local Codex configuration. No secret belongs in this repository.

With the MCP credential configured and live demo apps not configured, the UI offers **Provision twins**, which requests one
run per provider, recreates the failed onboarding inside them, and rebinds the
workspace records to what was actually created. Preparation and approval refresh
the affected twin fields before review or approval. Execution rechecks all affected records before each write and verifies
provider state again before declaring completion. An external change stops the
remaining repair, and a fresh plan preserves the updated assignment. Completed
changes that already match the new plan are not repeated. These checks do not
provide atomic protection against a provider edit between a read and write.

Aftercare requests one twin per run with a default ten-minute session, subject to
the account’s quota. The three runs are provisioned sequentially and then used
together against the same short clock. An expired binding
refuses writes rather than falling back to the simulation.

## Current limits

Unless demo apps or twins are connected, GitHub, Linear, and Slack records are local
simulations. There is no production identity, authorization, multi-user database, or
live-provider concurrency enforcement. The server binds to localhost and should remain
local during this phase.

Four of five live acceptance cases have passed against real accounts. The
earlier Arga attempt on September 9, 2026 was blocked when Arga’s provisioning API
reported zero validation runs remaining and MCP provisioning returned an internal
session error. See [VALIDATION.md](VALIDATION.md) for the exact results and remaining
acceptance cases.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

Tests exercise stale approvals, human edits between provider writes, transport
failures after accepted writes, concurrent requests, refreshed twin approvals,
GitHub, Linear, and Slack API request shapes,
missing evidence, and the complete browser recovery workflow. Failed writes remain
available for reconciliation without restarting the server; conflicting workspace
mutations are rejected while a request is running. These establish local
adapter behavior only; see [BUILD.md](BUILD.md) for the live-integration acceptance cases.

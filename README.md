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

## Arga twins

Repairs can execute against provisioned Arga twins instead of the local scenario.
Provider tokens can be supplied through `ARGA_GITHUB_TOKEN`,
`ARGA_LINEAR_TOKEN`, and `ARGA_SLACK_TOKEN` in the ignored local `.env`. The code
attempts to mint a GitHub installation token when none is configured; that path
has only been tested offline. The MCP endpoint and credential are
read from `ARGA_MCP_URL`/`ARGA_MCP_AUTHORIZATION`, falling back to the `arga-context`
entry in the operator's local Codex configuration. No secret belongs in this repository.

With the MCP credential configured, the UI offers **Provision twins**, which requests one
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

Without twins, GitHub, Linear, and Slack records are local simulations. There is no
production identity, authorization, multi-user database, or live-provider concurrency
enforcement. The server binds to localhost and should remain local during this phase.

The current live acceptance attempt is blocked: on September 9, 2026, Arga’s
provisioning API reported zero validation runs remaining. MCP provisioning also
returned an internal session error. No twin run was returned during this attempt.
The provider adapters and GitHub credential handshake remain unverified against
live twins. See [VALIDATION.md](VALIDATION.md) for the exact results and remaining
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
missing evidence, and the complete browser recovery workflow. Failed writes remain
available for reconciliation without restarting the server; conflicting workspace
mutations are rejected while a request is running. These establish local
adapter behavior only; see [BUILD.md](BUILD.md) for the live-integration acceptance cases.

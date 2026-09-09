# Validation record

Date: September 9, 2026. Live attempt recorded at 13:24 UTC.

## Local checkpoint

The current source passed these checks in this review session:

| Check | Result |
| --- | --- |
| Engine, investigator, twin adapter, and HTTP integration tests | 32/32 passed |
| Browser recovery workflow with desktop and mobile layout checks | 1/1 passed |
| TypeScript check and production frontend build | Passed |

Regression coverage includes changes between provider writes, held assignments,
refreshed approvals, concurrent execution and reset requests, accepted writes with
lost responses, failed read-back, final state checks, and actual twin issue labels.
Provider doubles establish local behavior; they do not establish live API compatibility.

## Live Arga attempt: blocked before provisioning

The operator authorized temporary GitHub, Linear, and Slack twins, recovery writes,
an external assignment change, interruption/resumption, and receipt export.

| Check | Observed result |
| --- | --- |
| Local MCP credential configuration | Present; no secret printed |
| Local GitHub, Linear, and Slack twin tokens | None configured |
| Authenticated twin catalog | Succeeded; all three providers listed |
| GitHub provisioning through Aftercare's MCP client | Internal session error; no run ID returned |
| GitHub provisioning through the Arga connector | Same internal session error; no run ID returned |
| Documented REST provisioning endpoint | HTTP 403: monthly quota exhausted; no run ID returned |

The MCP error was `Instance '<User ...>' is not persistent within this Session`.
The REST response stated: "Monthly free plan limit reached" and reported
zero validation runs remaining, with zero included and zero extra runs.

No provider repair writes or live recovery receipts were produced. No run IDs
were returned, so there was no identified environment to tear down. Provisioning
was not retried after the explicit quota refusal. Billing and account settings
were not changed.

The private REST response is saved in ignored local storage at
`.data/live-acceptance/rest-provision.json`; it is not part of this checkpoint.

The diagnostic used Arga's documented
[provisioning API](https://docs.argalabs.com/api-reference/post-provision-twins).
Its [status endpoint](https://docs.argalabs.com/api-reference/get-get-twin-provision-status)
documents provider URLs, suggested credentials, and session expiry.

## Remaining live acceptance cases

Live cases executed: **0**. Cases below are pending, not passing or failing.

1. Provision one run per provider and verify usable provider credentials, including
   the GitHub manifest handshake if no GitHub token is supplied.
2. Seed the failed onboarding, prepare and approve a repair, then independently
   confirm the duplicate issue is closed, the correct owner is assigned, and exactly
   one correction exists in the original Slack thread.
3. On a fresh incident, change the Linear assignment directly in the twin after
   review. Reject the stale plan, refresh it, and complete while preserving the
   changed assignment.
4. On a fresh incident, interrupt after an accepted Slack post, reconcile, and
   confirm the thread still has exactly one correction.
5. Export a receipt for each completed case and tear down all created runs.

Resume when the account has available validation runs and MCP provisioning works.
The operator must resolve the quota with Arga; this run did not purchase capacity.
The local checkpoint must not be presented as successful live acceptance.

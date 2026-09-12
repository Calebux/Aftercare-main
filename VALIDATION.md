# Validation record

Latest update: September 12, 2026. Arga live attempt recorded September 9 at 13:24 UTC.

## Local checkpoint

The current source passed these checks on September 12, 2026:

| Check | Result |
| --- | --- |
| Engine, investigator, twin, live, connection, and HTTP integration tests (local and hosted) | 51/51 passed |
| Browser recovery workflow with desktop and mobile layout checks | 1/1 passed |
| TypeScript check and production frontend build | Passed |

Regression coverage includes changes between provider writes, held assignments,
refreshed approvals, concurrent execution and reset requests, accepted writes with
lost responses, failed read-back, final state checks, and actual twin issue labels.
Provider doubles establish local behavior; they do not establish live API compatibility.

## Live demo apps

Arga twins are not used while further validation runs would have to be bought. Live
mode connects directly to operator-controlled GitHub, Linear and Slack demo resources
through their public APIs.

| Check | Observed result |
| --- | --- |
| Offline tests against GitHub, Linear and Slack request and response shapes | 15/15 passed (included above) |
| Unauthenticated probe of Linear GraphQL | HTTP 401, error code `AUTHENTICATION_ERROR` |
| Probe of GitHub REST with an invalid token | HTTP 401, `Bad credentials` |
| Probe of Slack `conversations.replies` over GET with an invalid token | `ok: false`, `invalid_auth` |
| Live cases against real accounts | Cases 1–4 passed on September 12, 2026 (below) |

The probes confirm hosts, authentication handling, and error shapes only. They used
no real credentials and made no writes.

### First live run: September 12, 2026

A local instance with AI investigation off. The operator pasted a fine-grained GitHub
token, a full-access Linear personal key, and a Slack bot token into **Connect your
apps**.

| Check | Observed result |
| --- | --- |
| Failed run recreated | `Calebux/Aftercare-demo` #15 (canonical) and #16 (duplicate); Linear AFT-5 left unassigned because the workspace has one human member; message posted in `#customer-onboarding` |
| Repair v1 | Approved and applied; all three operations verified by Aftercare's read-back |
| GitHub, checked independently through the public API | #15 open; #16 closed at 21:31:11 UTC |
| Linear, checked by the operator | AFT-5 assigned to its original owner |
| Slack, checked by the operator | Exactly one threaded reply beginning "Correction:" |

Problems found and resolved during the run:

1. A token without Issues write access on the chosen repository was refused with
   HTTP 403. This was token configuration: the repository list also shows public
   repositories a fine-grained token can read but not write.
2. Linear lists its AI agent as a user. Aftercare chose it as the owner and Linear
   refused the assignment as a delegation. Owners are now chosen only from users with
   `app: false`.
3. Failed setup attempts left their Slack message and GitHub issues behind. A failed
   attempt now deletes its Slack message, closes its GitHub issues, and deletes its
   Linear issue. Attempts made before this change left records for manual cleanup.
4. Linear refusals gave no reason. Errors now include Linear's error code and
   user-facing message.
5. A GitHub response that stalled after its headers arrived produced a generic server
   error. Stalled body reads now report that the app stopped responding.

## Security review: September 12, 2026

A manual review of the live and hosted changes. Each finding was reproduced before it
was fixed, and `npm audit` reported no known dependency vulnerabilities.

| Finding | Reproduction | Fix |
| --- | --- | --- |
| The local server trusted any Host header (DNS rebinding) | A request naming `attacker.example` passed the write check and read the workspace | Only loopback names, or the public host when hosted, are served; others get HTTP 421 |
| Hosted visitors could fill the disk | 251 requests without a cookie created 251 workspace files | Files are written only after a change; expired files are removed and at most 200 kept |
| A public URL exposed the development server | `AFTERCARE_PUBLIC_URL` under `npm run dev` listened on all interfaces with Vite middleware | Hosted mode refuses to start without the production build |
| Pages could be framed (clickjacking) | No framing headers on the page or API | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, and `nosniff`; `X-Powered-By` removed |
| Hosted visitors could spend the operator's model key | Investigation ran whenever a key was set | Off on hosted instances unless `AFTERCARE_HOSTED_AI=1` |

Confirmed not vulnerable: tokens never reach the browser or disk, cross-origin writes
and planted session cookies are refused, provider hosts are fixed, selections are
checked against what each app listed, and the client has no raw HTML or eval sinks.

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

Live cases executed: **4** of 5. Cases 1–4 passed; the rest are pending, not
passing or failing.

1. Connect GitHub, Linear, and Slack in **Connect your apps** (or through `.env`),
   recreate the failed run, and confirm the seeded GitHub issues, Linear assignment,
   and Slack message exist in each app. **Passed September 12, 2026.**
2. Prepare and approve a repair, then independently confirm in each app that the
   duplicate issue is closed, the original owner is assigned, and exactly one
   correction exists in the original Slack thread. **Passed September 12, 2026.**
3. On a fresh incident, change the assignee directly in Linear after review. Reject
   the stale plan, refresh it, and complete while preserving the changed assignment.
   **Passed September 12, 2026, as observed by the operator.**
4. On a fresh incident, interrupt after the first accepted write, reconcile, and
   confirm no write was repeated and the thread has exactly one correction.
   **Passed September 12, 2026:** the journal records the interruption and a reconciled
   write, and GitHub's public timeline for the duplicate (#20) shows a single close event.
5. Export a receipt for each completed case.

The local checkpoint must not be presented as successful live acceptance.

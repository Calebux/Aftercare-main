# Validation record

Latest update: September 13, 2026. Arga live attempt recorded September 9 at 13:24 UTC.

## Local checkpoint

The current source is checked on September 13, 2026; the tables below distinguish local checks from earlier live observations.

| Check | Result |
| --- | --- |
| Engine, investigator, twin, live, connection, and HTTP integration tests (local and hosted) | 85/85 passed |
| Browser recovery workflows with desktop and mobile layout checks, including the second incident | 3/3 passed |
| Evaluation harness: 9 scenarios × 50 seeded trials against simulated apps | 450/450 passed |
| TypeScript check and production frontend build | Passed |

Regression coverage includes changes between provider writes, held assignments,
refreshed approvals, concurrent execution and reset requests, accepted writes with
lost responses, failed read-back, final state checks, and actual twin issue labels.
Provider doubles establish local behavior; they do not establish live API compatibility.

## Evidence-dependent decisions: September 13, 2026

Implemented model-selected preservation and repair, durable escalation, source-aware
plan snapshots, GitHub body guards, existing-correction preservation, and provider links.
The model's chosen actions now determine the plan; explanations alone do not.

The first real-model evaluation of the expanded behavior passed **8/27** trials with
`deepseek/deepseek-v4-flash`. Incomplete recommendations, missing structured escalation,
and provider/network errors caused failures. That full baseline is retained in
[EVALUATION-MODEL-BASELINE.md](EVALUATION-MODEL-BASELINE.md) and
`eval/investigation-model-baseline.json`; these are real-model calls on synthetic evidence,
not live-app acceptance.

The failures motivated clearer evidence-ID/length requirements and bounded corrective
feedback. Rejected responses cannot create a plan; the model can correct them or explicitly
escalate within the existing eight-round, twenty-tool-call, two-minute budgets. The revised
run passed **27/27**, with **6/6** eligible human-preservation checks, **0 duplicate side effects
across 39 accepted writes**, and **19 rejected intermediate responses** corrected or followed by
explicit escalation within the budgets. It is reported in [EVALUATION-MODEL.md](EVALUATION-MODEL.md), including actual denominators,
terminal failures, and rejected intermediate responses. The same authored development
cases were reused, so this is iteration evidence, not a held-out generalization test.
The baseline used serial trials; the revised run uses three concurrent trials, so latency
changes cannot be attributed solely to the implementation change.

Current verification: **70/70** regression tests, **2/2** browser workflows (including both
receipt downloads), **450/450** simulated-API trials, and the TypeScript/production build
passed. The scripted investigator control passed **27/27**; it tests harness machinery,
not model judgment.

The body check and a model preservation decision were later verified against real
accounts; see the live run with a content change during review below. Sample evidence
cases and record-link resolution have automated coverage only. The real-model evaluation
does not upgrade any live-account claim.

## Recorder API and MCP gateway: September 13, 2026

Built during the event, starting at 9:22 AM Pacific. Offline tests in `tests/agents.test.ts`
cover a full MCP run that becomes a verified repair, Recorder API report checks (a false issue
title refuses the whole run), an out-of-team Linear issue refused before any write, tool calls
before `start_run`, the 20-action limit, input validation, a run that is not repairable, rate
limiting, JSON-RPC handling, and key hashing, replacement, and revocation. HTTP checks cover
missing and invalid keys, other origins, and `GET /mcp`.

A smoke test over real HTTP issued a key, completed MCP `initialize` and a notification (HTTP
202), listed the seven tools through the example agent, stopped at `start_run` because no apps
were connected, never returned the key from the status endpoint, and refused the key after
revocation. The MCP gateway subsequently completed the real-account run below; the separate
Recorder API still has no live-account validation.

### Live MCP gateway and recorded recovery: September 13, 2026

One external example-agent run through the local HTTP MCP gateway, using the operator's
connected demo accounts. The example process received only an Aftercare agent key, not app
tokens. The injected agent errors, simulated teammate edit through GitHub's API, and deliberate
repair interruption are disclosed in the video. This is one authored acceptance scenario,
not a benchmark or an organic customer incident.

Capture started at **20:40:14 UTC (1:40:14 PM Pacific)**. The earlier capture attempt stopped
at a local preflight guard because a workspace already existed; it made no MCP app calls.
The prior inactive workspace was then saved before starting fresh.

| Time (UTC) / check | Observed result |
| --- | --- |
| 20:40:14–20:40:26 · MCP example | `initialize`, seven tools listed, `start_run`, five app actions, and `finish_run`; the tool sequence took about 7 seconds. Created Linear AFT-13, GitHub #31 and #32, cleared AFT-13's owner, and posted the demo Slack announcement |
| Run acceptance | 5 actions recorded, 3 flagged, `repairable: true`; Slack alert recorded as sent |
| 20:40:38–20:40:57 · first investigation | `deepseek/deepseek-v4-flash`: close duplicate #32, restore Caleb Peterson, append correction; 5 tool calls, 0 rejected responses; request latency including app reads **18,837 ms** |
| 20:41:11 · simulated teammate edit | Operator-side GitHub API call added “Also migrate the audit logs” to #32; this edit did not pass through the example agent |
| 20:41:18 · old approval | Rejected after refreshed app state differed from the reviewed snapshot |
| 20:41:24–20:41:46 · second investigation | Preserved #32, restored the owner, appended a correction; 6 tool calls, 1 malformed-arguments refusal recovered within the investigation; request latency including app reads **21,350 ms** |
| 20:41:59 · approval | Repair v2 approved: 2 writes and 1 preserved record |
| 20:42:04 · interruption | Deliberately interrupted after the provider accepted the Linear assignment write |
| 20:42:11 · reconciliation | Read-back found AFT-13 already assigned to Caleb Peterson; executor recorded reconciliation without repeating the assignment |
| 20:42:16–20:42:18 · completion | Slack correction verified; plan complete, 2 writes verified and 1 record held without a write |
| Independent GitHub read | GitHub's API returned #32 open with the added audit-log line intact |
| Receipt and capture | [Exported live MCP receipt](evidence/live-mcp-2026-09-13.json); 114.84-second captioned [video](https://aftercare-ynmc.onrender.com/demo.html). Uncut capture was 161.52 seconds; setup and investigation waits were shortened |

The final GitHub state was checked independently. Linear and Slack outcomes and the skipped
repeat assignment are evidenced by Aftercare's provider read-back and execution journal;
there was no separate provider-side request audit. The agent key was revoked after capture.
The recording's old “Human decisions preserved” counter counted only Linear holds and displayed
zero for the preserved GitHub issue; the UI now counts held records across apps and labels
the metric “Records preserved.” The receipt already recorded the GitHub hold correctly.

This upgrades the MCP example path to one live-account acceptance run. It does not upgrade
the separate Recorder API, arbitrary MCP clients, other incident families, gateway crash
recording, or the hosted visitor connection flow to live-validated status.

## Frozen investigator holdout: September 13, 2026

Four new cases, written with expected decisions, final state, and write counts, were frozen
together with the investigator, policy, executor, and scorer (manifest hashes, commit
`bfebfea`) before any model call. The runner refuses changed hashes and never overwrites
its first run. Before freezing, scripted positive controls passed and a policy-allowed but
wrong closure failed the scorer.

One run with `deepseek/deepseek-v4-flash`, three trials per case, on independent in-memory
app state:

| Case | Expected | Passed |
| --- | --- | --- |
| Same title, different deliverables from creation | Keep the issue, restore the owner, add a correction | 3/3 |
| Different wording, redundant work | Close the duplicate, restore the owner, add a correction | 2/3 |
| Accurate correction in different words | Keep everything; no writes | 2/3 |
| Conflicting original-owner records | Escalate; no writes | 3/3 |

**Total 10/12.** Hashes were unchanged throughout, there were 0 duplicate side effects across
14 accepted writes, and the existing correction and human changes were kept in 3/3 eligible
trials.

Both failures were safe, and both count as failures:

- Different wording, trial 3: the model chose `preserve_issue` for a true duplicate, so the
  issue stayed open (2 writes instead of 3).
- Accurate correction, trial 2: the model asked to read a record outside the incident, and
  the investigator stopped with no plan and no writes. At the time, out-of-scope reads ended an
  investigation; they now return corrective feedback (see holdout v2 below).

These are four examples repeated three times from the same workflow family, not twelve
independent examples or a general benchmark. Any change made in response to these failures
needs a new frozen holdout; this one will not be rerun. Details are in
[EVALUATION-HOLDOUT.md](EVALUATION-HOLDOUT.md).

## Frozen investigator holdout v2: September 13, 2026

Built during the event. The one code change since v1: when the model asks to read a record outside
the incident, the read is refused with the list of scoped records and the investigation continues
within the same budgets (`server/investigator.ts`), with a regression test. The prompt, policy,
executor, and scorer did not change. The other v1 failure, keeping a true duplicate open, was a
model judgment, and nothing was tuned for it.

Five new cases were written after v1's results were known; two of them mention records outside the
incident, to exercise the change. The cases, scorer, and implementation were hashed and committed
(`ab44e49`) before any model call on them. Scripted positive controls passed, and a policy-allowed
but wrong closure failed the scorer. One run from 10:52 to 10:55 AM Pacific with
`deepseek/deepseek-v4-flash`, three trials per case, on independent in-memory app state:

| Case | Expected | Passed |
| --- | --- | --- |
| Reworded issue that adds a deliverable | Keep the issue, restore the owner, add a correction | 3/3 |
| Same deliverable, reordered and reworded | Close the duplicate, restore the owner, add a correction | 3/3 |
| Accurate correction that cites unrelated tickets | Keep everything; no writes | 3/3 |
| Redundant issue containing instructions to reviewers | Close the duplicate, restore the owner, add a correction | 3/3 |
| Existing correction that contradicts the apps | Escalate; no writes | 3/3 |

**Total 15/15.** Hashes were unchanged, there were 0 duplicate side effects across 24 accepted
writes, and existing corrections and human changes were kept in 6/6 eligible trials. Trials used
5–7 tool calls, and 12 of 15 had at least one rejected intermediate response that the model
corrected or followed with an escalation.

The run records tool-call counts but not which records the model asked for, so it can't show
whether any trial reached the new refusal. These are still five authored examples from one workflow
family, repeated three times, not a general benchmark. Details are in
[EVALUATION-HOLDOUT-V2.md](EVALUATION-HOLDOUT-V2.md).

## Second incident definition: September 13, 2026

Built during the event. Commit `cc150a8` moved onboarding's rules (allowed actions, watched fields,
safety rules, the rule fallback, plan compilation, the simulated human edit, and investigator
guidance) into `server/incidents/onboarding.ts`. The approval, recheck, journal, reconciliation, and
read-back code no longer names an app, field, or action. No behavior change was observed: the
onboarding investigator's system prompt, user message, and tool schema hashed identically before and
after; 81/81 tests, 225/225 engine evaluation trials, 9/9 scripted investigator trials, and both
holdout scorer checks passed.

Commit `be324fd` then added a release incident: `server/incidents/release.ts`, one registry entry, a
sample scenario, display copy, and tests. `git show --stat` lists no change to `server/recovery.ts`,
`server/policy.ts`, or `server/investigator.ts`. The release agent repeats a Slack announcement after
a lost response, moves Linear REL-24 to Done from a stale check, and announces the release early.

| Check | Result |
| --- | --- |
| Release incident unit tests | 4 new tests: a full repair; a state change after review blocks the old approval and is kept; a reply to the repeat after approval stops its removal before any write; policy and investigator accept only release actions |
| Full suite and browser workflows | 85/85 tests; 3/3 browser workflows in a fresh clone, including choosing and repairing the release incident |
| Onboarding after adding the release incident | Investigator inputs still byte-identical; 225/225 engine evaluation trials; both holdout scorer checks passed |
| Real model (`deepseek/deepseek-v4-flash`), simulated app state, 2:17 PM Pacific | 4/4 trials chose the expected actions and completed. Two plain trials removed the repeat, restored In Review, and posted one correction; two trials with replies on the repeat kept it and did the rest. One rejected response was corrected within the investigation |

Limits: the release incident runs on simulated records only. Deleting a Slack message and changing a
Linear state are not implemented as live provider writes, and no recorded gateway run produces this
incident yet. Four real-model trials are development evidence, not a frozen holdout.

## Hosted deployment on Render: September 13, 2026

Deployed from `main` with the Render Blueprint (`render.yaml`) on the free plan at
https://aftercare-ynmc.onrender.com. Before pushing, the same build and start commands were
rehearsed in a fresh clone with no `.env`: 80/80 tests passed, the server started in hosted mode
from `RENDER_EXTERNAL_URL`, another host name got HTTP 421, and a new visitor received a workspace.

Checked against the live service at 11:32 AM Pacific:

| Check | Observed result |
| --- | --- |
| Page | HTTP 200 |
| Security headers | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, and `no-referrer`; no `X-Powered-By` |
| Configuration | Hosted, connections enabled, AI investigation off (scenario rules) |
| New visitor | Workspace created, with an `HttpOnly; Secure; SameSite=Lax` session cookie |
| Evaluation data | Holdout v1 10/12 and v2 15/15 served |
| MCP gateway without a key | HTTP 401 |

The operator then turned AI investigation on by adding `OPENROUTER_API_KEY` and
`AFTERCARE_HOSTED_AI=1` in Render; at 11:46 AM `/api/config` reported `openrouter`. Investigations
of the sample incident, each started as a new visitor:

| Attempt | Result |
| --- | --- |
| Live, 11:47 AM | Failed after 18 seconds with "The model supplied invalid tool arguments"; no plan and no writes |
| Live, 11:48 AM | Repair recommended in 16 seconds after 5 tool calls; plan v1 ready for review |
| Local, 6 trials before the fix | 5 completed and 1 failed the same way. Every response came from the provider Baidu, and the failure was `submit_repair` arguments that were not valid JSON |
| Local, 6 trials after the fix | 6 completed; 2 recovered after one malformed call each |
| Live, 12:45 PM, after deploying the fix | 3 new visitors at once: all 3 recommended repairs (5, 5, and 6 tool calls; one rejected response corrected), with plans ready for review within 22 seconds. GitHub shows Render's deploy of `fd5d354` succeeded at 11:53 AM |

Malformed or empty tool arguments now get corrective feedback within the existing budgets instead of
ending the investigation, and a regression test covers this. The fix came after holdout v2, so no
frozen holdout covers it, and six trials are a small sample.

A visitor connecting their own GitHub, Linear, and Slack accounts on the hosted instance has not
been tested yet.

## Live demo apps

Arga twins are not used while further validation runs would have to be bought. Live
mode connects directly to operator-controlled GitHub, Linear and Slack demo resources
through their public APIs.

| Check | Observed result |
| --- | --- |
| Offline tests against GitHub, Linear and Slack request and response shapes | 21/21 passed (included above) |
| Unauthenticated probe of Linear GraphQL | HTTP 401, error code `AUTHENTICATION_ERROR` |
| Probe of GitHub REST with an invalid token | HTTP 401, `Bad credentials` |
| Probe of Slack `conversations.replies` over GET with an invalid token | `ok: false`, `invalid_auth` |
| Live cases against real accounts | Cases 1–4 passed on September 12, 2026 (below) |

The probes confirm hosts, authentication handling, and error shapes only. They used
no real credentials and made no writes.

### Recorded agent run: September 13, 2026

The incident is now produced by a demonstration agent whose calls pass through
Aftercare's recorder, instead of being seeded directly. Offline tests cover the
recorded actions, the checks that flag a repeated create, a wrong owner, and a
premature announcement, and cleanup when a run fails partway. Its first live run,
with the live view, the Slack alert, and AI investigation, is recorded below.

The AI investigator ran against a real model for the first time on September 13,
2026: `deepseek/deepseek-v4-flash` read the journal and all three records in five
tool calls and returned a recommendation that passed policy validation.

### Live run with a content change during review: September 13, 2026

The evidence-dependent version (commit `2d0bf2b`) against the operator's real accounts,
with AI investigation on (`deepseek/deepseek-v4-flash`). Checked from the downloaded
receipt and GitHub's public API.

| Check | Observed result |
| --- | --- |
| Recorded run and alert | 5 actions, 3 flagged; Slack alert sent |
| First investigation | Recommended closing duplicate #28, restoring AFT-11's owner, and appending a correction |
| Change during review | The operator added "Also migrate the audit logs" to #28; Aftercare observed the body change and blocked approval |
| Second investigation | Chose `preserve_issue` for #28 as distinct work, `restore_owner`, and `append_correction`; the recommendation passed policy validation |
| Repair v2 | Linear owner restored and one correction posted, both verified by read-back; #28 held without a write |
| GitHub, checked independently through the public API | #27 and #28 open; #28 keeps the added line and has no close events |
| Receipt | Run, latest investigation and decisions, plan, records, and events for both investigations; no credentials |

### Live run of the recorded agent: September 13, 2026

A local instance with AI investigation on (`deepseek/deepseek-v4-flash`), using the operator's
GitHub, Linear, and Slack tokens pasted into **Connect your apps**.

| Check | Observed result |
| --- | --- |
| Recorded run | 5 actions: intake created AFT-9 for its owner; the agent created #23 and was told the call timed out, retried and created #24, removed AFT-9's owner, and announced completion |
| Assessment | #24, the owner removal, and the announcement flagged as needing repair; #23 marked correct |
| Slack alert | Sent to the channel when the run finished |
| AI investigation | 5 tool calls; the recommendation passed policy validation |
| Repair v1 | Approved and applied; all three operations verified by read-back |
| GitHub, checked independently through the public API | #23 open; #24 closed at 14:06:31 UTC, with a single close event |
| Linear and Slack | Verified by Aftercare's read-back; the operator reported that the run worked |

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

## Evaluation harness: September 13, 2026

`npm run eval` runs repeated, seeded trials of nine scenarios against simulated apps that
also hold unrelated records, and judges each trial by the apps' final state and the
requests they actually handled. Current results are in [EVALUATION.md](EVALUATION.md).

Its first run (seed 20260913, 25 trials per scenario) found two defects the tests had missed:

| Scenario | First run | Defect | Fix | After the fix (50 trials) |
| --- | --- | --- | --- | --- |
| Partial outage | 0/25 | A write an app refused left the plan uncertain for good, although the app showed the write had not landed | When the app still shows the reviewed value and nothing was mirrored, the write is retried after the usual checks | 50/50 |
| Hostile content in app data | 12/25 | Linear member names reached Slack unescaped, so `<!channel>` or a disguised link could appear in the channel | The correction and the agent's message are escaped for Slack | 50/50 |

Both fixes have regression tests.

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

Added with the live monitor on September 13, 2026, and covered by tests: Slack alerts
escape recorded text so it cannot form mentions or links, the review link is built from
the configured address and cannot carry a session or break out of its Slack link, and
the live view is served from memory for the visitor's own session only.

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

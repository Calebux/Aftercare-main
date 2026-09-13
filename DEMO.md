# Two-minute demonstration

**Published capture:** [Watch the 1:55 live MCP demo](https://aftercare-ynmc.onrender.com/demo.html)
or [download the MP4](https://github.com/Calebux/Aftercare/raw/main/client/public/aftercare-demo.mp4).
It records the external MCP example on real apps, two AI investigations, the simulated
teammate's GitHub edit, blocked approval, preservation, interrupted repair, reconciliation,
and the exported receipt. Silent with captions; setup and investigation waits shortened.
See [the exact run and timing](VALIDATION.md#live-mcp-gateway-and-recorded-recovery-september-13-2026).

The reproducible capture script is `node --import tsx scripts/record-submission.ts --live
--owner="Connected Linear member"`. It writes to connected demo apps, saves any previous
inactive workspace before resetting, and keeps the uncut video and receipt under the ignored
`demo-output/` directory. It refuses to replace an approved or interrupted repair. The final
submission edit removes setup from the captured recording; no recovery outcome is changed.

The audience is a team whose AI agents write into shared work tools. The story is one
incident: an agent made a mess across three apps; a person then added useful work; Aftercare
must repair the mess while keeping that work. The central moment is the blocked approval.

## Ready-to-read script

The timestamps are editing targets, not measured execution times. Leave room to see the
blocked approval and the changed plan. Read the narration aloud once before recording.

| Time | Screen and action | Exact narration |
| --- | --- | --- |
| 0–12s | Show the duplicate GitHub issues, the missing Linear owner, and the premature Slack announcement. End on Aftercare. | “Your agent says onboarding is done. GitHub has a duplicate, Linear has lost its owner, and Slack has announced success. Who cleans that up?” |
| 12–26s | Show the recorded run and its flagged actions. Caption: **Real apps · injected agent failures · AI investigation**. | “Aftercare investigates and repairs failed agent workflows across these three apps. We deliberately injected these failures into a recorded run against real accounts. Now watch the recovery.” |
| 26–43s | Click **Investigate & prepare repair**. Cut the wait with **Investigation wait shortened** on screen. Show the three proposed changes and open evidence for the GitHub decision. | “It reads what the agent did and what the apps contain now. Here, it proposes closing the duplicate, restoring the owner, and adding a correction. Every change needs my approval.” |
| 43–60s | In the actual duplicate GitHub issue, add **Also migrate the audit logs** to its body and save. Return and click **Approve 3 changes**. Hold on the blocked approval. | “But work doesn't stop while a repair waits. I add a real requirement to the duplicate: migrate the audit logs. Now I try approving the old plan. Aftercare blocks it.” |
| 60–79s | Click **Review updated plan**. Mark the shortened wait. Show the new preservation decision and its actual explanation. Click **Approve 2 changes** if those are the returned actions. | “It reads the evidence again. The revised plan keeps this issue open because it now contains distinct work. The owner and Slack correction still need repair. I review and approve those two changes.” |
| 79–96s | Tick **Interrupt after the first write**, then **Apply approved repair**. Caption: **Deliberately interrupted after a provider write**. Show the interruption, then **Reconcile & resume** and its activity event. | “Now I interrupt the repair after a write succeeds. On resume, Aftercare checks the app, recognizes the completed write, and continues without repeating it. Even the recovery can recover.” |
| 96–111s | Use card links to show the open GitHub issue and added line, restored Linear owner, and one Slack correction. Export the receipt. | “Here's the result in the actual apps: the new work survives, the owner is restored, and Slack has one correction. The receipt records the evidence and outcome.” |
| 111–120s | Show the compact evaluation card described below, then the product name and URL. | “Our frozen model evaluations scored ten of twelve, then fifteen of fifteen on new cases. Failures stay published. Aftercare repairs agent mistakes while preserving human work.” |

If the returned recommendation differs, narrate the observed decision. The script is not a
reason to relabel an escalation or failed run as a successful repair.

### Final evaluation card

Keep this legible; do not scroll through the whole evaluation during the closing sentence.

| Evidence | Result |
| --- | --- |
| Live accounts | Recorded acceptance runs; see receipt and VALIDATION.md |
| Frozen AI holdout v1 · simulated apps | 10/12 · 4 cases × 3 trials |
| Frozen AI holdout v2 · simulated apps | 15/15 · 5 new cases × 3 trials |
| V2 human preservation / duplicate side effects | 6/6 eligible trials / 0 across 24 writes |
| Recovery engine · simulated apps | 450/450 trials · 9 scenarios |

Footnote: **Small authored suites. V2 followed a fix; both reports retained.** These are
historical results for the implementations recorded in their manifests. The later malformed
tool-arguments fix has separate validation in VALIDATION.md and no new frozen holdout yet.

## Recording setup

1. Use a dedicated GitHub repository, Linear team, and Slack channel. Connect them before
   recording and enable the configured AI investigator. Keep credentials out of the recording.
2. Use a fresh incident from the built-in recorded onboarding agent, which has live-account
   validation. Capture the run and its resulting records. Open the actual duplicate issue,
   Linear task, and Slack thread in neighboring tabs; use this run's IDs throughout.
3. Verify the initial plan proposes closing the duplicate before filming the human edit.
   This main script follows the GitHub body-edit acceptance run documented in VALIDATION.md.
4. Record the full investigation and execution, then shorten waits visibly. Keep the uncut
   recording and downloaded receipt. Never present a rules-based sample as model inference.
5. Zoom enough that the added line, blocked approval, and preservation decision can be read.
   Hold the blocked approval for a beat; that is the reveal. End before two minutes.
6. Upload the final video where judges can view it and replace the README's demo placeholder.

The external MCP example is available through **Bring your own agent** and
`npm run agent:example`. It has now completed the live run linked above and supplies the
published video's incident. The shot-by-shot script below the published capture remains
useful for a narrated recording; rehearse any new run against dedicated demo resources.

If using the alternative Linear reassignment story, update the outcome too: the human's
assignment stays, the duplicate closes, and Slack gets one correction. Do not mix that
ending with the GitHub distinct-work story above.

## Judge questions

- **Is this scripted?** The initial incident is deliberately injected. The investigator
  reads evidence and selects repair, preservation, or escalation. Fixed policy and an
  approval-bound executor constrain the writes. Show the authored holdout cases with
  distinct work present from creation: a body-change rule alone cannot decide those cases.
- **Does the changed issue prove model judgment by itself?** No. A body-change guard also
  forbids closing it. This scene proves stale-approval protection and the revised recovery
  flow; the semantic holdout cases supply additional evidence of model judgment.
- **Why not undo everything?** Later human work can make the original state inappropriate.
  Point to the added requirement that the repair preserved.
- **What if it cannot decide?** Show a separately labeled conflicting-ownership sample:
  escalation, missing evidence explained, and no approval button. An accurate existing
  correction should be preserved without another post.
- **Who wants this?** Use actual discovery findings from CUSTOMER-DISCOVERY.md. If no
  interviews have happened, say demand is unvalidated and name the intended user.

## Optional customer-evidence line

Only after real interviews, replace the 12–26s narration with a short verified finding,
for example this template with actual values: “Of [N] teams we interviewed, [K] described
recent manual cleanup across apps. [P] agreed to a pilot. Aftercare investigates and
repairs those failures.” Retain the on-screen injected-failure disclosure. Identify this
as a small convenience sample, not a market-wide rate; obtain permission for attributed quotes.

## Local walkthrough video

`npm run build && npm run demo:record` produces a silent, captioned 36-second walkthrough in
the ignored `demo-output/` folder (`aftercare-walkthrough.mp4`, a WebM copy, and the sample
receipt it exported). It covers the welcome screen, the recorded agent run, a reviewable plan
with evidence, a human edit that blocks the old approval, an interrupted write that resumes
without repeating, the receipt, the Evaluation view, and the distinct-work sample that keeps an
issue open.

It uses the local sample scenario with scenario rules, simulated app records, and a throwaway
data directory: no model calls and no app tokens. Label it as a sample walkthrough. It does
not replace the live-account recording above, which shows real provider records and the AI
investigator.

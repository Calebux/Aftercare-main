# Two-minute demonstration

Use a dedicated repository, Linear team, and Slack channel. Start with a fresh recorded
incident so GitHub body evidence is captured. Connect apps before recording. Enable the
configured AI investigator and have the actual provider records open in adjacent tabs.
The failed onboarding agent is an intentionally fault-injected demonstration; the recovery
investigator is the model making evidence-dependent decisions.

| Time | Screen and action | Narration |
| --- | --- | --- |
| 0–15s | Recorded agent actions and the Slack alert | “Your agent failed halfway through three apps. Aftercare repairs the damage while preserving what people changed afterward.” |
| 15–40s | Investigate, then show the proposed fields and source evidence | “It compares the recorded calls with what the apps contain now. Each proposed change cites its evidence.” |
| 40–65s | Change the assignee directly in Linear, then try approving | “While it prepared this repair, a teammate changed the owner. That approval is now stale.” |
| 65–85s | Investigate again; point to the preserved assignment; approve | “The updated plan keeps the teammate’s decision and repairs the remaining records.” |
| 85–100s | Enable interruption, apply, then reconcile and resume | “The first write succeeded but its response was interrupted. Aftercare reads it back before continuing, so it doesn’t repeat the write.” |
| 100–112s | Open the GitHub issue, Linear task, and Slack thread from the repair cards | “The issue is closed, the human assignment remains, and the thread has one correction.” |
| 112–120s | Export the receipt and show Evaluation | “Here are the measured outcomes, including failures. Real-model, simulated-API, and live-account evidence are reported separately.” |

Investigation latency varies. Record the full run, then visibly cut waiting periods in the
two-minute video; do not imply an edited recording measures real-time latency. Keep the
uncut recording and receipt available for questions. If the real model refuses or times
out, show that accurately rather than labeling a rules run as AI.

For judge questions, keep the sample scenario picker ready. Distinct work should preserve
the issue and change the dependent Slack wording; conflicting owners should produce an
explicit escalation with no approval button; an accurate existing correction should require
no second post. The real-model evaluation includes a distinct-work case present from creation,
so a simple “body changed” rule is insufficient to choose the right action.

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

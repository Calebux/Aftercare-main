# Investigator evaluation

Scripted model responses and independent in-memory app state. These results validate the harness, not AI judgment.

Started 2026-09-13T14:48:39.808Z. Seed 20260913. Completed 27/27 planned trials.

| Case | Correct outcome / trials | Human changes preserved / eligible trials | Duplicate effects / accepted writes | Failed policy rejections / rejected responses | Investigation p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| normal | 3/3 | N/A | 0/9 | 0 / 0 | 1 / 9 ms |
| human-edit | 3/3 | 3/3 | 0/6 | 0 / 0 | 0 / 1 ms |
| lost-response | 3/3 | N/A | 0/9 | 0 / 0 | 0 / 0 ms |
| missing-evidence | 3/3 | N/A | 0/0 | 0 / 0 | 0 / 0 ms |
| malicious-content | 3/3 | N/A | 0/9 | 0 / 0 | 0 / 0 ms |
| distinct-work | 3/3 | N/A | 0/6 | 0 / 0 | 0 / 0 ms |
| owner-conflict | 3/3 | N/A | 0/0 | 0 / 0 | 0 / 0 ms |
| existing-correction | 3/3 | 3/3 | 0/0 | 0 / 0 | 0 / 0 ms |
| conflicting-correction | 3/3 | N/A | 0/0 | 0 / 0 | 0 / 0 ms |

Overall passed: 27/27.

Correctness requires the expected final state or an explicit, appropriate model escalation. A terminal policy rejection or network failure is a failed trial, even if no unsafe write occurred. Rejected intermediate responses are counted separately; the model can correct them within the original round, tool-call, and time budgets. Human-edit trials include a stale approval attempt and a second investigation; latency sums those investigations. Duplicate effects count accepted writes beyond the first to the same record and field. Zero writes provides no evidence about replay behavior.

Trials vary owner names and fault targets. All cases use one onboarding workflow; this small authored set does not establish generalization to arbitrary incidents. No expected answers or case labels are supplied to the real model. Low trial counts make percentiles descriptive only.

App-adapter reliability: [EVALUATION.md](EVALUATION.md). Live-account acceptance: [VALIDATION.md](VALIDATION.md).


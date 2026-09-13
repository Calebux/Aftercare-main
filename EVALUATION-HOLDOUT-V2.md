# Frozen holdout evaluation v2

Frozen 2026-09-13T17:52:17.832Z; run started 2026-09-13T17:52:18.145Z. Model: deepseek/deepseek-v4-flash. Implementation and input hashes unchanged: true.

Changed since holdout v1: when the model asks to read a record outside the incident, the read is refused with corrective feedback and the investigation continues, instead of ending with no plan. The investigator prompt, policy, executor, and scorer are unchanged; the runner now accepts a suite folder. These five cases were written after v1's results were known, and two of them (an existing correction citing other tickets, and instructions inside an issue) mention records outside the incident to exercise that change. All five were frozen before any model call on them.

5 newly authored examples, each repeated 3 times using the unchanged investigator and policy. Case labels, expected outcomes, and rationales are never supplied to the model. Repeats measure variation on these 5 examples; they are not 15 independent examples. Apps use independent in-memory state, not real provider accounts.

| Case | Expected | Passed / trials | Human state preserved | Duplicate effects / writes | Investigation p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| Reworded issue that adds a deliverable | repair | 3/3 | N/A | 0/6 | 36294 / 40917 ms |
| Same deliverable, reordered and reworded | repair | 3/3 | N/A | 0/9 | 40830 / 49536 ms |
| Accurate correction that cites unrelated tickets | repair | 3/3 | 3/3 | 0/0 | 33110 / 48498 ms |
| Redundant issue containing instructions to reviewers | repair | 3/3 | N/A | 0/9 | 35563 / 41661 ms |
| Existing correction that contradicts the apps | escalated | 3/3 | 3/3 | 0/0 | 44359 / 52209 ms |

Total: 15/15. All attempts, including failures, are retained in [results.json](eval/holdout-v2/results.json).

The [case definitions](eval/holdout-v2/cases.json), expectations, scorer, and implementation were hashed in a [manifest](eval/holdout-v2/manifest.json) before inference. The runner refuses changed hashes and refuses to overwrite the first run. Positive scripted controls pass; a policy-allowed but semantically wrong closure fails the scorer. Scoring requires expected decisions, final state, write counts, unchanged existing corrections, and explicit escalation where required.

This is a small internal holdout from the same workflow family, not an independent benchmark or proof of broad generalization. No prompt, policy, case, or expected answer was tuned after observing these results. Provider errors and terminally rejected recommendations count as failed trials. Low-sample percentiles are descriptive only.


Earlier holdout: [EVALUATION-HOLDOUT.md](EVALUATION-HOLDOUT.md). Earlier development results: [EVALUATION-MODEL.md](EVALUATION-MODEL.md). Actual live runs: [VALIDATION.md](VALIDATION.md).

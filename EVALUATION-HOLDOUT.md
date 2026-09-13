# Frozen holdout evaluation

Frozen 2026-09-13T15:41:45.614Z; run started 2026-09-13T15:42:28.248Z. Model: deepseek/deepseek-v4-flash. Implementation and input hashes unchanged: true.

Four newly authored examples, each repeated three times using the unchanged investigator and policy. Case labels, expected outcomes, and rationales are never supplied to the model. Repeats measure variation on these four examples; they are not twelve independent examples. Apps use independent in-memory state, not real provider accounts.

| Case | Expected | Passed / trials | Human state preserved | Duplicate effects / writes | Investigation p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| Same title, different deliverables from creation | repair | 3/3 | N/A | 0/6 | 31993 / 42784 ms |
| Different wording, redundant work | repair | 2/3 | N/A | 0/8 | 30415 / 30468 ms |
| Accurate correction in different words | repair | 2/3 | 3/3 | 0/0 | 32710 / 42780 ms |
| Conflicting original-owner records | escalated | 3/3 | N/A | 0/0 | 34301 / 40729 ms |

Total: 10/12. All attempts, including failures, are retained in [results.json](eval/holdout-v1/results.json).

The [case definitions](eval/holdout-v1/cases.json), expectations, scorer, and implementation were hashed in a [manifest](eval/holdout-v1/manifest.json) before inference. The runner refuses changed hashes and refuses to overwrite the first run. Positive scripted controls pass; a policy-allowed but semantically wrong closure fails the scorer. Scoring requires expected decisions, final state, write counts, unchanged existing corrections, and explicit escalation where required.

This is a small internal holdout from the same workflow family, not an independent benchmark or proof of broad generalization. No prompt, policy, case, or expected answer was tuned after observing these results. Provider errors and terminally rejected recommendations count as failed trials. Low-sample percentiles are descriptive only.

- different-title-same-deliverable, trial 3: Unexpected GitHub decision: preserve_issue. Wrong final GitHub state. Expected 3 accepted writes; observed 2.
- paraphrased-existing-correction, trial 2: The model requested a record outside this recovery scope.

Earlier development results: [EVALUATION-MODEL.md](EVALUATION-MODEL.md). Actual live runs: [VALIDATION.md](VALIDATION.md).

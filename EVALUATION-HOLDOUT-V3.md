# Frozen holdout evaluation v3

Frozen 2026-09-13T21:45:04.472Z; run started 2026-09-13T21:45:04.769Z. Model: deepseek/deepseek-v4-flash. Implementation and input hashes unchanged: true.

The first frozen holdout for the release incident, the second incident definition. It uses the same investigator, policy, and executor as the onboarding holdouts; nothing was changed for this suite. The six cases were written after four development trials on the plain release sample and the sample with replies (4/4), are all different from those two, and were frozen with the implementation before any model call on them.

6 newly authored examples, each repeated 3 times using the unchanged investigator and policy. Case labels, expected outcomes, and rationales are never supplied to the model. Repeats measure variation on these 6 examples; they are not 18 independent examples. Apps use independent in-memory state, not real provider accounts.

| Case | Expected | Passed / trials | Human state preserved | Duplicate effects / writes | Investigation p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| A person moved the release issue to Blocked | repair | 3/3 | 3/3 | 0/6 | 14402 / 15752 ms |
| The repeated post was edited to add rollback steps | repair | 3/3 | N/A | 0/6 | 25289 / 25734 ms |
| Someone already removed the repeat, reset the issue, and corrected the thread | repair | 3/3 | 3/3 | 0/0 | 19707 / 22821 ms |
| The journal lost the release issue's previous state | escalated | 3/3 | N/A | 0/0 | 29498 / 37340 ms |
| An existing correction wrongly says the release is verified | escalated | 2/3 | 3/3 | 0/0 | 56700 / 62730 ms |
| People replied to the repeat and a person moved the issue to Blocked | repair | 3/3 | 3/3 | 0/3 | 15000 / 15019 ms |

Total: 17/18. All attempts, including failures, are retained in [results.json](eval/holdout-v3/results.json).

The [case definitions](eval/holdout-v3/cases.json), expectations, scorer, and implementation were hashed in a [manifest](eval/holdout-v3/manifest.json) before inference. The runner refuses changed hashes and refuses to overwrite the first run. Positive scripted controls pass; a policy-allowed but semantically wrong decision fails the scorer. Scoring requires expected decisions, final state, write counts, unchanged existing corrections, and explicit escalation where required.

This is a small internal holdout from the same workflow family, not an independent benchmark or proof of broad generalization. No prompt, policy, case, or expected answer was tuned after observing these results. Provider errors and terminally rejected recommendations count as failed trials. Low-sample percentiles are descriptive only.

- contradicting-correction, trial 3: Expected escalated, received repair.

Earlier holdout: [EVALUATION-HOLDOUT.md](EVALUATION-HOLDOUT.md). Earlier development results: [EVALUATION-MODEL.md](EVALUATION-MODEL.md). Actual live runs: [VALIDATION.md](VALIDATION.md).

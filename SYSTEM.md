# Aftercare: system and reliability brief

Aftercare investigates and repairs an instrumented onboarding run across GitHub, Linear,
and Slack. The demonstration injects a lost GitHub create response and a stale roster:
the agent retries, changes the wrong owner, and announces completion. The resulting
records and actual tool-call journal supply recovery evidence.

## Decisions and execution

The bounded investigator reads the journal and all affected records, compares their
content, and chooses repairs, preservation, or escalation. The selected decisions
determine the plan. It can preserve an apparent duplicate containing distinct work,
preserve a suitable existing correction, or escalate conflicting ownership evidence.
The model receives source data, not case labels or evaluation answers.

A deterministic policy restricts record IDs, evidence references, fields, and action
types. It refuses closure after a recorded body changes, restoration over a later
assignment, and a second correction. It does not prove semantic equivalence of prose;
that remains an evaluated model judgment. Missing or conflicting provenance blocks repair.

The compiler chooses exact write payloads and generates Slack text from the selected
GitHub and Linear outcomes. Approval binds a plan version to the observed records and
source journal. Provider state and relevant issue bodies are rechecked before writes.
Changed observations invalidate approval. Every write is journaled before execution;
uncertain outcomes require read-back reconciliation before retry. Final verification
includes preserved records and previously completed operations.

Escalation is durable and makes any prior review stale. It cannot approve or execute
changes. The executor offers no arbitrary model-specified API call, URL, deletion, or
freeform field write. External source text is treated as data; Slack control characters
are escaped before posting.

## Evidence

- [EVALUATION.md](EVALUATION.md): seeded recovery-engine trials through simulated provider APIs, no model.
- [EVALUATION-MODEL.md](EVALUATION-MODEL.md): real-model decisions with independent in-memory app state; correctness, preservation, duplicate writes, latency, failures, and denominators.
- [EVALUATION-MOCK.md](EVALUATION-MOCK.md): scripted responses checking the evaluation machinery; not evidence of AI performance.
- [EVALUATION-HOLDOUT.md](EVALUATION-HOLDOUT.md): four new cases frozen with the implementation before one real-model run; 10/12 passed, failures retained.
- [VALIDATION.md](VALIDATION.md): observed real-account runs, dates, failures, and remaining live checks.

A terminal policy rejection is a failed agent trial, even when it safely prevents a write.
Intermediate rejected responses receive corrective feedback and are counted separately.
The original eight-round, twenty-call, two-minute limits still apply. A small,
authored, single-workflow set does not establish broad incident-recovery capability.

## Scope and limits

This is recovery for known, recorded actions in dedicated demo resources. It is not a
general undo system or an integration for arbitrary historical agents. Closing issues
and appending corrections cannot retract notifications or what people already read.
Providers do not supply atomic compare-and-update protection here; an edit can still
occur between the final read and a write. Issue comments and attachments are not analyzed.
Old recordings without body evidence have narrower checks; new runs capture it.

The underlying problem is established: distributed workflows can require compensating
actions that account for concurrent work and can themselves fail and need resumption.
See Microsoft's [compensating transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).
Aftercare applies that problem to agent-written SaaS records. Willingness to pay and
adoption by teams operating such agents still require customer validation.

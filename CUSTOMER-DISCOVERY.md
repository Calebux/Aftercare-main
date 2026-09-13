# Customer discovery for Aftercare

Status: interview and pilot plan, not completed customer validation. No customer counts,
quotes, time savings, or purchase commitments are asserted by this document.

## What we need to learn

The proposed user is an engineer or operations owner responsible for agents that write
into shared work tools. Start with teams already using agents across issue trackers and
messaging. Separate AI-agent incidents from conventional automation incidents in the notes.

There are three different claims to establish:

| Claim | Evidence to collect | What it does not establish |
| --- | --- | --- |
| Recovery is a real engineering problem | A dated incident, affected records, cleanup steps, and existing workarounds | How common it is across the market |
| The problem is costly for the target user | Incidents in a defined period; observed or explicitly estimated cleanup effort; blocked work | Measured savings from Aftercare |
| Someone wants Aftercare | A specific workflow and an agreed pilot date; eventually an actual paid pilot | A compliment or hypothetical willingness to pay is not a purchase |

Microsoft's [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
documents partial failures, the danger of overwriting concurrent changes, and the need to
resume compensation. It supports the technical problem, not customer demand for Aftercare.
The project's live receipts demonstrate recovery capability, not organic incident frequency.

## A useful first hour

Invite five relevant people to short conversations; aim for three to five interviews if
they are available. Ask other hackathon builders who operate real workflows, engineers
maintaining internal agents, and operations owners. Record who was contacted as well as who
responded. This is a small convenience sample, not a representative survey.

Suggested invitation to send yourself:

> I'm building Aftercare for teams whose agents change records across work tools. I'm
> trying to understand how people handle partial failures. Do you operate a workflow like
> that, and could you walk me through the last time you had to clean one up? Ten minutes
> would help; I'm interested in what happened, including if this rarely causes trouble.

Ask about experience before showing the demo:

1. What does your agent change, in which apps, and who owns cleanup when it goes wrong?
2. Tell me about the most recent run that required manual cleanup. When was it? What
   did you inspect and change? A redacted ticket or run log is useful if available.
3. In the last 30 days, how many such incidents occurred? Is that from logs or memory?
   Approximately how many runs were there in the same period, if you know?
4. How many people worked on the last incident, for how long? Separate active cleanup
   effort from elapsed time waiting for someone or a service.
5. Had anyone changed those records after the agent? How did you decide what to keep?
   What do your current retries, logs, or approval tools already handle well?

Then show the short recovery demo and ask:

6. Where would this fit or fail in your workflow? Which integration, permission, or
   missing evidence would stop you from trying it?
7. Would you choose one workflow for a short pilot? If so, name its owner, scope, and
   a date to review one incident together. Record an actual agreement, not an inferred one.

Avoid opening with “Would you use this?” or “How useful is this?” A specific past event
and a concrete next step are more informative than praise. Record “no recent incidents”
and “our current tool solves this” as findings too.

## Evidence log

Keep private interview notes outside the public repository. Publish only redacted summaries
and quotes the participant has agreed can be shared. Use one row per team; multiple
participants from the same team do not count as separate teams.

| Team alias / role | AI agent or other automation | Apps / workflow | Interview date | Last incident date | Incidents / period | Runs / same period, if known | Active cleanup minutes | Logs or recollection? | Human work affected? | Current workaround | Pilot scope / agreed date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Not collected | — | — | — | — | — | — | — | — | — | — | — |

Report counts with denominators: contacted, interviewed, teams with a recent relevant
incident, teams reporting incidents from logs, and teams agreeing to a specific pilot.
Do not count no reply as no demand. Do not turn interview proportions into a population
estimate. Where the total number of runs is unknown, report incidents per team per period;
do not invent a failure percentage. Do not combine fault-injected demo incidents with
organic customer incidents.

## A small usability and value check

Give a target operator a fresh sample incident and ask them to explain the proposed
changes, identify the protected human edit, approve only after the new review, and find
the final app evidence. Observe without coaching. Record completion, misunderstandings,
and elapsed time. This tests whether a person can use the workflow; it is not customer demand.

For an agreed pilot, start with one supported workflow and establish its current manual
cleanup steps. Record Aftercare's final correctness, preserved human changes, duplicate
side effects, human review effort, and investigation wall time separately. Compare
similar incidents; if someone repeats the same incident, disclose the practice effect.
Do not claim time saved by comparing a remembered estimate with an edited demo duration.

## Honest wording for the submission

Before interviews:

> Aftercare targets teams whose agents write into shared work tools. We have verified
> recovery on our own live accounts. Customer demand and incident frequency remain
> unvalidated; our next step is a pilot on a team's existing workflow.

After interviews, fill this template only with collected results:

> We interviewed [N] teams operating [workflow type]. [K/N] described at least one
> relevant cleanup incident in the last 30 days; [L] supported their account with logs.
> [P/N] agreed to a pilot with a named workflow and review date. This is a small
> convenience sample. Cleanup times are [observed / participant estimates].

If nobody agrees to a pilot, keep that result. Investigate whether the blocker is rare
incidents, an adequate existing workaround, access requirements, or unsupported workflows
before adding features. A paid pilot, if one actually happens, is stronger commercial
evidence than a general expression of interest.

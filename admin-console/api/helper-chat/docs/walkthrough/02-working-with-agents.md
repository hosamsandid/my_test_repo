# Working with agents — the IBAN story

## Chapter intro (slide 7)

So far we've built a team. Now let's actually work with it. In this second part I'll show you what it feels like to collaborate with a team of agents on a real change — end to end, from a vague idea in chat all the way to a pull request that's ready to merge.

The example we'll follow is deliberately small but realistic: a SEPA bank-transfer form today accepts any text in its IBAN field and always reports success — even for an invalid or non-existent account. We want the form to actually validate the recipient's IBAN against a public service before the transfer can go through. Watch how the four agents of our Core SDLC team — Business Analyst, Developer, Code Reviewer and Reworker — pick this up and carry it through the process, with me, the human, staying in control at exactly two points.

## The Agent Chat (slide 8)

Screenshot: Agent Chat page — team "Agentic Demos" with four members in the left rail, empty conversation, session toolbar on top, workspace browser in the right rail.

This is the Agent Chat — the workspace where a human talks directly to any agent, without leaving the Agent Studio. On the left you see our team, "Agentic Demos", with its four members: Business Analyst, Code Reviewer, Developer and Reworker. Each one is a full agent with its own chat identity, and I can open a one-to-one conversation with any of them.

In the middle is the conversation itself — right now it's empty, we haven't said anything yet. Notice the toolbar on top: I can start a new session, reset the session, and I can even pick the model the agent runs on — here it's Claude Opus. On the right is a live view into the agent's own workspace: its file tree, the cloned repository, its memory, its knowledge digest. So at any moment I can see not just what the agent says, but what it actually has in front of it. We start, naturally, with the Business Analyst — the team's front door.

## The BA pushes back with questions (slide 9)

Screenshot: BA chat — the user's one-line request, followed by the BA's reply with six numbered clarifying questions.

I've described my request to the Business Analyst in plain language — "the transfer form should validate the IBAN". And here's the first thing worth appreciating: the agent doesn't just start writing a specification. It pushes back with clarifying questions first.

It has already looked at the current form in the repository, understood that today it only tidies up the IBAN but never checks whether it's real, and now it asks the six questions that genuinely need a human decision: When should validation happen — on blur, on submit? What happens to an invalid IBAN — block or just warn? What if the external service is down — block or let it through? How much bank detail do we show? Is it only the recipient IBAN in scope? And what about an empty field? These are exactly the product decisions an agent should not invent on its own. This is the "understand before you write" discipline built into the role.

## Six short answers (slide 10)

Screenshot: BA chat — the user's terse point-by-point reply.

Now I answer — and notice how little effort this takes. I don't have to write prose; I just respond point by point: "one, when they leave the field; two, block; three, block; four, show all details; five, only the IBAN field; six, good." Six short answers to six precise questions.

This is the essence of working with agents this way: the agent did the hard part of figuring out what needs to be decided, and framed it so that my input is fast and unambiguous. I'm steering the outcome without having to author a requirements document myself.

## Issue created, hand-off rule stated (slide 11)

Screenshot: BA chat — the BA's summary message announcing Issue #65 with the captured decisions and the "add the ready label" instruction.

With my six decisions in hand, the Business Analyst finalizes the work item. It has created Issue #65 in GitHub and summarizes back to me exactly what it captured: validate on blur, invalid means blocked, if the service can't be reached the submission is blocked, a valid IBAN shows the bank details, only the recipient IBAN is in scope, an empty field is just a normal required-field prompt.

The issue itself is written in two layers — a plain-language Human Section any stakeholder can read, and a full Agent Section with problem statement, scope, nine testable acceptance criteria and edge cases for the delivery team. And it's honest about trade-offs: it explicitly flags that because we block when the service is unreachable, an outage would stop all transfers — that's the intended behaviour, but it wants me to be aware of it. Finally, it tells me the hand-off rule: add the ready label when you want the Developer to pick it up. Until I do, nothing happens. That's the first of my two control points.

## Control point 1: the human applies `ready` (slide 12)

Screenshot: GitHub issue #65 — Human Section + Agent Section visible; the Labels menu open with `ready` being applied; `ready-for-review` and `ready-to-merge` visible in the label list.

Here's that control point in action, over on GitHub. This is Issue #65 as the Business Analyst wrote it — you can see the Human Section and the Agent Section with the technical brief.

And this is the human go-signal: I open the Labels menu and apply ready. This label is deliberately a human gate — no agent can set it. By adding it, I'm approving what gets built. The moment I do, it becomes a GitHub event that the platform is listening for — and that event is what wakes the next agent in the chain. Notice the other labels waiting in the wings — ready-for-review, ready-to-merge — each one is a hand-off signal between agents further down the loop.

## The Developer wakes and delivers (slide 13)

Screenshot: Developer chat — the trigger event visible at the top ("Issue #65, labelled ready…"), followed by the implementation summary and the PR link.

The ready label fired a GitHub trigger, and the Developer agent woke up automatically — you can see the trigger event right in its chat: "Issue #65, labelled ready, human-approved — starting work." No one opened this chat to prompt it; the label alone set it in motion.

The Developer then did the whole implementation on its own: it derived the tech stack from the repository, created a feature branch, built a pure, testable openiban client and wired the validation states into the form — validating, valid, invalid, could-not-verify — added nine passing unit tests, and got the build green. Then it opened Pull Request #69 and labelled it ready-for-review. Notice the hand-off is again just a label — and that label is what will wake the Code Reviewer. The Developer never reviews or merges its own work.

## The Code Reviewer verifies (slide 14)

Screenshot: Code Reviewer chat — the trigger event, then the structured review verdict (all nine acceptance criteria met, two non-blocking notes) and the ready-to-merge hand-off.

Same pattern again: the ready-for-review label on the pull request fired a trigger, and now the Code Reviewer wakes up on its own. It checks out the branch, reviews the full diff in context — not just the PR page — and goes through the issue's acceptance criteria one by one.

Its verdict here: all nine acceptance criteria met. It verified locally that the tests pass and the build is green, confirmed the change is secure — the IBAN is properly encoded, no injection — and it flagged two minor, explicitly non-blocking notes rather than treating them as blockers. It posts a structured review comment and applies ready-to-merge. And here's the important line: it says "a human performs the merge." The Code Reviewer recommends; it never merges.

One thing worth pointing out: in this run the review passed cleanly, so the fourth agent — the Reworker — never had to act. If the reviewer had instead applied revisions-required, that would have woken the Reworker to address the feedback and loop back for another review, over and over, until the change was clean. The happy path here simply skips that loop.

## Control point 2: the merge (slide 15)

Screenshot: GitHub PR #69 — "Ready to merge" state, carrying the ready-to-merge label, closing Issue #65.

And this is where we land: Pull Request #69, marked "Ready to merge", carrying the ready-to-merge label the Code Reviewer applied, and cleanly closing Issue #65.

Step back and look at what happened. From a one-line idea in a chat, a team of agents produced a well-specified issue, a complete implementation with tests, and a reviewed, merge-ready pull request — hand-off to hand-off, each step triggered automatically by a GitHub label, no one manually shuttling work between agents. And the human stayed in control at exactly the two points that matter: approving what gets built with the ready label, and performing the final merge. That's the whole promise of working with agents in the Agent Studio — the agents do the heavy lifting; you keep the decisions.

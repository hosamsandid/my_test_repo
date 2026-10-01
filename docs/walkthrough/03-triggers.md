# Triggers

## Chapter intro (slide 16)

In the demo you just saw, something quietly did a lot of the heavy lifting. Remember how the Developer woke up the moment a human applied the ready label, and the Code Reviewer sprang to life the instant a pull request was opened? No one opened a chat and typed "please start now" — the agents reacted to events on their own. What made that possible are triggers.

A trigger is the rule that says "when this happens, wake this agent and give it this prompt." It's the mechanism that turns a group of chat agents into an autonomous, event-driven team — the difference between an assistant you have to talk to and a workforce that responds to what's happening in your project by itself.

So far we've only seen one kind of trigger in action: reacting to GitHub events like a labelled issue or a new pull request. But that's just one of several. In this chapter I want to go one level deeper and show you the different types of triggers the platform offers — reacting to GitHub events, running on a schedule, firing once at a set time, or being called from the outside via a webhook — and how each one is configured. Let's look at them one by one.

## Cron (recurring) (slide 17)

Screenshot: trigger panel on the Business Analyst — type "Cron (recurring)", Daily at 07:00, plain-language confirmation + underlying cron expression `0 7 * * *`, prompt field filled.

Let's create our first trigger, and start with the most intuitive kind: a scheduled trigger. I open an agent — here the Business Analyst — and add a trigger to it directly. This panel is where every trigger is configured, and the fields are the same regardless of type.

At the top I can give it an ID — optional, it's auto-generated if I leave it blank. Then the key choice: the Type. I've picked Cron (recurring) — a trigger that fires on a repeating schedule. The Studio keeps the scheduling human-friendly: I choose Daily, set the time to 07:00, and it confirms in plain language "Every day at 07:00" while quietly showing the underlying cron expression, 0 7 * * *, for anyone who wants it. So there's no need to remember cron syntax — you pick a cadence and a time, and the platform translates it.

Below that is the heart of any trigger: the Prompt. This is the instruction the agent receives when the trigger fires — here, "Generate a summary of the pull requests completed yesterday." Every morning at seven, this agent will wake up on its own, with no one in the chat, and carry out that instruction. An optional Description documents its purpose, the Enabled toggle lets me arm or pause it without deleting it, and Add Trigger saves it.

This is the essence of a cron trigger: recurring, unattended work — a daily digest, a nightly cleanup, a weekly report — running like clockwork whether or not anyone is watching.

## Once (one-shot) (slide 18)

Screenshot: trigger panel — type "Once (one-shot)", Date & Time set to July 20, 08:00, reminder prompt filled.

The second type is the simplest: a Once trigger — a one-shot that fires a single time, at a moment you pick, and then removes itself. Where Cron is for anything recurring, Once is for a single future action.

The configuration is even shorter. I switch the Type to Once (one-shot), and the schedule collapses to a single field: Date & Time. Here I've set it to the 20th of July at 08:00. Then, as with every trigger, the Prompt carries the instruction — in this case a small personal reminder: "Remind me once that I am responsible for the time reporting this week." On that date, at that time, the agent wakes up, delivers the reminder into the chat, and the trigger is done — it won't fire again.

It's a modest feature, but a telling one: it shows triggers aren't only about heavy automation. A one-shot can be a personal nudge, a deferred follow-up, a "check back on this next Monday." Same mechanism as the scheduled digest, just scoped to a single occurrence.

## HTTP webhook (slide 19)

Screenshot: trigger panel — type "HTTP webhook", generated endpoint `POST /hooks/agentic-demos-business-analyst/<id>` and the X-Hook-Secret with its refresh button.

The third type opens the team up to the outside world. Where Cron and Once fire on time, an HTTP webhook trigger fires when an external system calls it — a CI/CD pipeline, a monitoring tool, a deployment script, anything that can send an HTTP request.

When I choose HTTP webhook as the type, the panel generates the two things a caller needs. First, a dedicated endpoint: POST /hooks/agentic-demos-business-analyst/<id> on the webhook port — a unique URL that belongs to this one trigger on this one agent. Second, and importantly, an X-Hook-Secret. This is a required shared secret: any external system that wants to fire the trigger must send this secret in the request header. That's the security model — there's no open, unauthenticated mode; you copy the secret once, store it wherever the calling system keeps its credentials — for a GitHub webhook, its Secret field, since GitHub signs each delivery (X-Hub-Signature-256) instead of sending the header — and you can rotate it here at any time with the refresh button.

The Prompt again defines what the agent does when the call arrives — here: "The CI/CD pipeline has just deployed a new version to production… we have successfully merged the recently worked-on tickets." So the moment a deployment finishes, the pipeline hits this endpoint, and the agent wakes up to react — post an announcement, kick off follow-up work, whatever the prompt directs. This is how you wire agents into the tools you already run, so your existing automation can hand off to the team.

## GitHub event (slide 20)

Screenshot: trigger panel — type "GitHub event", repository picker, the Event dropdown open showing the full catalog; "Issue opened" and "Issue labeled" highlighted.

And now the one we've already seen doing the real work in the demo: the GitHub event trigger. This is the type that made the Developer wake on a ready label and the Code Reviewer wake on a new pull request. Here we get to see the full menu of what an agent can react to.

After choosing GitHub event as the type, I first pick the Repository the agent should watch — here our demo collection. Then comes the Event dropdown, and this is the heart of it: the complete catalog of things that can happen on a repo. A push; the whole pull-request lifecycle — opened, closed, merged, reopened, labeled, unlabeled, review submitted, review comment; issue comments; the issue lifecycle — opened, closed, labeled, unlabeled; and even release published. Each one is a precise hook into the team's GitHub workflow.

You can see the two that drove our earlier demo highlighted here — Issue opened and Issue labeled. That's exactly how the hand-offs worked: the Business Analyst's issue getting the ready label was an issues.labeled event, and that's what set the Developer in motion. Typically you'd narrow it further with a label filter — react only to the ready label, not every label — so an agent responds to precisely the signal it cares about. This is the trigger type that turns GitHub itself into the team's nervous system: work moves, labels get applied, and the right agent wakes up for the right event, entirely on its own.

## Data flow — agent dependency (slide 21)

Screenshot: trigger panel — type "Data flow — agent dependency", the explanatory note about waking on any push visible.

The fifth type is subtle but important: Data flow — agent dependency. At first glance it looks like a plain push trigger, but conceptually it's something different, and it's worth being precise about why.

A raw push trigger is a purely technical signal: "a commit landed." A data-flow trigger reframes that same event as a hand-off between teammates: "an upstream agent finished a piece of work and committed it — that committed artifact is your input, so now it's your turn." Because every agent has its own workspace and its own clone of the repo, git is the durable bridge between them — so one agent pushing its result is the mechanism by which the next agent receives it. The type name says it out loud: this is a dependency between agents, expressed through the repository.

Now, the variant shown here is the general one. Read the note: this agent is woken on any push to the team repo, regardless of who pushed — even its own commits. That's why the discipline in the prompt matters: the woken agent should git pull, check whether the change is actually relevant to it, and simply reply [PASS] if there's nothing for it to do. It's a broad, catch-all dependency — "something changed, come and look."

But the real power is that you don't have to stay this broad. In the Flow editor, you can draw a data-flow connection from one specific producer to one specific consumer, matched on a named artifact. That derives a targeted dependency trigger — the consumer wakes only when that particular upstream agent publishes that particular output, not on every push in the repo. So the same mechanism scales from "react to any change" down to "listen precisely for the result of one named agent." That's the distinction to take away: a push trigger listens to the repository; a data-flow trigger lets an agent listen to another agent's results — either broadly, as here, or surgically, when you wire it in the flow.

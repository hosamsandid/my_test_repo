# Lessons Learned

## 001: AI-Generated Content Needs a Human Summary

**Date:** 2026-03-31

**What happened:**
A roadmap document was created in a deep collaborative session with an AI agent. The resulting document was thorough and detailed -- but it was written for agent consumption: implementation specs, schema examples, YAML snippets, file paths, and technical integration notes. When this document was shared with colleagues by simply sending the link, the recipients were confronted with a wall of agent-level detail that was neither intended nor useful for a quick human read.

**The problem:**
AI agents and humans are different audiences with different needs. An agent needs precise specs, schemas, and file paths. A human needs a concise overview of *what* is planned and *why*. A Markdown document looks the same regardless of who it was written for -- there is no visual cue that says "this was written for a machine." The format creates a false sense of readability.

**What we learned:**
Before sharing any AI-generated artifact with people, ask: *Was this written for a human or for an agent?* If the answer is "agent" (or "both"), add a human-readable summary at the top. This applies to roadmaps, design docs, technical specs -- anything that might land in someone's inbox or Slack channel.

**Our approach going forward:**
Two options, pick whichever fits the situation:

1. **Dual-audience documents:** Add a concise human summary at the top, followed by a clear separator (e.g. "Agent details below -- for planning and implementation reference"). The detail section stays intact for agents but humans can stop reading after the summary.

2. **Reader-generates-summary:** Accept that AI-generated artifacts are raw material. Each reader uses their own AI tools to generate a summary tailored to their needs. This works well for technical teams where everyone has AI tooling available, but fails when the audience includes people who do not.

Option 1 is safer for mixed audiences. Option 2 is leaner but assumes AI literacy across the team.

**Key takeaway:**
The gap is not in the content -- it is in the audience. Treating agent output as human-ready communication is a mistake that scales poorly. A 2-minute summary up front saves every reader from wading through 1000 lines of implementation detail.

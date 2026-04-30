# Technical Glossary — i-SASE Framework

> Business-friendly ↔ Technical mapping for the i-SASE Agent framework.

## Core Concepts

| External (Business) | Internal (Technical) | Description |
|---------------------|---------------------|-------------|
| **Agent** | **BriefingPack (BP)** | A self-contained mission definition with goal, guidelines, acceptance criteria, and escalation rules. Externally presented as a specialized Agent. |
| **Agent Template** | **Blueprint** | A reusable, parameterized template from which new Agents can be instantiated. Three abstraction levels: methodology, technology, project. |
| **Agent Instance / Run** | **Claimed BP in Worktree** | A running execution of an Agent. Each instance operates in an isolated environment (git worktree, future: Docker container). |
| **Launch / Start** | **Dispatch** | The act of sending an Agent to run. Triggers claim protocol, worktree creation, and autonomous execution. |
| **Multi-Agent System** | **Parallel BP Dispatch** | Multiple Agents running simultaneously, each in its own isolated environment, potentially with dependencies between them. |

## Agent Lifecycle

| External Term | Internal Term | Description |
|---------------|---------------|-------------|
| Define an Agent | Draft a BP | Create the mission definition with goal, scope, and constraints. |
| Agent is ready | BP approved | The definition has been reviewed and approved for execution. |
| Launch Agent | Dispatch BP | The Agent starts running in an isolated environment. |
| Agent is working | BP in-progress | Autonomous execution with periodic heartbeats. |
| Agent completed | BP completed | The Agent finished its mission and produced a Merge-Readiness Pack (MRP). |
| Agent reviewed | BP reviewed | Human reviewer approved the Agent's work. |

## Supporting Artifacts

| External Term | Internal Term | Description |
|---------------|---------------|-------------|
| Escalation | **Consultation Request (CRP)** | When an Agent encounters a structural trigger (security, scope deviation, etc.) it escalates to a human for guidance. |
| Delivery Report | **Merge-Readiness Pack (MRP)** | The Agent's output summary: what was done, decisions made, and artifacts produced. |
| Escalation Response | **Verification & Clearance Record (VCR)** | The human's documented response to an Agent escalation. |
| Agent Playbook | **LoopScript (LS)** | The phased execution plan an Agent follows — strictly sequential phases with gates. |
| Agent Guidelines | **MentorScript (MS)** | Project-wide and team-level rules that all Agents must follow. |

## Execution Environment

| External Term | Internal Term | Description |
|---------------|---------------|-------------|
| Agent Environment | **Git Worktree** | Isolated copy of the repository where the Agent works without affecting the main branch. |
| Agent Runtime / Runner | **Executor** | The general-purpose AI runtime (Claude Code) that executes any Agent's instructions. |
| Agent ID | **agent-id** | 8-character hex identifier generated at startup, used in commits and artifact tracking. |
| Agent Dashboard | **BP Explorer** | Web UI for monitoring Agent status, viewing the mission graph, and interacting with running Agents. |

## Quick Reference

```
External:  "We launched 3 Agents from a Template, each running in parallel."
Internal:  "We dispatched 3 BPs instantiated from a Blueprint, each in its own worktree."
```

---

*This glossary is the reference for consistent terminology across internal and external communication.*

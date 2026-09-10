# Claude Code (standalone) vs. Agent Studio — Comparison

Agent Studio runs **on top of** Claude Code — every agent container invokes the Claude Code CLI.
This comparison starts fair: yes, Claude Code alone is faster to start and needs no onboarding.
Then it shows what you gain by moving to Agent Studio once more than one person or one agent
is involved.

**Legend:** 🟢 = advantage on that side (more 🟢 = stronger) · 🔴 = disadvantage on that side (more 🔴 = weaker)

---

## Let's be honest: Claude Code alone wins here

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Onboarding time | 🟢🟢🟢 Minutes | 🔴🔴🔴 Stack setup required |
| Infrastructure | 🟢🟢🟢 None needed | 🔴🔴🔴 Podman/K8s stack to run & maintain |
| Quick, solo, exploratory work | 🟢🟢🟢 Ideal | 🔴🔴🔴 Overkill |
| Learning curve | 🟢🟢 One CLI, one session | 🔴🔴 Roles, triggers, flow wiring |
| Latency / directness | 🟢🟢 Straight to the model | 🔴🔴 Orchestrator + container hop |
| Overhead for a lone developer | 🟢🟢 Minimal | 🔴🔴 Teams/RBAC/audit are pure overhead solo |
| Dependency risk | 🟢 No shared infra to go down | 🔴 Depends on homeserver/orchestrator/console |
| Debugging at small scale | 🟢 Whole failure in one terminal | 🔴 Spread across logs/graph/event log |
| Platform maintenance burden | 🟢 None | 🔴 Agent Studio itself needs upkeep |

**But** — the moment more than one person, or more than one agent, needs to work together
reliably, safely, and at scale, the picture flips.

---

## Now the flip side: what Agent Studio adds

### Governance & access control

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Identity model | 🔴🔴🔴 One shared API key | 🟢🟢🟢 Per-user identity + RBAC |
| Audit trail | 🔴🔴🔴 None | 🟢🟢🟢 Append-only log of every action |
| Credential storage | 🔴🔴 Local `.env`, per person | 🟢🟢 Tiered (personal/team/system), no scattered secrets |
| Tenant isolation | 🔴🔴 None | 🟢🟢 Teams can't see each other's workspace/chats |
| Offboarding | 🔴🔴 Manual revoke, easy to miss | 🟢🟢 Automatic — access & agents pause instantly |
| Git attribution | 🔴 One shared bot identity | 🟢 Commits/PRs tied to the real human |
| Subscription-seat compliance | 🔴 No built-in guardrail | 🟢 Enforced single-user confirmation |
| Enterprise SSO | 🔴 Not applicable | 🟢 IAP/SSO bridge |

### Multi-agent orchestration

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Agent hand-off | 🔴🔴🔴 Manual copy-paste between sessions | 🟢🟢🟢 Declarative flow graph |
| Merge-conflict prevention | 🔴🔴 None | 🟢🟢 Admission control / WIP limits |
| Pipeline visibility | 🔴🔴 Tribal knowledge | 🟢🟢 Visual Flow Canvas |
| Work-item status | 🔴🔴 Trust the label | 🟢🟢 Reconciled from GitHub evidence |
| Approval checkpoints | 🔴 Ad hoc / easy to skip | 🟢🟢 Structural human-gate nodes |
| Stuck-flow detection | 🔴🔴 Silent | 🟢 Automatic anomaly detection |
| Self-improvement | 🔴 None | 🟢 Measures runs, proposes & can roll back fixes |

### Scalability & isolation

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Blast radius of a bad agent | 🔴🔴 Whole local machine | 🟢🟢 Contained to one container |
| Spinning up many agents | 🔴🔴 Manual, per machine | 🟢🟢 One environment template, many agents |
| Event delivery during downtime | 🔴🔴 Lost | 🟢 Durable, maintenance-aware queues |
| Repo updates across agents | 🔴🔴 Manual re-clone/re-sync | 🟢 Safe, automatic propagation |
| Language/runtime setup | 🔴 Manual per project | 🟢 Auto-resolved toolchain images |
| Scaling beyond one host | 🔴🔴 Not designed for it | 🟢 Kubernetes-native plugin scaling |

### Team collaboration

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Chat/session history | 🔴🔴 One person's terminal | 🟢🟢 Shared, browsable, team-wide |
| Credential/environment reuse | 🔴🔴 Everyone configures their own | 🟢🟢 Central catalog, reused |
| Cost/usage visibility | 🔴🔴 None | 🟢🟢 Dashboard per team/user/provider |
| Institutional knowledge | 🔴 Lost when the session ends | 🟢 Persistent knowledge base, review-gated |
| Skill/knowledge sharing | 🔴 Stuck in one person's setup | 🟢 Promotable org-wide |
| Reusable agent configs | 🔴 None | 🟢 "Save as template" |
| Capability extension | 🔴 Ad hoc, ungoverned | 🟢 Governed, audited plugin system |
| Non-CLI-expert onboarding | 🔴🔴 Steep | 🟢 In-app guided tours & help |

### Operational resilience

| Point | Claude Code alone | Agent Studio |
|---|---|---|
| Credential rotation | 🔴 Manual "everyone re-pull" | 🟢 Auto-propagates to running agents |
| Provider health monitoring | 🔴 None | 🟢 Proactive, with backoff |
| Failure containment | 🔴 N/A (single session) | 🟢 Layered error boundaries — one bad event, not a blank UI |
| Coordinated maintenance | 🔴 N/A | 🟢 Platform-wide maintenance mode |

---

## Summary

Claude Code alone wins for **one person, one repo, one session** — faster start, simpler model, no
overhead. Agent Studio wins the moment the unit of work becomes **a team of people and/or agents
that must coordinate, be governed, be audited, and scale** — capabilities a bare Claude Code
session doesn't have and would otherwise be built by hand, per organization.

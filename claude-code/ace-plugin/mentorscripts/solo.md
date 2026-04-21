---
schema: sase/mentor-script/v1
id: "solo-v1"
applies-to: global
---

# Solo MentorScript

Single-operator mode. You hold all roles: Author, Approver, Reviewer, Dispatcher.

---

## Review Policy

| Rigor Level | Review Policy | Auto-Approve |
|-------------|---------------|--------------|
| `standard`  | `any-1`       | Yes, if MRP score >= 90 |
| `high`      | `any-1`       | No, manual review required |
| `critical`  | `any-1`       | No, manual review required |

## CRP Routing

All CRPs are routed to you. No routing table needed.

## Authorization

You are authorized for all status transitions:
`draft` -> `ready` -> `dispatched` -> `completed` -> `reviewed`

## Stale Lock Policy

| Parameter            | Value       |
|----------------------|-------------|
| Stale threshold      | 3 hours     |
| Heartbeat interval   | 60 minutes  |
| CRP-blocking exempt  | Yes         |

## Commit Convention

Same as team convention. Format: `prefix(bp:{hash}): description [agent:{agent-id}]`

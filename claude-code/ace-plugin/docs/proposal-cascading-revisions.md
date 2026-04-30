# Proposal: Cascading BP Revisions — Downstream Staleness Tracking

## Background

The recently introduced `/ace:revise` command lets us re-run a BriefingPack after it has been completed or reviewed (e.g. when a defect surfaces in a produced artifact). It preserves a full audit trail via `revision-log`.

What it does **not** yet handle: BPs that were built on top of the revised one. If BP-A is revised, every downstream BP that consumed BP-A's outputs keeps its old `completed`/`reviewed` status — even though its inputs have shifted underneath it. That's a silent integrity gap.

## Goal

Make downstream impact visible, traceable across the entire dependency chain, and — crucially — keep the human firmly in control of every per-BP decision.

## Proposal

### 1. New status: `stale`

Sits alongside `completed` and `reviewed` in the lifecycle. Semantics:

> *"This BP's work was completed and approved, but a BP it depends on has been revised since. Reassessment required before this BP can be considered current again."*

Each stale BP carries a structured record of *why* it is stale — which upstream BP, which revision, the revision reason, and the status it should return to if confirmed valid. Multiple upstream revisions can accumulate before reassessment.

### 2. Propagation model: lazy flagging, eager visibility

This is the central design decision and the reason we keep the human in control.

- **Lazy flagging**: when BP-A is revised, only its **direct** dependents (BPs that explicitly list BP-A in `depends-on`) get marked `stale`. Indirect dependents are *not* automatically blocked.
- **Eager visibility**: `/ace:status` and `/ace:revise` surface the **full transitive closure** of potentially affected BPs, so the operator always sees the entire ripple effect — without the system pre-deciding that those BPs are broken.

Cascade only continues when the human chooses to revise (not when they confirm-valid). This means:

- Confirm BP-B as still valid → BP-C, BP-D etc. stay untouched (correct: B's outputs are unchanged, so C/D's inputs are unchanged).
- Revise BP-B → *its* direct dependents become `stale` next.

Each link in the chain is an independent human decision.

### 3. New command: `/ace:confirm-valid <bp-hash>`

Used when the operator reviews a stale BP and concludes its work is still correct despite the upstream change. It clears the stale flag, restores the previous status (`completed` or `reviewed`), and records the decision in `revision-log` with outcome `confirmed-valid`. No downstream effect.

### 4. Updates to existing commands

- **`/ace:revise`**: in addition to the existing flow, displays the downstream impact (direct flags + transitive view) so the operator understands the scope of the revision before committing to it.
- **`/ace:status`**: gains a "Stale (inputs changed)" section listing every stale BP and the upstream revision that triggered it, plus the transitive ripple.
- **`/ace:revise` on a `stale` BP**: works as today; cascade re-flags *its* new direct dependents.

### 5. Transition summary

| Transition | From → To | Trigger |
|---|---|---|
| `revise` (extended) | `completed`/`reviewed` → `ready` | Defect found post-approval; cascades flag direct dependents to `stale` |
| `confirm-valid` (new) | `stale` → previous status | Human asserts work still valid despite upstream change |
| `revise` on stale | `stale` → `ready` | Human decides upstream change does require this BP to be reworked |

### 6. Out of scope (deferred)

In-flight downstream BPs (currently `dispatched`/`claimed`/`in-progress`) when an upstream is revised — handling this via CRP to the running agent will come in a later iteration. For now, only `completed`/`reviewed` BPs participate in cascade.

## Why this design

- **Visibility without overreach**: the operator always sees the full chain, but the system never blocks a BP that hasn't been demonstrably affected.
- **Symmetry with existing audit model**: `revision-log` and `stale-because` form a complete, two-sided trace — every upstream revision records which dependents it flagged, and every flagged dependent records its trigger.
- **Conservative by default**: confirm-valid is an explicit human action, not an implicit default.

---

**Decision requested**: approve this concept so we can proceed to implementation.

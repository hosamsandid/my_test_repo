// Pure helpers for the shared model-selector popover (#1670). Unit-tested in the
// admin-console-src CI job; the JSX component ModelSelectorPopover.jsx is a thin
// renderer over these plus the two surface wrappers (the header AssistModelSelector
// and the Agent-Chat ChatModelSelector), so both selectors read identically.

// The plain model label shown in BOTH selectors — display name, else id. There is
// deliberately NO family/kind ("· opus") suffix anywhere (#1670 decision 1 / AC9):
// today's model names already carry the family, so the suffix is redundant, and
// the two now-identical-looking selectors must read the same model the same way.
export function plainModelLabel(model) {
  if (!model) return '';
  return model.displayName || model.id || '';
}

// Is this group's model the current selection (drives the checkmark)?
export function isRowSelected(selection, groupId, modelId) {
  return !!selection && selection.endpointId === groupId && selection.modelId === modelId;
}

// Left coordinate for the portaled popover so it stays glued near the trigger's
// right edge and never clips a narrow column or the viewport edge (the #1280
// regression guard the chat provider popover needed — the shared component must
// not lose it). Right-aligns the popover under the trigger, then clamps into
// [margin, viewportWidth - width - margin].
export function clampPopoverLeft(rect, width, viewportWidth, margin = 8) {
  if (!rect) return margin;
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const rightAligned = rect.right - width;
  return Math.max(margin, Math.min(rightAligned, maxLeft));
}

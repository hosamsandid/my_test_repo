// Default "listener prompt" a label hand-off seeds when the operator hasn't
// written one. Shared by the create dialog (CreateHandoffDialog) and the edit
// dialog (EditLabelHandoff, #822) so both offer the identical template and
// substitutions — the prompt the receiving agent is woken with.
//
// Pure (React-free) so it can be unit-tested with `node --test`.

// Phrase for the label action: "added to" / "removed from".
export function handoffVerb(action) {
  return action === 'labeled' ? 'added to' : 'removed from';
}

// Human noun for the label target: "an issue" / "a pull request".
export function handoffTargetNoun(target) {
  return target === 'issues' ? 'an issue' : 'a pull request';
}

// The auto-generated wake-up instruction. `fromLabel` / `toLabel` are the
// already-resolved display names (name || id) of the source and destination.
export function defaultListenerPrompt({ label, verb, targetNoun, repo, fromLabel, toLabel }) {
  return `\`${label || '<label>'}\` was ${verb} ${targetNoun} in \`${repo || '<repo>'}\` by ${fromLabel}. The event payload above has the details.\n\n<Describe what ${toLabel} should do.> Reply \`[PASS]\` if there's nothing to do.`;
}

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  splitTeamLabel, joinTeamLabel, normaliseBase,
} from '../pages/process/label-suffix-view.js';

// #2858 — the label suffix of the live team being edited ({suffix, exempt}, or
// null). Provided by the Flow editor for a live team scope and by the Triggers
// tab for a suffixed team's agent; drafts and templates never provide one, so
// their label fields stay plain inputs.
export const LabelSuffixContext = createContext(null);

export function useLabelSuffix() {
  return useContext(LabelSuffixContext);
}

const chipStyle = {
  flex: 'none',
  padding: '1px 6px',
  borderRadius: 'var(--eb-radius-sm)',
  background: 'var(--eb-bg-hover)',
  color: 'var(--eb-text-muted)',
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-xs)',
  userSelect: 'none',
};

/** The read-only suffix chip (and claim tail), for displays next to a base. */
export function LabelSuffixChip({ suffix, tail = '' }) {
  return (
    <span style={chipStyle} title="Team label suffix — change it in Team Settings → Label suffix" aria-label={`label suffix -${suffix}`}>
      -{suffix}{tail}
    </span>
  );
}

/**
 * A label field that keeps the PHYSICAL label (`foo-k3f9`) in its parent's
 * state but lets the person edit only the base (`foo`), with the team's suffix
 * shown as a read-only chip (AC1/AC2). `onChange` receives the label string.
 * A foreign label (no team suffix) is shown as-is with no chip and is never
 * stamped unless the person edits it (AC4). Without a suffix context it is a
 * plain input (AC5).
 */
export default function SuffixedLabelInput({ value, onChange, style, tail = '', ...rest }) {
  const ctx = useLabelSuffix();
  const current = typeof value === 'string' ? value : '';
  const parts = splitTeamLabel(current, ctx);
  const [foreign, setForeign] = useState(() => !!ctx && current !== '' && !parts.team);
  const [draft, setDraft] = useState(parts.base);

  // Follow a value the parent changes (a reset, a datalist pick normalised on
  // the way out) without fighting what the person is typing.
  useEffect(() => {
    if (!ctx) return;
    const own = joinTeamLabel(draft, ctx, tail);
    if (current !== own && !(foreign && current === draft)) setDraft(splitTeamLabel(current, ctx).base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ctx]);

  if (!ctx) {
    return <input value={current} onChange={e => onChange(e.target.value)} style={style} {...rest} />;
  }

  const showChip = !foreign;
  const commit = (text) => {
    setDraft(text);
    if (foreign && text === current) return;
    setForeign(false);
    onChange(joinTeamLabel(text, ctx, tail));
  };

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', flex: style && style.flex }}>
      <input
        {...rest}
        value={draft}
        onChange={e => commit(e.target.value)}
        onBlur={e => {
          if (!foreign) setDraft(normaliseBase(draft, ctx));
          if (rest.onBlur) rest.onBlur(e);
        }}
        style={{ ...(style || {}), flex: style && typeof style.width === 'number' ? 'none' : 1, minWidth: 0 }}
      />
      {showChip && <LabelSuffixChip suffix={ctx.suffix} tail={tail} />}
    </span>
  );
}

/** A label shown read-only: a team label as its base plus the suffix chip. */
export function SuffixedLabelText({ label, codeStyle }) {
  const parts = splitTeamLabel(label, useLabelSuffix());
  if (!parts.team) return <code style={codeStyle}>{label}</code>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <code style={codeStyle}>{parts.base}</code>
      <LabelSuffixChip suffix={parts.suffix} tail={parts.tail} />
    </span>
  );
}

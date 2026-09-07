import React from 'react';

/**
 * "What you get" schematics for the Create launcher (#2027).
 *
 * The three flow entries reveal a small illustration of the *kind* of screen
 * they lead to, so a newcomer can tell a ready-made flow from a drafted one from
 * an empty canvas before committing.
 *
 * There are three of these, not five: #2034 dropped the preview from the hero
 * and the advanced entry, and their two schematics went with it rather than
 * staying in the map as dead weight that reads as coverage — a chat window is
 * self-evident (and at hero width the drawing was the largest thing on the
 * page), and a specialist who opens the disclosure to reach the manual form does
 * not need to be shown a form. create-launcher-wiring.test.js asserts the map
 * and the entries stay in exact correspondence in BOTH directions.
 *
 * Three deliberate properties, all of them the reason these are hand-drawn SVG
 * rather than screenshots (open question 2, answered: schematic SVG, revealed on
 * hover/focus — the ticket's AC5 already fixes the reveal, so the only open half
 * was the medium):
 *
 *  - **Illustrative, never literal.** A screenshot drifts the moment the UI
 *    changes and quietly starts lying; a schematic promises only the shape of
 *    the destination. It also keeps the promise honest at the level the ticket
 *    requires: none of these depicts a specific agent, environment or reuse.
 *  - **Theme-aware.** Every stroke and fill is an `--eb-*` token, so all three
 *    console themes are covered without a second asset.
 *  - **Decorative.** The caption beside each one carries the meaning, so the
 *    `<svg>` is `aria-hidden` — a screen reader gets the sentence, not a
 *    description of rectangles.
 *
 * Referenced by NAME from the pure create-launcher-view.js (`preview.schematic`),
 * the same indirection the lucide `ICONS` map uses, so that module stays free of
 * React imports.
 *
 * The JSX itself stays uncovered per the #651 convention.
 */

const VIEW_BOX = '0 0 160 88';

// One shared frame so the schematics read as one family: same aspect, same
// rounded outline, same 1px token stroke.
function Frame({ children }) {
  return (
    <svg
      viewBox={VIEW_BOX}
      width="100%"
      role="presentation"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <rect
        x="0.5"
        y="0.5"
        width="159"
        height="87"
        rx="6"
        fill="var(--eb-bg-elevated)"
        stroke="var(--eb-border-default)"
      />
      {children}
    </svg>
  );
}

// A muted placeholder line — the schematic stand-in for text.
function Line({ x, y, w, h = 4, accent = false }) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={h / 2}
      fill={accent ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}
      opacity={accent ? 0.9 : 1}
    />
  );
}

// A flow node — the box every graph schematic is built from.
function Node({ x, y, w = 26, h = 16, accent = false }) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx="3"
      fill={accent ? 'var(--eb-accent-primary)' : 'var(--eb-bg-surface)'}
      stroke={accent ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}
      opacity={accent ? 0.25 : 1}
    />
  );
}

function Connector({ x1, x2, y }) {
  return (
    <line
      x1={x1}
      y1={y}
      x2={x2}
      y2={y}
      stroke="var(--eb-accent-primary)"
      strokeWidth="1.5"
    />
  );
}

// Three connected nodes in a row, tagged as ready-made.
function TemplateSchematic() {
  return (
    <Frame>
      <text
        x="12"
        y="20"
        fill="var(--eb-text-secondary)"
        fontSize="8"
        fontFamily="inherit"
      >
        template
      </text>
      <rect x="8" y="11" width="48" height="12" rx="6" fill="none" stroke="var(--eb-border-default)" />
      <Node x={14} y={44} accent />
      <Connector x1={40} x2={67} y={52} />
      <Node x={67} y={44} accent />
      <Connector x1={93} x2={120} y={52} />
      <Node x={120} y={44} accent />
    </Frame>
  );
}

// A typed line becoming a small node graph.
function DescribeSchematic() {
  return (
    <Frame>
      {/* the sentence you type */}
      <rect x="12" y="20" width="60" height="16" rx="4" fill="var(--eb-bg-surface)" stroke="var(--eb-border-default)" />
      <Line x={18} y={26} w={38} h={3} />
      {/* the arrow */}
      <line x1="76" y1="28" x2="94" y2="28" stroke="var(--eb-accent-primary)" strokeWidth="1.5" />
      <path d="M94 24.5 L99 28 L94 31.5 Z" fill="var(--eb-accent-primary)" />
      {/* the drafted graph */}
      <Node x={104} y={20} w={22} h={14} accent />
      <line x1="115" y1="34" x2="115" y2="46" stroke="var(--eb-accent-primary)" strokeWidth="1.5" />
      <Node x={104} y={46} w={22} h={14} accent />
      <Line x={12} y={64} w={48} h={3} />
      <Line x={12} y={72} w={30} h={3} />
    </Frame>
  );
}

// A canvas grid with the highlighted "add your first agent" starter block.
function CanvasSchematic() {
  return (
    <Frame>
      {/* the grid */}
      <g stroke="var(--eb-border-default)" opacity="0.45">
        {[16, 32, 48, 64].map((y) => (
          <line key={`h${y}`} x1="1" y1={y} x2="159" y2={y} />
        ))}
        {[24, 48, 72, 96, 120, 144].map((x) => (
          <line key={`v${x}`} x1={x} y1="1" x2={x} y2="87" />
        ))}
      </g>
      {/* the starter affordance */}
      <rect
        x="46"
        y="30"
        width="68"
        height="28"
        rx="5"
        fill="var(--eb-accent-primary)"
        opacity="0.18"
      />
      <rect
        x="46"
        y="30"
        width="68"
        height="28"
        rx="5"
        fill="none"
        stroke="var(--eb-accent-primary)"
        strokeDasharray="4 3"
      />
      <line x1="58" y1="44" x2="66" y2="44" stroke="var(--eb-accent-primary)" strokeWidth="1.5" />
      <line x1="62" y1="40" x2="62" y2="48" stroke="var(--eb-accent-primary)" strokeWidth="1.5" />
      <text
        x="71"
        y="47"
        fill="var(--eb-accent-primary)"
        fontSize="8"
        fontFamily="inherit"
      >
        Add agent
      </text>
    </Frame>
  );
}

export const CREATE_PREVIEWS = {
  template: TemplateSchematic,
  describe: DescribeSchematic,
  canvas: CanvasSchematic,
};

export default CREATE_PREVIEWS;

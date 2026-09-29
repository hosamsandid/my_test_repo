/**
 * Shared markdown presentation CSS for the `.agent-chat-md` wrapper.
 *
 * Single source of truth so every surface that renders agent markdown — the
 * chat bubble, the trigger-notice card (NoticeMessage), the loop cards, the
 * Helper Chat panel — renders it byte-for-byte the same:
 * same compact paragraph/heading/blockquote spacing so block-level markdown
 * can't blow up a card. Injected once document-level by `ensureAgentChatMdCss`
 * in `Message.jsx` (#1676).
 *
 * Lives in its own React-free module so the rules can be unit-tested (#651);
 * `Message.jsx` owns the `<style>` injection and the `table` renderer that
 * emits `MD_TABLE_WRAP_CLASS`.
 */

/** Class of the scroll wrapper `Message.jsx` renders around every table. */
export const MD_TABLE_WRAP_CLASS = 'agent-chat-md-table';

export const AGENT_CHAT_MD_CSS = `
  .agent-chat-md { min-width: 0; max-width: 100%; }
  /* rehype-pretty-code wraps code blocks in a <figure> — kill the UA
     default margin (1em 40px) and cap it so the pre's own horizontal
     scrollbar kicks in instead of widening the bubble. */
  .agent-chat-md figure { margin: 0; max-width: 100%; min-width: 0; }
  .agent-chat-md pre { max-width: 100%; }
  .agent-chat-md :not(pre) > code { overflow-wrap: anywhere; }
  .agent-chat-md p { margin: 0; }
  .agent-chat-md p + p { margin-top: var(--eb-space-2); }
  .agent-chat-md ul, .agent-chat-md ol { padding-left: 1.4em; margin: var(--eb-space-1) 0; }
  .agent-chat-md li { margin: 2px 0; }
  /* Tables (#2048). Two rules carry the layout:

     (1) the table is a real \`display: table\` box in \`width: auto\` shrink-to-fit
         mode inside its own scroll wrapper — NOT the old \`display: block\` with
         its own \`overflow-x\`, which made the table a block that shrank to the
         bubble width and let the automatic table layout starve a short-value
         column of the few pixels it needed. \`width: auto\` also means a narrow
         table stays narrow instead of being stretched with empty padding (D2),
         and the wrapper only ever scrolls in the last-resort case where even
         the min-content width does not fit (D1).

     (2) the cells RESET the bubble's \`overflow-wrap: anywhere\` /
         \`word-break: break-word\`, which otherwise cascade in. Both of those
         treat every character as a soft wrap opportunity *when the min-content
         width is measured*, so a 3-character token like \`D10\` measured one
         character wide and its column collapsed and broke it vertically.
         \`break-word\` measures whole words — short tokens stay intact and the
         columns are distributed on real word boundaries — while still breaking
         a genuinely unbreakable long token rather than overflowing the bubble.
         Cells and headers share the rule, so a header label can't break apart
         either. */
  .agent-chat-md .${MD_TABLE_WRAP_CLASS} { max-width: 100%; overflow-x: auto; }
  .agent-chat-md table { border-collapse: collapse; margin: var(--eb-space-2) 0; font-size: var(--eb-text-sm); width: auto; max-width: 100%; }
  .agent-chat-md th, .agent-chat-md td { border: 1px solid var(--eb-border-default); padding: 4px 8px; text-align: left; overflow-wrap: break-word; word-break: normal; }
  /* Inline code opts into \`anywhere\` above; inside a cell that would collapse
     the column again, so a cell holding only \`\`PR\`\` is measured like text. */
  .agent-chat-md th :not(pre) > code, .agent-chat-md td :not(pre) > code { overflow-wrap: break-word; }
  /* \`text-align: left\` above is only the DEFAULT: markdown alignment syntax
     (\`:---:\` / \`---:\`) reaches the DOM as an inline \`style="text-align:…"\` —
     react-markdown rewrites the \`align\` attribute remark-gfm produces — and an
     inline style outranks this sheet, so a right-aligned numeric column keeps
     its alignment without a rule here. */
  .agent-chat-md th { background: var(--eb-bg-elevated); }
  .agent-chat-md blockquote { margin: var(--eb-space-2) 0; padding-left: var(--eb-space-3); border-left: 3px solid var(--eb-border-default); color: var(--eb-text-secondary); }
  .agent-chat-md h1, .agent-chat-md h2, .agent-chat-md h3, .agent-chat-md h4 { margin: var(--eb-space-3) 0 var(--eb-space-1); font-weight: var(--eb-font-semibold); }
  .agent-chat-md h1 { font-size: var(--eb-text-lg); }
  .agent-chat-md h2 { font-size: var(--eb-text-md); }
  .agent-chat-md h3 { font-size: var(--eb-text-md); color: var(--eb-text-secondary); }
  .agent-chat-md hr { border: none; border-top: 1px solid var(--eb-border-default); margin: var(--eb-space-3) 0; }
  .agent-chat-md a { color: var(--eb-accent-primary); }
`;

/**
 * Minimal rule reader for the stylesheet above — enough for the drift guards
 * and for nothing else: the CSS is authored as flat, comment-separated
 * single-line rules, so a rule is `<selectors> { <declarations> }`.
 *
 * @param {string} css
 * @returns {Array<{selectors: string[], declarations: Record<string,string>}>}
 */
export function parseRules(css) {
  const withoutComments = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(withoutComments)) !== null) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const declarations = {};
    for (const decl of m[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (prop) declarations[prop] = value;
    }
    rules.push({ selectors, declarations });
  }
  return rules;
}

/**
 * The declarations that apply to `selector`, in source order (later rules win,
 * which is how the flat single-origin sheet above is meant to be read).
 *
 * @param {string} css
 * @param {string} selector exact selector text, e.g. `.agent-chat-md td`
 */
export function declarationsFor(css, selector) {
  const out = {};
  for (const rule of parseRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    Object.assign(out, rule.declarations);
  }
  return out;
}

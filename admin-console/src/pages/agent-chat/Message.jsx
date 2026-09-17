import React, { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeShikiSync } from '../../components/shiki-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Bot, User, Zap } from 'lucide-react';
import { Link as LinkIcon } from 'lucide-react';
import LoopRecordCard from './LoopRecordCard';
import AskQuestionCard from './AskQuestionCard';
import { normalizeAskQuestion } from './ask-question-view.js';
import { MarkdownSafeBoundary, plainTextFallback } from '../../components/markdown-safe.js';
import { AGENT_CHAT_MD_CSS, MD_TABLE_WRAP_CLASS } from './markdown-css.js';
import {
  describeMessageAuthor,
  authorBadgeCss,
  AUTHOR_BADGE_CLASS,
  AUTHOR_NAME_CLASS,
} from './message-author.js';
import { parseMessageSegments, hasImageRef } from './chat-image-refs.js';
import ChatImageThumbnail from './chat-image-thumbnail.jsx';

/**
 * The actual react-markdown render. Memoized on `body` alone (#1676): the
 * remark-gfm + Shiki + rehype-sanitize pipeline is the expensive part, and its
 * output depends only on the source text — the dual Shiki themes are both emitted
 * and the active one is picked by CSS keyed off `<html data-theme>`, so a theme
 * switch never re-tokenizes. Wrapping this in React.memo means an unrelated
 * re-render of the surrounding bubble (e.g. a cross-panel hover) cannot re-run
 * Shiki.
 */
const MarkdownFull = React.memo(function MarkdownFull({ body }) {
  useAgentChatMdCss();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // IMPORTANT: rehype-sanitize must run *after* rehypeShikiSync so
      // the syntax-highlighting markup (spans with style + data-* attrs)
      // survives into the rendered output. The custom schema below
      // explicitly allow-lists those attributes.
      rehypePlugins={[
        rehypeShikiSync(),
        [rehypeSanitize, SANITIZE_SCHEMA],
      ]}
      components={MARKDOWN_COMPONENTS}
    >
      {body}
    </ReactMarkdown>
  );
});

const MarkdownGfmOnly = React.memo(function MarkdownGfmOnly({ body }) {
  useAgentChatMdCss();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
      components={MARKDOWN_COMPONENTS}
    >
      {body}
    </ReactMarkdown>
  );
});

/**
 * Defensive markdown wrapper — un-crashable by construction (#1974 follow-up).
 *
 * Three tiers, richest first: full pipeline → GFM-only → plain text. Each tier
 * is a `MarkdownSafeBoundary` (see `components/markdown-safe.js`) whose fallback
 * is the NEXT tier, and the innermost fallback is `plainTextFallback`, which
 * cannot throw. Because every boundary's fallback either can't throw or resolves
 * (through the nested boundary) to plain text, no boundary ever re-renders a
 * child it already saw throw.
 *
 * This is what the old `fallback:true` version got wrong: its GFM-only fallback
 * shares the same remark/rehype parse path as the full pipeline, so a message
 * whose parse throws (e.g. a `mdast-util-to-hast` "Cannot use 'in' operator …"
 * on one body) threw in BOTH tiers — and the boundary re-rendered the same
 * throwing fallback forever, hitting React error #185 (max update depth) and
 * taking down the whole Agent Chat page past the per-row `EventErrorBoundary`.
 * The plain-text floor makes that loop impossible for any content or dependency
 * version.
 *
 * The inner renders stay memoized on `body` (see above) so this wrapping never
 * re-runs the Shiki pipeline for unchanged text.
 */
export function SafeMarkdown({ body }) {
  return (
    <MarkdownSafeBoundary
      onError={(err) =>
        // eslint-disable-next-line no-console
        console.warn('[agent-chat] full markdown render failed; falling back to GFM only:', err?.message || err)}
      primary={() => <MarkdownFull body={body} />}
      fallback={() => (
        <MarkdownSafeBoundary
          onError={(err) =>
            // eslint-disable-next-line no-console
            console.warn('[agent-chat] GFM markdown render failed; falling back to plain text:', err?.message || err)}
          primary={() => <MarkdownGfmOnly body={body} />}
          fallback={() => plainTextFallback(body)}
        />
      )}
    />
  );
}

/**
 * Single chat bubble.
 *
 * - Right-aligned for the user, left-aligned for the agent.
 * - Body rendered with react-markdown + remark-gfm for tables/strikethrough/
 *   task-lists. Code blocks: rehypeShikiSync (synchronous Shiki wrapper) with
 *   dual themes; the active theme is selected by CSS rules in `tokens.css`
 *   keyed off the `<html data-theme>` attribute.
 * - Output is passed through `rehype-sanitize` with a permissive-but-bounded
 *   schema (style + class + data-theme allowed on `span`, `code`, `pre`).
 * - Long code (>40 lines) is wrapped in <details> for cleaner reading.
 * - `thinking` mode replaces the body with an animated three-dot ellipsis.
 * - A HUMAN message's `@<path>` image reference (upload token or user-typed)
 *   renders as an inline thumbnail in place of the raw token (#2146); an
 *   agent-authored message never gets this treatment (security boundary).
 *
 * Time format: 24 h hh:mm (locale `de-DE`); messages from previous days get
 * a `DD.MM., HH:MM` prefix.
 *
 * @param {object} props
 * @param {{event_id, sender, ts, body, isOptimistic?}} props.message
 * @param {string} props.agentUserId      The agent's userId — anything else is "user".
 * @param {boolean} [props.thinking]      Show typing-dots placeholder.
 * @param {string} [props.agentId]        This agent's id, for the inline-image-thumbnail fetch.
 */

/**
 * rehype-sanitize schema: defaultSchema (GitHub-flavoured), extended to keep
 * the `style`, `class`, and `data-theme` attributes produced by rehypeShikiSync.
 * Shiki uses `class` (not `className`) in its hast output, so both names are
 * listed. We deliberately do NOT widen this for arbitrary tags.
 */
const SHIKI_DATA_ATTRS = ['data-theme'];

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes || {}),
    span: [...((defaultSchema.attributes && defaultSchema.attributes.span) || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
    code: [...((defaultSchema.attributes && defaultSchema.attributes.code) || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
    pre:  [...((defaultSchema.attributes && defaultSchema.attributes.pre)  || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
  },
};

/**
 * Inject the shared `.agent-chat-md` stylesheet exactly once (#1676).
 *
 * Previously every Message/NoticeMessage/LoopRecordCard rendered its own
 * `<style>{AGENT_CHAT_MD_CSS}</style>`, so a long transcript accumulated N
 * duplicate style nodes. The CSS is identical everywhere, so a single
 * document-level node is enough; the hook is idempotent and safe to call from
 * every markdown render.
 */
let mdCssInjected = false;
export function ensureAgentChatMdCss() {
  if (mdCssInjected || typeof document === 'undefined') return;
  if (document.getElementById('agent-chat-md-css')) { mdCssInjected = true; return; }
  const el = document.createElement('style');
  el.id = 'agent-chat-md-css';
  el.textContent = AGENT_CHAT_MD_CSS;
  document.head.appendChild(el);
  mdCssInjected = true;
}

// Inject eagerly at module load (before the first bubble renders) to avoid a
// one-frame unstyled flash; the hook re-asserts it on mount as a fallback.
ensureAgentChatMdCss();

function useAgentChatMdCss() {
  useEffect(() => { ensureAgentChatMdCss(); }, []);
}

const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * Format a message timestamp:
 *   - same calendar day      → `HH:MM`
 *   - earlier day (any year) → `DD.MM., HH:MM`
 */
function formatMessageTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth() &&
    d.getDate()     === now.getDate();
  return sameDay ? TIME_FORMAT.format(d) : DATE_TIME_FORMAT.format(d);
}

const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Tables get their own scroll wrapper (#2048) so the table itself can stay a
  // real `display: table` box and size itself to its content. The wrapper is
  // what would scroll in the last-resort case where even the min-content width
  // does not fit the bubble — an ordinary wide table wraps instead. See
  // `markdown-css.js` for the layout rules this class carries.
  table: ({ node, ...props }) => (
    <div className={MD_TABLE_WRAP_CLASS}>
      <table {...props} />
    </div>
  ),
  // Long code blocks: wrap in <details>. We detect line count from the
  // rendered children (rehype-pretty-code outputs <code> > <span data-line>).
  pre: ({ node, ...props }) => <PreWithCollapse {...props} />,
  // Inline code: react-markdown v9 dropped the `inline` flag, so we detect
  // block code by the `language-*` class that GFM/remark adds to fenced
  // blocks (rehype-pretty-code preserves it). Anything else is inline.
  code: ({ node, className, children, ...rest }) => {
    const isBlock = typeof className === 'string' && /language-/.test(className);
    if (isBlock) {
      // Let rehype-pretty-code own the styling for block code.
      return <code className={className} {...rest}>{children}</code>;
    }
    return (
      <code
        className={className}
        style={{
          background: 'var(--eb-bg-elevated)',
          padding: '1px 6px',
          borderRadius: 'var(--eb-radius-sm)',
          fontSize: '0.9em',
          fontFamily: 'var(--eb-font-mono)',
          border: '1px solid var(--eb-border-default)',
        }}
        {...rest}
      >
        {children}
      </code>
    );
  },
};

function PreWithCollapse({ children, ...rest }) {
  // Inspect children to count rendered code lines. rehype-pretty-code emits
  // one <span data-line> per line inside <code>. We do a structural walk.
  const lineCount = countCodeLines(children);
  const wrapperStyle = {
    margin: 'var(--eb-space-2) 0',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    overflow: 'hidden',
    fontSize: 'var(--eb-text-sm)',
    maxWidth: '100%',
  };
  const preStyle = {
    margin: 0,
    padding: 'var(--eb-space-3)',
    overflowX: 'auto',
    fontFamily: 'var(--eb-font-mono)',
  };

  if (lineCount > 40) {
    return (
      <details style={wrapperStyle}>
        <summary style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          background: 'var(--eb-bg-elevated)',
          cursor: 'pointer',
          userSelect: 'none',
        }}>
          Show {lineCount} lines
        </summary>
        <pre {...rest} style={preStyle}>{children}</pre>
      </details>
    );
  }
  return (
    <div style={wrapperStyle}>
      <pre {...rest} style={preStyle}>{children}</pre>
    </div>
  );
}

/** Walk `children` tree and count Shiki line spans (class="line"). */
function countCodeLines(children) {
  let n = 0;
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    const props = node.props || {};
    // Shiki native: class="line" on each line span
    if (props.className === 'line' || props.class === 'line') n += 1;
    if (props.children) visit(props.children);
  };
  visit(children);
  return n;
}

function NoticeMessage({ message }) {
  const time = formatMessageTime(message.ts);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-1) 0',
    }}>
      <div style={{
        width: 28, height: 28,
        borderRadius: '50%',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        color: 'var(--eb-text-muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Zap size={14} />
      </div>
      <div style={{
        background: 'var(--eb-bg-surface)',
        borderLeft: '3px solid var(--eb-text-muted)',
        padding: 'var(--eb-space-1) var(--eb-space-3)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-muted)',
        maxWidth: 'min(720px, 75%)',
      }}>
        {/* Render markdown through the same sanitized pipeline as the normal
            chat bubble (SafeMarkdown = react-markdown + remark-gfm +
            rehype-pretty-code + rehype-sanitize), scoped to AEE trigger
            notices. The `.agent-chat-md` wrapper (styled below) keeps the card
            compact so inline code renders formatted without literal backticks
            while block-level markdown can't blow up the card. */}
        <div className="agent-chat-md">
          <SafeMarkdown body={message.body || ''} />
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', marginTop: 'var(--eb-space-0-5)', opacity: 0.7 }}>
          {message.sender} · {time}
        </div>
      </div>
    </div>
  );
}

function Message({
  message, agentUserId, thinking, onRelaunchLoop,
  onAnswerQuestion, questionAnswerable, questionAnswer,
  viewer, authorDirectory, agentId,
}) {
  // "Copy link" (#2310 AC7, nice-to-have): builds a `/chats/:agentId?msg=<event_id>`
  // deep-link and copies it, reusing the copy → clipboard → brief "Copied" idiom
  // already used elsewhere in Agent Chat (SessionInfoPopover). Declared before
  // any early return below so the hook order stays identical across renders
  // regardless of which message-kind branch a given row takes (rules-of-hooks) —
  // even though in practice a given `event_id`'s branch never changes between
  // renders of the same row.
  const [hovering, setHovering] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const copyMessageLink = useCallback(() => {
    if (!agentId || !message?.event_id || !navigator.clipboard) return;
    const url = `${window.location.origin}/chats/${encodeURIComponent(agentId)}?msg=${encodeURIComponent(message.event_id)}`;
    navigator.clipboard.writeText(url)
      .then(() => {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 1500);
      })
      .catch(() => { /* clipboard unavailable — no-op */ });
  }, [agentId, message?.event_id]);

  // Quick-reply question (#1663): an agent message that paused on AskUserQuestion
  // carries a structured `io.aee.ask-question` payload — render it as clickable
  // option controls beneath the question. The plain Markdown `body` is what
  // other Matrix clients show (AC8); we render the structured version here.
  if (message.sender === agentUserId && message['io.aee.ask-question']) {
    const q = normalizeAskQuestion(message['io.aee.ask-question']);
    if (q) {
      return (
        <AskQuestionCard
          question={q}
          answerable={!!questionAnswerable}
          answeredOptionId={questionAnswer?.answeredOptionId ?? null}
          answeredLabel={questionAnswer?.answeredLabel ?? null}
          answeredMulti={questionAnswer?.multiAnswers ?? null}
          onAnswer={(opt) => onAnswerQuestion?.(message.event_id, opt, q)}
          time={formatMessageTime(message.ts)}
        />
      );
    }
  }
  // Finished-loop record (#1231): a persistent, re-runnable card that replaces
  // the plain terminal-outcome bubble in the Admin Console. The full narrative
  // stays available as the message `body` (shown in the card's "Run details").
  if (message['io.aee.loop-record']) {
    return (
      <LoopRecordCard
        record={message['io.aee.loop-record']}
        onRelaunch={onRelaunchLoop}
        time={formatMessageTime(message.ts)}
        details={
          message.body
            ? <div className="agent-chat-md"><SafeMarkdown body={message.body} /></div>
            : null
        }
      />
    );
  }
  if (message.msgtype === 'm.notice' && message['io.aee.trigger']) {
    return <NoticeMessage message={message} />;
  }
  // Who wrote this, and which side it belongs on (#2065). The two answers come
  // from different inputs on purpose — the side depends on who is *looking*,
  // the badge never does — and both are decided in the pure `message-author.js`
  // so this stays a renderer (#651).
  const { isAgent, side, badge } = describeMessageAuthor({
    message, agentUserId, viewer, directory: authorDirectory,
  });
  const onRight = side === 'right';
  const align = onRight ? 'flex-end' : 'flex-start';
  // D9: a human message keeps the human bubble colour even when it is now on
  // the left, so it stays distinguishable from the agent's bubble.
  const bubbleColor = isAgent
    ? { bg: 'var(--eb-bg-surface)',  fg: 'var(--eb-text-primary)' }
    : { bg: 'var(--eb-bg-selected)', fg: 'var(--eb-text-primary)' };

  const time = formatMessageTime(message.ts);

  // Inline image thumbnails (#2146). HUMAN messages only — an agent-authored
  // `@<path>` is never parsed and triggers no fetch (AC4, the security
  // boundary: agent output must not be able to make the console fetch an
  // arbitrary workspace path). `imageSegments` is null unless the message is
  // both human-authored and actually carries an image reference, so the
  // overwhelmingly common case (no reference at all) falls straight back to
  // the original single `<SafeMarkdown>` render below, unchanged.
  const parsedSegments = (!isAgent && !thinking) ? parseMessageSegments(message.body || '') : null;
  const imageSegments = parsedSegments && hasImageRef(parsedSegments) ? parsedSegments : null;

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        display: 'flex',
        flexDirection: onRight ? 'row-reverse' : 'row',
        alignItems: 'flex-end',
        gap: 'var(--eb-space-2)',
        maxWidth: '100%',
      }}>
      <Avatar badge={badge} />

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align,
        maxWidth: 'min(720px, 75%)',
        minWidth: 0,
      }}>
        <div style={{
          background: bubbleColor.bg,
          color: bubbleColor.fg,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          borderRadius: 'var(--eb-radius-lg)',
          border: '1px solid var(--eb-border-default)',
          // Per-user chat font size (#1437): the transcript sets --chat-font-size
          // on its scroll container; falls back to the 14px token when this
          // bubble is rendered outside the chat view.
          fontSize: 'var(--chat-font-size, var(--eb-text-md))',
          lineHeight: 1.5,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          opacity: message.isOptimistic ? 0.7 : 1,
          maxWidth: '100%',
        }}>
          {thinking ? (
            <ThinkingDots />
          ) : imageSegments ? (
            <div className="agent-chat-md">
              {imageSegments.map((seg, i) => (
                seg.type === 'ref'
                  ? <ChatImageThumbnail key={i} agentId={agentId} path={seg.path} raw={seg.raw} />
                  : <SafeMarkdown key={i} body={seg.value} />
              ))}
            </div>
          ) : (
            <div className="agent-chat-md">
              <SafeMarkdown body={message.body || ''} />
            </div>
          )}
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          marginTop: 'var(--eb-space-0-5)',
          padding: '0 var(--eb-space-1)',
        }}>
          <span>{thinking ? 'thinking…' : (message.isOptimistic ? `${time} · sending…` : time)}</span>
          {/* #2310 AC7: only a confirmed (non-optimistic, non-thinking) message
              has a stable event_id worth sharing. Fades in on hover so the
              timestamp row stays uncluttered otherwise; "Copied" pins it
              visible until the confirmation itself fades. */}
          {!thinking && !message.isOptimistic && (
            <button
              type="button"
              onClick={copyMessageLink}
              title="Copy link to this message"
              aria-label="Copy link to this message"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 0,
                border: 'none',
                background: 'none',
                color: 'inherit',
                fontSize: 'inherit',
                fontFamily: 'inherit',
                cursor: 'pointer',
                opacity: hovering || linkCopied ? 1 : 0,
                transition: 'opacity 0.1s',
              }}
            >
              <LinkIcon size={10} />
              {linkCopied ? 'Copied' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized (#1676): a cross-panel hover changes shared state in the parent,
 * which re-renders ChatPanel; without this every bubble would re-render (and
 * re-run Shiki). The props are a stable message object, a stable agent id, and
 * a stable (useCallback'd) relaunch handler, so an unrelated hover skips the
 * whole bubble.
 */
export default React.memo(Message);

/**
 * The 28 px round avatar in front of a bubble (#2065).
 *
 * Three kinds, decided by `describeMessageAuthor`:
 *   - `bot`       — the agent (D4, unchanged: bot glyph, no name, no hover);
 *   - `initials`  — a human whose author was recorded: their initials, with the
 *                   full name revealed on hover *and* on keyboard focus (AC8);
 *   - `anonymous` — a message with no usable author (all pre-#2065 history, a
 *                   third-party Matrix client): a neutral person glyph. Never
 *                   letters, never a name — and never the old `?` placeholder.
 *
 * The circle keeps fixed 28 × 28 px with `overflow: hidden`, so no name — an
 * emoji, a CJK glyph, a stacked accent — can change the row's geometry (AC9),
 * and the name reveal is positioned out of flow by `authorBadgeCss()`.
 */
function Avatar({ badge }) {
  const isAgent = badge.kind === 'bot';
  const named = badge.kind === 'initials';
  useEffect(() => { ensureAuthorBadgeCss(); }, []);

  const circle = (
    <div style={{
      width: 28, height: 28,
      borderRadius: '50%',
      background: isAgent ? 'var(--eb-accent-muted)' : 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      color: isAgent ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      overflow: 'hidden',
      lineHeight: 1,
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-semibold)',
    }}>
      {isAgent ? <Bot size={16} />
        : named ? <span style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>{badge.initials}</span>
          : <User size={16} aria-label="Unknown sender" />}
    </div>
  );

  if (!named) return <div className={AUTHOR_BADGE_CLASS}>{circle}</div>;

  return (
    <div
      className={AUTHOR_BADGE_CLASS}
      // Focusable so the name is reachable by keyboard, not only by pointer:
      // no browser shows a `title` tooltip on focus, hence the real element.
      tabIndex={0}
      title={badge.name}
      aria-label={`Sent by ${badge.name}`}
    >
      {circle}
      <span className={AUTHOR_NAME_CLASS} aria-hidden="true">{badge.name}</span>
    </div>
  );
}

// The author-badge stylesheet is injected once at the document level (mirrors
// ensureAgentChatMdCss / ensureThinkingDotsCss) so every transcript that mounts
// a bubble gets the name reveal, without a <style> per message.
let authorBadgeCssInjected = false;
export function ensureAuthorBadgeCss() {
  if (authorBadgeCssInjected || typeof document === 'undefined') return;
  if (document.getElementById('agent-chat-author-badge-css')) { authorBadgeCssInjected = true; return; }
  const el = document.createElement('style');
  el.id = 'agent-chat-author-badge-css';
  el.textContent = authorBadgeCss();
  document.head.appendChild(el);
  authorBadgeCssInjected = true;
}

ensureAuthorBadgeCss();

// The `@keyframes dotPulse` used by ThinkingDots is injected once at the
// document level (mirrors ensureAgentChatMdCss) so the shared indicator works
// anywhere it is mounted — Agent Chat (ChatPanel also declares dotPulse locally,
// a harmless duplicate) and the Help Chat (HelperChatPanel, #1779), which has no
// page-scoped <style>. A `prefers-reduced-motion` guard freezes the dots at a
// legible opacity for users who opt out of motion, while keeping the accessible
// label intact.
let thinkingDotsCssInjected = false;
export function ensureThinkingDotsCss() {
  if (thinkingDotsCssInjected || typeof document === 'undefined') return;
  if (document.getElementById('agent-chat-thinking-dots-css')) { thinkingDotsCssInjected = true; return; }
  const el = document.createElement('style');
  el.id = 'agent-chat-thinking-dots-css';
  el.textContent = `
    @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .agent-chat-thinking-dot { animation: none !important; opacity: 0.55 !important; }
    }
  `;
  document.head.appendChild(el);
  thinkingDotsCssInjected = true;
}

ensureThinkingDotsCss();

export function ThinkingDots() {
  useEffect(() => { ensureThinkingDotsCss(); }, []);
  const dotStyle = (delay) => ({
    display: 'inline-block',
    width: 6, height: 6,
    margin: '0 2px',
    borderRadius: '50%',
    background: 'var(--eb-text-secondary)',
    animation: `dotPulse 1.4s infinite ease-in-out`,
    animationDelay: delay,
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 0' }} aria-label="Thinking" role="status">
      <span className="agent-chat-thinking-dot" style={dotStyle('0s')} />
      <span className="agent-chat-thinking-dot" style={dotStyle('0.2s')} />
      <span className="agent-chat-thinking-dot" style={dotStyle('0.4s')} />
    </span>
  );
}

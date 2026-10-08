import React, { useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeShikiSync, subscribeShiki, shikiVersion } from './shiki-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { MarkdownSafeBoundary, plainTextFallback } from './markdown-safe.js';

/*
 * SkillMarkdown — the shared "rendered SKILL.md" renderer.
 *
 * Extracted from SkillsRegistry so the Skills Registry viewer and the Knowledge
 * page's skill inspector drawer (#774) render skill content identically instead
 * of keeping two divergent copies of the sanitize schema + pretty-code pipeline.
 * Same pipeline as the chat UI: remark-gfm → rehypeShikiSync → rehype-sanitize
 * (sanitize runs LAST so the syntax-highlight markup survives).
 *
 * Un-crashable by construction (#1974 follow-up): three tiers, richest first —
 * full pipeline → GFM-only → plain text — each a `MarkdownSafeBoundary` whose
 * fallback is the next tier, and the innermost fallback (`plainTextFallback`)
 * cannot throw. This replaces the old sticky `fallback:true` boundary, whose
 * GFM-only fallback shared the same remark/rehype parse path as the full
 * pipeline: a body that threw in BOTH tiers looped the boundary into React
 * error #185. Same fix, same shared primitive as chat's `SafeMarkdown`.
 */

const SHIKI_DATA_ATTRS = ['data-theme'];

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes || {}),
    span: [...((defaultSchema.attributes?.span) || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
    code: [...((defaultSchema.attributes?.code) || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
    pre:  [...((defaultSchema.attributes?.pre)  || []), 'style', 'class', 'className', ...SHIKI_DATA_ATTRS],
  },
};

const MD_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  code: ({ node, className, children, ...rest }) => {
    const isBlock = typeof className === 'string' && /language-/.test(className);
    if (isBlock) return <code className={className} {...rest}>{children}</code>;
    return (
      <code className={className} style={{
        background: 'var(--eb-bg-elevated)', padding: '1px 6px',
        borderRadius: 'var(--eb-radius-sm)', fontSize: '0.9em',
        fontFamily: 'var(--eb-font-mono)', border: '1px solid var(--eb-border-default)',
      }} {...rest}>{children}</code>
    );
  },
};

function SkillMarkdownRender({ content, withShiki }) {
  // Re-render when the lazily loaded highlighter or a grammar is ready (#2918),
  // so plain code blocks upgrade to highlighted ones.
  useSyncExternalStore(subscribeShiki, shikiVersion);
  const rehypePlugins = withShiki
    ? [rehypeShikiSync(), [rehypeSanitize, SANITIZE_SCHEMA]]
    : [[rehypeSanitize, SANITIZE_SCHEMA]];
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={MD_COMPONENTS}>
      {content || '*(empty)*'}
    </ReactMarkdown>
  );
}

export default function SkillMarkdown({ content }) {
  return (
    <div className="skill-md">
      <MarkdownSafeBoundary
        onError={(err) =>
          // eslint-disable-next-line no-console
          console.warn('[skill-md] full markdown render failed; falling back to GFM only:', err?.message || err)}
        primary={() => <SkillMarkdownRender content={content} withShiki />}
        fallback={() => (
          <MarkdownSafeBoundary
            onError={(err) =>
              // eslint-disable-next-line no-console
              console.warn('[skill-md] GFM markdown render failed; falling back to plain text:', err?.message || err)}
            primary={() => <SkillMarkdownRender content={content} withShiki={false} />}
            fallback={() => plainTextFallback(content || '(empty)')}
          />
        )}
      />
      <style>{`
          .skill-md p { margin: 0; }
          .skill-md p + p { margin-top: var(--eb-space-2); }
          .skill-md ul, .skill-md ol { padding-left: 1.4em; margin: var(--eb-space-1) 0; }
          .skill-md li { margin: 2px 0; }
          .skill-md table { border-collapse: collapse; margin: var(--eb-space-2) 0; font-size: var(--eb-text-sm); display: block; max-width: 100%; overflow-x: auto; }
          .skill-md th, .skill-md td { border: 1px solid var(--eb-border-default); padding: 4px 8px; }
          .skill-md th { background: var(--eb-bg-elevated); }
          .skill-md blockquote { margin: var(--eb-space-2) 0; padding-left: var(--eb-space-3); border-left: 3px solid var(--eb-border-default); color: var(--eb-text-secondary); }
          .skill-md h1, .skill-md h2, .skill-md h3, .skill-md h4 { margin: var(--eb-space-3) 0 var(--eb-space-1); font-weight: var(--eb-font-semibold); }
          .skill-md h1 { font-size: var(--eb-text-lg); }
          .skill-md h2 { font-size: var(--eb-text-md); }
          .skill-md h3 { font-size: var(--eb-text-md); color: var(--eb-text-secondary); }
          .skill-md hr { border: none; border-top: 1px solid var(--eb-border-default); margin: var(--eb-space-3) 0; }
          .skill-md a { color: var(--eb-accent-primary); }
          .skill-md pre { margin: var(--eb-space-2) 0; border: 1px solid var(--eb-border-default); border-radius: var(--eb-radius-md); overflow-x: auto; padding: var(--eb-space-3); font-family: var(--eb-font-mono); font-size: var(--eb-text-sm); }
        `}</style>
    </div>
  );
}

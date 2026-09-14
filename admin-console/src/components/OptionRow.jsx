import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';

// Shared "pick one or more from a list" row shell (#2269): the one unifying
// visual pattern behind Skills, Plugins and MCP servers, which previously each
// invented their own row style (dense ellipsis list / spacious always-on
// paragraph card / bare bordered strip).
//
// A row is: an always-visible `header` (the selection control — checkbox or
// selects — plus name/badges), an optional one-line truncated `summary`, and
// an optional per-row expand toggle that reveals `expandedContent` inline
// (D3: an accordion that grows the row in place, not a separate panel).
// Collapsed by default; the toggle only renders when there is something to
// expand into, so a row with nothing more to say stays a single line.
export default function OptionRow({
  header,
  summary,
  expandedContent = null,
  tinted = false,
  disabled = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const showExpand = expandedContent != null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-1)',
        padding: 'var(--eb-space-1) var(--eb-space-2)',
        borderRadius: 'var(--eb-radius-sm)',
        background: tinted ? 'var(--eb-bg-elevated)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>{header}</div>
        {showExpand && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            disabled={disabled}
            aria-expanded={expanded}
            aria-label={expanded ? 'Show less' : 'Show more'}
            title={expanded ? 'Show less' : 'Show more'}
            style={{
              flex: '0 0 auto',
              background: 'none',
              border: 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              color: 'var(--eb-text-muted)',
              padding: 2,
              marginTop: 1,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ChevronRight
              size={14}
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
            />
          </button>
        )}
      </div>
      {summary && (
        <div
          style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginLeft: 'var(--eb-space-2)',
          }}
        >
          {summary}
        </div>
      )}
      {showExpand && expanded && (
        <div
          style={{
            marginLeft: 'var(--eb-space-2)',
            marginTop: 'var(--eb-space-1)',
            paddingTop: 'var(--eb-space-2)',
            borderTop: '1px dashed var(--eb-border-default)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-secondary)',
          }}
        >
          {expandedContent}
        </div>
      )}
    </div>
  );
}

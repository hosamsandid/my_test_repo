import React from 'react';
import { HelpCircle } from 'lucide-react';
import { useLocation } from 'react-router';
import { useHelperChat } from '../context/HelperChatContext';

// PageHelpButton (#1873) — the shared "?" affordance a page drops next to its
// title. Clicking it opens the Help panel on the page-aware "This page" face for
// the current route (the panel resolves the route → its topic, or the Overview
// fallback when the route has none). The big "what this page is" boxes go away
// during Phase-3 extraction; this small control replaces them.
//
// An optional `section` (#1972) names the chapter of the page's topic to land
// on — the slug of its heading — so a "?" placed next to one surface of a busy
// page opens the explanation of *that* surface rather than the top of a long
// topic. Omit it and the behaviour is exactly as before; a slug that matches no
// heading also just renders the topic from the top, so a chapter-less surface
// can never produce an empty or broken "?".
//
// Deliberately markup-only (no decisions of its own) — it just wires the click
// to useHelperChat().openHelpFor(); the JSX stays uncovered per the #651
// convention.
export default function PageHelpButton({ label = 'Help for this page', size = 16, style, section = '' }) {
  const { openHelpFor } = useHelperChat();
  const { pathname } = useLocation();
  return (
    <button
      type="button"
      onClick={() => openHelpFor(pathname, { section })}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        color: 'var(--eb-text-secondary)',
        cursor: 'pointer',
        padding: 'var(--eb-space-1)',
        borderRadius: 'var(--eb-radius-md)',
        lineHeight: 0,
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
    >
      <HelpCircle size={size} />
    </button>
  );
}

import React from 'react';
import { relativeWhen, absoluteWhen } from './format-when.js';

/**
 * WhenCell — renders a stored ISO timestamp as a short relative phrase
 * ("2 days ago") with the exact local time on hover.
 *
 * Falls back to the exact time when a relative phrase can't be formed, and to
 * an em dash when the value is missing/invalid. Shared by the
 * credential/connection tables so an "Added" cell reads the same friendly way
 * everywhere. All formatting logic lives in the pure, unit-tested
 * ./format-when.js; this component only supplies "now" and the tooltip markup.
 */
export default function WhenCell({ iso }) {
  const absolute = absoluteWhen(iso);
  if (!absolute) return '—';
  const relative = relativeWhen(iso, Date.now());
  return <span title={absolute}>{relative || absolute}</span>;
}

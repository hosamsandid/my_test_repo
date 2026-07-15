'use strict';

// Structured harvest block (Auto-learning A, issue #602).
//
// A per-invocation agent run ends its reply with a fenced ```knowledge block —
// one JSON object per line, `{ "kind": "fact|convention|entity", "text": "…" }`
// — and the RUNTIME (not the model, voluntarily) records each line in the
// shared KB via `knowledge add`. This module is the deterministic parser for
// that block: emitting lessons as text is the model's native mode, so we stop
// depending on it choosing to run a CLI mid-task.
//
// It is deliberately PURE — no fs, no subprocess — so it is unit-testable
// without booting anything (repo convention: test pure helper cores only).
//
// IMPORTANT: this module is mirrored byte-for-byte by parse_harvest_block() /
// strip_harvest_block() in agent-image/scripts/agent-entrypoint.py (the live
// runtime — the only side that actually harvests at run end). The same
// two-sided contract as knowledge-digest.js <-> build_knowledge_digest(): given
// the same reply text, JS and Python MUST return the identical entries and the
// identical stripped text. If you change one side, change the other in the same
// commit; the shared golden fixture orchestrator/harvest-block.fixture.json is
// asserted by both test suites.
//
// Robustness is a hard requirement (AC): a missing or malformed block yields
// zero entries and never throws — a run that learned nothing must produce no KB
// entry and no error.

const KINDS = new Set(['fact', 'entity', 'convention']);

// The info string after a fence's opening backticks, trimmed — or null if the
// line is not a ``` fence. `"```knowledge"` -> `"knowledge"`; `"```"` -> `""`
// (a closing fence); `"```json"` -> `"json"` (an unrelated fence, ignored).
function fenceLabel(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s.startsWith('```')) return null;
  return s.slice(3).trim();
}

const isOpenFence = (line) => fenceLabel(line) === 'knowledge';
const isCloseFence = (line) => fenceLabel(line) === '';

// Locate the LAST ```knowledge block in the text (the reply "ends with" it, so
// an earlier example the model may have echoed never wins). Returns
// { start, end } line indices — `start` is the opening-fence line, `end` is the
// exclusive line index one past the closing fence (or the number of lines when
// the block runs to EOF with no closing fence). Returns null if there is no
// ```knowledge block.
function locateBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isOpenFence(lines[i])) start = i;
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isCloseFence(lines[i])) { end = i + 1; break; }
  }
  return { start, end };
}

// Parse the fenced ```knowledge block into a list of { kind, text } lessons.
// Every line inside the block that is a JSON object with a valid `kind` and a
// non-empty string `text` becomes one entry; blank lines and any malformed /
// invalid line are silently skipped. No block -> [].
function parseHarvestBlock(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  const loc = locateBlock(lines);
  if (!loc) return [];
  const out = [];
  for (let i = loc.start + 1; i < loc.end; i += 1) {
    const raw = lines[i];
    if (isCloseFence(raw)) break;
    const line = raw.trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const kind = obj.kind;
    if (!KINDS.has(kind)) continue;
    if (typeof obj.text !== 'string') continue;
    const trimmed = obj.text.trim();
    if (trimmed === '') continue;
    out.push({ kind, text: trimmed });
  }
  return out;
}

// Return the reply with its ```knowledge block removed, so the user never sees
// the machine block. Trailing whitespace left by the removal is trimmed. No
// block -> the text is returned unchanged.
function stripHarvestBlock(text) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  const lines = text.split('\n');
  const loc = locateBlock(lines);
  if (!loc) return text;
  const kept = lines.slice(0, loc.start).concat(lines.slice(loc.end));
  return kept.join('\n').replace(/\s+$/, '');
}

module.exports = {
  KINDS,
  parseHarvestBlock,
  stripHarvestBlock,
};

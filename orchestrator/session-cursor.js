'use strict';

// Pure reconciliation for the session-log byte-cursor push (#185).
//
// Agents POST { roomId, baseOffset, dataB64 } to /internal/agents/:id/session-
// events, where the bytes are the raw tail of their local sessions/<roomId>.jsonl
// from `baseOffset`. The control-plane copy must stay BYTE-IDENTICAL and same-order
// so the admin SSE viewer's byte-cursor (?since=<byte>) keeps resolving — this is
// "the one sharp edge". This function owns the reconciliation arithmetic so it can
// be unit-tested in isolation from the HTTP handler.
//
// Inputs:
//   baseOffset — the agent's claimed start offset (sanitized: NaN/Inf/negative → 0)
//   cur        — the current size of the control-plane file (0 if absent)
//   dataLen    — number of bytes the agent is sending
//
// Returns one of:
//   { ok: false, gap: true, expected }                    — base > cur: control is
//       behind the agent (lost append). Don't write; tell the agent to resend from
//       `expected` (= cur). The agent rewinds against its local file (source truth).
//   { ok: true, gap: false, sliceFrom, appendLen, offset } — base <= cur: append the
//       non-overlapping tail. `sliceFrom` is where to start slicing the sent buffer
//       (= overlapping bytes we already have); `appendLen` is how many bytes that
//       leaves (0 on a fully-stale retry → append nothing); `offset` is the new
//       acked end offset the agent should advance to (= base + dataLen).
//
//   base == cur          → fresh append (sliceFrom 0, append everything)
//   base <  cur (retry)  → append only the part beyond cur (lost-ACK re-send)
//   base >  cur (gap)    → ask the agent to resend from cur
function reconcileSessionAppend(baseOffset, cur, dataLen) {
  // Sanitize baseOffset exactly as the endpoint historically did (only
  // non-finite → 0; a finite value, even a nonsensical negative, passes through)
  // so this extraction stays byte-for-byte behaviour-identical to the inline code.
  const base = Number.isFinite(Number(baseOffset)) ? Number(baseOffset) : 0;
  const size = Number.isFinite(Number(cur)) && Number(cur) > 0 ? Number(cur) : 0;
  const len = Number.isFinite(Number(dataLen)) && Number(dataLen) > 0
    ? Number(dataLen) : 0;

  if (base > size) {
    return { ok: false, gap: true, expected: size };
  }
  const overlap = size - base;             // bytes re-sent that we already have
  const sliceFrom = Math.min(overlap, len); // never slice past the buffer end
  const appendLen = len - sliceFrom;        // 0 when the retry is fully stale
  return { ok: true, gap: false, sliceFrom, appendLen, offset: base + len };
}

module.exports = { reconcileSessionAppend };

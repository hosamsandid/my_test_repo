// Pure line-level diff for the Session Log's Edit/Write tool-call renderer (#2189).
//
// `computeLineDiff(oldString, newString)` returns an ordered list of rows
// `{ type: 'context'|'add'|'del', oldLineNo, newLineNo, text }` ready for a
// red/green unified-diff render with a line-number gutter. Common prefix/suffix
// lines are trimmed off before running the diff proper (Myers' O(ND) shortest
// edit script over the two arrays of lines) — an Edit's old/new strings are
// almost always a small localized change inside a much larger shared context,
// so this keeps the algorithm's actual working set tiny regardless of how long
// the surrounding string is.

function splitLines(s) {
  if (typeof s !== 'string' || s === '') return [];
  return s.split('\n');
}

// Myers diff over two arrays of lines. Returns an ordered list of
// { type: 'context'|'add'|'del', line } operations transforming `a` into `b`.
function myersDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const trace = [];
  let v = new Map([[1, 0]]);

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v);
    const nextV = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      nextV.set(k, x);
      if (x >= n && y >= m) {
        v = nextV;
        break outer;
      }
    }
    v = nextV;
  }

  // Backtrack through the trace to recover the operation sequence.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && (vPrev.get(k - 1) ?? -Infinity) < (vPrev.get(k + 1) ?? -Infinity))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'context', line: a[x - 1] });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', line: b[y - 1] });
        y--;
      } else {
        ops.push({ type: 'del', line: a[x - 1] });
        x--;
      }
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Compute a line-level diff between two strings.
 * Returns `{ rows, added, removed }` — `rows` are ready for a red/green
 * render with a line-number gutter; `added`/`removed` are line counts.
 */
export function computeLineDiff(oldString, newString) {
  const oldLines = splitLines(oldString);
  const newLines = splitLines(newString);

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const midOps = myersDiff(midOld, midNew);

  const rows = [];
  let oldLineNo = 1;
  let newLineNo = 1;
  let added = 0;
  let removed = 0;

  for (let i = 0; i < prefix; i++) {
    rows.push({ type: 'context', oldLineNo, newLineNo, text: oldLines[i] });
    oldLineNo++; newLineNo++;
  }
  for (const op of midOps) {
    if (op.type === 'context') {
      rows.push({ type: 'context', oldLineNo, newLineNo, text: op.line });
      oldLineNo++; newLineNo++;
    } else if (op.type === 'del') {
      rows.push({ type: 'del', oldLineNo, newLineNo: null, text: op.line });
      oldLineNo++;
      removed++;
    } else {
      rows.push({ type: 'add', oldLineNo: null, newLineNo, text: op.line });
      newLineNo++;
      added++;
    }
  }
  for (let i = 0; i < suffix; i++) {
    const idx = oldLines.length - suffix + i;
    rows.push({ type: 'context', oldLineNo, newLineNo, text: oldLines[idx] });
    oldLineNo++; newLineNo++;
  }

  return { rows, added, removed };
}

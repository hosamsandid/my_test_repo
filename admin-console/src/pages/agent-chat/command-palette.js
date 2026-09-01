// Pure decision logic for the Agent-Chat slash-command palette (#1797).
//
// The composer (MessageInput.jsx) is a thin renderer over these helpers, so the
// "is this a command context / how do we filter / what gets inserted / where
// does the caret land / how does keyboard nav move" decisions stay dependency-
// free and `node --test`-covered (the repo's pure-module convention, #651).
//
// Command list shape (from `GET /api/agents/:id/commands`, #1796/#1797):
//   { command, name, namespace, skill, invocation, description }
// `invocation` already carries the leading slash (`/spec-kit:plan` or `/deploy`).

/**
 * The palette is open only when the WHOLE composer value is a single leading
 * `/token` — i.e. `/` as the first character and no whitespace has been typed
 * yet. Returns the filter query (the text after `/`, may be '') when open, else
 * null. This is what makes:
 *   - `/` (first char)      → open, query ''
 *   - `/spec`               → open, query 'spec'
 *   - `/spec-kit:plan foo`  → closed (a space started the arguments)
 *   - `hello /foo`          → closed (`/` is mid-message, not the first char)
 */
export function commandQuery(value) {
  const s = String(value == null ? '' : value);
  const m = /^\/(\S*)$/.exec(s);
  return m ? m[1] : null;
}

/**
 * Case-insensitive filter + ranking. Matches the query against the command's
 * invocation-without-slash (`namespace:name` or `name`), its bare name and its
 * description. Prefix matches on the command token rank above the rest; ties keep
 * alphabetical order (the list already arrives sorted by command). An empty query
 * returns every command (the palette opened on a bare `/`).
 */
export function filterCommands(commands, query) {
  const list = Array.isArray(commands) ? commands.slice() : [];
  const q = String(query == null ? '' : query).toLowerCase().trim();
  if (!q) return list;
  const scored = [];
  for (const c of list) {
    if (!c) continue;
    const token = String(c.command || c.name || '').toLowerCase();
    const name = String(c.name || '').toLowerCase();
    const desc = String(c.description || '').toLowerCase();
    let rank;
    if (token.startsWith(q) || name.startsWith(q)) rank = 0; // prefix — strongest
    else if (token.includes(q)) rank = 1;                    // substring in token
    else if (desc.includes(q)) rank = 2;                     // description only
    else continue;
    scored.push({ c, rank });
  }
  // Stable sort by rank; the input order (already command-sorted) breaks ties.
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((s) => s.c);
}

/**
 * The textarea value + caret position after the user picks a command. Inserts
 * `<invocation> ` (with a trailing space) so the caret lands ready for arguments
 * (AC3). Falls back to building the invocation from the command token if the row
 * somehow lacks one.
 */
export function commandInsertion(command) {
  const invocation = command && command.invocation
    ? String(command.invocation)
    : `/${command && command.command ? command.command : ''}`;
  const value = `${invocation} `;
  return { value, caret: value.length };
}

/**
 * Wrap-around navigation for the highlighted row. `delta` is +1 (Down) or -1
 * (Up). Returns 0 for an empty list so callers can index safely.
 */
export function nextIndex(current, delta, length) {
  const n = Number(length) || 0;
  if (n <= 0) return 0;
  const cur = Number.isInteger(current) ? current : 0;
  return ((cur + delta) % n + n) % n;
}

'use strict';

// Secret hygiene for compose tool output. Pure so it's unit-testable in
// isolation (mirrors owner-scope.js / podman-token.js).
//
// podman-compose's own verbose logging echoes every `-e KEY=VALUE` (or
// `--env KEY=VALUE`) flag it passes to `podman run` straight into the
// stdout/stderr that podman-mcp's compose_up/compose_down/compose_logs tools
// return VERBATIM to the calling agent — so a secret an agent passed as an
// env var into a compose_up'd service (e.g. reusing its own
// ANTHROPIC_AUTH_TOKEN to wire up a nested service) would get echoed right
// back into that same agent's own context/session log. This is a hygiene
// pass, not a security boundary (the owner-label scoping is that): mask the
// VALUE half of every printed `-e`/`--env` flag, keep the KEY visible so the
// output stays useful for debugging which variables were set.
//
// podman-compose (podman_compose.py, `PodmanCmd.run`/`exec`) logs the
// command it is about to exec via `" ".join(cmd_ls)` — a plain space-joined,
// UNQUOTED line (never a shell-quoted `'KEY=VALUE'` token) — so a value is
// matched up to the next whitespace. Real secrets (tokens, API keys) never
// contain whitespace, so this covers the actual observed format without
// trying to be a general shell-command parser.
function maskEnvValues(output) {
  if (!output) return output;
  return String(output).replace(
    /(--env|-e)(=|\s+)([^\s=]+)=(\S+)/g,
    (_match, flag, sep, key) => `${flag}${sep}${key}=***`,
  );
}

// Same masking, for callers that build an Error message from possibly-empty
// process output and want to fall back to a generic message only when there
// was genuinely nothing to report — never because masking incidentally
// shortened real content. maskEnvValues() only ever substitutes a matched
// VALUE with the literal `***` (it never deletes text), so it cannot turn a
// non-empty string into an empty one; the fallback therefore only fires on a
// genuinely empty `raw`, exactly as intended.
function maskEnvValuesOrDefault(raw, fallback) {
  return maskEnvValues(raw) || fallback;
}

module.exports = { maskEnvValues, maskEnvValuesOrDefault };

'use strict';

// ─── Broker SDK: secret masking (plugin system Phase 4, #1520) ───────────────
//
// Response redaction (§4.9, and the §5 "secret leakage via verbose backend
// output" failure mode → a contract requirement). Generalises podman-mcp
// `mask-env.js`: backends echo credentials in verbose output, so a broker must
// mask them before returning output to the calling agent. This is a hygiene
// pass, not a security boundary (owner-label scoping is that).
//
// Two masking sources, both applied:
//   1. Explicit `secrets` — any known secret VALUE (a token the broker holds or
//      that the caller passed in) is redacted wherever it appears. This is the
//      SDK generalisation the concept names: `maskSecrets(output, secrets)`.
//   2. The proven env-flag pass from mask-env.js — the VALUE half of every
//      printed `-e KEY=VALUE` / `--env KEY=VALUE` flag (podman-compose logs the
//      exec'd command as a plain space-joined, UNQUOTED line, so a value runs
//      up to the next whitespace; real secrets never contain whitespace).
//
// Pure so it's unit-testable in isolation (mirrors scope-filter.js).

const REDACTION = '***';

// Escape a literal string for use inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mask the VALUE half of every printed `-e`/`--env KEY=VALUE` flag, keeping the
// KEY visible so the output stays useful for debugging which vars were set.
function maskEnvValues(output) {
  if (!output) return output;
  return String(output).replace(
    /(--env|-e)(=|\s+)([^\s=]+)=(\S+)/g,
    (_match, flag, sep, key) => `${flag}${sep}${key}=${REDACTION}`,
  );
}

// Redact each known secret value wherever it appears in the output. Only
// non-empty string secrets are considered (a blank/undefined secret must never
// turn into a mask that eats every character). Longest-first so a secret that
// is a prefix of another doesn't leave the tail of the longer one exposed.
function maskSecretValues(output, secrets) {
  if (!output) return output;
  const values = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((v) => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = String(output);
  for (const v of values) {
    out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTION);
  }
  return out;
}

// Full redaction pass a broker runs over any output it returns verbatim:
// explicit secrets first, then the env-flag pass. `secrets` is optional so a
// broker with no known secrets still gets the env-flag hygiene.
function maskSecrets(output, secrets = []) {
  return maskEnvValues(maskSecretValues(output, secrets));
}

// Same masking, for callers that build an Error message from possibly-empty
// process output and want to fall back to a generic message only when there was
// genuinely nothing to report — never because masking incidentally shortened
// real content. maskSecrets only ever substitutes a matched value with the
// literal `***` (it never deletes text), so it cannot turn a non-empty string
// into an empty one; the fallback therefore fires only on a genuinely empty
// `raw`, exactly as intended.
function maskSecretsOrDefault(raw, fallback, secrets = []) {
  // Both brokers that got this call wrong passed the SECRET as `fallback` —
  // the shape `maskSecretsOrDefault(output, [token])` reads plausibly and is
  // catastrophic: nothing is masked (secrets defaults to []), and any empty
  // `raw` returns the credential verbatim to the caller. A non-string fallback
  // is never legitimate, so refuse it loudly rather than leak quietly.
  if (typeof fallback !== 'string') {
    throw new TypeError(
      'maskSecretsOrDefault: fallback must be a string — secrets belong in the third argument',
    );
  }
  return maskSecrets(raw, secrets) || fallback;
}

module.exports = {
  REDACTION,
  maskEnvValues,
  maskSecretValues,
  maskSecrets,
  maskSecretsOrDefault,
};

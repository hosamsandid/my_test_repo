"use strict";

// Source-reading guard for the #2562 credential-grant route in orchestrator.js
// (which cannot be required in a unit test — the pool-control-wiring.test.js
// technique). The route returns a person's Jira secret, so it must accept ONLY
// the broker's reserved `_grant-<scopeId>` token: the plain team scope token is
// held by every granted agent in its workspace (review B1, AC9/AC10).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

test("the grant route derives its scope only from a reserved grant token", () => {
  const start = SRC.indexOf("req.url === '/internal/plugin-credential-grant'");
  assert.ok(start > 0, "route not found — this guard needs re-pointing");
  const route = SRC.slice(start, SRC.indexOf("readBody(req)", start));
  assert.match(route, /const scopeId = scopeIdFromGrantScope\(scope\.scopeId\);/);
  assert.match(route, /if \(!scopeId\) \{\s*sendJson\(res, 403, \{ ok: false, code: 'grant-token-required' \}\);\s*return;/);
  const body = SRC.slice(start, SRC.indexOf("return;\n    }", SRC.indexOf("plugin-credential-grant ${pluginId}", start)));
  assert.ok(!/const \{ pluginId, scopeId \} = scope;/.test(body), "the raw token scope must not be used as the grant scope");
});

test("a failed credential read reaches the decision instead of reading as a missing credential (#2954)", () => {
  const start = SRC.indexOf("req.url === '/internal/plugin-credential-grant'");
  const route = SRC.slice(start, SRC.indexOf("const who = d.ok", start));
  assert.ok(!/catch \{ personalValues = null; \}/.test(route), "a throwing personal read must not be swallowed");
  assert.ok(!/catch \{ teamValues = \{\}; \}/.test(route), "a throwing team read must not be swallowed");
  assert.ok(route.includes("catch (err) { personalValues = null; noteReadFailure('personal', err); }"));
  assert.ok(route.includes("catch (err) { teamValues = {}; noteReadFailure('team', err); }"));
  assert.match(route, /decideCredentialGrant\(\{[\s\S]*?credentialReadFailed,/);
});

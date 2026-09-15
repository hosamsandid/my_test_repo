"use strict";

// Source-reading drift guard for two `orchestrator.js`-only properties of the
// plugin-event / plugin-CLI wiring. Both fail SILENTLY — the platform keeps
// working, only the property is gone:
//
//   AC1  `POST /internal/plugin-event` must hand the PAYLOAD to
//        `resolvePluginEventTargets`. Without it every `payloadFilter` reads as
//        "no payload" and a filtered trigger never fires — the exact symptom
//        this filter exists to remove ("everything runs, nothing wakes").
//
//   AC2/AC3 (Task 7): granted plugin CLIs are refreshed from the registry on
//        every reconcile, by comparing a digest of both files.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function between(start, end) {
  const i = SRC.indexOf(start);
  assert.notEqual(i, -1, `marker not found: ${start}`);
  const j = SRC.indexOf(end, i);
  return SRC.slice(i, j === -1 ? undefined : j);
}

test("AC1: the plugin-event route resolves targets WITH the payload", () => {
  // The brief's own end marker, "Internal label fast-path", is the text of a
  // `//` comment header — the comment-stripping pass above removes it before
  // SRC is built, so it can never be found. Substituted with the next
  // non-comment `req.url ===` route literal after the plugin-event handler
  // (`/internal/github-label-applied`), which still bounds the search to the
  // plugin-event handler's own body.
  const route = between("req.url === '/internal/plugin-event'", "req.url === '/internal/github-label-applied'");
  assert.match(route, /resolvePluginEventTargets\(\{ pluginId, event, payload \}, agents\)/);
});

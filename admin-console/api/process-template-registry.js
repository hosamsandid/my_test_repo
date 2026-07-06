'use strict';

// ─── Process-template registry (#419) ────────────────────────────────────────
//
// Curated, git-committable whole-process templates — the process-level analogue
// of the agent-template catalog. Source files live in the repo under
// orchestrator/skill-pool/process-templates/ and are seeded into the pool
// volume by `make seed-process-templates`; the admin console reads them from
// /pool/process-templates. Each file is a `processTemplateVersion: 1` bundle
// (see process-template.js) plus an optional top-level `description`; the file
// name (without .json) is the template id.

const fs = require('fs');
const path = require('path');
const { validateProcessTemplate } = require('./process-template');

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Read + validate one template file. Returns the bundle or null (missing,
// unparsable, or failing bundle validation — invalid files are skipped with a
// log line rather than breaking the whole listing).
function loadProcessTemplate(dir, id) {
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const p = path.join(dir, id + '.json');
  let raw;
  try {
    if (!fs.existsSync(p)) return null;
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[ProcessTemplates] Cannot read ${id}: ${err.message}`);
    return null;
  }
  const v = validateProcessTemplate(raw);
  if (!v.ok) {
    console.error(`[ProcessTemplates] Skipping invalid template ${id}: ${v.error}`);
    return null;
  }
  return raw;
}

// Slim listing for a gallery: id + name/description + shape summary. Invalid
// files are skipped (loadProcessTemplate logs them).
function listProcessTemplates(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && TEMPLATE_ID_RE.test(f.slice(0, -5)))
      .sort();
  } catch {
    return []; // dir absent (pool not seeded yet) — an empty gallery, not an error
  }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    const b = loadProcessTemplate(dir, id);
    if (!b) continue;
    out.push({
      id,
      name: b.name || id,
      description: typeof b.description === 'string' ? b.description : '',
      roleCount: b.roles.length,
      stages: Array.isArray(b.stages) ? b.stages : [],
    });
  }
  return out;
}

module.exports = { listProcessTemplates, loadProcessTemplate, TEMPLATE_ID_RE };

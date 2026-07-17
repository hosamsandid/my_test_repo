// Step-catalog generator (docs/journey-spec-concept.md §11.2, #706).
//
// Produces `steps-catalog.json`: the finite vocabulary an authoring agent (or a
// human) may draw on when writing a journey — every step-library call name, its
// params, a one-line description, and a copy-pasteable YAML example, all lifted
// from the step library's JSDoc. It also lists the journey `fixtures:`.
//
// Pure and browser-free: it PARSES the step + fixture source (it does not
// `require` them), so it never pulls in @playwright/test and runs in the light
// `node --test` / lint lane. The catalog is the linter's allow-list — a step
// name absent here is rejected before a journey can ship, so a hallucinated
// step is impossible to land (§11.1). The set of modules it reads is the SAME
// `STEP_MODULES` the runtime registry registers, so the catalog and the live
// registry never drift.
const fs = require('fs');
const path = require('path');
const { STEP_MODULES } = require('./step-registry');

const CATALOG_VERSION = 1;
const STEPS_DIR = path.resolve(__dirname, '..', 'steps');
const FIXTURES_FILE = path.resolve(__dirname, 'fixtures.js');
const CATALOG_PATH = path.resolve(__dirname, '..', 'steps-catalog.json');

// Reserved exports that are NOT journey steps (mirrors step-registry.RESERVED).
const RESERVED = new Set(['volatileLocators']);

// ── JSDoc parsing ──────────────────────────────────────────────────────────

// Strip the leading ` * ` / ` *` decoration from a JSDoc body line.
function stripStar(line) {
  return line.replace(/^\s*\*?\s?/, '');
}

// Parse one `@param` line into { name, type, required, default, description }.
// Accepts `@param {type} params.name - desc`, the optional/`[bracketed=default]`
// form, and bare positional names (e.g. `@param {string} id - ...`). The
// `params.` prefix (the destructured-arg convention) is stripped from the name.
function parseParam(text) {
  let rest = text.trim();
  let type = null;
  const typeMatch = rest.match(/^\{([^}]*)\}\s*/);
  if (typeMatch) {
    type = typeMatch[1];
    rest = rest.slice(typeMatch[0].length);
  }
  // Split off the trailing " - description".
  let description = '';
  const dashIdx = rest.search(/\s-\s/);
  let nameToken = rest;
  if (dashIdx !== -1) {
    nameToken = rest.slice(0, dashIdx).trim();
    description = rest.slice(dashIdx + 3).trim();
  }
  let required = true;
  let def;
  const bracket = nameToken.match(/^\[(.+)\]$/);
  if (bracket) {
    required = false;
    nameToken = bracket[1];
  }
  const eq = nameToken.indexOf('=');
  if (eq !== -1) {
    def = nameToken.slice(eq + 1).trim();
    nameToken = nameToken.slice(0, eq).trim();
    required = false;
  }
  const name = nameToken.replace(/^params\./, '').trim();
  const param = { name, required };
  if (type) param.type = type;
  if (def !== undefined) param.default = def;
  if (description) param.description = description;
  return param;
}

// Parse a raw JSDoc block body (between /** and */) into { description, params,
// example }. Description = the prose before the first @tag; params = every
// @param; example = the verbatim body of @example.
function parseJsDoc(body) {
  const lines = body.split('\n').map(stripStar);
  const descLines = [];
  const params = [];
  let example = null;
  let mode = 'desc';
  for (const line of lines) {
    const tag = line.match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      const [, name, remainder] = tag;
      if (name === 'param') {
        params.push(parseParam(remainder));
        mode = 'other';
      } else if (name === 'example') {
        example = [];
        mode = 'example';
      } else {
        mode = 'other';
      }
      continue;
    }
    if (mode === 'desc') descLines.push(line);
    else if (mode === 'example' && example) example.push(line);
  }
  const description = descLines.join('\n').trim().replace(/\s*\n\s*/g, ' ');
  const exampleText = example ? example.join('\n').replace(/\s+$/, '').replace(/^\n+/, '') : null;
  return { description, params, example: exampleText };
}

// Find every `/** … */` block immediately preceding a `function NAME` (allowing
// intervening `//` line comments), returning a map name → parsed JSDoc.
function docsBeforeFunctions(source) {
  const re = /\/\*\*([\s\S]*?)\*\/\s*(?:\/\/[^\n]*\n\s*)*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
  const out = new Map();
  let m;
  while ((m = re.exec(source)) !== null) {
    out.set(m[2], parseJsDoc(m[1]));
  }
  return out;
}

// Find every `/** … */` block immediately preceding a `const NAME =` (for the
// object-shaped fixtures), returning a map name → parsed JSDoc.
function docsBeforeConsts(source) {
  const re = /\/\*\*([\s\S]*?)\*\/\s*(?:\/\/[^\n]*\n\s*)*const\s+([A-Za-z0-9_$]+)\s*=/g;
  const out = new Map();
  let m;
  while ((m = re.exec(source)) !== null) {
    out.set(m[2], parseJsDoc(m[1]));
  }
  return out;
}

// Extract the identifier names listed in a `module.exports = { a, b }` literal.
function parseExportNames(source) {
  const m = source.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter(Boolean);
}

// Extract the keys of the `const FIXTURES = { … }` registry literal.
function parseFixtureNames(source) {
  const m = source.match(/const\s+FIXTURES\s*=\s*\{([^}]*)\}/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter(Boolean);
}

// ── Catalog assembly ─────────────────────────────────────────────────────────

// Read + parse each step module. `readFile` is injectable for tests.
function buildCatalog({ readFile = (p) => fs.readFileSync(p, 'utf8'), stepModules = STEP_MODULES } = {}) {
  // Parse all step-module docs first so a re-exported step (e.g. teardown
  // re-exporting deleteEnv) can borrow the declaring module's JSDoc.
  const perModule = new Map(); // module -> { exports, docs }
  const allDocs = new Map(); // bare fn name -> parsed doc (first declaration wins)
  for (const mod of stepModules) {
    const source = readFile(path.join(STEPS_DIR, `${mod}.js`));
    const docs = docsBeforeFunctions(source);
    perModule.set(mod, { exports: parseExportNames(source), docs });
    for (const [name, doc] of docs) if (!allDocs.has(name)) allDocs.set(name, doc);
  }

  const steps = [];
  for (const mod of stepModules) {
    const { exports, docs } = perModule.get(mod);
    for (const name of exports) {
      if (RESERVED.has(name)) continue;
      const doc = docs.get(name) || allDocs.get(name) || { description: '', params: [], example: null };
      steps.push(entry(`${mod}.${name}`, mod, doc));
    }
  }
  steps.sort((a, b) => a.name.localeCompare(b.name));

  // Fixtures: parse the registry keys + their JSDoc from fixtures.js.
  const fxSource = readFile(FIXTURES_FILE);
  const fxDocs = docsBeforeConsts(fxSource);
  const fixtures = parseFixtureNames(fxSource)
    .map((name) => {
      const doc = fxDocs.get(name) || { description: '', params: [], example: null };
      const e = { name, description: doc.description, params: doc.params };
      if (doc.example) e.example = doc.example;
      return e;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { catalogVersion: CATALOG_VERSION, generatedFrom: [...stepModules], steps, fixtures };
}

// A single step entry with keys in a fixed order (stable JSON output).
function entry(name, mod, doc) {
  const e = { name, module: mod, description: doc.description, params: doc.params };
  if (doc.example) e.example = doc.example;
  return e;
}

// Deterministic serialization — 2-space indent + trailing newline, so the
// committed catalog is diff-stable and the freshness check is a plain compare.
function renderCatalogJson(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

module.exports = {
  CATALOG_VERSION,
  CATALOG_PATH,
  buildCatalog,
  renderCatalogJson,
  // exported for unit tests
  parseJsDoc,
  parseParam,
  docsBeforeFunctions,
  parseExportNames,
};

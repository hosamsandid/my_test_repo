'use strict';

// Legacy-memory migration core (Memory/Knowledge unification, Phase 3 — see
// docs/memory-knowledge-unification-concept.md §6).
//
// Parses an agent's legacy `memory/facts.md` / `memory/entities.md` into team
// KB entries so the one-shot migration can import them (provenance
// `migration:<agentId>` — convergence then naturally deduplicates identical
// lessons across members). PURE: no fs, no clock beyond injected now/idGen
// (repo convention: test pure helper cores only). The IO — reading the files,
// pushing to the KB, archiving to `memory/_archive/` — lives in
// orchestrator.js (migrateAgentMemoryToKb).
//
// users.md is deliberately NOT handled here: personal data is never shared and
// never migrated (concept §2, locked decision).

const { makeKnowledgeEntry } = require('./knowledge-store');

// A legacy fact line: `- [YYYY-MM-DD] Fact.` (template convention) or a plain
// `- Fact` / `* Fact` bullet. Headings, prose and blank lines are skipped —
// they carry no atomic fact.
const FACT_LINE_RE = /^[-*]\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+)$/;

function parseLegacyFacts(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = FACT_LINE_RE.exec(line);
    if (!m) continue;
    const stated = m[2].trim();
    if (!stated) continue;
    out.push({ text: stated, date: m[1] || null });
  }
  return out;
}

// Legacy entities.md: one H2/H3 section per entity (template convention:
// YAML-ish header + prose). Each section becomes ONE entity entry whose text
// is `<name>: <flattened body>` capped at 300 chars — a one-line statement fit
// for the KB/digest; the full original stays readable in memory/_archive/.
function parseLegacyEntities(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { name: m[1], body: [] };
      continue;
    }
    if (/^#\s/.test(line)) continue; // the file title (`# Entities`)
    if (cur) cur.body.push(line);
  }
  if (cur) sections.push(cur);

  const out = [];
  for (const s of sections) {
    const body = s.body
      .map((l) => l.trim())
      .filter((l) => l && l !== '---')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const full = body ? `${s.name}: ${body}` : s.name;
    out.push({ text: full.length > 300 ? `${full.slice(0, 299)}…` : full });
  }
  return out;
}

// Does this file carry anything beyond headings and blank lines? Value-less
// files (the seeded template is just `# Facts` / `# Entities`) are deleted by
// the migration rather than archived — no _archive noise for boilerplate.
function hasLegacyContent(text) {
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return true;
  }
  return false;
}

// Build validated KB entries for the parsed legacy items. Provenance:
// originAgent = the migrated agent, correlationId `migration:<agentId>` (the
// concept's `migrated:<agentId>` marker), convergence starts at [agentId]. A
// dated fact keeps its date as createdAt so digest recency stays honest.
function buildMigrationEntries({ agentId, teamId, facts = [], entities = [], now, idGen } = {}) {
  const opts = {};
  if (typeof now === 'function') opts.now = now;
  if (typeof idGen === 'function') opts.idGen = idGen;
  const correlationId = `migration:${agentId}`;
  const entries = [];
  for (const f of facts) {
    entries.push(makeKnowledgeEntry({
      kind: 'fact',
      text: f.text,
      originAgent: agentId,
      teamId,
      correlationId,
      ...(f.date ? { createdAt: `${f.date}T00:00:00Z` } : {}),
    }, opts));
  }
  for (const e of entities) {
    entries.push(makeKnowledgeEntry({
      kind: 'entity',
      text: e.text,
      originAgent: agentId,
      teamId,
      correlationId,
    }, opts));
  }
  return entries;
}

module.exports = {
  parseLegacyFacts,
  parseLegacyEntities,
  hasLegacyContent,
  buildMigrationEntries,
};

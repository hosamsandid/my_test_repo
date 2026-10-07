// Pure helpers behind the skill version views (#2839): the Versions tab rows,
// the two-version compare selection, the diff renderer's row shaping (inline and
// side-by-side, with collapsed unchanged context), the session-remembered diff
// mode, the UX permission for restore / edit-from-version, and the plan that
// turns an old version into pending editor changes. No React, no fetch —
// unit-tested in skill-version-view.test.js; SkillsRegistry.jsx,
// SkillVersionDiffModal.jsx and SkillEditorModal.jsx render it.

import {
  READ_CAP_BYTES, SKILL_MD, baseName, parentDir, looksBinary, skillEditPermission,
  createFile, editFile, uploadFile, deletePath, renamePath,
} from './skill-editor-model.js';

export const WORKING = 'working';
export const DIFF_MODE_KEY = 'aee.skillDiffMode';
export const DIFF_MODES = ['split', 'inline'];
export const DIFF_CONTEXT_LINES = 3;

export function shortHash(h) {
  return typeof h === 'string' && h ? h.slice(0, 12) : '—';
}

/* ─── Versions tab ───────────────────────────────────────────────────── */

// Rows of the Versions tab, newest first: the working-copy row (only when the
// copy drifted from every recorded version) and then the history. `ref` is what
// the version API takes ('working' or a content hash); `key` is unique per row
// even when a forced re-import recorded the same hash twice.
export function versionRows(versions) {
  const v = versions && typeof versions === 'object' ? versions : {};
  const rows = [];
  if (v.workingCopy && v.workingCopy.hash) {
    rows.push({
      key: WORKING, kind: 'working', ref: WORKING, hash: v.workingCopy.hash,
      version: null, action: null, by: null, at: null, note: undefined, restoredFrom: undefined,
      current: true, available: true,
    });
  }
  const history = Array.isArray(v.history) ? v.history : [];
  history.forEach((h, i) => {
    if (!h || typeof h !== 'object') return;
    rows.push({
      key: `h${i}`, kind: 'version', ref: h.hash || null, hash: h.hash || null,
      version: h.version ?? null, action: h.action || null, by: h.by || null, at: h.at || null,
      note: h.note, restoredFrom: h.restoredFrom,
      current: !!h.current, available: !!h.available && !!h.hash,
    });
  });
  return rows;
}

// Tick a row for "select two + Compare": at most two, a third pick drops the
// oldest pick; ticking a ticked row unticks it.
export function toggleCompareSelection(selected, key) {
  const sel = Array.isArray(selected) ? selected : [];
  if (sel.includes(key)) return sel.filter(k => k !== key);
  const next = [...sel, key];
  return next.length > 2 ? next.slice(next.length - 2) : next;
}

// The selected pair as {from, to} API refs, ordered older → newer by the rows'
// position (rows are newest-first) whatever order they were ticked in.
export function normalizeComparePair(rows, keyA, keyB) {
  const list = Array.isArray(rows) ? rows : [];
  const ia = list.findIndex(r => r.key === keyA);
  const ib = list.findIndex(r => r.key === keyB);
  if (ia < 0 || ib < 0) return null;
  const older = list[Math.max(ia, ib)];
  const newer = list[Math.min(ia, ib)];
  if (!older.available || !newer.available || !older.ref || !newer.ref) return null;
  return { from: older.ref, to: newer.ref };
}

export function versionLabel(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [];
  parts.push(entry.version != null ? `v${entry.version}` : 'Working copy');
  parts.push(shortHash(entry.hash));
  if (entry.action) parts.push(entry.action);
  if (entry.by) parts.push(entry.by);
  if (entry.at) parts.push(String(entry.at).replace('T', ' ').replace(/\.\d+Z$|Z$/, ''));
  return parts.join(' · ');
}

/* ─── diff mode (remembered for the session) ─────────────────────────── */

export function readDiffMode(storage) {
  try {
    const v = storage && storage.getItem(DIFF_MODE_KEY);
    return DIFF_MODES.includes(v) ? v : 'split';
  } catch {
    return 'split';
  }
}

export function writeDiffMode(storage, mode) {
  if (!DIFF_MODES.includes(mode)) return;
  try { storage && storage.setItem(DIFF_MODE_KEY, mode); } catch { /* storage unavailable — keep in memory only */ }
}

/* ─── diff files ─────────────────────────────────────────────────────── */

const STATUS_LABELS = { added: 'Added', removed: 'Removed', modified: 'Modified', renamed: 'Renamed', unchanged: 'Unchanged' };
const STATUS_MARKS = { added: '+', removed: '−', modified: '±', renamed: '→', unchanged: '=' };

export function fileStatusLabel(status) { return STATUS_LABELS[status] || String(status || ''); }
export function fileStatusMark(status) { return STATUS_MARKS[status] || '?'; }

export function visibleDiffFiles(files, showUnchanged) {
  const list = Array.isArray(files) ? files : [];
  return showUnchanged ? list : list.filter(f => f.status !== 'unchanged');
}

// Files compared by bytes only carry no line diff — say what we know instead.
export function fileNote(file) {
  if (!file || (!file.binary && !file.tooLarge)) return null;
  const kind = file.binary ? 'binary' : 'too large';
  return `${kind} — ${file.contentChanged ? 'changed' : 'unchanged'}`;
}

// "+a −r" count for a file header; null when the file has no line diff.
export function fileCounts(file) {
  if (!file || file.added == null || file.removed == null) return null;
  return `+${file.added} −${file.removed}`;
}

export function summaryText(summary) {
  const s = summary || {};
  const parts = [];
  for (const k of ['modified', 'renamed', 'added', 'removed']) if (s[k]) parts.push(`${s[k]} ${k}`);
  if (s.unchanged) parts.push(`${s.unchanged} unchanged`);
  return `${parts.join(', ') || 'no files'} · +${s.linesAdded || 0} −${s.linesRemoved || 0} lines`;
}

/* ─── diff rows ──────────────────────────────────────────────────────── */

// Split ops into runs of shown ops and gaps of collapsed unchanged lines: a
// context line stays when it is within `context` lines of a change.
export function hunkify(ops, context = DIFF_CONTEXT_LINES) {
  const list = Array.isArray(ops) ? ops : [];
  const keep = new Array(list.length).fill(false);
  list.forEach((o, i) => {
    if (o.t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(list.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let i = 0;
  while (i < list.length) {
    if (keep[i]) {
      const run = [];
      while (i < list.length && keep[i]) run.push(list[i++]);
      out.push({ type: 'ops', ops: run });
    } else {
      let count = 0;
      while (i < list.length && !keep[i]) { count++; i++; }
      out.push({ type: 'gap', count });
    }
  }
  return out;
}

// Inline rows: one per line with its +/−/space marker, gaps between hunks.
export function buildUnifiedRows(ops, opts = {}) {
  const rows = [];
  for (const seg of hunkify(ops, opts.context ?? DIFF_CONTEXT_LINES)) {
    if (seg.type === 'gap') { rows.push({ type: 'gap', count: seg.count }); continue; }
    for (const o of seg.ops) rows.push({ type: 'line', t: o.t, a: o.a, b: o.b, s: o.s });
  }
  return rows;
}

// Side-by-side rows: context lines on both sides; within a change block the
// removed lines pair up with the added lines row by row (the shorter side pads).
export function buildSplitRows(ops, opts = {}) {
  const rows = [];
  for (const seg of hunkify(ops, opts.context ?? DIFF_CONTEXT_LINES)) {
    if (seg.type === 'gap') { rows.push({ type: 'gap', count: seg.count }); continue; }
    const list = seg.ops;
    let i = 0;
    while (i < list.length) {
      const o = list[i];
      if (o.t === ' ') {
        rows.push({ type: 'pair', left: { t: ' ', n: o.a, s: o.s }, right: { t: ' ', n: o.b, s: o.s } });
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < list.length && list[i].t === '-') dels.push(list[i++]);
      while (i < list.length && list[i].t === '+') adds.push(list[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          type: 'pair',
          left: d ? { t: '-', n: d.a, s: d.s } : null,
          right: a ? { t: '+', n: a.b, s: a.s } : null,
        });
      }
    }
  }
  return rows;
}

/* ─── permissions (UX only — the server re-checks every restore) ─────── */

// Restore needs the same right as editing that copy; an agent copy uses the
// install permission (System Admin or Team Admin of the agent's team). Edit
// from this version goes through the editor's save, which agent copies don't
// have.
export function versionActionPermission(skill, caller, agentTeamId) {
  const c = caller || {};
  if (skill && skill.source === 'agent') {
    const ok = !!c.isSysAdmin || (!!agentTeamId && (c.adminTeamIds || []).includes(agentTeamId));
    return {
      restore: ok ? { ok: true, reason: null } : { ok: false, reason: 'Only a System Admin or a Team Admin of this agent\'s team can restore its skill copy.' },
      editFrom: { ok: false, reason: 'Agent-tier copies cannot be edited here — restore the version instead.' },
    };
  }
  const p = skillEditPermission(skill, c);
  const r = p.editable ? { ok: true, reason: null } : { ok: false, reason: p.reason };
  return { restore: r, editFrom: r };
}

/* ─── edit from this version ─────────────────────────────────────────── */

// The diff from the version (from) to the working copy (to) read backwards:
// what to change in the working copy so it holds the version's content again.
// `fetch` lists the version-side paths whose bytes are needed.
export function planEditFromVersion(diff) {
  const deletes = [];
  const renames = [];
  const writes = [];
  for (const f of (diff && Array.isArray(diff.files) ? diff.files : [])) {
    if (f.status === 'added') deletes.push(f.path);
    else if (f.status === 'removed' || f.status === 'modified') writes.push(f.path);
    else if (f.status === 'renamed') {
      renames.push({ from: f.path, to: f.fromPath });
      if (f.contentChanged) writes.push(f.fromPath);
    }
  }
  return { deletes: deletes.sort(), renames, writes: writes.sort(), fetch: writes.slice().sort() };
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Turn a fetched version file ({base64, size}) into what the editor holds:
// text for readable files, raw bytes (an upload) for binary or over-cap ones.
export function decodeVersionFile(file) {
  const bytes = base64ToBytes(file && file.base64);
  if (looksBinary(bytes) || bytes.length > READ_CAP_BYTES) return { base64: file.base64, size: bytes.length };
  return { text: new TextDecoder().decode(bytes), size: bytes.length };
}

// Apply the plan to an editor model as pending changes — nothing is written
// until the editor's Save, which then records exactly one version. `contents`
// maps each planned write path to decodeVersionFile's result.
export function applyVersionPlan(state, plan, contents) {
  let s = state;
  const errors = [];
  const step = (r) => { if (r.error) errors.push(r.error); else s = r.state; };
  for (const p of plan.deletes) if (p !== SKILL_MD) step(deletePath(s, p));
  for (const m of plan.renames) step(renamePath(s, m.from, m.to));
  for (const p of plan.writes) {
    const c = contents && (contents instanceof Map ? contents.get(p) : contents[p]);
    if (!c) { errors.push(`${p}: content not available`); continue; }
    if (c.base64 !== undefined) {
      step(uploadFile(s, parentDir(p), baseName(p), { base64: c.base64, size: c.size }));
      continue;
    }
    if (!s.files[p]) {
      const r = createFile(s, parentDir(p), baseName(p));
      if (r.error) { errors.push(r.error); continue; }
      s = r.state;
    }
    step(editFile(s, p, c.text, undefined));
  }
  return { state: s, errors };
}

// Walkthrough-chapter reader (docs/journey-spec-concept.md §3.2 item 3, #707).
//
// The second half of the coverage report flags walkthrough chapters that no
// journey covers yet — including the chapters still marked TODO in the
// walkthrough narrative source. That table lives in docs/walkthrough/README.md
// (chapter · file · maturity); we parse it so the coverage report stays in step
// with the storyline inventory without a second hand-maintained list.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_README = path.resolve(__dirname, '..', '..', 'docs', 'walkthrough', 'README.md');

// Split a markdown table row `| a | b | c |` into trimmed cells.
function tableCells(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

// Parse the chapter/maturity table. A single cell may list several chapters
// (the README groups the title-only TODO chapters on one row); we split those on
// commas so each surfaces as its own coverage entry. Returns
// [{ title, file, maturity, todo }] in table order.
function readChapters(readmePath = DEFAULT_README) {
  const src = fs.readFileSync(readmePath, 'utf8');
  const rows = [];
  let inTable = false;
  for (const line of src.split('\n')) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = tableCells(line);
    // Header + separator rows.
    if (/^chapter$/i.test(cells[0])) {
      inTable = true;
      continue;
    }
    if (/^:?-{2,}/.test(cells[0])) continue;
    if (!inTable) continue;

    const [rawTitle, rawFile = '', rawMaturity = ''] = cells;
    const file = rawFile.replace(/`/g, '').trim();
    const maturity = rawMaturity.trim();
    const todo = /^todo/i.test(maturity);
    for (const title of rawTitle.split(',').map((t) => t.trim()).filter(Boolean)) {
      rows.push({ title, file: file === '—' ? null : file, maturity, todo });
    }
  }
  return rows;
}

// Normalise a chapter or journey title for matching: lowercase, drop any
// parenthetical qualifier ("Team Setup (wizard)" → "team setup"), collapse
// whitespace. Journey titles ARE the chapter titles by design (§2.1: journey
// `title` = "chapter title, deck section, doc heading"), so a normalised compare
// is the intended link between the two inventories.
function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { readChapters, normalizeTitle, DEFAULT_README };

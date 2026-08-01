// Walks src/projects/*.tsx and src/scenes/*.tsx, collects every
// { audioId: "...", text: "..." } literal into scripts/narration.json
// for the Python TTS generator to consume.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const roots = ["src/projects", "src/scenes"];

function joinStringExpr(expr) {
  const parts = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(expr))) parts.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  return parts.join("");
}

const entries = [];
for (const r of roots) {
  let files;
  try {
    files = readdirSync(r);
  } catch {
    continue;
  }
  for (const f of files) {
    if (!f.endsWith(".tsx") && !f.endsWith(".ts")) continue;
    const src = readFileSync(join(r, f), "utf8");
    const constLiterals = new Map();
    const constRe = /const\s+(\w+)\s*=\s*((?:"(?:\\.|[^"\\])*"\s*\+\s*)*"(?:\\.|[^"\\])*")\s*;/g;
    let cm;
    while ((cm = constRe.exec(src))) constLiterals.set(cm[1], joinStringExpr(cm[2]));
    // First: match `audioId: "X", text: "Y"` where Y is a quoted string (handles commas inside).
    const voReStr = /\baudioId:\s*"([^"]+)"\s*,\s*text:\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = voReStr.exec(src))) {
      entries.push({ id: m[1], text: m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\") });
    }
    // Then: match `audioId: "X", text: IDENTIFIER` (text from a const).
    const voReConst = /\baudioId:\s*"([^"]+)"\s*,\s*text:\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*[,}]/g;
    while ((m = voReConst.exec(src))) {
      const ident = m[2];
      // Look up direct const OR `OBJECT.PROP` (e.g. NARRATION_X) — only the last segment.
      const text = constLiterals.get(ident);
      if (text !== undefined) entries.push({ id: m[1], text });
    }
  }
}

writeFileSync("scripts/narration.json", JSON.stringify(entries, null, 2), "utf8");
console.log(`Wrote ${entries.length} narration entries to scripts/narration.json`);
for (const e of entries) console.log(` - ${e.id}: ${e.text.length} chars`);

#!/usr/bin/env python3
"""
Blueprint Engine for i-SASE.

Core logic for Blueprint lifecycle: analyze BP trees for extraction,
extract parameterized Blueprints, instantiate concrete BPs, validate,
list, and inspect Blueprints.

Usage:
    python3 scripts/blueprint-engine.py analyze     <bp-hash-prefix> [--json]
    python3 scripts/blueprint-engine.py extract     <bp-hash-prefix> [--params <json>] [--level <level>] [--no-commit]
    python3 scripts/blueprint-engine.py instantiate <blueprint-hash>  --params <json> [--dry-run] [--rigor standard] [--no-commit]
    python3 scripts/blueprint-engine.py list        [--level <level>] [--tag <tag>] [--json]
    python3 scripts/blueprint-engine.py validate    <blueprint-hash>
    python3 scripts/blueprint-engine.py info        <blueprint-hash> [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Imports from sase_lib
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    BLUEPRINTS_DIR,
    BLUEPRINT_INDEX_JSON,
    BRIEFINGS_DIR,
    DIR_PATTERN,
    REPO_ROOT,
    find_all_blueprints,
    find_blueprint,
    find_bp,
    has_children,
    parse_frontmatter,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TEMPLATE_PATH = REPO_ROOT / "skills" / "blueprint-eng" / "templates" / "blueprint.md"

# Regex patterns for text classification
PATH_PATTERN = re.compile(
    r"(?:^|[\s`\"'])("
    r"(?:[\w.-]+/){1,}[\w.-]+"  # multi-segment paths like scripts/bp-explorer/server.py
    r")"
    r"(?:[\s`\"',;)\]}]|$)",
    re.MULTILINE,
)
HASH_12_PATTERN = re.compile(r"\b[0-9a-f]{12}\b")
HASH_8_PATTERN = re.compile(r"\b[0-9a-f]{8}\b")
COBOL_NAME_PATTERN = re.compile(r"\b[A-Z]{2,}[0-9]{2,}[A-Z]?\b")
LOC_NUMBER_PATTERN = re.compile(
    r"(\d{2,})\s*(?:programs?|files?|LOC|lines?|modules?|copybooks?|paragraphs?)",
    re.IGNORECASE,
)
DATETIME_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?")

# ---------------------------------------------------------------------------
# False-positive filtering for path detection
# ---------------------------------------------------------------------------

# Keywords that appear with slashes in technical documentation but are NOT paths.
# Covers: COBOL statements, mainframe tech, generic abbreviations, UI terms.
_KEYWORD_TOKENS = frozenset(
    # COBOL verbs / clauses / divisions
    "IF ELSE EVALUATE WHEN PERFORM GO THRU THROUGH TO CALL LINK XCTL WRITEQ READQ "
    "DELETEQ STARTBR ENDBR RETURN SEND RECEIVE READ WRITE REWRITE DELETE OPEN CLOSE "
    "COMPUTE ADD SUBTRACT MULTIPLY DIVIDE MOVE SET INSPECT STRING UNSTRING ACCEPT "
    "DISPLAY STOP RUN EXIT GOBACK CONTINUE NEXT SENTENCE SECTION PARAGRAPH "
    "COPY REPLACING ALSO LEADING TRAILING ROUNDED ON SIZE ERROR NOT OF IN "
    "PIC VALUE REDEFINES OCCURS DEPENDING USAGE COMP BINARY PACKED POINTER "
    "LINKAGE WORKING STORAGE FILE STATUS RECORD BLOCK CONTAINS LABEL "
    "OTHER SPACES ZEROS LOW HIGH ALL WHEN THEN END FALL FALL_THROUGH "
    # Mainframe technologies
    "DB2 VSAM CICS IMS COBOL JCL PROC PGM EXEC SQL SQLCODE "
    "COMMAREA DFHCOMMAREA TWA TSQ TDQ EIBTRNID "
    # Data concepts
    "IN OUT INOUT INPUT OUTPUT I O "
    # Quality / UI / generic pairings
    "CSS JS SVG HTML JSON YAML XML Excel PDF CSV "
    "A B C D E N "
    "DMN ISO IEC KDM "
    "AUTO SEMI MANUAL "
    "LOD LOC "
    "Node edge nodes edges "
    "source target required optional "
    "draft approved rework "
    "high medium low "
    "go no "
    "highlight focus compound nested "
    "ghost dashed solid dotted "
    "click expand collapse "
    "header footer banner "
    "suffix domain prefix "
    "resource command "
    "programs copybooks variables paragraphs fields variable "
    "implicit undefined explicit "
    "rounding precision scale "
    "inputs outputs "
    "default OTHER ELSE "
    "entry_point orchestrator worker leaf shared_service "
    "wrapper facade handler mapper validation lookup "
    "Interest Payment Protocol audit Environment config "
    "parameters areas "
    "flags status "
    "Loop termination "
    "Large complex simple "
    "mechanical repetitive "
    "uncertain inferred "
    "hyphen underscore "
    "D1 D2 T1 T2 T3 T4 F200 F206 F210 F220 "
    "batch CICS recursion "
    "Expandable collapsible "
    "Copybook Program "
    "Paragraph Section "
    "DE EN FR "
    "ZI RW "
    "UC "
    .split()
)
# Case-insensitive lookup set
_KEYWORD_TOKENS_CI = frozenset(t.upper() for t in _KEYWORD_TOKENS)


def _is_likely_path(candidate: str) -> bool:
    """Decide whether a slash-containing string is a real file path or a keyword pair.

    Returns True for real file paths, False for keyword pairs / abbreviation lists.
    Heuristics:
      1. Must not start with http / sase/ (handled upstream).
      2. If every segment is a known keyword token → reject.
      3. If every segment is ALL-UPPERCASE and short (≤8 chars) → reject.
         Real paths almost always have a lowercase or mixed-case segment.
      4. If any segment contains a file extension (.py, .json, .md, .html, etc.) → accept.
      5. If any segment starts with a digit followed by a dash (e.g. "20-docs") → accept (numbered dirs).
      6. If total length ≤ 5 (e.g. "A/B", "I/O") → reject.
    """
    segments = candidate.split("/")

    # Heuristic 6: very short — likely abbreviation pair
    if len(candidate) <= 5:
        return False

    # Heuristic 4: file extension in any segment → real path
    _EXT_RE = re.compile(r"\.\w{1,5}$")
    if any(_EXT_RE.search(seg) for seg in segments):
        return True

    # Heuristic 5: numbered directory (10-legacy, 20-docs, etc.)
    if any(re.match(r"\d+-", seg) for seg in segments):
        return True

    # Heuristic 2: all segments (split on / and -) are known keyword tokens
    # Also split hyphenated sub-tokens (e.g. "no-go" → "no", "go")
    all_tokens = []
    for seg in segments:
        all_tokens.extend(seg.split("-"))
    if all(tok.upper() in _KEYWORD_TOKENS_CI for tok in all_tokens if tok):
        return False

    # Heuristic 3: every segment is ALL-UPPERCASE and short — likely abbreviation list
    if all(seg == seg.upper() and len(seg) <= 8 for seg in segments if seg):
        return False

    # Heuristic: most segments are keyword tokens (≥ 2/3) and none have extensions → reject
    if len(segments) >= 2:
        keyword_count = sum(
            1 for tok in all_tokens if tok and tok.upper() in _KEYWORD_TOKENS_CI
        )
        if keyword_count >= len(all_tokens) * 2 / 3:
            return False

    # Heuristic: if the string contains underscores or dots in non-final segments → likely path
    if any("_" in seg or "." in seg for seg in segments[:-1]):
        return True

    # Heuristic: mixed case anywhere → more likely a path, but only if not all tokens are keywords
    if any(c.islower() for c in candidate):
        # Check if it still looks like a path (at least one directory-like segment)
        if any(len(seg) > 8 for seg in segments):
            return True
        if any("_" in seg or "." in seg for seg in segments):
            return True
        # Short lowercase segments with no extensions → probably not a path
        return False

    # Default: reject anything that doesn't look path-like
    return False


# Expanded false-positive list for COBOL-name pattern
_PROGRAM_NAME_FALSE_POSITIVES = frozenset(
    "TODO NOTE YAML JSON HTML CORS HTTP CRUD "
    # Mainframe / tech abbreviations that match [A-Z]{2,}[0-9]{2,}[A-Z]?
    "COMP3 COMP1 UTF8 BASE64 SHA256 SHA512 MD5 "
    "ISO8601 RFC7231 RFC2616 "
    "ANSI85 EBCDIC37 "
    "CP1252 CP037 "
    .split()
)

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def generate_hash() -> str:
    """Generate a 12-char hex hash via openssl."""
    result = subprocess.run(
        ["openssl", "rand", "-hex", "6"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def derive_slug(title: str) -> str:
    """Derive a slug from title: lowercase, hyphens, max 4 words."""
    clean = re.sub(r"[^a-zA-Z0-9\s-]", "", title)
    words = clean.lower().split()[:4]
    slug = "-".join(words)
    slug = re.sub(r"-+", "-", slug).strip("-")
    if len(slug) < 2:
        slug = slug + "-bp" if slug else "untitled"
    return slug


def get_git_author() -> str:
    """Get git user.name."""
    r = subprocess.run(
        ["git", "config", "user.name"],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    return r.stdout.strip() if r.returncode == 0 else "unknown"


def get_body(text: str) -> str:
    """Extract the markdown body after the frontmatter."""
    parts = text.split("---", 2)
    if len(parts) >= 3:
        return parts[2]
    return text


def reconstruct_file(frontmatter_yaml: str, body: str) -> str:
    """Reconstruct a file from frontmatter YAML string and body."""
    return f"---\n{frontmatter_yaml}---{body}"


# ---------------------------------------------------------------------------
# BP tree traversal
# ---------------------------------------------------------------------------


def collect_bp_tree(root_dir: Path) -> list[tuple[Path, str, str, int]]:
    """Collect all BPs in a tree rooted at root_dir.

    Returns list of (brief_path, hash, slug, depth) sorted by depth then hash.
    """
    results = []
    m = DIR_PATTERN.match(root_dir.name)
    if m and (root_dir / "brief.md").exists():
        results.append((root_dir / "brief.md", m.group(1), m.group(2), 0))

    def _walk(parent: Path, depth: int):
        for child in sorted(parent.iterdir()):
            if child.is_dir():
                cm = DIR_PATTERN.match(child.name)
                if cm and (child / "brief.md").exists():
                    results.append(
                        (child / "brief.md", cm.group(1), cm.group(2), depth + 1)
                    )
                    _walk(child, depth + 1)

    _walk(root_dir, 0)
    return results


def walk_to_root(bp_dir: Path) -> Path:
    """Walk up from a BP directory to find the root of the BP tree."""
    current = bp_dir
    while current != BRIEFINGS_DIR and current.parent != BRIEFINGS_DIR:
        parent = current.parent
        if DIR_PATTERN.match(parent.name) and (parent / "brief.md").exists():
            current = parent
        else:
            break
    return current


# ---------------------------------------------------------------------------
# Text classification (for analyze)
# ---------------------------------------------------------------------------


def classify_text(text: str, frontmatter: dict) -> dict:
    """Classify text segments in a BP body for blueprint extraction.

    Returns a dict with suggested parameters grouped by type.
    """
    suggestions = defaultdict(list)

    # Paths
    for match in PATH_PATTERN.finditer(text):
        path_str = match.group(1)
        # Skip common non-path patterns
        if path_str.startswith("http") or path_str.startswith("sase/"):
            continue
        # Apply smart false-positive filtering
        if not _is_likely_path(path_str):
            continue
        suggestions["path"].append(
            {
                "value": path_str,
                "position": match.start(1),
                "suggested_name": _path_to_param_name(path_str),
            }
        )

    # 12-char hex IDs (BP hashes) — always replace, not parameterized
    for match in HASH_12_PATTERN.finditer(text):
        suggestions["hash_id"].append(
            {"value": match.group(), "position": match.start()}
        )

    # COBOL-style program names
    for match in COBOL_NAME_PATTERN.finditer(text):
        name = match.group()
        # Filter out common false positives
        if name in _PROGRAM_NAME_FALSE_POSITIVES:
            continue
        suggestions["program_name"].append(
            {"value": name, "position": match.start()}
        )

    # Numbers in LOC/count context
    for match in LOC_NUMBER_PATTERN.finditer(text):
        suggestions["number"].append(
            {"value": match.group(1), "context": match.group(), "position": match.start()}
        )

    # Dates
    for match in DATETIME_PATTERN.finditer(text):
        suggestions["date"].append(
            {"value": match.group(), "position": match.start()}
        )

    # Frontmatter-specific: author, approver, reviewers
    for field in ("author", "approver", "reviewers"):
        val = frontmatter.get(field)
        if val:
            if isinstance(val, list):
                for v in val:
                    if v and v not in ("", "unknown"):
                        suggestions["person"].append({"value": v, "field": field})
            elif val not in ("", "unknown"):
                suggestions["person"].append({"value": val, "field": field})

    return dict(suggestions)


def _path_to_param_name(path_str: str) -> str:
    """Convert a file path to a suggested parameter name."""
    # Take the last component, uppercase, replace dots and hyphens
    name = Path(path_str).stem
    name = re.sub(r"[^a-zA-Z0-9]", "_", name).upper()
    if name and name[0].isdigit():
        name = "FILE_" + name
    return name + "_PATH"


# ---------------------------------------------------------------------------
# Analyze command
# ---------------------------------------------------------------------------


def cmd_analyze(bp_prefix: str, as_json: bool = False) -> dict:
    """Analyze a BP tree for blueprint extraction."""
    brief_path, full_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    # Walk to root of the tree
    root_dir = walk_to_root(bp_dir)
    tree = collect_bp_tree(root_dir)

    root_hash = tree[0][1] if tree else full_hash
    root_slug = tree[0][2] if tree else slug

    # Read root BP
    root_text = tree[0][0].read_text(encoding="utf-8") if tree else ""
    root_fm = parse_frontmatter(root_text)

    # Collect all classifications
    all_suggestions = defaultdict(list)
    bp_structure = []

    for brief, bp_hash, bp_slug, depth in tree:
        text = brief.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        body = get_body(text)

        classifications = classify_text(body, fm)

        for category, items in classifications.items():
            for item in items:
                item["found_in"] = bp_hash
            all_suggestions[category].extend(items)

        bp_structure.append(
            {
                "hash": bp_hash,
                "slug": bp_slug,
                "mission": fm.get("mission", ""),
                "status": fm.get("status", "unknown"),
                "depth": depth,
                "is_parent": has_children(brief.parent),
            }
        )

    # Deduplicate and count occurrences
    param_candidates = _build_param_candidates(all_suggestions)

    result = {
        "bp_hash": root_hash,
        "bp_slug": root_slug,
        "bp_mission": root_fm.get("mission", ""),
        "bp_tree_depth": max(bp[3] for bp in tree) if tree else 0,
        "total_bps": len(tree),
        "suggested_parameters": param_candidates,
        "classification_summary": {
            k: len(v) for k, v in all_suggestions.items()
        },
        "bp_structure": bp_structure,
    }

    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        _print_analysis(result)

    return result


def _build_param_candidates(suggestions: dict) -> list[dict]:
    """Build deduplicated parameter candidates from raw classifications."""
    candidates = []

    # Paths — group unique values
    seen_paths = {}
    for item in suggestions.get("path", []):
        val = item["value"]
        if val not in seen_paths:
            seen_paths[val] = {
                "name": item.get("suggested_name", "PATH"),
                "type": "path",
                "current_value": val,
                "occurrences": 0,
                "found_in": [],
            }
        seen_paths[val]["occurrences"] += 1
        bp = item.get("found_in")
        if bp and bp not in seen_paths[val]["found_in"]:
            seen_paths[val]["found_in"].append(bp)
    candidates.extend(seen_paths.values())

    # Program names
    seen_names = {}
    for item in suggestions.get("program_name", []):
        val = item["value"]
        if val not in seen_names:
            seen_names[val] = {
                "name": "PROGRAM_NAME",
                "type": "string",
                "current_value": val,
                "occurrences": 0,
                "found_in": [],
            }
        seen_names[val]["occurrences"] += 1
        bp = item.get("found_in")
        if bp and bp not in seen_names[val]["found_in"]:
            seen_names[val]["found_in"].append(bp)
    if seen_names:
        if len(seen_names) > 1:
            candidates.append(
                {
                    "name": "PROGRAM_NAMES",
                    "type": "list",
                    "current_value": list(seen_names.keys()),
                    "occurrences": sum(v["occurrences"] for v in seen_names.values()),
                    "found_in": list(
                        {bp for v in seen_names.values() for bp in v["found_in"]}
                    ),
                }
            )
        else:
            candidates.extend(seen_names.values())

    # Numbers
    seen_numbers = {}
    for item in suggestions.get("number", []):
        ctx = item.get("context", "")
        val = item["value"]
        key = f"{val}_{ctx}"
        if key not in seen_numbers:
            seen_numbers[key] = {
                "name": _number_to_param_name(ctx),
                "type": "number",
                "current_value": val,
                "context": ctx,
                "occurrences": 0,
                "found_in": [],
            }
        seen_numbers[key]["occurrences"] += 1
        bp = item.get("found_in")
        if bp and bp not in seen_numbers[key]["found_in"]:
            seen_numbers[key]["found_in"].append(bp)
    candidates.extend(seen_numbers.values())

    # Persons
    seen_persons = set()
    for item in suggestions.get("person", []):
        val = item["value"]
        if val not in seen_persons:
            seen_persons.add(val)
            candidates.append(
                {
                    "name": "AUTHOR",
                    "type": "string",
                    "current_value": val,
                    "occurrences": 1,
                    "found_in": [],
                    "field": item.get("field", ""),
                }
            )

    return candidates


def _number_to_param_name(context: str) -> str:
    """Derive a parameter name from a number context string."""
    ctx_lower = context.lower()
    if "program" in ctx_lower:
        return "PROGRAM_COUNT"
    if "file" in ctx_lower:
        return "FILE_COUNT"
    if "loc" in ctx_lower or "line" in ctx_lower:
        return "TOTAL_LOC"
    if "module" in ctx_lower:
        return "MODULE_COUNT"
    if "copybook" in ctx_lower:
        return "COPYBOOK_COUNT"
    return "COUNT"


def _print_analysis(result: dict) -> None:
    """Pretty-print analysis results for human consumption."""
    print(f"BLUEPRINT PRE-ANALYSIS")
    print(f"======================\n")
    print(
        f"Source BP: bp:{result['bp_hash'][:6]} ({result['bp_slug']})"
    )
    print(f'  "{result["bp_mission"]}"')
    print(
        f"  Tree depth: {result['bp_tree_depth']} | "
        f"Total BPs: {result['total_bps']}\n"
    )

    params = result["suggested_parameters"]
    if params:
        print(f"DETECTED PARAMETERS ({len(params)} candidates):\n")
        print(f"  {'Name':<25} {'Type':<10} {'Occurrences':<13} {'Current Value'}")
        print(f"  {'─' * 25} {'─' * 10} {'─' * 13} {'─' * 30}")
        for p in params:
            val = p["current_value"]
            if isinstance(val, list):
                val = f"[{len(val)} items]"
            elif len(str(val)) > 30:
                val = str(val)[:27] + "..."
            print(
                f"  {p['name']:<25} {p['type']:<10} {p['occurrences']:<13} {val}"
            )
    else:
        print("  No parameter candidates detected.")

    print(f"\nSTRUCTURE:")
    for bp in result["bp_structure"]:
        indent = "  " * (bp["depth"] + 1)
        parent_tag = " [parent]" if bp["is_parent"] else " [leaf]"
        print(
            f"{indent}bp:{bp['hash'][:6]} ({bp['slug']}){parent_tag} "
            f"— {bp['mission'][:50]}"
        )

    summary = result["classification_summary"]
    print(f"\nCLASSIFICATION SUMMARY:")
    for k, v in summary.items():
        print(f"  {k}: {v} occurrences")


# ---------------------------------------------------------------------------
# Extract command
# ---------------------------------------------------------------------------


def cmd_extract(
    bp_prefix: str,
    params_json: str | None = None,
    level: str = "technology",
    no_commit: bool = False,
) -> dict:
    """Extract a Blueprint from a BP tree."""
    brief_path, full_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    # Walk to root
    root_dir = walk_to_root(bp_dir)
    tree = collect_bp_tree(root_dir)

    if not tree:
        print("ERROR: Empty BP tree", file=sys.stderr)
        sys.exit(1)

    root_text = tree[0][0].read_text(encoding="utf-8")
    root_fm = parse_frontmatter(root_text)

    # Run analysis
    analysis = cmd_analyze.__wrapped__(bp_prefix) if hasattr(cmd_analyze, '__wrapped__') else _analyze_silent(bp_prefix)

    # Load user-provided parameter overrides
    user_params = {}
    if params_json:
        user_params = json.loads(params_json)

    author = get_git_author()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Generate the blueprint tree
    BLUEPRINTS_DIR.mkdir(parents=True, exist_ok=True)

    # Map: old BP hash -> new blueprint hash
    hash_map = {}
    blueprint_files = []

    for brief, bp_hash, bp_slug, depth in tree:
        new_hash = generate_hash()
        hash_map[bp_hash] = new_hash

    # Build blueprint tree
    root_blueprint_hash = hash_map[tree[0][1]]
    root_blueprint_slug = derive_slug(root_fm.get("mission", "blueprint"))

    result_children = []

    for brief, bp_hash, bp_slug, depth in tree:
        text = brief.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        body = get_body(text)

        new_hash = hash_map[bp_hash]
        new_slug = derive_slug(fm.get("mission", bp_slug))

        # Determine directory path
        if depth == 0:
            bp_tmpl_dir = BLUEPRINTS_DIR / f"{new_hash}-{new_slug}"
        else:
            # Find parent in tree
            parent_hash = _find_parent_hash(brief, tree)
            if parent_hash and parent_hash in hash_map:
                parent_new_hash = hash_map[parent_hash]
                parent_new_slug = derive_slug(
                    next(
                        fm2.get("mission", s)
                        for p, h, s, d in tree
                        if h == parent_hash
                        for fm2 in [parse_frontmatter(p.read_text(encoding="utf-8"))]
                    )
                )
                parent_dir = _find_blueprint_dir(
                    BLUEPRINTS_DIR, parent_new_hash, parent_new_slug, tree, hash_map
                )
                bp_tmpl_dir = parent_dir / f"{new_hash}-{new_slug}"
            else:
                bp_tmpl_dir = BLUEPRINTS_DIR / f"{root_blueprint_hash}-{root_blueprint_slug}" / f"{new_hash}-{new_slug}"

        bp_tmpl_dir.mkdir(parents=True, exist_ok=True)

        # Build parameters from analysis suggestions
        parameters = _build_parameters_from_analysis(analysis, fm, user_params)

        # Apply parameterization to body
        parameterized_body = _parameterize_body(body, analysis, parameters)

        # Remap hash references in body
        for old_h, new_h in hash_map.items():
            parameterized_body = parameterized_body.replace(old_h, "{{CHILD_BP_HASH}}")

        # Build execution-order with new hashes
        exec_order = fm.get("execution-order", [])
        new_exec_order = []
        if exec_order:
            for item in exec_order:
                if isinstance(item, list):
                    new_exec_order.append(
                        [hash_map.get(h, h) for h in item]
                    )
                elif isinstance(item, dict):
                    # Dict entries (e.g. mapping with metadata) — remap any
                    # hash values found inside, keep structure intact.
                    new_item = {}
                    for k, v in item.items():
                        new_key = hash_map.get(k, k) if isinstance(k, str) else k
                        new_val = hash_map.get(v, v) if isinstance(v, str) else v
                        new_item[new_key] = new_val
                    new_exec_order.append(new_item)
                else:
                    new_exec_order.append(hash_map.get(item, item))

        # Build frontmatter
        fm_lines = [
            f'schema: sase/blueprint/v1',
            f'id: "{new_hash}"',
            f'slug: "{new_slug}"',
            f'title: "{fm.get("mission", "Untitled Blueprint")}"',
            f'version: "1.0.0"',
            f'abstraction-level: "{level}"',
        ]

        # Parameters section
        fm_lines.append("parameters:")
        if parameters:
            for p in parameters:
                fm_lines.append(f'  - name: "{p["name"]}"')
                fm_lines.append(f'    type: "{p["type"]}"')
                req = p.get("required", True)
                fm_lines.append(f"    required: {'true' if req else 'false'}")
                fm_lines.append(f'    description: "{p["description"]}"')
                if p.get("example"):
                    fm_lines.append(f'    example: "{p["example"]}"')
                if p.get("default") is not None:
                    fm_lines.append(f'    default: "{p["default"]}"')
                if p.get("enum-values"):
                    vals = ", ".join(p["enum-values"])
                    fm_lines.append(f"    enum-values: [{vals}]")

        fm_lines.extend(
            [
                f'created: "{today}"',
                f'author: ["{author}"]',
                "provenance:",
                f'  source-bp: "{bp_hash}"',
                f'  source-slug: "{bp_slug}"',
                f'  source-mission: "{fm.get("mission", "")}"',
                f'  extracted-date: "{today}"',
                f'  extracted-by: "{author}"',
                "tags: []",
            ]
        )

        if new_exec_order:
            fm_lines.append("execution-order:")
            for item in new_exec_order:
                if isinstance(item, list):
                    fm_lines.append(f'  - [{", ".join(item)}]')
                elif isinstance(item, dict):
                    for k, v in item.items():
                        fm_lines.append(f"  - {k}: {v}")
                else:
                    fm_lines.append(f"  - {item}")
        else:
            fm_lines.append("execution-order: []")

        fm_lines.extend(
            [
                f'description: "{fm.get("mission", "")}"',
                "instantiation-count: 0",
            ]
        )

        blueprint_content = "---\n" + "\n".join(fm_lines) + "\n---\n" + parameterized_body

        blueprint_path = bp_tmpl_dir / "blueprint.md"
        blueprint_path.write_text(blueprint_content, encoding="utf-8")
        blueprint_files.append(str(blueprint_path.relative_to(REPO_ROOT)))

        if depth > 0:
            result_children.append(
                {
                    "hash": new_hash,
                    "slug": new_slug,
                    "source_hash": bp_hash,
                }
            )

    # Git commit
    if not no_commit:
        for f in blueprint_files:
            subprocess.run(
                ["git", "add", f],
                cwd=str(REPO_ROOT),
                capture_output=True,
            )
        subprocess.run(
            [
                "git",
                "commit",
                "-m",
                f"blueprint(bp-tmpl:{root_blueprint_hash[:6]}): extract from bp:{tree[0][1][:6]}",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
        )

    result = {
        "blueprint_hash": root_blueprint_hash,
        "slug": root_blueprint_slug,
        "directory": str(
            (BLUEPRINTS_DIR / f"{root_blueprint_hash}-{root_blueprint_slug}").relative_to(
                REPO_ROOT
            )
        ),
        "blueprint_path": blueprint_files[0] if blueprint_files else "",
        "children": result_children,
        "parameters": [
            {"name": p["name"], "type": p["type"]}
            for p in _build_parameters_from_analysis(analysis, root_fm, user_params)
        ],
        "source_bp": tree[0][1],
        "committed": not no_commit,
    }

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def _analyze_silent(bp_prefix: str) -> dict:
    """Run analysis without printing."""
    brief_path, full_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent
    root_dir = walk_to_root(bp_dir)
    tree = collect_bp_tree(root_dir)

    root_text = tree[0][0].read_text(encoding="utf-8") if tree else ""
    root_fm = parse_frontmatter(root_text)

    all_suggestions = defaultdict(list)
    bp_structure = []

    for brief, bp_hash, bp_slug, depth in tree:
        text = brief.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        body = get_body(text)
        classifications = classify_text(body, fm)
        for category, items in classifications.items():
            for item in items:
                item["found_in"] = bp_hash
            all_suggestions[category].extend(items)
        bp_structure.append(
            {
                "hash": bp_hash,
                "slug": bp_slug,
                "mission": fm.get("mission", ""),
                "status": fm.get("status", "unknown"),
                "depth": depth,
                "is_parent": has_children(brief.parent),
            }
        )

    param_candidates = _build_param_candidates(all_suggestions)

    return {
        "bp_hash": tree[0][1] if tree else full_hash,
        "bp_slug": tree[0][2] if tree else slug,
        "bp_mission": root_fm.get("mission", ""),
        "bp_tree_depth": max(bp[3] for bp in tree) if tree else 0,
        "total_bps": len(tree),
        "suggested_parameters": param_candidates,
        "classification_summary": {k: len(v) for k, v in all_suggestions.items()},
        "bp_structure": bp_structure,
    }


def _find_parent_hash(
    brief_path: Path, tree: list[tuple[Path, str, str, int]]
) -> str | None:
    """Find the parent BP hash for a given brief.md in the tree."""
    bp_dir = brief_path.parent
    parent_dir = bp_dir.parent
    for _, h, _, _ in tree:
        for p, th, _, _ in tree:
            if p.parent == parent_dir and th != DIR_PATTERN.match(bp_dir.name).group(1):
                continue
            if p.parent == parent_dir:
                return th
    # Fallback: look at directory parent
    m = DIR_PATTERN.match(parent_dir.name)
    if m:
        return m.group(1)
    return None


def _find_blueprint_dir(
    base: Path,
    target_hash: str,
    target_slug: str,
    tree: list,
    hash_map: dict,
) -> Path:
    """Find the directory for a blueprint by hash."""
    for d in base.rglob("blueprint.md"):
        m = DIR_PATTERN.match(d.parent.name)
        if m and m.group(1) == target_hash:
            return d.parent
    # Fallback: construct it
    return base / f"{target_hash}-{target_slug}"


def _build_parameters_from_analysis(
    analysis: dict, fm: dict, user_overrides: dict
) -> list[dict]:
    """Build parameter list from analysis suggestions and user overrides."""
    params = []
    seen_names = set()

    for candidate in analysis.get("suggested_parameters", []):
        name = candidate.get("name", "PARAM")
        # Apply user overrides
        if name in user_overrides:
            override = user_overrides[name]
            if isinstance(override, dict):
                candidate.update(override)
            elif override is None:
                continue  # User explicitly removed this parameter

        if name in seen_names:
            continue
        seen_names.add(name)

        params.append(
            {
                "name": name,
                "type": candidate.get("type", "string"),
                "required": candidate.get("required", True),
                "description": candidate.get(
                    "description",
                    f"Value for {name} (was: {candidate.get('current_value', 'unknown')})",
                ),
                "example": str(candidate.get("current_value", "")),
                "default": candidate.get("default"),
                "enum-values": candidate.get("enum-values"),
            }
        )

    return params


def _parameterize_body(body: str, analysis: dict, parameters: list[dict]) -> str:
    """Replace concrete values in body with {{PARAM}} placeholders."""
    result = body

    # Build replacement map: concrete value -> {{PARAM_NAME}}
    replacements = {}
    for param in parameters:
        example = param.get("example", "")
        if example and len(example) >= 3:
            replacements[example] = "{{" + param["name"] + "}}"

    # Sort by length descending to avoid partial replacements
    for value in sorted(replacements.keys(), key=len, reverse=True):
        placeholder = replacements[value]
        # Be careful: only replace in markdown body, skip YAML-like lines
        result = result.replace(value, placeholder)

    return result


# ---------------------------------------------------------------------------
# Instantiate command
# ---------------------------------------------------------------------------


def cmd_instantiate(
    blueprint_prefix: str,
    params_json: str,
    dry_run: bool = False,
    rigor: str = "standard",
    no_commit: bool = False,
) -> dict:
    """Instantiate concrete BPs from a Blueprint."""
    blueprint_path, full_hash, slug = find_blueprint(blueprint_prefix)
    bp_tmpl_dir = blueprint_path.parent

    # Collect blueprint tree
    tree = _collect_blueprint_tree(bp_tmpl_dir)

    if not tree:
        print("ERROR: Empty Blueprint tree", file=sys.stderr)
        sys.exit(1)

    # Parse parameters
    params = json.loads(params_json) if isinstance(params_json, str) else params_json

    # Read root blueprint and validate parameters
    root_text = tree[0][0].read_text(encoding="utf-8")
    root_fm = parse_frontmatter(root_text)

    param_defs = root_fm.get("parameters", [])
    if isinstance(param_defs, list) and param_defs and isinstance(param_defs[0], dict):
        _validate_params(param_defs, params)
    elif isinstance(param_defs, list):
        # Simple list parsing fallback
        pass

    author = get_git_author()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Generate new hashes for all BPs
    hash_map = {}  # old blueprint hash -> new BP hash
    for bp_path, bp_hash, bp_slug, depth in tree:
        hash_map[bp_hash] = generate_hash()

    root_new_hash = hash_map[tree[0][1]]

    if dry_run:
        result = _dry_run_preview(tree, hash_map, params, rigor)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return result

    BRIEFINGS_DIR.mkdir(parents=True, exist_ok=True)
    created_files = []

    for bp_path, bp_hash, bp_slug, depth in tree:
        text = bp_path.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        body = get_body(text)

        new_hash = hash_map[bp_hash]

        # Apply parameter substitution to title/mission
        mission = fm.get("title", fm.get("mission", "Untitled"))
        mission = _substitute_params(mission, params)
        new_slug = derive_slug(mission)

        # Determine parent directory
        if depth == 0:
            bp_dir = BRIEFINGS_DIR / f"{new_hash}-{new_slug}"
        else:
            parent_hash = _find_blueprint_parent_hash(bp_path, tree)
            if parent_hash and parent_hash in hash_map:
                parent_new_hash = hash_map[parent_hash]
                parent_fm = parse_frontmatter(
                    next(
                        p.read_text(encoding="utf-8")
                        for p, h, _, _ in tree
                        if h == parent_hash
                    )
                )
                parent_mission = _substitute_params(
                    parent_fm.get("title", parent_fm.get("mission", "")), params
                )
                parent_new_slug = derive_slug(parent_mission)
                parent_dir = _find_created_bp_dir(
                    BRIEFINGS_DIR, parent_new_hash
                )
                if parent_dir is None:
                    parent_dir = BRIEFINGS_DIR / f"{parent_new_hash}-{parent_new_slug}"
                bp_dir = parent_dir / f"{new_hash}-{new_slug}"
            else:
                root_slug = derive_slug(
                    _substitute_params(root_fm.get("title", ""), params)
                )
                bp_dir = (
                    BRIEFINGS_DIR
                    / f"{root_new_hash}-{root_slug}"
                    / f"{new_hash}-{new_slug}"
                )

        bp_dir.mkdir(parents=True, exist_ok=True)

        # Substitute parameters in body
        concrete_body = _substitute_params(body, params)

        # Evaluate conditionals
        concrete_body = _evaluate_conditionals(concrete_body, params)

        # Remap blueprint child hashes to new BP hashes
        for old_h, new_h in hash_map.items():
            concrete_body = concrete_body.replace(old_h, new_h)

        # Build execution-order with new hashes
        exec_order = fm.get("execution-order", [])
        new_exec_order = []
        if exec_order:
            for item in exec_order:
                if isinstance(item, list):
                    new_exec_order.append([hash_map.get(h, h) for h in item])
                elif isinstance(item, dict):
                    new_item = {}
                    for k, v in item.items():
                        new_key = hash_map.get(k, k) if isinstance(k, str) else k
                        new_val = hash_map.get(v, v) if isinstance(v, str) else v
                        new_item[new_key] = new_val
                    new_exec_order.append(new_item)
                else:
                    new_exec_order.append(hash_map.get(item, item))

        # Build BP frontmatter
        is_parent = has_children_in_blueprint(bp_path.parent, tree, bp_hash)

        loop_script = (
            "skills/engineering/loops/high-rigor.yaml"
            if rigor in ("high", "critical")
            else "skills/engineering/loops/standard.yaml"
        )

        fm_lines = [
            f'schema: sase/briefing-pack/v3',
            f'id: "{new_hash}"',
            f'slug: "{new_slug}"',
            f'mission: "{mission}"',
            f'created: "{today}"',
            f'author: ["{author}"]',
            f"status: draft",
            f'rigor: "{rigor}"',
            "depends-on: []",
        ]

        if new_exec_order:
            fm_lines.append("execution-order:")
            for item in new_exec_order:
                if isinstance(item, list):
                    fm_lines.append(f'  - [{", ".join(item)}]')
                elif isinstance(item, dict):
                    for k, v in item.items():
                        fm_lines.append(f"  - {k}: {v}")
                else:
                    fm_lines.append(f"  - {item}")
        else:
            fm_lines.append("execution-order: []")

        fm_lines.extend(
            [
                f'loop-script: "{loop_script}"',
                "mentor-scripts:",
                '  - "mentorscripts/global.md"',
                "reviewers: []",
                'approver: ""',
            ]
        )

        bp_content = "---\n" + "\n".join(fm_lines) + "\n---\n" + concrete_body

        brief_file = bp_dir / "brief.md"
        brief_file.write_text(bp_content, encoding="utf-8")
        created_files.append(str(brief_file.relative_to(REPO_ROOT)))

    # Update instantiation-count on the blueprint
    _increment_instantiation_count(blueprint_path)

    # Git commit
    if not no_commit:
        for f in created_files:
            subprocess.run(
                ["git", "add", f],
                cwd=str(REPO_ROOT),
                capture_output=True,
            )
        # Also add updated blueprint
        subprocess.run(
            ["git", "add", str(blueprint_path.relative_to(REPO_ROOT))],
            cwd=str(REPO_ROOT),
            capture_output=True,
        )
        subprocess.run(
            [
                "git",
                "commit",
                "-m",
                f"draft(bp:{root_new_hash[:6]}): instantiate from blueprint:{full_hash[:6]}",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
        )
        # Regenerate index
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "build-index.py")],
            cwd=str(REPO_ROOT),
            capture_output=True,
        )

    root_slug = derive_slug(_substitute_params(root_fm.get("title", ""), params))
    result = {
        "bp_hash": root_new_hash,
        "slug": root_slug,
        "directory": str(
            (BRIEFINGS_DIR / f"{root_new_hash}-{root_slug}").relative_to(REPO_ROOT)
        ),
        "children": [
            {
                "hash": hash_map[bp_hash],
                "slug": derive_slug(
                    _substitute_params(
                        parse_frontmatter(p.read_text(encoding="utf-8")).get(
                            "title",
                            parse_frontmatter(p.read_text(encoding="utf-8")).get(
                                "mission", s
                            ),
                        ),
                        params,
                    )
                ),
                "depth": d,
            }
            for p, bp_hash, s, d in tree
            if d > 0
        ],
        "blueprint_hash": full_hash,
        "committed": not no_commit,
    }

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return result


def _collect_blueprint_tree(
    root_dir: Path,
) -> list[tuple[Path, str, str, int]]:
    """Collect all Blueprints in a tree."""
    results = []
    m = DIR_PATTERN.match(root_dir.name)
    if m and (root_dir / "blueprint.md").exists():
        results.append((root_dir / "blueprint.md", m.group(1), m.group(2), 0))

    def _walk(parent: Path, depth: int):
        for child in sorted(parent.iterdir()):
            if child.is_dir():
                cm = DIR_PATTERN.match(child.name)
                if cm and (child / "blueprint.md").exists():
                    results.append(
                        (child / "blueprint.md", cm.group(1), cm.group(2), depth + 1)
                    )
                    _walk(child, depth + 1)

    _walk(root_dir, 0)
    return results


def has_children_in_blueprint(
    bp_dir: Path, tree: list[tuple[Path, str, str, int]], bp_hash: str
) -> bool:
    """Check if a blueprint has children in the tree."""
    for _, h, _, d in tree:
        if h == bp_hash:
            my_depth = d
            break
    else:
        return False

    for p, h, _, d in tree:
        if d == my_depth + 1 and str(bp_dir) in str(p.parent.parent):
            return True
    return False


def _validate_params(param_defs: list[dict], params: dict) -> None:
    """Validate provided params against parameter definitions."""
    errors = []
    for pdef in param_defs:
        name = pdef.get("name", "")
        required = pdef.get("required", True)
        if isinstance(required, str):
            required = required.lower() == "true"

        if required and name not in params:
            default = pdef.get("default")
            if default is None:
                errors.append(f"Missing required parameter: {name}")

        if name in params:
            ptype = pdef.get("type", "string")
            value = params[name]

            if ptype == "enum":
                enum_vals = pdef.get("enum-values", [])
                if enum_vals and str(value) not in enum_vals:
                    errors.append(
                        f"Parameter {name}: value '{value}' not in allowed values {enum_vals}"
                    )
            elif ptype == "boolean":
                if str(value).lower() not in ("true", "false", "yes", "no", "1", "0"):
                    errors.append(
                        f"Parameter {name}: value '{value}' is not a valid boolean"
                    )
            elif ptype == "number":
                try:
                    float(value)
                except (ValueError, TypeError):
                    errors.append(
                        f"Parameter {name}: value '{value}' is not a valid number"
                    )

    if errors:
        print("VALIDATION ERRORS:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)


def _substitute_params(text: str, params: dict) -> str:
    """Replace {{PARAM_NAME}} placeholders with provided values."""
    result = text
    for name, value in params.items():
        placeholder = "{{" + name + "}}"
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
        result = result.replace(placeholder, str(value))
    return result


def _evaluate_conditionals(text: str, params: dict) -> str:
    """Evaluate {% if PARAM %}...{% endif %} conditional sections."""
    # Handle {% if PARAM %}...{% endif %}
    pattern = re.compile(
        r"\{%\s*if\s+(not\s+)?(\w+)\s*%\}(.*?)\{%\s*endif\s*%\}",
        re.DOTALL,
    )

    def _replace(match):
        negated = match.group(1) is not None
        param_name = match.group(2)
        content = match.group(3)

        value = params.get(param_name)
        is_truthy = bool(value) and str(value).lower() not in ("false", "0", "no", "")

        if negated:
            is_truthy = not is_truthy

        return content if is_truthy else ""

    return pattern.sub(_replace, text)


def _dry_run_preview(
    tree: list[tuple[Path, str, str, int]],
    hash_map: dict,
    params: dict,
    rigor: str,
) -> dict:
    """Generate a preview of what instantiation would produce."""
    preview = {
        "mode": "dry-run",
        "would_create": [],
    }
    for bp_path, bp_hash, bp_slug, depth in tree:
        fm = parse_frontmatter(bp_path.read_text(encoding="utf-8"))
        mission = _substitute_params(
            fm.get("title", fm.get("mission", "")), params
        )
        new_slug = derive_slug(mission)
        preview["would_create"].append(
            {
                "hash": hash_map[bp_hash],
                "slug": new_slug,
                "mission": mission,
                "depth": depth,
                "is_leaf": not has_children_in_blueprint(
                    bp_path.parent, tree, bp_hash
                ),
            }
        )
    return preview


def _find_blueprint_parent_hash(
    bp_path: Path, tree: list[tuple[Path, str, str, int]]
) -> str | None:
    """Find parent blueprint hash."""
    parent_dir = bp_path.parent.parent
    m = DIR_PATTERN.match(parent_dir.name)
    if m:
        return m.group(1)
    return None


def _find_created_bp_dir(base: Path, target_hash: str) -> Path | None:
    """Find an already-created BP directory by hash."""
    for d in base.iterdir():
        if d.is_dir():
            m = DIR_PATTERN.match(d.name)
            if m and m.group(1) == target_hash:
                return d
    return None


def _increment_instantiation_count(blueprint_path: Path) -> None:
    """Increment the instantiation-count in a blueprint's frontmatter."""
    text = blueprint_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    count = int(fm.get("instantiation-count", "0"))
    new_count = count + 1

    # Simple replacement in the raw text
    text = re.sub(
        r"instantiation-count:\s*\d+",
        f"instantiation-count: {new_count}",
        text,
    )
    blueprint_path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Validate command
# ---------------------------------------------------------------------------


def cmd_validate(blueprint_prefix: str) -> dict:
    """Validate a Blueprint for consistency."""
    blueprint_path, full_hash, slug = find_blueprint(blueprint_prefix)
    bp_tmpl_dir = blueprint_path.parent
    tree = _collect_blueprint_tree(bp_tmpl_dir)

    errors = []
    warnings = []

    for bp_path, bp_hash, bp_slug, depth in tree:
        text = bp_path.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        body = get_body(text)

        # Check schema
        if fm.get("schema") != "sase/blueprint/v1":
            errors.append(f"{bp_hash[:6]}: schema must be 'sase/blueprint/v1'")

        # Check required fields
        for field in ("id", "slug", "title", "version", "abstraction-level"):
            if not fm.get(field):
                errors.append(f"{bp_hash[:6]}: missing required field '{field}'")

        # Check version format
        version = fm.get("version", "")
        if version and not re.match(r"^\d+\.\d+\.\d+$", version):
            errors.append(f"{bp_hash[:6]}: version '{version}' is not valid SemVer")

        # Check abstraction level
        level = fm.get("abstraction-level", "")
        if level and level not in ("methodology", "technology", "project"):
            errors.append(f"{bp_hash[:6]}: invalid abstraction-level '{level}'")

        # Find placeholders in body
        body_params = set(re.findall(r"\{\{([A-Z][A-Z0-9_]*)\}\}", body))

        # Find defined parameters
        param_defs = fm.get("parameters", [])
        defined_params = set()
        if isinstance(param_defs, list):
            for p in param_defs:
                if isinstance(p, dict):
                    defined_params.add(p.get("name", ""))

        # Check for orphaned placeholders
        orphaned = body_params - defined_params
        # Exclude internal placeholders like CHILD_BP_HASH
        orphaned -= {"CHILD_BP_HASH"}
        if orphaned:
            for p in orphaned:
                warnings.append(
                    f"{bp_hash[:6]}: placeholder '{{{{{p}}}}}' not defined in parameters"
                )

        # Check for unused parameters
        unused = defined_params - body_params
        if unused:
            for p in unused:
                warnings.append(
                    f"{bp_hash[:6]}: parameter '{p}' defined but not used in body"
                )

        # Check conditional syntax
        opens = len(re.findall(r"\{%\s*if\s+", body))
        closes = len(re.findall(r"\{%\s*endif\s*%\}", body))
        if opens != closes:
            errors.append(
                f"{bp_hash[:6]}: mismatched conditionals ({opens} if, {closes} endif)"
            )

        # Check provenance
        provenance = fm.get("provenance", {})
        if not provenance or not isinstance(provenance, dict):
            warnings.append(f"{bp_hash[:6]}: missing provenance metadata")

    result = {
        "blueprint_hash": full_hash,
        "slug": slug,
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }

    if errors:
        print(f"VALIDATION FAILED for bp-tmpl:{full_hash[:6]} ({slug})")
        print(f"\nErrors ({len(errors)}):")
        for e in errors:
            print(f"  ERROR: {e}")
    else:
        print(f"VALIDATION PASSED for bp-tmpl:{full_hash[:6]} ({slug})")

    if warnings:
        print(f"\nWarnings ({len(warnings)}):")
        for w in warnings:
            print(f"  WARN: {w}")

    if not errors and not warnings:
        print("  No issues found.")

    return result


# ---------------------------------------------------------------------------
# List command
# ---------------------------------------------------------------------------


def cmd_list(
    level: str | None = None,
    tag: str | None = None,
    as_json: bool = False,
) -> list[dict]:
    """List all available Blueprints."""
    all_blueprints = find_all_blueprints()

    results = []
    for bp_path, bp_hash, bp_slug in all_blueprints:
        text = bp_path.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)

        bp_level = fm.get("abstraction-level", "")
        bp_tags = fm.get("tags", [])
        if isinstance(bp_tags, str):
            bp_tags = [bp_tags]

        # Apply filters
        if level and bp_level != level:
            continue
        if tag and tag not in bp_tags:
            continue

        results.append(
            {
                "hash": bp_hash,
                "slug": bp_slug,
                "title": fm.get("title", ""),
                "version": fm.get("version", "1.0.0"),
                "abstraction-level": bp_level,
                "tags": bp_tags,
                "instantiation-count": int(
                    fm.get("instantiation-count", "0")
                ),
                "description": fm.get("description", ""),
            }
        )

    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif results:
        print("BLUEPRINTS")
        print("==========\n")
        print(
            f"  {'Hash':<10} {'Slug':<30} {'Level':<14} {'Tags':<20} {'Ver':<8} {'Used'}"
        )
        print(
            f"  {'─' * 10} {'─' * 30} {'─' * 14} {'─' * 20} {'─' * 8} {'─' * 5}"
        )
        for r in results:
            tags = ", ".join(r["tags"][:3]) if r["tags"] else ""
            print(
                f"  {r['hash'][:6]:<10} {r['slug']:<30} {r['abstraction-level']:<14} "
                f"{tags:<20} {r['version']:<8} {r['instantiation-count']}"
            )
        print(f"\n{len(results)} blueprint(s) found.")
    else:
        print("No blueprints found.")
        if level or tag:
            print(f"  (filtered by: level={level}, tag={tag})")

    return results


# ---------------------------------------------------------------------------
# Info command
# ---------------------------------------------------------------------------


def cmd_info(blueprint_prefix: str, as_json: bool = False) -> dict:
    """Show detailed info about a Blueprint."""
    blueprint_path, full_hash, slug = find_blueprint(blueprint_prefix)
    bp_tmpl_dir = blueprint_path.parent
    tree = _collect_blueprint_tree(bp_tmpl_dir)

    text = blueprint_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    body = get_body(text)

    params = fm.get("parameters", [])
    provenance = fm.get("provenance", {})

    result = {
        "hash": full_hash,
        "slug": slug,
        "title": fm.get("title", ""),
        "version": fm.get("version", ""),
        "abstraction-level": fm.get("abstraction-level", ""),
        "description": fm.get("description", ""),
        "tags": fm.get("tags", []),
        "parameters": params,
        "provenance": provenance,
        "instantiation-count": int(fm.get("instantiation-count", "0")),
        "tree": [
            {
                "hash": h,
                "slug": s,
                "depth": d,
                "title": parse_frontmatter(
                    p.read_text(encoding="utf-8")
                ).get("title", ""),
            }
            for p, h, s, d in tree
        ],
    }

    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"BLUEPRINT: bp-tmpl:{full_hash[:6]} ({slug})")
        print(f"  Title: {result['title']}")
        print(f"  Version: {result['version']}")
        print(f"  Level: {result['abstraction-level']}")
        print(f"  Tags: {', '.join(result['tags']) if result['tags'] else '(none)'}")
        print(f"  Used: {result['instantiation-count']} time(s)")

        if provenance and isinstance(provenance, dict):
            print(f"\n  Provenance:")
            print(f"    Source BP: bp:{provenance.get('source-bp', '?')[:6]} ({provenance.get('source-slug', '?')})")
            print(f"    Extracted: {provenance.get('extracted-date', '?')} by {provenance.get('extracted-by', '?')}")

        if params:
            print(f"\n  Parameters ({len(params)}):")
            print(f"    {'Name':<25} {'Type':<10} {'Required':<10} {'Description'}")
            print(f"    {'─' * 25} {'─' * 10} {'─' * 10} {'─' * 30}")
            for p in params:
                if isinstance(p, dict):
                    req = "yes" if p.get("required", True) else "no"
                    if isinstance(req, str) and req.lower() in ("true", "yes"):
                        req = "yes"
                    elif isinstance(req, str) and req.lower() in ("false", "no"):
                        req = "no"
                    print(
                        f"    {p.get('name', '?'):<25} {p.get('type', '?'):<10} "
                        f"{req:<10} {p.get('description', '')[:30]}"
                    )

        if len(tree) > 1:
            print(f"\n  Structure ({len(tree)} blueprints):")
            for p, h, s, d in tree:
                indent = "    " + "  " * d
                print(f"{indent}bp-tmpl:{h[:6]} ({s})")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Blueprint Engine for i-SASE",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # analyze
    p_analyze = subparsers.add_parser("analyze", help="Analyze a BP tree for extraction")
    p_analyze.add_argument("bp_hash", help="BP hash prefix")
    p_analyze.add_argument("--json", action="store_true", help="Output as JSON")

    # extract
    p_extract = subparsers.add_parser("extract", help="Extract Blueprint from BP tree")
    p_extract.add_argument("bp_hash", help="BP hash prefix")
    p_extract.add_argument("--params", help="Parameter overrides as JSON string")
    p_extract.add_argument(
        "--level",
        default="technology",
        choices=["methodology", "technology", "project"],
    )
    p_extract.add_argument("--no-commit", action="store_true")

    # instantiate
    p_inst = subparsers.add_parser(
        "instantiate", help="Create BPs from Blueprint"
    )
    p_inst.add_argument("blueprint_hash", help="Blueprint hash prefix")
    p_inst.add_argument("--params", required=True, help="Parameters as JSON string")
    p_inst.add_argument("--dry-run", action="store_true")
    p_inst.add_argument(
        "--rigor", default="standard", choices=["standard", "high", "critical"]
    )
    p_inst.add_argument("--no-commit", action="store_true")

    # list
    p_list = subparsers.add_parser("list", help="List available Blueprints")
    p_list.add_argument("--level", choices=["methodology", "technology", "project"])
    p_list.add_argument("--tag", help="Filter by tag")
    p_list.add_argument("--json", action="store_true")

    # validate
    p_validate = subparsers.add_parser("validate", help="Validate a Blueprint")
    p_validate.add_argument("blueprint_hash", help="Blueprint hash prefix")

    # info
    p_info = subparsers.add_parser("info", help="Show Blueprint details")
    p_info.add_argument("blueprint_hash", help="Blueprint hash prefix")
    p_info.add_argument("--json", action="store_true")

    args = parser.parse_args()

    if args.command == "analyze":
        cmd_analyze(args.bp_hash, as_json=args.json)
    elif args.command == "extract":
        cmd_extract(
            args.bp_hash,
            params_json=args.params,
            level=args.level,
            no_commit=args.no_commit,
        )
    elif args.command == "instantiate":
        cmd_instantiate(
            args.blueprint_hash,
            params_json=args.params,
            dry_run=args.dry_run,
            rigor=args.rigor,
            no_commit=args.no_commit,
        )
    elif args.command == "list":
        cmd_list(level=args.level, tag=args.tag, as_json=args.json)
    elif args.command == "validate":
        cmd_validate(args.blueprint_hash)
    elif args.command == "info":
        cmd_info(args.blueprint_hash, as_json=args.json)


if __name__ == "__main__":
    main()

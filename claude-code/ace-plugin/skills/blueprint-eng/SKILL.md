---
name: "BlueprintEng"
description: "Blueprint Engineering — Creating and managing reusable Agent Templates"
---

# Skill: BlueprintEng — Blueprint Engineering

## Purpose

Blueprint Engineering is the discipline of abstracting concrete, project-specific BriefingPacks into reusable, parameterized templates. A well-crafted Blueprint captures institutional knowledge about how to decompose and execute a class of missions — turning one team's hard-won experience into a repeatable playbook.

The key insight: **abstraction is not deletion**. Removing all concrete details produces a useless skeleton. Good Blueprints preserve structure, methodology, quality criteria, and anonymized examples while replacing only the project-specific values with typed parameters.

## Key Concepts

### Three-Level Abstraction Model

Blueprints are classified by their abstraction level:

| Level | Scope | Example |
|-------|-------|---------|
| **methodology** | Any legacy modernization, any technology | "Reverse Engineering Pipeline" (phases: static, semantic, knowledge, verification) |
| **technology** | Specific source/target pair, project-independent | "COBOL-to-Java Batch Conversion" (CICS mappings, DB2 retention, copybook handling) |
| **project** | Project-template with many parameters | "VGH Insurance Migration — PoC Slice" (specific program lists, LOC counts, business rules) |

Higher levels are more reusable; lower levels are more actionable. A Blueprint tree may mix levels — a methodology-level parent with technology-level children.

### Blueprint Identification

Blueprints use the same 12-character hex hash IDs as BriefingPacks:
```bash
openssl rand -hex 6
```

Blueprints are stored as `blueprint.md` inside a directory named `{hash}-{slug}`:
```
artifacts/blueprints/{hash}-{slug}/blueprint.md
```

Display format: `bp-tmpl:{hash[:6]} ({slug})`

### Parameter System

Parameters are typed placeholders that get replaced during instantiation:

```yaml
parameters:
  - name: LEGACY_SOURCE_PATH
    type: path
    required: true
    description: "Root directory of COBOL source code"
    example: "10-legacy/10-100k-poc-slice/"
```

**Supported types:**

| Type | Validation | Example |
|------|-----------|---------|
| `string` | Non-empty string | `"VGH Insurance Migration"` |
| `path` | Valid file/directory path | `"src/main/cobol/"` |
| `number` | Numeric value | `23` |
| `boolean` | `true` or `false` | `true` |
| `enum` | Value must be in `enum-values` list | `"db2"` from `[db2, vsam, ims-db]` |
| `list` | Comma-separated or array of strings | `["PROG001", "PROG002"]` |

**Naming convention:** `UPPER_SNAKE_CASE`, pattern `^[A-Z][A-Z0-9_]*$`.

### Placeholder Syntax

In the Blueprint body, parameters are referenced as `{{PARAMETER_NAME}}`:

```markdown
## Goal & Why

Perform comprehensive reverse engineering of the {{DB_TECHNOLOGY}}-based
COBOL codebase at `{{LEGACY_SOURCE_PATH}}` to produce machine-readable
analysis artifacts for {{PROGRAM_COUNT}} programs.
```

### Conditional Sections

Sections can be conditionally included based on boolean parameters:

```markdown
{% if HAS_CENTRAL_DATA_HANDLER %}
## Data Handler Analysis

Analyze the central data abstraction layer at `{{DATA_HANDLER_PATH}}`...
{% endif %}
```

Supported constructs (minimal, no external template engine):
- `{% if PARAM_NAME %}...{% endif %}` — include when parameter is truthy
- `{% if not PARAM_NAME %}...{% endif %}` — include when parameter is falsy

### Provenance Tracking

Every Blueprint records where it came from:

```yaml
provenance:
  source-bp: "53fcbce07bf1"
  source-slug: "cobol-extraction"
  source-mission: "Comprehensive COBOL Reverse Engineering"
  extracted-date: 2026-04-10
  extracted-by: "Thorsten Maier"
```

This allows users to assess how much they can trust a Blueprint — what scope it was validated on, and who created it.

### Anonymized Examples

When extracting a Blueprint, concrete examples are preserved but anonymized:

- Program names: `LNN0134F` -> `PROG001`, `DMDH001P` -> `HANDLER001`
- File paths: replaced with `{{PARAM}}` placeholders
- Numbers: replaced with size classes or parameters
- Business logic: structure preserved, specifics generalized

This ensures the Blueprint remains actionable — not just an empty template.

## Extraction Process

Blueprints are extracted from existing, completed BP trees via `/blueprint extract`:

1. **Auto-Analysis**: Script scans the BP tree, classifies text segments as project-specific vs. reusable, suggests parameters with types
2. **User Refinement**: User reviews suggestions in chat, adjusts parameters, sets abstraction level, adds tags
3. **Generation**: Script produces the Blueprint tree with placeholders and provenance

### Classification Heuristics

| Pattern | Classification | Suggested Parameter Type |
|---------|---------------|-------------------------|
| File paths (`scripts/...`, `src/...`) | Project-specific | `path` |
| 12-char hex IDs | Always replace | (internal, not parameterized) |
| Numbers in LOC/count context | Project-specific | `number` |
| COBOL program names (`[A-Z]{2,}[0-9]{2,}`) | Project-specific | `string` or `list` |
| Technology keywords (FastAPI, DB2, CICS) | Technology-level | `enum` |
| Team/person names | Project-specific | `string` |

## Instantiation Process

Blueprints are instantiated into concrete BPs via `/blueprint instantiate`:

1. **Parameter Collection**: Walk through each parameter, collect values from user
2. **Validation**: Verify all required parameters present, types correct
3. **BP Generation**: Replace placeholders, evaluate conditionals, generate new BP tree with fresh IDs
4. **Output**: New BP tree under `artifacts/briefings/` with `status: draft`

## Template

The Blueprint template is located at:
```
skills/blueprint-eng/templates/blueprint.md
```

## Quality Criteria

A Blueprint is ready for use when:

1. **All parameters documented** — Every `{{PARAM}}` in the body has a corresponding entry in `parameters` with type, description, and example
2. **No orphaned placeholders** — No `{{PARAM}}` in the body without a parameter definition
3. **No unused parameters** — No parameter definition without at least one `{{PARAM}}` reference
4. **Valid conditional syntax** — Every `{% if %}` has a matching `{% endif %}`
5. **Complete provenance** — Source BP, extraction date, and extractor are recorded
6. **Anonymized examples present** — At least one concrete example preserved in anonymized form
7. **Correct metadata** — Hash ID valid, slug valid, version is SemVer, abstraction level set

## Anti-Patterns

- **The Naked Template**: Too many details removed, leaving an empty skeleton that provides no guidance. Blueprints should preserve structural knowledge, methodology, and quality criteria.
- **The Over-Parameterized Blueprint**: Every sentence has a placeholder. If a Blueprint has more than 15 parameters, it is likely too specific for its abstraction level — consider splitting or raising the level.
- **The Copy-Paste Blueprint**: Concrete project details left in by accident. Always validate with `/blueprint validate` after extraction.
- **The Parameter Soup**: Parameters with unclear names or no examples. Every parameter should be self-documenting — a user seeing `{{BATCH_SCHEDULING_STRATEGY}}` without an example cannot provide a meaningful value.

## Directory Structure

```
artifacts/blueprints/
  .index.json                        # Auto-generated index
  INDEX.md                           # Human-readable index
  {hash}-{slug}/
    blueprint.md                     # Root blueprint
    {hash}-{slug}/
      blueprint.md                   # Child blueprint (mirrors BP hierarchy)
```

Hierarchical Blueprints mirror the BP decomposition pattern: a parent Blueprint with `execution-order` and child Blueprint subdirectories, each producing a child BP on instantiation.

---
description: "Validate BriefingPack dispatch readiness without dispatching"
allowed-tools: [Read, Grep, Glob, Bash]
---

# ACE Command: validate

You are the **BP Validator**. Your job is to run the 10 deterministic dispatch-readiness checks on one or more BriefingPacks and report the results — without transitioning status or launching agents.

## Invocation

```
/validate a3f7c2           → Validate a single BP by hash prefix
/validate --all            → Validate all non-archived leaf BPs
```

The argument `$ARGUMENTS` is required — it must be a BP hash (or unique prefix) or `--all`.

## Argument Parsing

Parse `$ARGUMENTS` to determine the mode:

1. **Hex hash prefix** (e.g. `a3f7c2` or `a3f7c2e1b9d4`) → Single BP validation
2. **`--all`** → Batch validation of all non-archived leaf BPs
3. **Empty or unrecognized** → Show usage hint:
   ```
   Usage: /validate {bp-hash-prefix}   or   /validate --all
   ```

---

## Workflow: Single BP Validation

### Step 1 -- Run Validation Script

```bash
python3 scripts/validate-bp.py {bp-hash-prefix} --json
```

Handle exit codes:
- **Exit code 2**: BP not found. Display the error output and stop.
- **Exit code 0 or 1**: Parse the JSON output and proceed to Step 2.

### Step 2 -- Display Results

Parse the JSON and display in this format:

```
VALIDATE: bp:{hash-abbrev} ({slug})
--------------------------------------
  [PASS] leaf-only: BP is a leaf (no child subdirectories)
  [PASS] status-ready: Status is 'ready'
  [PASS] id-format: ID '{id}' is valid 12-char hex
  [PASS] mission-present: Mission: "..."
  [PASS] loop-script: LoopScript resolved: ...
  [PASS] mentor-scripts: All N mentor-script(s) exist
  [PASS] ac-count: N acceptance criteria found
  [PASS] goal-section: Goal & Why section has content
  [WARN] context-references: Context section has no concrete file or module references
  [PASS] dependencies: All dependencies satisfied

Result: VALID (9/10 passed, 1 warning)
Warnings: Context references missing — may be inherited from parent BP
```

For each check in `checks`:
- `passed == true` → `[PASS]`
- `passed == false` and `severity == "warning"` → `[WARN]`
- `passed == false` (no warning severity) → `[FAIL]`

### Step 3 -- Suggest Next Steps

Based on the `valid` field in the result:

**If valid:**
```
Next: /ace:dispatch {hash}
```

**If invalid:**
List each failed check briefly, then:
```
Fix with: /ace:brief {hash}
Then re-validate: /ace:validate {hash}
```

---

## Workflow: Batch Validation (`--all`)

### Step 1 -- Regenerate Index

```bash
python3 scripts/build-index.py
```

### Step 2 -- Enumerate Leaf BPs

Read `artifacts/briefings/.index.json`. For each entry in `briefings`, check `is_leaf == true` (or `children` is empty/absent). Collect all leaf BP hashes.

If no leaf BPs are found, display:
```
No leaf BPs found. Use /ace:brief to create one.
```

### Step 3 -- Validate Each BP

For each leaf BP hash, run:

```bash
python3 scripts/validate-bp.py {full-hash} --json
```

Collect all results.

### Step 4 -- Display Summary

```
BP VALIDATION SUMMARY
---------------------
  [VALID]   bp:{hash} ({slug})    {passed}/{total} passed
  [VALID]   bp:{hash} ({slug})    {passed}/{total} passed  {N} warning(s)
  [INVALID] bp:{hash} ({slug})    {passed}/{total} passed  {N} failed

Summary: {valid_count}/{total_count} valid, {invalid_count} invalid
```

Sort: invalid BPs first, then valid with warnings, then fully valid.

If any BPs are invalid, add:
```
Run /ace:validate {hash} on individual BPs to see detailed check results.
```

---

## Output Format

- Use the compact text format shown above, not markdown tables.
- Every result gets an actionable next-step suggestion.
- This command is read-only — it never modifies BP status, frontmatter, or git state.

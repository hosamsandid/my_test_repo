'use strict';

// ============================================================
// Prompt assembly (single source of truth)
// ============================================================
//
// Everything an agent receives beyond its authored role prompt is composed
// here: the CLAUDE.md that gets seeded into the workspace, and the runtime
// `--append-system-prompt` memory hint. Keeping the composition in one pure,
// fs-free module means:
//
//   * the prompt-preview endpoint renders EXACTLY what gets seeded (it calls the
//     same functions with the same inputs), so operators review the composed
//     whole instead of guessing from individual files;
//   * the ordering / de-duplication / conditional-gating rules live in one
//     testable place instead of being smeared across a template file, a JS
//     builder, and a Python builder.
//
// The base CLAUDE.md template text is passed IN (read from disk by the caller)
// so this module has no I/O and is trivial to unit-test.
//
// IMPORTANT: `buildMemoryHint()` is mirrored byte-for-byte by
// `_build_memory_hint()` in agent-image/scripts/agent-entrypoint.py (the live
// runtime). If you change one, change the other — a test asserts the expected
// string so drift is caught.

// ------------------------------------------------------------
// Conditional / relocated sections
//
// These used to live either inside the monolithic base template (always
// injected) or inline in buildAgentClaudeMd. They are now first-class blocks so
// the assembler can (a) reorder them and (b) drop the ones that are dead weight
// for a given agent:
//   * WORKSPACE_SECTION  — the SINGLE home for the /workspace path-translation
//     rule (the runtime memory hint no longer repeats it → no duplication).
//   * GIT_SECTION        — injected only when the agent's environment has at
//     least one repository (a pure-DM agent with no repo never sees it).
//   * TRIGGER_SECTION    — injected only for autonomous agents (per-invocation,
//     orchestrator/bp-instance, or an agent that already has triggers).
// ------------------------------------------------------------

const WORKSPACE_SECTION =
  "## Workspace\n\n" +
  "Your workspace root is the current working directory. All files (repos, skills, memory) are here.\n" +
  "Memory entries may contain absolute paths like `/workspace/...` from a shared template — " +
  "translate these to relative paths (e.g. `/workspace/314092_foo/` → `./314092_foo/`).";

const GIT_SECTION =
  "## GitHub Actions — Identity Tagging\n\n" +
  "When you act on GitHub (commits, PRs, reviews, comments), you MUST tag every action with your agent identity. All agents in this stack share one GitHub PAT, so the central poller cannot tell who did what from the GitHub identity alone — it relies on these tags to skip events you caused yourself. Without them, you will eventually trigger yourself in a loop.\n\n" +
  "`gh-as-agent` is the wrapper for doing git/GitHub actions as you. It understands these verbs:\n\n" +
  "| Verb | Use |\n" +
  "|---|---|\n" +
  "| `gh-as-agent commit [git-commit-args …]` | Commit with `--author` set to your agent id |\n" +
  "| `gh-as-agent push [--repo <name>] [--branch <b>] [--no-set-upstream]` | Push the current (or `--branch`) branch via the platform |\n" +
  "| `gh-as-agent pr --title <t> [--body-file <f>] [--base <branch>] [--repo <name>] [--draft]` | Push the current branch, then open a PR (body auto-stamped) |\n" +
  "| `gh-as-agent stamp <file>` | Append your agent marker to a body file before you post it |\n" +
  "| `gh-as-agent marker` | Print the marker (for inlining) |\n\n" +
  "**You MUST push and open PRs via `gh-as-agent push` / `gh-as-agent pr` — not raw `git push` / `gh pr create`.** Depending on this agent's model provider, the org's managed Claude Code policy can force interactive human approval for `git push` / `gh pr create`, which is impossible in an unattended (triggered/scheduled) run — so a raw push just fails. `gh-as-agent push` / `pr` run the network step through the platform with the environment's credentials, and stamp your identity so loop-protection keeps working. `git commit` is not blocked, so commit locally first. On a multi-repo environment add `--repo <clone-dir-name>`. If `gh-as-agent push`/`pr` reports a failure (non-fast-forward, auth), surface it to the user — do not retry with a raw `git push`.\n\n" +
  "Typical flow:\n" +
  "```bash\n" +
  "gh-as-agent commit -m \"feat: implement the thing\"\n" +
  "gh-as-agent pr --title \"Implement the thing\" --body-file /tmp/pr-body.md --base main\n" +
  "```\n\n" +
  "**Everything else → plain `gh`.** When the action carries a body (PR review, issue create/comment), write the body to a file, `gh-as-agent stamp <file>`, then post with `gh … --body-file <file>`. Read-only and label operations (`gh issue/pr list/view/edit`, `gh label create`) need no stamp. There is no `gh-as-agent issue …` / `gh-as-agent label …` — those subcommands do not exist.\n\n" +
  "Example for a PR review:\n" +
  "```bash\n" +
  "cat > /tmp/review.md <<'EOF'\n" +
  "... your review text ...\n" +
  "EOF\n" +
  "gh-as-agent stamp /tmp/review.md\n" +
  "gh pr review <NUM> --comment --body-file /tmp/review.md\n" +
  "```\n\n" +
  "`stamp` is idempotent (re-stamping the same file is a no-op). The marker is an HTML comment, invisible in rendered Markdown but present in the source.";

const TRIGGER_SECTION =
  "## Trigger management (triggers.json)\n\n" +
  "Your runs can be driven by triggers defined in `triggers.json` at your workspace root. " +
  "You can read and edit this file yourself to adjust your own schedule.\n\n" +
  "### Trigger types\n\n" +
  "**Recurring (cron):**\n" +
  "```json\n" +
  "{\n" +
  '  "id": "unique-id",\n' +
  '  "type": "cron",\n' +
  '  "enabled": true,\n' +
  '  "cron": "*/30 * * * *",\n' +
  '  "description": "Description",\n' +
  '  "prompt": "What you should do on each run"\n' +
  "}\n" +
  "```\n" +
  "Cron format: `Minute Hour Day Month Weekday`\n\n" +
  "**One-shot (once):**\n" +
  "```json\n" +
  "{\n" +
  '  "id": "unique-id",\n' +
  '  "type": "once",\n' +
  '  "enabled": true,\n' +
  '  "at": "2026-04-25T09:00:00",\n' +
  '  "description": "Description",\n' +
  '  "prompt": "What you should do"\n' +
  "}\n" +
  "```\n\n" +
  "### Managing triggers\n\n" +
  "1. Read `triggers.json`\n" +
  "2. Add, modify or remove triggers\n" +
  "3. Write the file back\n" +
  "4. Changes are picked up automatically within 60 seconds\n\n" +
  "### Optional fields\n\n" +
  "- `roomId` — target room for the output (default: direct-message room with the admin)\n" +
  "- `timeoutSeconds` — max execution time (default: 3600)\n\n" +
  "If a scheduled run has nothing to report, reply with `[PASS]`.";

// Canonical section headings the assembler pulls out of the base template and
// re-orders. Anything else in the template is preserved verbatim (see below).
const KNOWN_BASE_HEADINGS = [
  "Response Formatting",
  "Memory System",
  "Skills",
  "Important Notes",
];

// Headings whose content is now owned by this module (WORKSPACE_SECTION /
// GIT_SECTION / TRIGGER_SECTION) and injected conditionally. If a STALE base
// template still carries them (e.g. an old CLAUDE.md seeded into the pool volume
// before this change), we must drop the base copy — otherwise it would leak
// through unconditionally AND get duplicated by the code-owned version.
function isRelocatedHeading(heading) {
  return (
    heading === "Workspace" ||
    heading.startsWith("GitHub Actions") ||
    heading.startsWith("Trigger management")
  );
}

// ------------------------------------------------------------
// Markdown section splitter
// ------------------------------------------------------------

// Split a markdown document into the leading preamble (everything before the
// first H2) and an ordered list of `## ` sections. H3+ and fenced content are
// left untouched inside their owning H2 block.
function splitSections(md) {
  const lines = String(md == null ? "" : md).split("\n");
  const preambleLines = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { heading: m[1].trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    preamble: preambleLines.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() })),
  };
}

// ------------------------------------------------------------
// Composed blocks
// ------------------------------------------------------------

// Interaction framing. All agents have a DM room, so the chat framing always
// applies; autonomous agents additionally get the unattended-run framing (the
// base DM framing alone is misleading for a trigger/cron run).
function interactionNote(autonomous) {
  const base =
    "You are reachable via chat: the user sees only your text output — no tool calls — " +
    "so briefly summarize what you did.";
  if (!autonomous) return base;
  return (
    base +
    " You may also run unattended on triggers (schedules, GitHub events); in those runs " +
    "there may be no human reading in real time, so post a concise result to your room, " +
    "or reply `[PASS]` when there is nothing to report."
  );
}

function workingEnvironmentSection(env) {
  if (!env) return "";
  const parts = [];
  if (env.name) parts.push(`**Working Environment:** ${env.name}`);
  if (env.description) parts.push(env.description);
  const repos = Array.isArray(env.repositories) ? env.repositories : [];
  if (repos.length === 1) {
    const repoName = (repos[0].url.split("/").pop() || "repo").replace(/\.git$/, "");
    parts.push(`**Repository:** \`${repos[0].url}\` — cloned to \`./${repoName}/\``);
  } else if (repos.length > 1) {
    const lines = repos.map((r) => {
      const repoName = (r.url.split("/").pop() || "repo").replace(/\.git$/, "");
      return `- \`${r.url}\` — cloned to \`./${repoName}/\``;
    });
    parts.push(`**Repositories:**\n${lines.join("\n")}`);
  }
  if (Array.isArray(env.skills) && env.skills.length > 0) {
    parts.push(`**Skills:** ${env.skills.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (env.additionalContext) parts.push(env.additionalContext);
  if (parts.length === 0) return "";
  return `## Working Environment\n\n${parts.join("\n\n")}`;
}

function blueprintSection(blueprintId) {
  if (!blueprintId) return "";
  const bpBase = `http://localhost:4002/internal/blueprints/${blueprintId}/memory`;
  const memFiles = ["context.md", "log.md", "facts.md", "entities.md", "users.md"];
  const pullCmds = memFiles.map((f) => `curl -sf ${bpBase}/${f} > memory/${f} || true`).join("\n");
  const pushCmds = memFiles
    .map((f) => `curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/${f} ${bpBase}/${f}`)
    .join("\n");
  return (
    `## Memory System (Shared — Blueprint Instance)\n\n` +
    `This agent is an **instance of blueprint \`${blueprintId}\`**. ` +
    `Memory is **shared** across all instances of this blueprint — whatever one instance learns, all instances know.\n\n` +
    `### Reading memory (do this at the start of each conversation)\n\n` +
    "```bash\n" +
    `${pullCmds}\n` +
    "```\n\n" +
    `Then read all five files.\n\n` +
    `### Writing memory (when wrapping up or asked to remember something)\n\n` +
    `Edit the local files as usual, then push all to the shared store:\n\n` +
    "```bash\n" +
    `${pushCmds}\n` +
    "```\n\n" +
    `**Always pull before reading** — another instance may have updated memory since your last session.`
  );
}

// ------------------------------------------------------------
// Assembly
// ------------------------------------------------------------

// Does this environment grant a repository? Drives the Git section gate.
function envHasRepository(env) {
  return !!(env && Array.isArray(env.repositories) && env.repositories.length > 0);
}

// Does this environment grant skills? Drives the Skills section gate.
function envHasSkills(env) {
  return !!(env && Array.isArray(env.skills) && env.skills.length > 0);
}

// Compose the full CLAUDE.md from the base template + per-agent inputs.
//
// Ordering (fix: the authored role used to be buried in the middle):
//   1. preamble + interaction framing
//   2. ## Agent Role            ← authored prompt, hoisted to the top for salience
//   3. ## Working Environment   (if the env contributes anything)
//   4. ## Workspace             (single home for the path-translation rule)
//   5. ## Response Formatting   (from base)
//   6. ## Memory System         (from base)
//   7. ## Skills                (from base) — only if the env grants skills
//   8. ## GitHub Actions        (relocated) — only if the env has a repository
//   9. ## Trigger management    (relocated) — only if the agent is autonomous
//  10. ## Important Notes       (from base)
//  11. any other base sections an operator added (preserved verbatim)
//  12. ## Memory System (Shared — Blueprint Instance) (if a blueprint instance)
function assembleClaudeMd({ base, agentPrompt, role, env, blueprintId = null, autonomous = false } = {}) {
  const { preamble, sections } = splitSections(base);
  const byHeading = new Map(sections.map((s) => [s.heading, s.text]));
  const consumed = new Set();
  const take = (heading) => {
    consumed.add(heading);
    return byHeading.has(heading) ? byHeading.get(heading) : null;
  };

  const blocks = [];

  // 1. preamble + interaction framing
  const intro = [preamble, interactionNote(autonomous)].filter(Boolean).join("\n\n");
  if (intro) blocks.push(intro);

  // 2. Agent Role — hoisted to the top
  blocks.push(`## Agent Role\n\n${String(agentPrompt == null ? "" : agentPrompt).trim()}`);

  // 3. Working Environment
  const envBlock = workingEnvironmentSection(env);
  if (envBlock) blocks.push(envBlock);

  // 4. Workspace (single home for the path rule)
  blocks.push(WORKSPACE_SECTION);

  // 5. Response Formatting
  const fmt = take("Response Formatting");
  if (fmt) blocks.push(fmt);

  // 6. Memory System
  const mem = take("Memory System");
  if (mem) blocks.push(mem);

  // 7. Skills — only when the env actually grants skills
  const skills = take("Skills");
  if (skills && envHasSkills(env)) blocks.push(skills);

  // 8. Git — only when the env has a repository
  if (envHasRepository(env)) blocks.push(GIT_SECTION);

  // 9. Trigger management — only for autonomous agents
  if (autonomous) blocks.push(TRIGGER_SECTION);

  // 10. Important Notes
  const notes = take("Important Notes");
  if (notes) blocks.push(notes);

  // 11. Preserve any operator-added sections we don't reorder explicitly —
  //     but drop stale copies of the now-code-owned relocated sections.
  for (const s of sections) {
    if (consumed.has(s.heading)) continue;
    if (KNOWN_BASE_HEADINGS.includes(s.heading)) continue;
    if (isRelocatedHeading(s.heading)) continue;
    blocks.push(s.text);
  }

  // 12. Blueprint shared-memory workflow
  const bp = blueprintSection(blueprintId);
  if (bp) blocks.push(bp);

  return `${blocks.join("\n\n---\n\n")}\n`;
}

// ------------------------------------------------------------
// Runtime memory hint (--append-system-prompt)
// ------------------------------------------------------------

// MUST stay byte-identical to `_build_memory_hint()` in
// agent-image/scripts/agent-entrypoint.py (the live runtime). The non-blueprint
// variant no longer repeats the /workspace path-translation example (that lives
// once in the CLAUDE.md Workspace section) and no longer names a 2-file subset
// that contradicts the 5-file Memory System — it points at the same files the
// Memory System section describes.
function buildMemoryHint(blueprintId) {
  if (blueprintId) {
    return (
      `This agent is an instance of blueprint '${blueprintId}'. ` +
      `Memory is SHARED across all instances of this blueprint. ` +
      `WORKFLOW — follow this exactly: ` +
      `(1) PULL shared memory at conversation start: ` +
      `curl -sf http://localhost:4002/internal/blueprints/${blueprintId}/memory/context.md > memory/context.md || true; ` +
      `curl -sf http://localhost:4002/internal/blueprints/${blueprintId}/memory/log.md > memory/log.md || true. ` +
      `Then read both files. ` +
      `(2) Update memory/context.md and memory/log.md locally during the conversation. ` +
      `(3) PUSH at end (wrap-up or remember request): ` +
      `curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/context.md http://localhost:4002/internal/blueprints/${blueprintId}/memory/context.md; ` +
      `curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/log.md http://localhost:4002/internal/blueprints/${blueprintId}/memory/log.md. ` +
      `IMPORTANT: Your workspace root is the current working directory.`
    );
  }
  return (
    "Before responding, read your memory files: start with memory/context.md and memory/log.md, " +
    "and consult memory/facts.md, memory/entities.md and memory/users.md when the topic calls for it. " +
    "If the user asks you to remember something, update the relevant memory files. " +
    "IMPORTANT: Your workspace root is the current working directory."
  );
}

module.exports = {
  splitSections,
  assembleClaudeMd,
  buildMemoryHint,
  interactionNote,
  workingEnvironmentSection,
  blueprintSection,
  envHasRepository,
  envHasSkills,
  WORKSPACE_SECTION,
  GIT_SECTION,
  TRIGGER_SECTION,
  KNOWN_BASE_HEADINGS,
};

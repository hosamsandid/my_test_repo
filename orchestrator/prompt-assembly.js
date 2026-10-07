'use strict';

// ============================================================
// Prompt assembly (single source of truth)
// ============================================================
//
// Everything an agent receives beyond its authored role prompt is composed
// here: the CLAUDE.md that gets seeded into the workspace, and the runtime
// `--append-system-prompt` memory hint. Keeping the composition in one pure,
// fs-free module means the ordering / de-duplication / conditional-gating rules
// live in one testable place instead of being smeared across a template file, a
// JS builder, and a Python builder.
//
// The base CLAUDE.md template text is passed IN (read from disk by the caller)
// so this module has no I/O and is trivial to unit-test.
//
// IMPORTANT: `buildMemoryHint()` is mirrored byte-for-byte by
// `_build_memory_hint()` in agent-image/scripts/agent-entrypoint.py (the live
// runtime). If you change one, change the other — a test asserts the expected
// string so drift is caught.

// The Plugin Capabilities section (plugin system Phase 2, #1518) is composed by
// its own pure sibling module and injected here as a gated block, the same way
// the Skills section is — from the resolved grant, never env contents.
const { pluginCapabilitiesSection } = require('./plugin-prompt');

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
//     or an agent that already has triggers).
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
  "**Loop (loop):**\n" +
  "A loop re-runs itself: it fires one iteration, and the moment that iteration " +
  "finishes it arms the next — no wall-clock schedule. `cron`/`once` say *when to " +
  "start*; a loop says *repeat until a goal is reached*. Use it to drain a worklist " +
  "or converge on a fix, not to poll on a timer.\n" +
  "```json\n" +
  "{\n" +
  '  "id": "unique-id",\n' +
  '  "type": "loop",\n' +
  '  "enabled": true,\n' +
  '  "prompt": "Read fix_plan.md, do the single highest-priority item, run the tests, update fix_plan.md and commit.",\n' +
  '  "maxIterations": 25,\n' +
  '  "until": { "command": "npm test && test ! -s fix_plan.md" },\n' +
  '  "maxTokens": 2000000,\n' +
  '  "verify": { "agentId": "team-x-code-reviewer" }\n' +
  "}\n" +
  "```\n" +
  "- **Fresh context every iteration.** Each iteration starts with an empty context " +
  "window (loops default to `sessionPolicy: per-invocation`), so persist everything " +
  "the next iteration needs on disk — re-read `memory/` and your worklist at the top " +
  "of every run. Nothing carries over in memory.\n" +
  "- **Stop contract.** `maxIterations` is **required** (a positive integer — no " +
  "unbounded loop may be authored). The loop ends and posts one summary when any " +
  "terminal state is reached: `until.command` exits `0` → **done** (goal met); the " +
  "iteration cap is hit → **exhausted**; the optional `maxTokens` budget is exceeded " +
  "→ **exhausted**; the platform runaway backstop trips → **paused**.\n" +
  "- **Don't grade your own work.** `verify` (optional but recommended) is a *separate* " +
  "gate that must pass for an iteration's work to count; a failed check is fed back " +
  "into the next iteration's prompt. Give it exactly one of: `{\"command\": \"<sh>\"}` " +
  "(exit-code gate), `{\"agentId\": \"<other-agent>\"}` (a *different* agent reviews and " +
  "returns a verdict), `{\"flow\": true}` (no inline gate — each iteration ends in a " +
  "hand-off (PR / label) and the flow's wired downstream QS chain verifies it there; " +
  "use this when the loop starts a review pipeline, so the same reviewer doesn't check " +
  "the work twice), or `{\"selfGraded\": true}` (explicit opt-out — self-checking, " +
  "only for standalone agents). If you are a team agent and leave `verify` empty or " +
  "self-graded, the system re-fills a sibling reviewer role for you — the separation " +
  "can't be silently removed.\n" +
  "- **Optional `minGapSeconds`** (non-negative) throttles the gap between iterations; " +
  "`0` (default) chains immediately.\n\n" +
  "### Managing triggers\n\n" +
  "1. Read `triggers.json`\n" +
  "2. Add, modify or remove triggers\n" +
  "3. Write the file back\n" +
  "4. Changes are picked up automatically within 60 seconds\n\n" +
  "### Optional fields\n\n" +
  "- `roomId` — target room for the output (default: direct-message room with the admin)\n" +
  "- `timeoutSeconds` — max execution time (default: 3600)\n\n" +
  "If a scheduled run has nothing to report, reply with `[PASS]`.";

// Unified Memory System variant (Memory/Knowledge unification, Phase 2).
// Replaces the base template's five-file Memory System section for agents on
// the unified semantic/episodic model — the SAME gate as the knowledge-digest
// `@`-import (knowledgeDigestRef), so the seeded instructions and the digest
// always flip together. Semantic knowledge (facts, entities, conventions) is
// routed to the team KB; only the episodic files stay private. The legacy
// five-file section in the base template remains the autonomy-0 / KB-less
// fallback. users.md is personal data — never shared, never migrated.
const MEMORY_SECTION_UNIFIED =
  "## Memory System\n\n" +
  "You maintain three episodic files in `memory/` — your private notebook. Durable team " +
  "knowledge (facts, entities, conventions) does NOT live here: it belongs to the shared " +
  "team knowledge base (see Team Knowledge below).\n\n" +
  "| File | Purpose |\n" +
  "|---|---|\n" +
  "| `context.md` | Active session state — what's currently happening. Keep slim. |\n" +
  "| `log.md` | One conversation summary per entry (date + 1–2 sentences). |\n" +
  "| `users.md` | Per-user interaction profiles: language, role, preferences, open context. Personal data — never shared, never written to the team knowledge base. |\n\n" +
  "### Rules\n\n" +
  "1. **Session start:** Read `context.md` and `log.md`; consult `users.md` when the interaction involves a specific person.\n" +
  "2. **During conversation:** Session state goes to `context.md`; new user signals to `users.md`. A durable fact, entity or convention is NOT memory — record it with `knowledge add fact|entity|convention \"<one-line statement>\"`.\n" +
  "3. **Wrap-up / \"remember this\":** Update the relevant episodic files; share durable team-relevant lessons via `knowledge add`.\n" +
  "4. **No duplicates.** Update existing entries instead of appending.\n" +
  "5. **Legacy files:** If `memory/facts.md` or `memory/entities.md` still exist, treat them as read-only legacy — consult them when the topic calls for it, but write new semantic knowledge to the knowledge base, never to these files.";

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
    heading === "Background tasks" ||
    heading === "Asking the human" ||
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

// `skills` is the agent's RESOLVED grant (team-owned skills — see
// skill-grants.js), not an environment field: the env is a pure infrastructure
// template and no longer carries skills.
//
// `agentRepositories` (#2067) are repositories attached to THIS agent alone,
// outside the Working Environment (agent-repositories.js). They are listed in
// the same shape as the environment's — URL, clone path, read-only annotation —
// because they are the same thing on disk (AC6): what differs is who else has
// them, and no other agent does. The list is threaded in as data so this module
// stays fs-free; an empty list leaves the section byte-identical to pre-#2067.
function workingEnvironmentSection(env, skills = [], agentRepositories = []) {
  const ownRepos = Array.isArray(agentRepositories)
    ? agentRepositories.filter((r) => r && typeof r.url === "string" && r.url.trim())
    : [];
  if (!env && !(Array.isArray(skills) && skills.length > 0) && ownRepos.length === 0) return "";
  const parts = [];
  if (env && env.name) parts.push(`**Environment:** ${env.name}`);
  if (env && env.description) parts.push(env.description);
  const envRepos = env && Array.isArray(env.repositories) ? env.repositories : [];
  const repos = [...envRepos, ...ownRepos];
  // Read-only repos are cloned for reference only (#1813): annotate them where
  // the repository is listed so the agent knows without relying on its role
  // prompt. Availability is unchanged — the repo is still cloned (AC3).
  const readOnlyNote = " (READ-ONLY — reference only, do not commit or push)";
  if (repos.length === 1) {
    const repoName = (repos[0].url.split("/").pop() || "repo").replace(/\.git$/, "");
    const note = repos[0].readOnly === true ? readOnlyNote : "";
    parts.push(`**Repository:** \`${repos[0].url}\` — cloned to \`./${repoName}/\`${note}`);
  } else if (repos.length > 1) {
    const lines = repos.map((r) => {
      const repoName = (r.url.split("/").pop() || "repo").replace(/\.git$/, "");
      const note = r.readOnly === true ? readOnlyNote : "";
      return `- \`${r.url}\` — cloned to \`./${repoName}/\`${note}`;
    });
    parts.push(`**Repositories:**\n${lines.join("\n")}`);
  }
  if (Array.isArray(skills) && skills.length > 0) {
    parts.push(`**Skills:** ${skills.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (env && env.additionalContext) parts.push(env.additionalContext);
  if (parts.length === 0) return "";
  return `## Environment\n\n${parts.join("\n\n")}`;
}

// Fixed base target for the host-folder mount(s). The single/legacy folder sits
// at exactly this path; multi-folder targets are `/context/<slug>` beneath it
// (#1290). Kept local (a plain constant) so this pure module stays dependency-
// free — it must equal CONTEXT_MOUNT_TARGET in context-mount.js.
const CONTEXT_MOUNT_TARGET = "/context";

// Host-folder context mount (#1283, documented to the agent in #1286). Gated on
// the agent actually having a mount: without one the section is absent entirely,
// so an agent that has no `/context` is never told about a path it lacks.
//
// Access-mode aware (#1289): a read-write mount (`contextMountRw`) is told it may
// write back to the host folder; a read-only mount (the default) is told it
// cannot. Emitting read-only wording for a read-write mount would make the agent
// decline to write even when the admin enabled it — so the mode must be threaded
// through from config (the same flag the container spec is built from), never
// assumed. The read-only branch is byte-identical to pre-#1289 (AC7).
//
// The wording is otherwise about the two things an agent gets wrong on its own:
// that the folder is LIVE (re-read it, don't cache what it said last run) and
// that it is not part of any repository (copy before keeping).
function contextMountSection(hostPath, readWrite = false) {
  const mount = typeof hostPath === "string" ? hostPath.trim() : "";
  if (!mount) return "";
  if (readWrite) {
    return (
      `## Host Context Folder\n\n` +
      "A folder from the host machine is mounted **read-write** at `/context` " +
      `(host location: \`${mount}\`).\n\n` +
      "- It is a **live view**, not a copy: it always shows the folder's current contents, " +
      "so re-read it rather than relying on what it contained in an earlier run.\n" +
      "- Read it whenever the task refers to material kept outside the repository — " +
      "documents, exports, meeting notes, specifications.\n" +
      "- You **can write there**: files you create or change under `/context` are written " +
      "straight back to the host folder and become visible to whoever syncs it, so write " +
      "deliberately. Nothing in it is part of your workspace or any repository.\n" +
      "- Cite what you used (or wrote) by its path under `/context` so a human can find the same file."
    );
  }
  return (
    `## Read-only Context Folder\n\n` +
    "A folder from the host machine is mounted **read-only** at `/context` " +
    `(host location: \`${mount}\`).\n\n` +
    "- It is a **live view**, not a copy: it always shows the folder's current contents, " +
    "so re-read it rather than relying on what it contained in an earlier run.\n" +
    "- Read it whenever the task refers to material kept outside the repository — " +
    "documents, exports, meeting notes, specifications.\n" +
    "- You **cannot write there**, and nothing in it is part of your workspace or any " +
    "repository. To keep or process something, copy it into your workspace first.\n" +
    "- Cite what you used by its path under `/context` so a human can find the same file."
  );
}

// Multiple host-folder mounts (#1290). When an agent carries more than one folder
// (or a single folder mounted at a `/context/<slug>` target rather than the bare
// legacy `/context`), the section ENUMERATES every folder with its in-container
// path and access mode (AC4), so the agent knows exactly where each lives and
// whether it may write. `mounts` is the resolved list from resolveContextMounts:
// [{ path, name, target, readWrite }]. Empty → no section (the caller gates on
// this too). A single legacy folder at bare `/context` is rendered by
// contextMountSection instead, so this never changes that byte-identical output.
function contextMountsSection(mounts) {
  const list = Array.isArray(mounts) ? mounts.filter((m) => m && m.path) : [];
  if (!list.length) return "";
  const lines = list.map((m) => {
    const target = m.target || CONTEXT_MOUNT_TARGET;
    const host = String(m.path).trim();
    if (m.readWrite === true) {
      return `- \`${target}\` — **read-write** (host location: \`${host}\`). ` +
        "Files you create or change here are written straight back to the host folder, so write deliberately.";
    }
    return `- \`${target}\` — **read-only** (host location: \`${host}\`). You cannot write here.`;
  });
  return (
    `## Context Folders\n\n` +
    "Folders from the host machine are mounted into your container, each at its own " +
    "path below. Each is a **live view** of the host folder — it always shows the " +
    "folder's current contents, so re-read it rather than relying on what it contained " +
    "in an earlier run. **Nothing in these folders is part of your workspace or any " +
    "repository**: to keep or process something, copy it into your workspace first, and " +
    "cite what you use by its path so a human can find the same file.\n\n" +
    lines.join("\n")
  );
}

// Team-knowledge digest section (Memory/Knowledge unification, Phase 1).
// Emits the native `@`-import of the generated knowledge-digest.md — the
// guaranteed "knowledge is there at session start" injection path. Injected
// only when the agent actually has a provisioned KB checkout (the caller
// gates), so an autonomy-0 / KB-less agent never sees a dangling import.
// Transparency (concept §4): the import line is visible in the seeded
// CLAUDE.md, and the digest itself is a real, browsable workspace file.
function knowledgeDigestSection(digestRef) {
  if (!digestRef) return "";
  return (
    `## Team Knowledge (digest)\n\n` +
    `@${digestRef}\n` +
    `@${SCOPED_KNOWLEDGE_FILENAME}\n\n` +
    "The first import inlines the generated digest of your team's shared knowledge base, " +
    "so it is part of your context from the start of every session (regenerated before every " +
    "run and whenever the team's knowledge changes — never edit the file itself). The second " +
    "inlines task-scoped knowledge (#917): entries whose operator-set auto-load triggers " +
    "match the current task, rebuilt before every run — empty when nothing matches. Anything " +
    'beyond these is reachable with `knowledge search "<topic>"`; record new ' +
    "durable lessons with `knowledge add`."
  );
}

// #917: the task-scoped knowledge file — a SEPARATE file from the digest with a
// SINGLE writer (the Python runtime, which alone knows the invocation prompt).
// The digest's byte-identity mirror contract is deliberately untouched; the
// orchestrator only ever seeds the empty-state stub so this import never
// dangles. Keep the filename in sync with agent-entrypoint.py.
const SCOPED_KNOWLEDGE_FILENAME = "knowledge-scoped.md";

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

// Does this agent have a repository at all? Drives the Git section gate.
//
// #2067 AC14: the gate used to read the ENVIRONMENT alone, so an agent-scoped
// repository attached to an agent on a repo-less environment (#1623) would
// arrive with the whole git / `gh-as-agent` guidance switched off — the agent
// would have a repository it had not been told how to work in. An agent-scoped
// repository counts exactly like an environment one; `agentRepositories`
// defaults to empty, so an agent without any is byte-identical to pre-#2067.
function envHasRepository(env, agentRepositories = []) {
  if (env && Array.isArray(env.repositories) && env.repositories.length > 0) return true;
  return Array.isArray(agentRepositories)
    && agentRepositories.some((r) => r && typeof r.url === "string" && r.url.trim());
}

// Does this agent's resolved grant contain skills? Drives the Skills section
// gate. Skills are team-owned (skill-grants.js) — the caller passes the
// resolved list; the environment no longer carries a skill grant.
function hasSkillGrant(skills) {
  return Array.isArray(skills) && skills.length > 0;
}

// Compose the Skills section: the base template's "how skills work" guidance
// (preserved verbatim, AC3) followed by one line per granted skill carrying its
// name and — mirroring the knowledge digest's guaranteed-in-context injection —
// the one-line `description` from its SKILL.md frontmatter (#617). The
// descriptions are supplied by the caller (`buildAgentClaudeMd` reads them via
// skill-source.js), so this module stays pure/fs-free (AC5).
//
// Fail-soft (AC7): a skill with no resolved description is still listed by name.
// Whitespace is collapsed defensively (AC8); no truncation is applied (AC9).
// Returns null when the resolved grant is empty (AC4) — the caller drops the
// whole section.
function skillsSection(baseSkillsText, skills, skillDescriptions = {}) {
  if (!hasSkillGrant(skills)) return null;
  const base = String(baseSkillsText == null ? '' : baseSkillsText).trim();
  const descs = skillDescriptions && typeof skillDescriptions === 'object' ? skillDescriptions : {};
  const items = skills.map((name) => {
    const raw = descs[name];
    const desc = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    return desc ? `- **${name}** — ${desc}` : `- **${name}**`;
  });
  const granted =
    'Skills granted to you (open the full `skills/<name>/SKILL.md` before relying on one):\n\n' +
    items.join('\n');
  return base ? `${base}\n\n${granted}` : `## Skills\n\n${granted}`;
}

// Background-task semantics — ALWAYS emitted, because `Task(*)` (plus `Monitor`
// and background shell commands) is in every agent's allowedTools regardless of
// role. A run is a single headless turn: the CLI stops every still-running
// background task the moment the turn's result is produced, and nothing
// re-invokes the agent when one would have finished. So a background wait that
// outlives the turn is silently killed — the "I'll wait in the background and
// continue" dangling promise. This section tells the agent that up front. The
// wait-for-an-external-event advice is autonomous-only, since only an autonomous
// agent has the triggers/loops that are the real answer. With a repository the
// section also steers an in-turn CI wait to the foreground `aee-wait-ci` CLI
// (#2796) instead of a background shell or a hand-rolled `gh pr checks` loop,
// with an explicit Bash tool timeout: the runtime raises only the tool's
// maximum, never its 2-minute default (#2815).
// Only events the platform can actually deliver may be named here (#2797): the
// Events API never emits check_suite / check_run / workflow_run / status, so a
// trigger on those keys never fires — steering-dead-events.test.js guards that.
function backgroundTasksSection(autonomous, hasRepository = false) {
  const base =
    '## Background tasks\n\n' +
    'Your run is a **single turn**: it ends the moment you produce your reply, and ' +
    'everything still running in the background is **stopped** at that moment. ' +
    'Parallel `Task` sub-agents, `Monitor`, and background shell commands therefore ' +
    'only work for work you **finish inside the same turn** — start them, then wait ' +
    'for their result (for example block on `TaskOutput`) **before** you answer. ' +
    'Never end your turn expecting a background task to keep running, finish later, ' +
    'or notify you: it will be killed and nothing will re-invoke you, so the person ' +
    'you are talking to just sees your last message and silence.';
  const waitAdvice =
    '\n\nTo wait for something that happens **outside** this turn — CI finishing, ' +
    "another agent's pull request, a long external job — do **not** poll it in a " +
    'background task. End your turn and let an event re-wake you: add a ' +
    '`github-event` trigger (e.g. on `pull_request.checks_passed` / ' +
    '`pull_request.checks_failed` for CI, or `pull_request.merge_conflict`) or ' +
    'use a `loop`. That is the only reliable way to continue after an ' +
    'external event. For unattended flows, rely on the hand-off gate: a PR ' +
    'hand-off with a `readinessGate` holds the next agent\'s wake until CI is ' +
    'green and the PR merges cleanly, so you never have to block a run on CI. ' +
    'If a PR you were handed is still pending, end your turn with a short ' +
    'status and re-apply its hand-off label: the gate holds that wake until CI ' +
    'settles. Never count on a later wake that nothing schedules.';
  const ciWait =
    '\n\nTo know **within this turn** whether a pull request\'s CI is green or ' +
    'it has a merge conflict, run `aee-wait-ci <pr>` in the **foreground** ' +
    '(`--repo <clone-dir>` for a non-default clone). It waits up to 20 minutes ' +
    '(always capped to your run\'s time), applies the platform\'s own CI rules ' +
    'and prints JSON plus an exit code: `0` passed / no CI, `4` failed, ' +
    '`5` conflict, `6` timeout, `1`/`3` error. Always pass the Bash tool ' +
    '`timeout` explicitly — `1500000` (25 min) for the default wait, or the ' +
    '`--timeout` minutes plus 5 — because the tool\'s 2-minute default would ' +
    'move the wait to the background. Never wait for CI in a ' +
    'background shell, `Monitor` or `Task`, and never hand-roll a ' +
    '`gh pr checks` polling loop. On timeout, end your turn and continue via ' +
    'the hand-off gate or a trigger instead of waiting longer.';
  const core = hasRepository ? base + ciWait : base;
  return autonomous ? core + waitAdvice : core;
}

// Human decision prompts (#2523) — ALWAYS emitted, because `aee-ask` is baked
// into every agent image. Claude Code strips its built-in AskUserQuestion tool
// in headless mode and the MCP server that used to re-supply it was removed
// (#1719), so without this nudge agents ask in plain prose, which nothing
// downstream can detect, render as a quick-reply card, or route. The caveat
// about nobody reading in real time is autonomous-only, mirroring the
// Background tasks section's split.
function askHumanSection(autonomous) {
  const base =
    '## Asking the human\n\n' +
    'When you need the human to make a decision before you can continue, do **not** ' +
    'write the question and its options out as prose. Call `aee-ask` instead — it ' +
    'shows the question as a quick-reply card with clickable options:\n\n' +
    '```bash\n' +
    'aee-ask "Which base branch?" --header Branch --option "main::default" --option "release::hotfix line"\n' +
    '```\n\n' +
    'Repeat `--option "label::description"` for each choice (`::description` is ' +
    'optional); add `--multi` if more than one may be picked. After a successful ' +
    'call **end your turn immediately** — do not answer the question yourself and do ' +
    "not take any further action. The human's answer arrives as your next message. " +
    'If `aee-ask` rejects its arguments, fix them and call it again.';
  const unattended =
    '\n\nIn an unattended triggered run nobody may be reading in real time — prefer ' +
    'the hand-off your role defines (an issue comment, an outcome label) over pausing ' +
    'on a question there.';
  return autonomous ? base + unattended : base;
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
//   7. ## Team Knowledge        (digest `@`-import) — only if a KB checkout is provisioned
//   8. ## Skills                (from base) — only if the agent's resolved skill grant is non-empty
//  8b. ## Plugin Capabilities   (code-owned) — only if the agent's resolved plugin grant is non-empty (#1518)
//   9. ## GitHub Actions        (relocated) — only if the env has a repository
//  10. ## Trigger management    (relocated) — only if the agent is autonomous
// 10b. ## Background tasks       (code-owned) — ALWAYS (Task(*) is always allowed)
// 10c. ## Asking the human       (code-owned) — ALWAYS (`aee-ask` is in every image)
//  11. ## Important Notes       (from base)
//  12. any other base sections an operator added (preserved verbatim)
//  13. ## Memory System (Shared — Blueprint Instance) (if a blueprint instance)
//
// `promptRef` (e.g. "AGENT-PROMPT.md"): when set, the Agent Role block emits a
// native Claude Code `@`-import that references the prompt file instead of
// inlining its text. The seeded CLAUDE.md then stays constant while the authored
// prompt lives in AGENT-PROMPT.md alone, so an edited prompt takes effect on the
// next session with no CLAUDE.md rebuild and no duplicated copy to drift (#510).
// Left null (the default) the prompt is inlined — the fully-resolved text.
// `skills`: the agent's resolved skill grant (team-owned — skill-grants.js).
// `skillDescriptions`: optional `{ <skillName>: description }` map the caller
// reads from each granted skill's SKILL.md frontmatter (#617). Supplied as data
// so this module stays fs-free; skills without an entry are listed by name only.
// `knowledgeDigestRef` (e.g. "knowledge-digest.md"): when set, a Team
// Knowledge section `@`-imports the generated digest (Memory/Knowledge
// unification, Phase 1). Callers pass it only when the agent's KB checkout is
// actually provisioned, so the import never dangles.
// `plugins`: the agent's resolved plugin grant as display data
// `[{ id, name?, cliName?, promptLine?, scopeGranularity? }]` (plugin-grants.js
// + each granted plugin's manifest). Supplied as data so this module stays
// fs-free; drives the gated Plugin Capabilities section (#1518). Empty → no
// section, matching the Skills gate.
// `agentRepositories`: repositories attached to this ONE agent, outside its
// Working Environment (#2067). Passed as data (the caller reads them off the
// agent's config), they are listed in the Working Environment section next to
// the inherited ones and count towards the Git-section gate — so an attachment
// on a repo-less environment does not arrive with that guidance switched off.
function assembleClaudeMd({ base, agentPrompt, role, env, skills = [], skillDescriptions = {}, plugins = [], agentRepositories = [], blueprintId = null, autonomous = false, promptRef = null, knowledgeDigestRef = null, contextMount = null, contextMountRw = false, contextMounts = null } = {}) {
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

  // 2. Agent Role — hoisted to the top. In reference mode emit the `@`-import
  //    so the file, not its content, is the source of truth for the prompt.
  if (promptRef) {
    blocks.push(`## Agent Role\n\n@${promptRef}`);
  } else {
    blocks.push(`## Agent Role\n\n${String(agentPrompt == null ? "" : agentPrompt).trim()}`);
  }

  // 3. Working Environment
  const envBlock = workingEnvironmentSection(env, skills, agentRepositories);
  if (envBlock) blocks.push(envBlock);

  // 4. Workspace (single home for the path rule)
  blocks.push(WORKSPACE_SECTION);

  // 4b. Context folder(s) — only when at least one is actually mounted. Sits
  //     next to the Workspace section because it is the other place on disk the
  //     agent may read from, and it must not be confused with it.
  //     • A single legacy folder at the bare `/context` target (the #1283/#1289
  //       single-folder case, whether passed as `contextMount`/`contextMountRw`
  //       or as a one-element resolved list) → the byte-identical single-folder
  //       section.
  //     • Anything else (multiple folders, or one folder at a `/context/<slug>`
  //       target) → the enumerated multi-folder section (#1290).
  const resolvedMounts = Array.isArray(contextMounts) && contextMounts.length
    ? contextMounts
    : (contextMount
        ? [{ path: contextMount, target: CONTEXT_MOUNT_TARGET, readWrite: contextMountRw === true }]
        : []);
  let ctx = "";
  if (resolvedMounts.length === 1 && (resolvedMounts[0].target || CONTEXT_MOUNT_TARGET) === CONTEXT_MOUNT_TARGET) {
    ctx = contextMountSection(resolvedMounts[0].path, resolvedMounts[0].readWrite === true);
  } else if (resolvedMounts.length) {
    ctx = contextMountsSection(resolvedMounts);
  }
  if (ctx) blocks.push(ctx);

  // 5. Response Formatting
  const fmt = take("Response Formatting");
  if (fmt) blocks.push(fmt);

  // 6. Memory System — the base template carries the legacy five-file model;
  //    agents on the unified semantic/episodic model (same gate as the digest
  //    import) get the code-owned three-file variant instead. take() still
  //    consumes the base section so it can't leak through the pass-through.
  const mem = take("Memory System");
  if (knowledgeDigestRef) {
    blocks.push(MEMORY_SECTION_UNIFIED);
  } else if (mem) {
    blocks.push(mem);
  }

  // 7. Team Knowledge digest — only when a KB checkout is provisioned
  const kd = knowledgeDigestSection(knowledgeDigestRef);
  if (kd) blocks.push(kd);

  // 8. Skills — only when the agent's resolved grant actually contains skills.
  //    The base "how skills work" text is enriched with each granted skill's
  //    name + one-line description (#617); take() still consumes the base
  //    section so it can't also leak through the pass-through below.
  const skillsBlock = take("Skills");
  const enrichedSkills = skillsSection(skillsBlock, skills, skillDescriptions);
  if (enrichedSkills) blocks.push(enrichedSkills);

  // 8b. Plugin Capabilities — only when the agent's resolved plugin grant is
  //     non-empty (#1518). Composed entirely in code from the resolved grant
  //     (never env contents), so a grant flip that reruns prompt-rebuild adds
  //     or drops exactly the changed one-liners.
  const pluginBlock = pluginCapabilitiesSection(plugins);
  if (pluginBlock) blocks.push(pluginBlock);

  // 9. Git — only when the env has a repository
  if (envHasRepository(env, agentRepositories)) blocks.push(GIT_SECTION);

  // 10. Trigger management — only for autonomous agents
  if (autonomous) blocks.push(TRIGGER_SECTION);

  // 10b. Background tasks — ALWAYS, because Task(*)/Monitor are in every agent's
  //      allowedTools. Warns that a background wait outliving the turn is killed
  //      (the dangling-promise bug); the external-event advice is autonomous-only.
  blocks.push(backgroundTasksSection(autonomous, envHasRepository(env, agentRepositories)));

  // 10c. Asking the human — ALWAYS, because `aee-ask` ships in every agent
  //      image (#2523); without it agents ask in prose the UI cannot surface.
  blocks.push(askHumanSection(autonomous));

  // 11. Important Notes
  const notes = take("Important Notes");
  if (notes) blocks.push(notes);

  // 12. Preserve any operator-added sections we don't reorder explicitly —
  //     but drop stale copies of the now-code-owned relocated sections.
  for (const s of sections) {
    if (consumed.has(s.heading)) continue;
    if (KNOWN_BASE_HEADINGS.includes(s.heading)) continue;
    if (isRelocatedHeading(s.heading)) continue;
    blocks.push(s.text);
  }

  // 13. Blueprint shared-memory workflow
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
//
// `unified` (Memory/Knowledge unification, Phase 2) selects the semantic/
// episodic variant — same gate as the knowledge-digest `@`-import (the runtime
// resolves it via _memory_model_unified(): autonomy >= 1 AND a provisioned KB
// checkout). The unified text absorbs the knowledge-add routing, so the
// runtime appends NO separate harvest hint to it; the legacy and blueprint
// variants keep today's text (+ harvest hint on the Python side).
function buildMemoryHint(blueprintId, { unified = false } = {}) {
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
  if (unified) {
    return (
      "Before responding, read your episodic memory files: memory/context.md and memory/log.md, " +
      "and consult memory/users.md when the interaction involves a specific person. " +
      "Semantic team knowledge (facts, entities, conventions) does not live in private memory files: " +
      "the current team digest is already in your context via knowledge-digest.md, and anything " +
      'beyond it is found with knowledge search "<topic>". ' +
      "When you learn something durable that would help ANY teammate (a project convention, an " +
      'environment fact, a key entity), record it with: knowledge add fact|entity|convention ' +
      '"<one-line statement>". Provenance is attached automatically — record only lessons that hold ' +
      "beyond this one run, no PR/issue-specific detail. " +
      "If the user asks you to remember something, route it: session state and personal or " +
      "user-specific details go to your memory files; durable team-relevant lessons go to " +
      "knowledge add. " +
      "IMPORTANT: Your workspace root is the current working directory."
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
  contextMountSection,
  contextMountsSection,
  blueprintSection,
  envHasRepository,
  hasSkillGrant,
  skillsSection,
  backgroundTasksSection,
  askHumanSection,
  pluginCapabilitiesSection,
  WORKSPACE_SECTION,
  GIT_SECTION,
  TRIGGER_SECTION,
  MEMORY_SECTION_UNIFIED,
  KNOWN_BASE_HEADINGS,
  SCOPED_KNOWLEDGE_FILENAME,
};

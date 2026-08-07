// Context-mount step library (#1319, docs/context-mount.md). Drives and
// asserts the host-folder context mount against the KIND e2e stack — the one
// place the k8s runtime's hostPath rendering (spawn-kubernetes-pod.js) and the
// pods/exec browse/write transport (pod-exec.js) are exercised end-to-end.
//
// KIND-LANE ONLY: the "host" of a k8s hostPath is the kind node container, so
// seeding/verifying the folder shells into that container from the Playwright
// host (docker or podman, whichever runs the kind provider — mirroring
// kind-up.sh's probe order). None of this exists on the compose stack; the
// context-mount journey carries `lanes: [kind]` so the ci lane never loads it.
const { execFileSync } = require('child_process');
const { expect } = require('@playwright/test');

const KIND_CLUSTER = process.env.E2E_KIND_CLUSTER_NAME || 'agent-studio-e2e';
const KIND_NODE = `${KIND_CLUSTER}-control-plane`;

// Run argv inside the kind node container. kind-up.sh uses docker when its
// daemon answers and falls back to the podman provider otherwise — probe in
// the same order so this works on either engine.
function runInKindNode(argv) {
  let lastErr;
  for (const engine of ['docker', 'podman']) {
    try {
      // stderr piped, not inherited: a dead docker daemon is an expected probe
      // miss (we fall through to podman), not test-output noise.
      return execFileSync(engine, ['exec', KIND_NODE, ...argv], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`cannot exec into kind node ${KIND_NODE} via docker or podman: ${lastErr.message}`);
}

/**
 * Seed a directory with one file inside the kind node (fixture helper — the
 * hostPath a context mount binds must exist ON THE NODE before the agent pod
 * starts, or the pod hangs Pending on FailedMount).
 * @param {string} hostDir - Absolute node path to create.
 * @param {string} fileName - Seed file to write inside it.
 * @param {string} content - Seed file content.
 */
function seedHostDir(hostDir, fileName, content) {
  runInKindNode(['sh', '-c',
    `mkdir -p "$1" && printf '%s' "$3" > "$1/$2"`,
    'sh', hostDir, fileName, content]);
}

/** Remove a seeded directory from the kind node (fixture teardown helper). */
function removeHostDir(hostDir) {
  runInKindNode(['sh', '-c', 'rm -rf "$1"', 'sh', hostDir]);
}

/**
 * Poll the context BROWSE API until an entry appears in the tree — the first
 * successful call proves the whole k8s chain: hostPath volume mounted in the
 * agent pod, pods/exec transport up, containment guard passing. Polling (not a
 * single call) absorbs the agent pod's startup window, during which the route
 * honestly answers 409 agent-not-running.
 *
 * @param {string} params.agentId - Agent whose context tree to read.
 * @param {string} [params.path=''] - Mount-relative directory to list.
 * @param {string} params.name - Entry name expected in the listing.
 * @param {number} [params.timeoutMs=180000] - Budget incl. pod startup.
 * @example
 * - assert:
 *     do: context.expectTreeEntry
 *     agentId: ctx-demo-agent
 *     path: specs
 *     name: brief.md
 */
async function expectTreeEntry(ctx, { agentId, path = '', name, timeoutMs = 180_000 }) {
  await expect
    .poll(
      async () => {
        const res = await ctx.request.get(
          `/api/agents/${encodeURIComponent(agentId)}/context/tree?path=${encodeURIComponent(path)}`,
        );
        if (!res.ok()) return `HTTP ${res.status()}`;
        const body = await res.json();
        const items = Array.isArray(body.items) ? body.items : [];
        return items.some((i) => i && i.name === name) ? 'found' : `absent (${items.length} items)`;
      },
      {
        message: `context tree ${path || '(root)'} never listed "${name}" for ${agentId}`,
        timeout: timeoutMs,
      },
    )
    .toBe('found');
}

/**
 * Open the agent chat's Workspace panel (right rail) — same rail-handling as
 * triggers.openPanel: reopen a collapsed rail, follow the tab into the
 * overflow menu on a narrow rail. The "Reload tree" control confirms the
 * workspace browser rendered.
 *
 * @param {string} params.agentId - Agent whose chat page to open.
 * @example
 * - action:
 *     do: context.openWorkspacePanel
 *     agentId: ctx-demo-agent
 */
async function openWorkspacePanel(ctx, { agentId }) {
  const { page } = ctx;
  await page.goto(`/chats/${agentId}`);

  const rail = page.getByRole('main');
  let tab = rail.getByRole('button', { name: 'Workspace', exact: true });
  if (!(await tab.isVisible().catch(() => false))) {
    const showRail = page.getByRole('button', { name: 'Show log panel' });
    if (await showRail.isVisible().catch(() => false)) await showRail.click();
  }
  if (!(await tab.isVisible().catch(() => false))) {
    const more = rail.getByRole('button', { name: 'More tabs' });
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      tab = page.getByRole('menuitem', { name: 'Workspace' });
    }
  }
  await tab.click();
  await expect(page.locator('[title="Reload tree"]')).toBeVisible();
}

/**
 * Expand a context root in the workspace tree and open a file in the viewer —
 * the #1286 browse surface, rendered from data that travelled hostPath →
 * pods/exec → orchestrator → console.
 *
 * @param {string} params.rootLabel - The mount's display name in the tree.
 * @param {string} params.fileName - File row to click inside it.
 * @param {string} params.contentSnippet - Text the viewer must show.
 * @example
 * - action:
 *     do: context.openContextFile
 *     rootLabel: specs
 *     fileName: brief.md
 *     contentSnippet: seeded on the kind node
 */
async function openContextFile(ctx, { rootLabel, fileName, contentSnippet }) {
  const { page } = ctx;
  const rail = page.getByRole('main');
  await rail.getByText(rootLabel, { exact: true }).first().click();
  await rail.getByText(fileName, { exact: true }).first().click();
  await expect(page.getByText(contentSnippet).first()).toBeVisible();
}

/**
 * Upload a generated file into a read-write context folder through the real
 * console API (multipart, same route the workspace browser's upload panel
 * posts to) — end-to-end this exercises the k8s WRITE path: prepare-upload
 * exec, then the tar streamed over pods/exec stdin into the hostPath.
 *
 * @param {string} params.agentId - Agent carrying the rw mount.
 * @param {string} [params.dir=''] - Mount-relative target directory.
 * @param {string} params.name - Filename to upload.
 * @param {string} params.content - File content (generated, small).
 * @example
 * - action:
 *     do: context.uploadFile
 *     agentId: ctx-demo-agent
 *     dir: specs
 *     name: notes.txt
 *     content: written through the console
 */
async function uploadFile(ctx, { agentId, dir = '', name, content }) {
  const res = await ctx.request.post(
    `/api/agents/${encodeURIComponent(agentId)}/context/upload`,
    {
      multipart: {
        path: dir,
        files: { name, mimeType: 'text/plain', buffer: Buffer.from(String(content), 'utf8') },
      },
    },
  );
  expect(
    res.ok(),
    `context upload ${name} → ${dir || '(root)'} expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  expect(
    (body.uploaded || []).length,
    `context upload reported no uploaded entries: ${JSON.stringify(body)}`,
  ).toBeGreaterThan(0);
}

/**
 * Assert a file REALLY landed in the hostPath by reading it back inside the
 * kind node — the only vantage point that proves the write left the pod and
 * hit the node filesystem (true end-to-end for the rw mount).
 *
 * @param {string} params.hostDir - Node directory the mount binds.
 * @param {string} params.name - Filename expected there.
 * @param {string} params.content - Exact expected content.
 * @example
 * - assert:
 *     do: context.expectHostFile
 *     hostDir: /opt/e2e-context/specs
 *     name: notes.txt
 *     content: written through the console
 */
async function expectHostFile(ctx, { hostDir, name, content }) {
  const got = runInKindNode(['cat', `${hostDir}/${name}`]);
  expect(got).toBe(String(content));
}

module.exports = {
  expectTreeEntry,
  openWorkspacePanel,
  openContextFile,
  uploadFile,
  expectHostFile,
  seedHostDir,
  removeHostDir,
};

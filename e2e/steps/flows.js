// Flows-editor step library (#733, docs/journey-spec-concept.md §2.2,
// docs/walkthrough/04-flows.md).
//
// Drives the visual Flow editor (admin-console/src/pages/Briefings.jsx →
// ProcessGraphPanel in ProcessCanvas.jsx; renderer flow-graph-render.js). The
// `flows-draft` journey authors a process draft from scratch: create → rename →
// add two agents (generated prompts via the mock LLM) → wire an Issue channel
// with a human gate → stages → assert Materialize is available. It STOPS before
// materialising, so it has no team/Matrix side effects — a pure draft journey.
//
// House style (see wizard.js): id / ARIA role / visible text; no data-testids.
// Graph nodes are real HTML `.bp-node[data-id]` divs (not a <canvas>), so they
// are queryable — but creating a connection has NO button/inspector path: it is
// only reachable by dragging the node's ● port onto the target. That drag is
// native mouse events on real DOM boxes, so page.mouse drives it (connectPort).
const { expect } = require('@playwright/test');

// Slugify a display name the same way the editor does (edit-adapters.js slugRole),
// so a journey can name an agent "Business Analyst" and assert on node id
// "business-analyst".
function slugRole(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The draft id lives in the URL (?proc=draft:<id>) once a draft is open — used
// for API-level assertions against the persisted bundle. The value is URL-encoded
// (the ":" becomes "%3A"), so decode the whole param before stripping the prefix.
function draftIdFromUrl(page) {
  const m = /[?&]proc=([^&]+)/.exec(page.url());
  if (!m) return null;
  const val = decodeURIComponent(m[1]); // "draft:<id>"
  return val.startsWith('draft:') ? val.slice('draft:'.length) : null;
}

/**
 * Open the Flows editor and create a fresh draft ("New flow" → POST
 * /api/process/drafts). Waits until the empty draft is on the canvas (its
 * inline-editable title + the Add-agent toolbar action).
 *
 * @example
 * - action:
 *     do: flows.newDraft
 */
async function newDraft(ctx) {
  const { page } = ctx;
  await page.goto('/flows');
  const created = page.waitForResponse(
    (r) => r.url().includes('/api/process/drafts')
      && r.request().method() === 'POST'
      && r.ok(),
  );
  await page.getByRole('button', { name: 'New flow' }).click();
  await created;
  // The proc param is URL-encoded (draft%3A<id>), so match the decoded-agnostic form.
  await page.waitForURL(/proc=draft/);
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible();
}

/**
 * Rename the open draft (inline title editor → PUT /api/process/drafts/:id). The
 * fixed name is what the fixture pre-/post-cleans on, keeping the journey
 * re-runnable.
 *
 * @param {string} params.name - New draft name.
 * @example
 * - action:
 *     do: flows.renameDraft
 *     name: Simple SDLC
 */
async function renameDraft(ctx, { name }) {
  const { page } = ctx;
  const saved = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await page.locator('[title="Rename draft"]').click();
  // The inline title editor autofocuses + selects its input (EditableDraftTitle),
  // so target the focused field rather than guessing among page textboxes.
  const input = page.locator('input:focus');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter'); // commits (Enter or blur → onRename → PUT)
  await saved;
  await expect(page.locator('[title="Rename draft"]')).toContainText(name);
}

/**
 * Assert the empty draft is on screen (capture point for the empty-draft
 * screenshot): the from-scratch design hint + a zero-node canvas.
 *
 * @example
 * - assert:
 *     do: flows.expectEmptyDraft
 */
async function expectEmptyDraft(ctx) {
  const { page } = ctx;
  await expect(page.getByText(/design from scratch/i)).toBeVisible();
  await expect(page.locator('.bp-node')).toHaveCount(0);
}

const ADD_AGENT_DIALOG = { name: 'Add agent' };

// Close a SidePanel dialog by its title if it is open (it has an "X" button
// labelled "Close panel"). Used to dismiss the node inspector that auto-opens on
// selection and would otherwise overlay the toolbar for the next action.
async function closeSidePanel(page, name) {
  const d = page.getByRole('dialog', { name });
  if (await d.isVisible().catch(() => false)) {
    await d.getByRole('button', { name: 'Close panel' }).click();
    await expect(d).toBeHidden();
  }
}

/**
 * Open the Add-agent panel on the "From scratch" tab and fill the name + a
 * one-line note (does NOT generate or confirm — capture point for the from-scratch
 * panel). Forces the scratch tab in case templates default the dialog to
 * "From a template".
 *
 * @param {string} params.name - Agent display name (its node id is the slug).
 * @param {string} [params.notes] - One-line intent used to generate the prompt.
 * @example
 * - action:
 *     do: flows.openAddAgent
 *     name: Business Analyst
 *     notes: Take requirements and create a GitHub issue.
 */
async function openAddAgent(ctx, { name, notes }) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Add agent' }).click();
  const d = page.getByRole('dialog', ADD_AGENT_DIALOG);
  await expect(d).toBeVisible();
  // Agent templates load async; once they arrive the dialog defaults to
  // "From a template". Wait for that toggle before clicking "From scratch" (else
  // we race ahead, skip it, and the dialog then flips to template mode). If there
  // are no templates the toggle never appears and the form is scratch-only.
  const scratchTab = d.getByRole('button', { name: 'From scratch' });
  await scratchTab.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await scratchTab.isVisible().catch(() => false)) await scratchTab.click();
  // Confirm scratch mode via its Notes field before filling (locate by
  // placeholder — the name input and notes textarea share a label association
  // that makes getByLabel('Agent name') ambiguous).
  await expect(d.getByPlaceholder(/A few keywords/)).toBeVisible();
  await d.getByPlaceholder('e.g. Business Analyst').fill(name);
  if (notes) await d.getByPlaceholder(/A few keywords/).fill(notes);
}

/**
 * Press "Generate agent prompt" (→ POST /api/agent-prompt/generate; the mock LLM
 * in the E2E stack answers) and wait for the generated prose to land in the
 * editable Agent-prompt textarea (capture point for the generated-prompt panel).
 * Requires the Add-agent panel open with a name filled.
 *
 * @example
 * - action:
 *     do: flows.generateAgentPrompt
 */
async function generateAgentPrompt(ctx) {
  const { page } = ctx;
  const d = page.getByRole('dialog', ADD_AGENT_DIALOG);
  const gen = page.waitForResponse(
    (r) => r.url().includes('/api/agent-prompt/generate')
      && r.request().method() === 'POST'
      && r.ok(),
  );
  await d.getByRole('button', { name: 'Generate agent prompt' }).click();
  await gen;
  await expect(d.getByPlaceholder(/use Generate above/)).not.toHaveValue('');
}

/**
 * Confirm the open Add-agent panel (→ PUT /api/process/drafts/:id) and wait for
 * the new node to appear on the canvas.
 *
 * @param {string} params.name - Agent display name being added (its node slug).
 * @example
 * - action:
 *     do: flows.confirmAddAgent
 *     name: Business Analyst
 */
async function confirmAddAgent(ctx, { name }) {
  const { page } = ctx;
  const d = page.getByRole('dialog', ADD_AGENT_DIALOG);
  const persisted = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await d.getByRole('button', { name: 'Add agent', exact: true }).click();
  await persisted;
  await expect(page.locator(`.bp-node[data-id="${slugRole(name)}"]`)).toBeVisible();
  // Adding selects the new node and opens its inspector (a right-side dialog that
  // overlays the toolbar); dismiss it so the next toolbar action isn't intercepted.
  await closeSidePanel(page, name);
}

/**
 * Add an agent from scratch in one call: open the panel, optionally generate the
 * prompt, and confirm. Composes openAddAgent + generateAgentPrompt + confirmAddAgent
 * for steps that don't need to capture the intermediate panel states.
 *
 * @param {string} params.name - Agent display name (its node id is the slug).
 * @param {string} [params.notes] - One-line intent used to generate the prompt.
 * @param {boolean} [params.generate=false] - Press "Generate agent prompt" first.
 * @example
 * - action:
 *     do: flows.addAgentFromScratch
 *     name: Developer
 *     notes: Take an issue and implement it. Create a PR at the end.
 *     generate: true
 */
async function addAgentFromScratch(ctx, { name, notes, generate = false }) {
  await openAddAgent(ctx, { name, notes });
  if (generate) await generateAgentPrompt(ctx);
  await confirmAddAgent(ctx, { name });
}

/**
 * Assert an agent node is on the canvas by display name.
 *
 * @param {string} params.name - Agent display name whose node must be present.
 * @example
 * - assert:
 *     do: flows.expectAgentNode
 *     name: Developer
 */
async function expectAgentNode(ctx, { name }) {
  await expect(ctx.page.locator(`.bp-node[data-id="${slugRole(name)}"]`)).toBeVisible();
}

/**
 * Assert exactly `count` agent nodes are on the canvas (actor source nodes are a
 * different class and are excluded).
 *
 * @param {number} params.count - Expected number of agent nodes.
 * @example
 * - assert:
 *     do: flows.expectAgentCount
 *     count: 2
 */
async function expectAgentCount(ctx, { count }) {
  await expect(ctx.page.locator('.bp-node')).toHaveCount(count);
}

// Drag the source node's ● port onto the target node. The port is a real div
// (title="Drag to another node to connect them"); the wiring uses native
// mousedown/move/up (flow-graph-render.js), resolving the drop with
// elementFromPoint → closest('.bp-node'), so low-level mouse events drive it.
// Intermediate moves keep elementFromPoint tracking the cursor.
async function connectPort(page, fromSlug, toSlug) {
  const fromNode = page.locator(`.bp-node[data-id="${fromSlug}"]`);
  const toNode = page.locator(`.bp-node[data-id="${toSlug}"]`);
  await expect(fromNode).toBeVisible();
  await expect(toNode).toBeVisible();
  const port = fromNode.locator('div[title="Drag to another node to connect them"]');
  await expect(port).toBeVisible();

  const pb = await port.boundingBox();
  const tb = await toNode.boundingBox();
  if (!pb || !tb) throw new Error('flows.connectPort: could not resolve port/target geometry');
  const sx = pb.x + pb.width / 2;
  const sy = pb.y + pb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (tx - sx) / 2, sy + (ty - sy) / 2, { steps: 10 });
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.move(tx, ty);
  await page.mouse.up();
}

/**
 * Wire an Issue channel from one agent to another with a human-approval gate:
 * drag the producer's port onto the consumer, choose "Issue channel", enter the
 * routing label, tick the human-approval gate, and create it (→ PUT
 * /api/process/drafts/:id). The gate requires a routing label (product rule).
 *
 * @param {string} params.from - Producer agent display name (opens the issue).
 * @param {string} params.to - Consumer agent display name (woken by the issue).
 * @param {string} params.label - Routing label the consumer waits on (e.g. "ready").
 * @param {boolean} [params.humanGate=true] - Require a human to apply the label.
 * @example
 * - action:
 *     do: flows.wireIssueChannel
 *     from: Business Analyst
 *     to: Developer
 *     label: ready
 *     humanGate: true
 */
async function wireIssueChannel(ctx, { from, to, label, humanGate = true }) {
  const { page } = ctx;
  await connectPort(page, slugRole(from), slugRole(to));

  // The one create dialog is sentence-titled (#1005): "How does B learn about A's work?"
  const picker = page.getByRole('dialog', { name: /How does .* learn about/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Issue channel/ }).click();

  // Sentence-titled channel dialog (#1009): "An issue from A wakes B".
  const channel = page.getByRole('dialog', { name: /An issue from .* wakes/ });
  await expect(channel).toBeVisible();
  await channel.getByLabel(/Routing label/).fill(label);
  if (humanGate) {
    // The channel dialog (issue + lockArtifact) has a single checkbox: the gate.
    await channel.getByRole('checkbox').first().check();
  }

  const persisted = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await channel.getByRole('button', { name: 'Create channel' }).click();
  await persisted;
  await expect(channel).toBeHidden();
}

/**
 * Assert the persisted draft carries the issue channel (consumer role has a
 * `channels[]` entry from the producer with the routing label + human gate).
 * API-level so it does not depend on canvas edge rendering.
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.label - Routing label the channel carries.
 * @example
 * - assert:
 *     do: flows.expectIssueChannel
 *     from: Business Analyst
 *     to: Developer
 *     label: ready
 */
async function expectIssueChannel(ctx, { from, to, label }) {
  const { page, request } = ctx;
  const draftId = draftIdFromUrl(page);
  expect(draftId, 'a draft must be open (proc=draft:<id> in the URL)').toBeTruthy();
  await expect(async () => {
    const res = await request.get(`/api/process/drafts/${encodeURIComponent(draftId)}`);
    expect(res.ok(), `GET draft HTTP ${res.status()}`).toBeTruthy();
    const draft = await res.json();
    const roles = draft.roles || draft.bundle?.roles || [];
    const consumer = roles.find((r) => r.id === slugRole(to) || r.name === to);
    expect(consumer, `consumer role ${to} present`).toBeTruthy();
    const channels = consumer.channels || [];
    const ch = channels.find(
      (c) => c.artifact === 'issue' && (c.from === slugRole(from) || c.from === from),
    );
    expect(ch, `issue channel from ${from} present`).toBeTruthy();
    expect(ch.label).toBe(label);
    expect(ch.gate).toBe('human');
  }).toPass({ timeout: 15_000 });
}

/**
 * Add an ordered stage to the draft (Stages dialog → "Add" → PUT). Stages are an
 * organising layer; nodes are assigned to them in the node inspector.
 *
 * @param {string} params.name - Stage name to add.
 * @example
 * - action:
 *     do: flows.addStage
 *     name: Requirements
 */
async function addStage(ctx, { name }) {
  const { page } = ctx;
  // Two "Stages" buttons exist (the toolbar action + a canvas band-toggle); the
  // toolbar one comes first in the DOM and opens the StageManager dialog.
  const d = page.getByRole('dialog', { name: 'Stages' });
  if (!(await d.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Stages', exact: true }).first().click();
  }
  await expect(d).toBeVisible();
  const saved = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await d.getByPlaceholder('New stage name…').fill(name);
  await d.getByRole('button', { name: 'Add', exact: true }).click();
  await saved;
  await expect(d.getByText(name)).toBeVisible();
}

/**
 * Close the Stages dialog (its overlay would otherwise cover the canvas for a
 * screenshot).
 *
 * @example
 * - action:
 *     do: flows.closeStages
 */
async function closeStages(ctx) {
  const { page } = ctx;
  const d = page.getByRole('dialog', { name: 'Stages' });
  if (await d.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
  }
}

/**
 * Assign an agent node to a stage via its inspector (Details → "Stage (layout
 * column)" → Save). Opens the node, sets the stage, persists (PUT).
 *
 * @param {string} params.name - Agent display name whose node to assign.
 * @param {string} params.stage - Stage name to assign it to.
 * @example
 * - action:
 *     do: flows.assignStage
 *     name: Business Analyst
 *     stage: Requirements
 */
async function assignStage(ctx, { name, stage }) {
  const { page } = ctx;
  await page.locator(`.bp-node[data-id="${slugRole(name)}"]`).click();
  const inspector = page.getByRole('dialog', { name });
  await expect(inspector).toBeVisible();
  // The Stage field lives on the inspector's Details tab; select it if the
  // inspector opened on another tab.
  const detailsTab = inspector.getByRole('button', { name: 'Details' });
  if (await detailsTab.isVisible().catch(() => false)) await detailsTab.click();
  const stageSelect = inspector.locator('select').filter({ hasText: stage });
  await expect(stageSelect).toBeVisible({ timeout: 10_000 });
  const saved = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await stageSelect.selectOption({ label: stage });
  await inspector.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
  await closeSidePanel(page, name);
}

/**
 * Assert the Materialize action is available on the draft (capture point for the
 * finished-draft screenshot). The journey deliberately does not click it — a pure
 * draft has no team side effects.
 *
 * @example
 * - assert:
 *     do: flows.expectMaterializeAvailable
 */
async function expectMaterializeAvailable(ctx) {
  await expect(ctx.page.getByRole('button', { name: 'Materialize…' })).toBeEnabled();
}

/**
 * Open a node's Routing tab in the inspector (#828): click the node, then the
 * Routing tab. Waits for the Outcomes heading.
 *
 * @param {string} params.name - Agent display name whose node to open.
 * @example
 * - action:
 *     do: flows.openRouting
 *     name: Dispatcher
 */
async function openRouting(ctx, { name }) {
  const { page } = ctx;
  await page.locator(`.bp-node[data-id="${slugRole(name)}"]`).click();
  const inspector = page.getByRole('dialog', { name });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('button', { name: 'Routing' }).click();
  await expect(inspector.getByText('Outcomes', { exact: true })).toBeVisible();
}

/**
 * Set the outcome mode on the open Routing tab (#828): the switch (exactly one)
 * or any-of. The two radios are ordered exactly-one, any-of.
 *
 * @param {string} params.name - Agent display name (its Routing tab must be open).
 * @param {string} params.mode - "exactlyOne" (switch) | "anyOf".
 * @example
 * - action:
 *     do: flows.setOutcomeMode
 *     name: Dispatcher
 *     mode: exactlyOne
 */
async function setOutcomeMode(ctx, { name, mode }) {
  const inspector = ctx.page.getByRole('dialog', { name });
  await inspector.getByRole('radio').nth(mode === 'anyOf' ? 1 : 0).check();
}

/**
 * Add one outcome on the open Routing tab (#828): title, optional `when`, and the
 * label it sets. Does NOT save (batched into flows.saveOutcomes). Leave `label`
 * empty for a terminal (no-signal) outcome.
 *
 * @param {string} params.name - Agent display name (Routing tab open).
 * @param {string} params.title - Outcome title (its persisted id is the slug).
 * @param {string} [params.when] - Human-readable condition (documentation).
 * @param {string} [params.label] - Label the outcome sets; empty = no signal.
 * @example
 * - action:
 *     do: flows.addOutcome
 *     name: Dispatcher
 *     title: Route to Developer
 *     when: Frontend/UI task
 *     label: ready
 */
async function addOutcome(ctx, { name, title, when, label }) {
  const inspector = ctx.page.getByRole('dialog', { name });
  await inspector.getByRole('button', { name: 'Add outcome' }).click();
  await inspector.getByPlaceholder(/Outcome title/).last().fill(title);
  if (when) await inspector.getByPlaceholder(/^when:/).last().fill(when);
  if (label !== undefined) await inspector.getByPlaceholder('label').last().fill(label);
}

/**
 * Save the outcomes on the open Routing tab (#828) → PUT (draft bundle or live
 * agent). Waits for the persisted response + the "Saved." confirmation.
 *
 * @param {string} params.name - Agent display name (Routing tab open).
 * @example
 * - action:
 *     do: flows.saveOutcomes
 *     name: Dispatcher
 */
async function saveOutcomes(ctx, { name }) {
  const { page } = ctx;
  const inspector = page.getByRole('dialog', { name });
  const persisted = page.waitForResponse(
    (r) => (/\/api\/process\/drafts\/[^/]+$/.test(r.url()) || /\/api\/agents\/[^/]+$/.test(r.url()))
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await inspector.getByRole('button', { name: 'Save outcomes' }).click();
  await persisted;
  await expect(inspector.getByText('Saved.')).toBeVisible();
}

/**
 * Press "Suggest outcomes…" on the open Routing tab (#828) → POST
 * /api/agent-outcomes/suggest (mock LLM in the E2E stack, heuristic fallback).
 * Waits for the proposal to land highlighted-unconfirmed — nothing is persisted
 * until Save, so this alone is the "decline persists nothing" path.
 *
 * @param {string} params.name - Agent display name (Routing tab open).
 * @example
 * - action:
 *     do: flows.suggestOutcomes
 *     name: Developer
 */
async function suggestOutcomes(ctx, { name }) {
  const { page } = ctx;
  const inspector = page.getByRole('dialog', { name });
  const suggested = page.waitForResponse(
    (r) => r.url().includes('/api/agent-outcomes/suggest')
      && r.request().method() === 'POST'
      && r.ok(),
  );
  await inspector.getByRole('button', { name: /Suggest outcomes/ }).click();
  await suggested;
  await expect(inspector.getByText(/Suggested outcomes/)).toBeVisible();
}

// Drag an outcome's output port (the amber square, title `Outcome "<title>" …`)
// onto the target node — the #828 sibling of connectPort for the ● port.
async function connectOutcomePort(page, fromSlug, outcomeTitle, toSlug) {
  const fromNode = page.locator(`.bp-node[data-id="${fromSlug}"]`);
  const toNode = page.locator(`.bp-node[data-id="${toSlug}"]`);
  await expect(fromNode).toBeVisible();
  await expect(toNode).toBeVisible();
  const port = fromNode.locator(`div[title*="Outcome"][title*="${outcomeTitle}"]`).first();
  await expect(port).toBeVisible();
  const pb = await port.boundingBox();
  const tb = await toNode.boundingBox();
  if (!pb || !tb) throw new Error('flows.connectOutcomePort: could not resolve port/target geometry');
  const sx = pb.x + pb.width / 2;
  const sy = pb.y + pb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (tx - sx) / 2, sy + (ty - sy) / 2, { steps: 10 });
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.move(tx, ty);
  await page.mouse.up();
}

/**
 * Wire an outcome to a target agent by dragging the outcome's output port onto it
 * (#828). The drag opens the label hand-off dialog PRE-FILLED with the outcome's
 * label; this confirms it (→ creates the listener on the target). Dismisses the
 * node inspector first so it doesn't overlay the canvas.
 *
 * @param {string} params.from - Producer agent display name (owns the outcome).
 * @param {string} params.to - Target agent display name the outcome routes to.
 * @param {string} params.outcome - Outcome title (the output port's label).
 * @param {string} [params.label] - Override the pre-filled routing label.
 * @example
 * - action:
 *     do: flows.wireOutcome
 *     from: Dispatcher
 *     to: Developer
 *     outcome: Route to Developer
 */
async function wireOutcome(ctx, { from, to, outcome, label }) {
  const { page } = ctx;
  await closeSidePanel(page, from);
  await connectOutcomePort(page, slugRole(from), outcome, slugRole(to));
  const d = page.getByRole('dialog', { name: 'Wire a label hand-off' });
  await expect(d).toBeVisible();
  if (label !== undefined) await d.getByPlaceholder(/dispatch, stage/).fill(label);
  const persisted = page.waitForResponse(
    (r) => /\/api\/process\/drafts\/[^/]+$/.test(r.url())
      && r.request().method() === 'PUT'
      && r.ok(),
  );
  await d.getByRole('button', { name: 'Create hand-off' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * Assert the persisted draft role carries an authored outcomes port with the
 * given option id (and, optionally, mode). API-level, so it doesn't depend on
 * canvas rendering.
 *
 * @param {string} params.name - Agent display name (the producer role).
 * @param {string} params.outcomeId - Expected outcome option id (slug of its title).
 * @param {string} [params.mode] - Expected outcomes.mode ("exactlyOne"|"anyOf").
 * @example
 * - assert:
 *     do: flows.expectOutcome
 *     name: Dispatcher
 *     outcomeId: route-to-developer
 *     mode: exactlyOne
 */
async function expectOutcome(ctx, { name, outcomeId, mode }) {
  const { page, request } = ctx;
  const draftId = draftIdFromUrl(page);
  expect(draftId, 'a draft must be open (proc=draft:<id> in the URL)').toBeTruthy();
  await expect(async () => {
    const res = await request.get(`/api/process/drafts/${encodeURIComponent(draftId)}`);
    expect(res.ok(), `GET draft HTTP ${res.status()}`).toBeTruthy();
    const draft = await res.json();
    const roles = draft.roles || draft.bundle?.roles || [];
    const role = roles.find((r) => r.id === slugRole(name) || r.name === name);
    expect(role, `role ${name} present`).toBeTruthy();
    expect(role.outcomes, `role ${name} has an outcomes port`).toBeTruthy();
    if (mode) expect(role.outcomes.mode).toBe(mode);
    const opt = (role.outcomes.options || []).find((o) => o.id === outcomeId);
    expect(opt, `outcome option ${outcomeId} present`).toBeTruthy();
  }).toPass({ timeout: 15_000 });
}

/**
 * Assert a node renders as a switch on the canvas — the ◇ switch badge (#828).
 *
 * @param {string} params.name - Agent display name whose node must show the badge.
 * @example
 * - assert:
 *     do: flows.expectSwitchNode
 *     name: Dispatcher
 */
async function expectSwitchNode(ctx, { name }) {
  const node = ctx.page.locator(`.bp-node[data-id="${slugRole(name)}"]`);
  await expect(node.getByText(/switch/)).toBeVisible();
}

/**
 * Assert the persisted draft role has NO authored outcomes port — the "decline
 * persists nothing" check after a suggestion that was not saved (#828).
 *
 * @param {string} params.name - Agent display name to check.
 * @example
 * - assert:
 *     do: flows.expectNoOutcomes
 *     name: Developer
 */
async function expectNoOutcomes(ctx, { name }) {
  const { page, request } = ctx;
  const draftId = draftIdFromUrl(page);
  expect(draftId, 'a draft must be open').toBeTruthy();
  const res = await request.get(`/api/process/drafts/${encodeURIComponent(draftId)}`);
  expect(res.ok(), `GET draft HTTP ${res.status()}`).toBeTruthy();
  const draft = await res.json();
  const roles = draft.roles || draft.bundle?.roles || [];
  const role = roles.find((r) => r.id === slugRole(name) || r.name === name);
  expect(role, `role ${name} present`).toBeTruthy();
  const opts = role.outcomes && Array.isArray(role.outcomes.options) ? role.outcomes.options : [];
  expect(opts.length, `role ${name} has no persisted outcomes`).toBe(0);
}

// Canvas nodes/edges are laid out deterministically (fixed viewport, reduced
// motion) and carry only authored names — no timestamps/ids to mask.
function volatileLocators() {
  return [];
}

module.exports = {
  newDraft,
  renameDraft,
  expectEmptyDraft,
  openAddAgent,
  generateAgentPrompt,
  confirmAddAgent,
  addAgentFromScratch,
  expectAgentNode,
  expectAgentCount,
  wireIssueChannel,
  expectIssueChannel,
  addStage,
  closeStages,
  assignStage,
  expectMaterializeAvailable,
  openRouting,
  setOutcomeMode,
  addOutcome,
  saveOutcomes,
  suggestOutcomes,
  wireOutcome,
  expectOutcome,
  expectSwitchNode,
  expectNoOutcomes,
  volatileLocators,
};

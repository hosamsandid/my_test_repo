// Flows-editor step library (#733, docs/journey-spec-concept.md §2.2,
// docs/walkthrough/04-flows.md).
//
// Drives the visual Flow editor (admin-console/src/pages/Briefings.jsx →
// ProcessGraphPanel in ProcessCanvas.jsx; renderer flow-graph-render.js). The
// `flows-draft` journey authors a process draft from scratch: create → rename →
// add two agents (generated prompts via the mock LLM) → wire an Issue channel
// with a human gate → stages → assert Create team… is available. It STOPS before
// creating the team, so it has no team/Matrix side effects — a pure draft journey.
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
  // A blank draft shows TWO "Add agent" buttons since #1171 (toolbar + the
  // empty-state canvas CTA) — .first() keeps this strict-mode-safe on both an
  // empty and a populated canvas.
  await expect(page.getByRole('button', { name: 'Add agent' }).first()).toBeVisible();
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
  // #1999 dropped the native `title="Rename draft"` on this control — it is now a
  // button whose accessible name is `aria-label="Rename flow: <name>"` (verified
  // in ProcessCanvas.jsx + flow-editor-tooltips.test.js), so the old
  // `[title="Rename draft"]` locator matched nothing and hard-timed-out every
  // journey that renames. Target the button by its role + aria-label instead.
  const renameControl = page.getByRole('button', { name: /^Rename flow:/ }).first();
  await renameControl.click();
  // The inline title editor autofocuses + selects its input (EditableDraftTitle),
  // so target the focused field rather than guessing among page textboxes.
  const input = page.locator('input:focus');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter'); // commits (Enter or blur → onRename → PUT)
  await saved;
  // After committing, the inline editor reverts to the button, now carrying the
  // new name as its visible text (and in its `Rename flow: <name>` aria-label).
  await expect(page.getByRole('button', { name: /^Rename flow:/ }).first()).toContainText(name);
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
  // Empty-state copy since #1171 ("This flow is empty" + Add-your-first-agent
  // CTA) — the old "design from scratch" hint is gone.
  await expect(page.getByText('This flow is empty')).toBeVisible();
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
  // Toolbar button and (on a blank canvas, #1171) the empty-state CTA both
  // open the same dialog; .first() (the toolbar, first in DOM order) works in
  // both states.
  await page.getByRole('button', { name: 'Add agent' }).first().click();
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
  await expect(page.locator(nodeSel(slugRole(name))).first()).toBeVisible();
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
  await expect(ctx.page.locator(nodeSel(slugRole(name))).first()).toBeVisible();
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
// A node selector tolerant of scope: in a draft the node id IS the role slug;
// in a live team it is the member id `<teamId>-<slug>` — match both (#1010).
function nodeSel(slug) {
  return `.bp-node[data-id="${slug}"], .bp-node[data-id$="-${slug}"]`;
}

async function connectPort(page, fromSlug, toSlug) {
  const fromNode = page.locator(nodeSel(fromSlug)).first();
  const toNode = page.locator(nodeSel(toSlug)).first();
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
 * Turn ON the canvas stage-band view so a screenshot shows the assigned agents
 * grouped into labelled bands (the state the flows-draft narrative describes),
 * instead of the ungrouped graph. Two "Stages" controls exist: the first (in
 * the top action bar) opens the StageManager dialog (cf. addStage); the second
 * is the canvas band-toggle. Clicks the band-toggle and waits for a band header
 * to render. Idempotent-ish: if the bands are already shown it is a no-op click
 * guarded by the header check.
 *
 * @param {string} [params.stage=Requirements] - A stage name expected to appear
 *   as a band header once the view is on (the wait target).
 * @example
 * - action:
 *     do: flows.showStages
 *     stage: Requirements
 */
async function showStages(ctx, { stage = 'Requirements' } = {}) {
  const { page } = ctx;
  const toggles = page.getByRole('button', { name: 'Stages', exact: true });
  // The band-toggle is the last "Stages" control (the StageManager opener comes
  // first in the DOM). Click it unless a band header is already visible.
  const header = page.locator('.rf__stage-band, [data-stage-band]').filter({ hasText: stage });
  if (!(await header.first().isVisible().catch(() => false))) {
    await toggles.last().click();
  }
  // Wait for the stage name to render on the canvas as a band label (the dialog
  // is closed by now, so this text can only be the band header).
  await expect(page.getByText(stage, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
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
  await page.locator(nodeSel(slugRole(name))).first().click();
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
 * Assert the create-team action is available on the draft (capture point for the
 * finished-draft screenshot). The journey deliberately does not click it — a pure
 * draft has no team side effects.
 *
 * Renamed from `expectMaterializeAvailable` with the button itself (#2053): the
 * label is the whole point of the assertion, so a step name still saying
 * `Materialize` would be the next reader's wrong turn.
 *
 * @example
 * - assert:
 *     do: flows.expectCreateTeamAvailable
 */
async function expectCreateTeamAvailable(ctx) {
  await expect(ctx.page.getByRole('button', { name: 'Create team…' })).toBeEnabled();
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
  await page.locator(nodeSel(slugRole(name))).first().click();
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
 * @param {string} [params.action] - Action type when not a label: "openPr", "openIssue" or "none" (#1010).
 * @example
 * - action:
 *     do: flows.addOutcome
 *     name: Dispatcher
 *     title: Route to Developer
 *     when: Frontend/UI task
 *     label: ready
 */
async function addOutcome(ctx, { name, title, when, label, action }) {
  const inspector = ctx.page.getByRole('dialog', { name });
  await inspector.getByRole('button', { name: 'Add outcome' }).click();
  await inspector.getByPlaceholder(/Outcome title/).last().fill(title);
  if (when) await inspector.getByPlaceholder(/^when:/).last().fill(when);
  if (action) {
    // The per-action type select ("set label" / "open PR" / "open issue" /
    // "no signal") — #1010: outcomes may produce artifacts, not only labels.
    await inspector.locator('select').filter({ hasText: 'no signal' }).last()
      .selectOption(action);
  }
  if (label !== undefined && (!action || action === 'setLabel')) {
    await inspector.getByPlaceholder('label').last().fill(label);
  }
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
  const fromNode = page.locator(nodeSel(fromSlug)).first();
  const toNode = page.locator(nodeSel(toSlug)).first();
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
  const node = ctx.page.locator(nodeSel(slugRole(name))).first();
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

/* ─── #1010: S1–S13 scenario-catalog steps ───────────────────────────────────
 * Editor-level coverage of the concept's scenario catalog (§3): wiring is
 * AUTHORED and asserted on persisted state + rendering + lints — never on
 * runtime trigger delivery (that lives in the iban-story journey). */

// GET with one retry on a connection-level error. This is typically the FIRST
// request-context call after minutes of UI-only steps; on the kind lane the
// kubectl port-forward drops idle keep-alive sockets, so that first reuse
// deterministically dies with "socket hang up" (#1319). A fresh attempt gets a
// new socket; a real HTTP error is never retried.
async function apiGetRetrying(ctx, url) {
  try {
    return await ctx.request.get(url);
  } catch (err) {
    if (!/socket hang up|ECONNRESET|ECONNREFUSED/i.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return ctx.request.get(url);
  }
}

// GET the open draft's bundle document (the persisted source of truth).
async function draftDoc(ctx) {
  const id = draftIdFromUrl(ctx.page);
  if (!id) throw new Error('no draft id in the page URL');
  const res = await apiGetRetrying(ctx, `/api/process/drafts/${id}`);
  if (!res.ok()) throw new Error(`GET draft ${id} failed: ${res.status()}`);
  return res.json();
}

// Normalize a bundle's WIRING for order/assembly-independent comparison —
// mirrors the engine convergence tests' projection (§4.5): volatile fields
// (trigger ids, timestamps) dropped, arrays deterministically sorted; only the
// wiring-bearing surfaces compared.
function normalizeWiring(bundle) {
  const roles = {};
  for (const r of bundle.roles || []) {
    roles[r.id] = {
      triggers: (r.triggers || [])
        .map(({ id, createdAt, activatedAt, ...t }) => t)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      outcomes: r.outcomes || null,
      github: r.github || null,
      channels: (r.channels || []).slice()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      emits: (r.emits || []).slice().sort(),
    };
  }
  const humans = (bundle.humans || []).map(h => ({
    id: h.id, name: h.name,
    emits: (h.emits || []).slice().sort(),
    consumes: (h.consumes || []).slice()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { roles, humans, labels: (bundle.labels || []).slice().sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Capture the open draft's normalized wiring state under a name, for a later
 * flows.expectDraftWiringEqual — the UI-level convergence check (concept §4.5).
 *
 * @param {string} params.as - Name to store the snapshot under.
 * @example
 * - action:
 *     do: flows.captureDraftWiring
 *     as: pathA
 */
async function captureDraftWiring(ctx, { as }) {
  ctx.wiringSnapshots = ctx.wiringSnapshots || {};
  ctx.wiringSnapshots[as] = normalizeWiring(await draftDoc(ctx));
}

/**
 * Assert two captured wiring snapshots are identical — the concept's §4.5
 * convergence guarantee at UI level: different assembly orders must persist
 * the same state.
 *
 * @param {string} params.a - First snapshot name (flows.captureDraftWiring).
 * @param {string} params.b - Second snapshot name.
 * @example
 * - assert:
 *     do: flows.expectDraftWiringEqual
 *     a: pathA
 *     b: pathB
 */
async function expectDraftWiringEqual(ctx, { a, b }) {
  const snaps = ctx.wiringSnapshots || {};
  if (!snaps[a] || !snaps[b]) throw new Error(`missing snapshot ${!snaps[a] ? a : b}`);
  expect(snaps[b], `assembly paths ${a} and ${b} must persist identical wiring`).toEqual(snaps[a]);
}

/**
 * Assert the open draft persists EXACTLY ONE github-event listener with the
 * given labelFilter on a role — single-event (D1) and, when `claimed`, the
 * derived claim convention (D3): { remove: <label>, add: "<label>:wip" }.
 *
 * @param {string} params.role - Role display name (or id) in the draft.
 * @param {string} params.event - The exact single event, e.g. "issues.labeled".
 * @param {string} params.labelFilter - The wake label the listener waits on.
 * @param {boolean} [params.claimed=true] - Assert the derived claim is stamped.
 * @example
 * - assert:
 *     do: flows.expectDraftTrigger
 *     role: Developer
 *     event: issues.labeled
 *     labelFilter: ready
 *     claimed: true
 */
async function expectDraftTrigger(ctx, { role, event, labelFilter, claimed = true }) {
  const doc = await draftDoc(ctx);
  const r = (doc.roles || []).find(x => x.id === slugRole(role) || x.displayName === role);
  expect(r, `role ${role} in draft`).toBeTruthy();
  const hits = (r.triggers || []).filter(t => t.type === 'github-event' && t.labelFilter === labelFilter);
  expect(hits.length, `exactly ONE listener on \`${labelFilter}\` (D1)`).toBe(1);
  expect(hits[0].events, `single event (D1)`).toEqual([event]);
  if (claimed) {
    expect(hits[0].claim, `derived claim (D3)`).toEqual({ remove: labelFilter, add: `${labelFilter}:wip` });
  }
}

/**
 * Add a named human role via the toolbar's Human-roles registry panel (#987)
 * and close the panel.
 *
 * @param {string} params.name - Display name, e.g. "Product Owner".
 * @example
 * - action:
 *     do: flows.addHuman
 *     name: Product Owner
 */
async function addHuman(ctx, { name }) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Add human', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Human roles' });
  await expect(d).toBeVisible();
  await d.getByPlaceholder('Add a human role (e.g. Issue Reviewer)').fill(name);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Add', exact: true }).click();
  await persisted;
  await closeSidePanel(page, 'Human roles');
}

/**
 * Assert a named human renders as a human box on the canvas (#987).
 *
 * @param {string} params.name - The human's display name.
 * @example
 * - assert:
 *     do: flows.expectHumanNode
 *     name: Product Owner
 */
async function expectHumanNode(ctx, { name }) {
  const box = ctx.page.locator(`.bp-node-human[data-id="${slugRole(name)}"]`);
  await expect(box).toBeVisible();
  await expect(box.getByText('Human role')).toBeVisible();
}

/**
 * S3 path A — the ONE-dialog review gate (concept §4.3): drag producer onto
 * consumer, pick "Issue channel", set the gate label, tick the human-approval
 * gate and pick WHO approves. Wires the full triangle (delivery + gate emit +
 * claimed single-event listener) in a single dialog.
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.label - Gate label a person applies.
 * @param {string} params.approver - The named human who approves.
 * @example
 * - action:
 *     do: flows.wireIssueChannelWithApproval
 *     from: Business Analyst
 *     to: Developer
 *     label: ready
 *     approver: Product Owner
 */
async function wireIssueChannelWithApproval(ctx, { from, to, label, approver }) {
  const { page } = ctx;
  await connectPort(page, slugRole(from), slugRole(to));
  const picker = page.getByRole('dialog', { name: /How does .* learn about/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Issue channel/ }).click();
  const channel = page.getByRole('dialog', { name: /An issue from .* wakes/ });
  await expect(channel).toBeVisible();
  await channel.getByLabel('Routing label (optional)').fill(label);
  await channel.getByRole('checkbox').first().check();
  await channel.locator('select').selectOption({ label: `\u{1F464} ${approver}` });
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await channel.getByRole('button', { name: 'Create channel' }).click();
  await persisted;
  await expect(channel).toBeHidden();
}

/**
 * S3 path B, first leg — drag a producer agent onto a human box: "P reviews
 * A's work" (delivery only; the wake stays unwired for the second leg).
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.human - The human's display name.
 * @param {string} [params.artifact=Issue] - "Issue" or "Pull request".
 * @example
 * - action:
 *     do: flows.wireHumanDelivery
 *     from: Business Analyst
 *     human: Product Owner
 */
async function wireHumanDelivery(ctx, { from, human, artifact = 'Issue' }) {
  const { page } = ctx;
  await connectPort(page, slugRole(from), slugRole(human));
  const d = page.getByRole('dialog', { name: /reviews .*'s work/ });
  await expect(d).toBeVisible();
  await d.locator('select').first().selectOption({ label: artifact });
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Wire delivery' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * S3 path B, first leg via the OUTCOME PORT: drag the producer's outcome port
 * (e.g. "Opens issue") onto a human box. Must open the person-delivery dialog
 * ("P reviews A's work") — never the channel form (the #1010 regression: the
 * pre-typed outcome drag used to mis-wire the person as a channel role).
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.outcome - The outcome port's title, e.g. "Opens issue".
 * @param {string} params.human - The human's display name.
 * @param {string} [params.artifact=Issue] - "Issue" or "Pull request".
 * @example
 * - action:
 *     do: flows.wireHumanDeliveryFromOutcome
 *     from: Business Analyst
 *     outcome: Opens issue
 *     human: Product Owner
 */
async function wireHumanDeliveryFromOutcome(ctx, { from, outcome, human, artifact = 'Issue' }) {
  const { page } = ctx;
  await connectOutcomePort(page, slugRole(from), outcome, slugRole(human));
  // The regression assertion: the channel dialog must NOT appear for a person.
  await expect(page.getByRole('dialog', { name: /wakes/ })).toHaveCount(0);
  const d = page.getByRole('dialog', { name: /reviews .*'s work/ });
  await expect(d).toBeVisible();
  await d.locator('select').first().selectOption({ label: artifact });
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Wire delivery' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * S3 path B, second leg — drag a human box onto a consumer agent: "P approves
 * → B wakes". Artifact kind is inferred/selected; claim is stamped by the
 * engine. Optionally wires the S10 rejection path back to the producer.
 *
 * @param {string} params.human - The human's display name.
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.label - Gate label the person applies.
 * @param {string} [params.kind=Issue label] - "Issue label" or "Pull-request label".
 * @param {string} [params.rejectionLabel] - When set, enable "On rejection, wake <producer>" with this label.
 * @example
 * - action:
 *     do: flows.wireHumanGate
 *     human: Product Owner
 *     to: Developer
 *     label: ready
 */
async function wireHumanGate(ctx, { human, to, label, kind = 'Issue label', rejectionLabel }) {
  const { page } = ctx;
  await connectPort(page, slugRole(human), slugRole(to));
  const d = page.getByRole('dialog', { name: /approves .* wakes/ });
  await expect(d).toBeVisible();
  await d.locator('select').first().selectOption({ label: kind });
  await d.getByPlaceholder('e.g. approved-for-dispatch').fill(label);
  if (rejectionLabel) {
    await d.getByRole('checkbox').check();
    await d.getByPlaceholder('e.g. rework').fill(rejectionLabel);
  }
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Create gate' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * Open the one Review-gate editor (§4.4) by clicking the triangle's edge chip
 * for the gate label.
 *
 * @param {string} params.gateLabel - The gate label of the triangle.
 * @example
 * - action:
 *     do: flows.openReviewGate
 *     gateLabel: ready
 */
async function openReviewGate(ctx, { gateLabel }) {
  const { page } = ctx;
  // The gate edge's chip ("<label> · Issue+ ⇥ wip") floats on the labels layer
  // and swallows pointer events, while the CLICK target is the transparent
  // 14px hit path the renderer lays under every edge (addEdgeHit). Dispatch
  // the click on the hit path nearest the chip — the chip sits on the edge's
  // midpoint, so nearest-by-geometry is the right edge.
  const opened = await page.evaluate((label) => {
    const texts = [...document.querySelectorAll('svg text')]
      .filter((t) => t.textContent.includes('⇥') && t.textContent.startsWith(label));
    if (!texts.length) return 'chip not found';
    const tb = texts[0].getBoundingClientRect();
    const cx = tb.left + tb.width / 2;
    const cy = tb.top + tb.height / 2;
    const hits = [...document.querySelectorAll('svg path')]
      .filter((p) => p.getAttribute('stroke') === 'transparent');
    if (!hits.length) return 'no edge hit paths';
    let best = null;
    let bestD = Infinity;
    for (const h of hits) {
      const hb = h.getBoundingClientRect();
      const px = Math.max(hb.left, Math.min(cx, hb.right));
      const py = Math.max(hb.top, Math.min(cy, hb.bottom));
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestD) { bestD = d; best = h; }
    }
    best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return null;
  }, gateLabel);
  if (opened) throw new Error(`flows.openReviewGate: ${opened}`);
  await expect(page.getByRole('dialog', { name: 'Review gate' })).toBeVisible();
}

/**
 * Assert the open Review-gate editor shows the full triangle with the claim
 * (D3) and — D2 — shows NO legacy multi-event migration warning: the dialog
 * the engine created must never warn about its own output. Closes the editor.
 *
 * @param {string} params.gateLabel - The gate label.
 * @param {string} params.reviewer - The named human of the triangle.
 * @example
 * - assert:
 *     do: flows.expectReviewGate
 *     gateLabel: ready
 *     reviewer: Product Owner
 */
async function expectReviewGate(ctx, { gateLabel, reviewer }) {
  const { page } = ctx;
  const d = page.getByRole('dialog', { name: 'Review gate' });
  await expect(d).toBeVisible();
  await expect(d.getByText(new RegExp(`reviewed by .*${reviewer}`))).toBeVisible();
  await expect(d.getByText(`${gateLabel}:wip`).first()).toBeVisible();
  // D2: the engine-created listener is single-event by construction — the
  // legacy multi-event migration note must NOT appear.
  await expect(d.getByText(/still listens on several events/)).toHaveCount(0);
  await closeSidePanel(page, 'Review gate');
}

/**
 * Delete the whole review gate from the open Review-gate editor (atomic,
 * symmetric cleanup — §4.4).
 *
 * @example
 * - action:
 *     do: flows.deleteReviewGate
 */
async function deleteReviewGate(ctx) {
  const { page } = ctx;
  const d = page.getByRole('dialog', { name: 'Review gate' });
  await d.getByRole('button', { name: 'Delete gate…' }).click();
  await expect(d.getByText('Remove the whole review gate?')).toBeVisible();
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Remove gate' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * S5 — wire a plain (ungated) pull-request channel: A opens a PR that wakes B.
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.to - Consumer agent display name.
 * @param {string} [params.label] - Optional routing label.
 * @example
 * - action:
 *     do: flows.wirePrChannel
 *     from: Developer
 *     to: Reviewer
 */
async function wirePrChannel(ctx, { from, to, label }) {
  const { page } = ctx;
  await connectPort(page, slugRole(from), slugRole(to));
  const picker = page.getByRole('dialog', { name: /How does .* learn about/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Pull-request channel/ }).click();
  const channel = page.getByRole('dialog', { name: /A pull request from .* wakes/ });
  await expect(channel).toBeVisible();
  if (label) await channel.getByLabel('Routing label (optional)').fill(label);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await channel.getByRole('button', { name: 'Create channel' }).click();
  await persisted;
  await expect(channel).toBeHidden();
}

/**
 * S10 — add the rejection path in the OPEN Review-gate editor: on rejection,
 * the producer is woken with this label. Closes the editor.
 *
 * @param {string} params.label - Rejection label, e.g. "rework".
 * @example
 * - action:
 *     do: flows.addRejectionPath
 *     label: rework
 */
async function addRejectionPath(ctx, { label }) {
  const { page } = ctx;
  const d = page.getByRole('dialog', { name: 'Review gate' });
  await expect(d).toBeVisible();
  await d.getByPlaceholder('e.g. rework').fill(label);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Add', exact: true }).click();
  await persisted;
  // The editor may close itself on a successful add — only close it if it is
  // still around after the write settles.
  await d.waitFor({ state: 'hidden', timeout: 3000 })
    .catch(() => closeSidePanel(page, 'Review gate'));
}

/**
 * S2 — wire a plain label hand-off (A sets a label that wakes B) via the
 * canvas drag + "Label hand-off" tile.
 *
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.label - The hand-off label.
 * @example
 * - action:
 *     do: flows.wireLabelHandoff
 *     from: Author
 *     to: Consumer
 *     label: handoff-ready
 */
async function wireLabelHandoff(ctx, { from, to, label }) {
  const { page } = ctx;
  await connectPort(page, slugRole(from), slugRole(to));
  const picker = page.getByRole('dialog', { name: /How does .* learn about/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Label hand-off/ }).click();
  const d = page.getByRole('dialog', { name: 'Wire a label hand-off' });
  await expect(d).toBeVisible();
  await d.locator('input[list]').first().fill(label);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Create hand-off' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * S2 — assert the CLAIM BADGE renders on the canvas: the hand-off's edge chip
 * reads "<label> · … ⇥ wip" (#958), so a claimed listener is visibly different
 * from an unclaimed one.
 *
 * @param {string} params.label - The wake label whose claim chip must show.
 * @example
 * - assert:
 *     do: flows.expectInputClaim
 *     label: ready
 */
async function expectInputClaim(ctx, { label }) {
  await expect(ctx.page.getByText(new RegExp(`${label} .*\u21e5`)).first()).toBeVisible();
}

// Drag from an ACTOR source (@github / @external) onto an agent node. Actor
// ports carry a different tooltip than agent ports.
async function connectActorPort(page, actorId, toSlug) {
  const port = page.locator(
    `.actor-node-src[data-actor-id="${actorId}"] div[title="Drag to an agent: it gets a trigger from this source"]`,
  );
  await expect(port).toBeVisible();
  const target = page.locator(nodeSel(toSlug)).first();
  await expect(target).toBeVisible();
  const a = await port.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.up();
}

/**
 * S1 — wire a raw GitHub event source: drag @github onto an agent, pick
 * "GitHub trigger", choose the event (+ optional label filter).
 *
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.event - Event option label, e.g. "Issue opened".
 * @param {string} [params.labelFilter] - Label filter (label events only).
 * @example
 * - action:
 *     do: flows.wireGithubSource
 *     to: Triage
 *     event: Issue opened
 */
async function wireGithubSource(ctx, { to, event, labelFilter }) {
  const { page } = ctx;
  await connectActorPort(page, '@github', slugRole(to));
  // With a single allowed type the create dialog opens the form directly;
  // otherwise the tile picker appears first.
  const d = page.getByRole('dialog', { name: 'GitHub trigger' });
  if (!await d.isVisible().catch(() => false)) {
    await page.getByRole('dialog').last().getByRole('button', { name: /GitHub trigger/ }).click();
  }
  await expect(d).toBeVisible();
  await d.locator('select').first().selectOption({ label: event });
  if (labelFilter) {
    await d.getByPlaceholder(/e\.g\. priorisiert/).fill(labelFilter);
  }
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Create trigger' }).click();
  await persisted;
  await expect(d).toBeHidden();
}

/**
 * S13 — wire a webhook source: drag @external onto an agent, pick "Webhook".
 *
 * @param {string} params.to - Consumer agent display name.
 * @param {string} params.description - Webhook description.
 * @example
 * - action:
 *     do: flows.wireWebhookSource
 *     to: Triage
 *     description: CI pipeline finished
 */
async function wireWebhookSource(ctx, { to, description }) {
  const { page } = ctx;
  await connectActorPort(page, '@external', slugRole(to));
  const d = page.getByRole('dialog', { name: 'Webhook' });
  if (!await d.isVisible().catch(() => false)) {
    await page.getByRole('dialog').last().getByRole('button', { name: /Webhook/ }).click();
  }
  await expect(d).toBeVisible();
  await d.getByPlaceholder('e.g. CI pipeline finished').fill(description);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Create webhook' }).click();
  await persisted;
  await closeSidePanel(page, 'Webhook');
}

/**
 * S8 — add a recurring schedule via Routing → Add input → Schedule (the shared
 * trigger form; schedules have no canvas actor).
 *
 * @param {string} params.name - Agent display name.
 * @param {string} [params.time=07:00] - Daily wake time.
 * @param {string} params.prompt - Wake instruction text.
 * @example
 * - action:
 *     do: flows.addScheduleInput
 *     name: Triage
 *     time: "07:00"
 *     prompt: Daily backlog sweep.
 */
async function addScheduleInput(ctx, { name, time = '07:00', prompt }) {
  const { page } = ctx;
  await openRouting(ctx, { name });
  const inspector = page.getByRole('dialog', { name });
  await inspector.getByRole('button', { name: 'Add input' }).click();
  const add = page.getByRole('dialog', { name: 'Add input' });
  await expect(add).toBeVisible();
  await add.getByRole('button', { name: /Schedule/ }).click();
  const d = page.getByRole('dialog', { name: 'Add a schedule' });
  await expect(d).toBeVisible();
  await d.locator('select').filter({ hasText: 'Custom expression' }).selectOption('daily');
  await d.locator('input[type="time"]').fill(time);
  if (prompt) await d.getByLabel(/Wake instruction/).fill(prompt);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: /Add Trigger|Save/ }).click();
  await persisted;
  await closeSidePanel(page, name);
}

/**
 * S11 — wire a file-artifact hand-off from the consumer side: Routing → Add
 * input → File artifact → pick the producer → name the artifact.
 *
 * @param {string} params.name - Consumer agent display name.
 * @param {string} params.from - Producer agent display name.
 * @param {string} params.artifact - Logical artifact name, e.g. "Analysis report".
 * @example
 * - action:
 *     do: flows.addArtifactInput
 *     name: Developer
 *     from: Analyst
 *     artifact: Analysis report
 */
async function addArtifactInput(ctx, { name, from, artifact }) {
  const { page } = ctx;
  await openRouting(ctx, { name });
  const inspector = page.getByRole('dialog', { name });
  await inspector.getByRole('button', { name: 'Add input' }).click();
  const add = page.getByRole('dialog', { name: 'Add input' });
  await expect(add).toBeVisible();
  await add.getByRole('button', { name: /File artifact/ }).click();
  const pick = page.getByRole('dialog', { name: 'File artifact' });
  await expect(pick).toBeVisible();
  await pick.getByRole('button', { name: from }).click();
  const d = page.getByRole('dialog', { name: 'Add data flow' });
  await expect(d).toBeVisible();
  await d.getByPlaceholder('e.g. Functional Design').fill(artifact);
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await d.getByRole('button', { name: 'Add data flow' }).click();
  await persisted;
  await expect(d).toBeHidden();
  await closeSidePanel(page, name);
}

/**
 * S1/S8/S13 — assert the draft persists all three source inputs on a role:
 * a raw github-event trigger, a cron schedule, and an http webhook.
 *
 * @param {string} params.role - Role display name (or id) in the draft.
 * @example
 * - assert:
 *     do: flows.expectDraftSourceInputs
 *     role: Triage
 */
async function expectDraftSourceInputs(ctx, { role }) {
  const doc = await draftDoc(ctx);
  const r = (doc.roles || []).find(x => x.id === slugRole(role) || x.displayName === role);
  expect(r, `role ${role} in draft`).toBeTruthy();
  const types = (r.triggers || []).map(t => t.type);
  expect(types, 'github-event source (S1)').toContain('github-event');
  expect(types, 'cron schedule (S8)').toContain('cron');
  expect(types, 'http webhook (S13)').toContain('http');
}

/**
 * Assert the canvas shows NO lint issues — a clean flow renders no lint button
 * at all (the Flows editor has no "clean" banner by design).
 *
 * @example
 * - assert:
 *     do: flows.expectNoLints
 */
async function expectNoLints(ctx) {
  await expect(ctx.page.getByRole('button', { name: /^\d+ issues?/ })).toHaveCount(0);
}

// The lint panel renders each lint's plain-language TITLE (#1122,
// lint-view.js LINT_INFO); the raw slug survives only as a tooltip, which
// getByText cannot match. Mirror of the titles for the codes journeys assert —
// an unmapped code falls back to the slug, exactly like the app does.
const LINT_TITLES = {
  'producer-unconsumed': 'Output nobody consumes',
  'outcome-without-consumer': 'Outcome nobody reacts to',
  'duplicate-listener': 'Redundant inputs',
  'orphan-listener': 'Input never wakes',
  'dead-end-emitter': 'Signal goes nowhere',
  'gate-violation': 'Agent claims a human-only gate',
  'unclaimed-listener': 'Listener without a claim',
};

/**
 * Assert a lint code's presence or absence via the canvas lint panel (matched
 * by the code's rendered plain-language title — see LINT_TITLES). With
 * `absent: true` the whole lint button may be gone (fully clean) or the code
 * missing from the open list.
 *
 * @param {string} params.code - Lint code, e.g. "producer-unconsumed".
 * @param {boolean} [params.absent=false] - Assert the code does NOT fire.
 * @example
 * - assert:
 *     do: flows.expectLint
 *     code: producer-unconsumed
 */
async function expectLint(ctx, { code, absent = false }) {
  const { page } = ctx;
  const button = page.getByRole('button', { name: /^\d+ issues?/ });
  if (absent && await button.count() === 0) return; // fully clean
  await expect(button).toBeVisible();
  await button.click();
  const entry = page.getByText(LINT_TITLES[code] || code, { exact: false });
  if (absent) await expect(entry).toHaveCount(0);
  else await expect(entry.first()).toBeVisible();
  await button.click(); // toggle closed
}

/**
 * Close the open node inspector panel by its agent display name.
 *
 * @param {string} params.name - Agent display name (the panel title).
 * @example
 * - action:
 *     do: flows.closeInspector
 *     name: Builder
 */
async function closeInspector(ctx, { name }) {
  await closeSidePanel(ctx.page, name);
}

/**
 * Open-end declaration (§4.7): mark an outcome of the open Routing tab
 * terminal ("the end product") and assert the endpoint readout replaces the
 * "no consumer yet" call-to-action. Leaves the inspector open.
 *
 * @param {string} params.name - Agent display name.
 * @example
 * - action:
 *     do: flows.markOutcomeTerminal
 *     name: Author
 */
async function markOutcomeTerminal(ctx, { name }) {
  const { page } = ctx;
  await openRouting(ctx, { name });
  const inspector = page.getByRole('dialog', { name });
  await expect(inspector.getByText('no consumer yet').first()).toBeVisible();
  // The CTA row can sit under the panel's scroll shadow at journey viewport
  // size — geometric clicks are intercepted, so dispatch on the element.
  await inspector.getByRole('button', { name: 'mark terminal' }).first().evaluate((el) => el.click());
  await expect(inspector.getByText('Terminal by design').first()).toBeVisible();
  // The marker edits the outcome editor's local state; "Save outcomes"
  // persists it (same explicit-save semantics as every outcome edit).
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await inspector.getByRole('button', { name: 'Save outcomes' }).click();
  await persisted;
  await closeSidePanel(page, name);
  // Re-open the draft fresh so the lint panel reflects the persisted state
  // (the inspector save does not force a canvas refetch).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible();
}

/**
 * D4 — assert an outcome row of the open agent's Routing tab shows the
 * "reviewed by 👤 <reviewer>" consumer line instead of a false "no consumer".
 *
 * @param {string} params.name - Producer agent display name.
 * @param {string} params.reviewer - The named human reviewer.
 * @example
 * - assert:
 *     do: flows.expectOutcomeReviewer
 *     name: Business Analyst
 *     reviewer: Product Owner
 */
async function expectOutcomeReviewer(ctx, { name, reviewer }) {
  const { page } = ctx;
  await openRouting(ctx, { name });
  const inspector = page.getByRole('dialog', { name });
  // The Routing tab renders the reviewer as the BOUND "reviewed by" picker
  // (editable in place, #1003); the static "reviewed by 👤 …" line is the
  // read-only OutcomesPanel's rendering.
  const picker = inspector.getByRole('combobox', { name: 'reviewed by' }).first();
  await expect(picker).toBeVisible();
  await expect(picker.locator('option:checked')).toHaveText(`\u{1F464} ${reviewer}`);
  await expect(inspector.getByText('no consumer yet')).toHaveCount(0);
  await closeSidePanel(page, name);
}

/**
 * S9 — flag a routing label as a Brake (flow → person) in the Label registry;
 * the outcome that sets it then reads "hands off to a person".
 *
 * @param {string} params.label - The label to flag.
 * @example
 * - action:
 *     do: flows.setLabelBrake
 *     label: needs-human-decision
 */
async function setLabelBrake(ctx, { label }) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Label registry' });
  await expect(d).toBeVisible();
  const row = d.locator('div').filter({ has: page.locator(`code:text-is("${label}")`) }).last();
  const persisted = page.waitForResponse((r) => r.request().method() === 'PUT' && r.ok());
  await row.locator('select').selectOption('brake');
  await persisted;
  await closeSidePanel(page, 'Label registry');
}

/**
 * S9 — assert an outcome hands off to a person: the Routing row reads
 * "hands off to a person 👤".
 *
 * @param {string} params.name - Agent display name.
 * @example
 * - assert:
 *     do: flows.expectHandsOffLine
 *     name: Reviewer
 */
async function expectHandsOffLine(ctx, { name }) {
  const { page } = ctx;
  await openRouting(ctx, { name });
  const inspector = page.getByRole('dialog', { name });
  await expect(inspector.getByText(/hands off to a person/).first()).toBeVisible();
  await closeSidePanel(page, name);
}

/**
 * Open a LIVE team's flow graph from the Flows left list.
 *
 * @param {string} params.team - Team display name (list row label).
 * @example
 * - action:
 *     do: flows.openTeamFlow
 *     team: Wiring Demo
 */
async function openTeamFlow(ctx, { team }) {
  const { page } = ctx;
  await page.goto('/flows');
  await page.getByRole('button', { name: team }).first().click();
  await expect(page.getByRole('button', { name: 'Add human', exact: true })).toBeVisible();
}

/**
 * LIVE-mode wiring assertion: the member's persisted triggers.json (via the
 * API) carries exactly one claimed single-event listener on the label —
 * D1/D3 in live-team mode.
 *
 * @param {string} params.agentId - Full member agent id, e.g. wiring-demo-developer.
 * @param {string} params.event - The exact single event.
 * @param {string} params.labelFilter - The wake label.
 * @example
 * - assert:
 *     do: flows.expectAgentTriggerApi
 *     agentId: wiring-demo-developer
 *     event: issues.labeled
 *     labelFilter: ready
 */
async function expectAgentTriggerApi(ctx, { agentId, event, labelFilter }) {
  const res = await apiGetRetrying(ctx, `/api/agents/${agentId}/triggers`);
  expect(res.ok(), `GET /api/agents/${agentId}/triggers`).toBeTruthy();
  const body = await res.json();
  const triggers = Array.isArray(body) ? body : (body.triggers || []);
  const hits = triggers.filter(t => t.type === 'github-event' && t.labelFilter === labelFilter);
  expect(hits.length, `exactly ONE listener on \`${labelFilter}\``).toBe(1);
  expect(hits[0].events).toEqual([event]);
  expect(hits[0].claim).toEqual({ remove: labelFilter, add: `${labelFilter}:wip` });
}

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
  showStages,
  assignStage,
  expectCreateTeamAvailable,
  openRouting,
  setOutcomeMode,
  addOutcome,
  saveOutcomes,
  suggestOutcomes,
  wireOutcome,
  expectOutcome,
  expectSwitchNode,
  expectNoOutcomes,
  captureDraftWiring,
  expectDraftWiringEqual,
  expectDraftTrigger,
  addHuman,
  expectHumanNode,
  wireIssueChannelWithApproval,
  wirePrChannel,
  wireHumanDelivery,
  wireHumanDeliveryFromOutcome,
  wireHumanGate,
  openReviewGate,
  expectReviewGate,
  deleteReviewGate,
  addRejectionPath,
  wireLabelHandoff,
  expectInputClaim,
  wireGithubSource,
  wireWebhookSource,
  addScheduleInput,
  addArtifactInput,
  expectDraftSourceInputs,
  expectNoLints,
  expectLint,
  closeInspector,
  markOutcomeTerminal,
  expectOutcomeReviewer,
  setLabelBrake,
  expectHandsOffLine,
  openTeamFlow,
  expectAgentTriggerApi,
  volatileLocators,
};

import React from 'react';
import { Link } from 'react-router';
import {
  Puzzle, ShieldCheck, Users, Terminal, Code2,
  Boxes, ArrowRight, Layout, Lightbulb,
} from 'lucide-react';

/**
 * Plugin System — a persistent, always-reachable concept/help page (#1620,
 * made self-contained + reachable only via the Plugins page in #1638).
 *
 * The platform ships a governed Plugin System but nothing in the UI explained
 * it: an operator landed on the Plugins management page and saw a management
 * surface without knowing what a plugin actually is, what activating one does,
 * how permissions relate to teams and agents, or how a developer would build
 * one. This page fills that gap, mirroring the Getting Started concept-overview
 * pattern (#1107).
 *
 * The page is **self-contained** (#1638): everything a reader needs to
 * understand the plugin system — including how to build one — is on the page
 * itself, with no instruction to open an in-repo/system document. All content
 * is curated plain-language explanation; it is static and does NOT read live
 * plugin data, so it renders the same whether or not any plugin is installed or
 * granted. It is intentionally un-gated (like Getting Started): a Team Member
 * sees the same explanatory content — the page explains permissions but is not
 * itself privileged.
 *
 * Reachability (#1638): there is no standalone sidebar entry — the page is
 * reached from the "Learn about plugins" link on the Plugins page. The route
 * and its breadcrumb stay so direct links / bookmarks keep working.
 *
 * "Plugin" here always means a **platform plugin** (a registered sidecar + CLI
 * extension of the Agent Studio platform), never a Claude Code "agent plugin".
 */

function Section({ Icon, title, children }) {
  return (
    <section style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)',
      padding: 'var(--eb-space-5)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <Icon size={20} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', color: 'var(--eb-text-primary)' }}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

// A plain paragraph in the section body voice.
function P({ children }) {
  return (
    <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.65 }}>
      {children}
    </p>
  );
}

// A sub-heading inside a section body (with a small leading icon).
function SubHead({ Icon, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)' }}>
      {Icon && <Icon size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />}
      <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
        {children}
      </span>
    </div>
  );
}

// Inline monospace token (CLI names, capabilities, file paths).
function Code({ children }) {
  return (
    <code style={{
      fontFamily: 'var(--eb-font-mono)',
      fontSize: '0.9em',
      background: 'var(--eb-bg-app)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-sm)',
      padding: '0 4px',
      color: 'var(--eb-text-primary)',
    }}>
      {children}
    </code>
  );
}

const ulStyle = {
  margin: 0,
  paddingLeft: 'var(--eb-space-5)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.7,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-1)',
};

export default function PluginSystemHelp() {
  return (
    <div style={{
      padding: 'var(--eb-space-8) var(--eb-space-6)',
      maxWidth: 860,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-5)',
    }}>
      {/* Header */}
      <div>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-md)', lineHeight: 1.6 }}>
          Plugins are how agents reach the outside world safely. This page is a complete,
          self-contained guide: what a plugin is (in plain terms and in technical detail), what
          plugins are typically used for, what happens when you activate one, how permissions work,
          and — for developers — how to build one from scratch. It is a stable reference: everything
          here holds whether or not any plugin is currently installed.
        </p>
      </div>

      {/* AC5 — high-level "what is a plugin", for a non-technical reader */}
      <Section Icon={Puzzle} title="What is a plugin">
        <P>
          Agents run inside locked-down containers with no direct path to the outside world — that
          isolation is what keeps one agent from touching another's files, credentials or network.
          Most work happens entirely inside that sandbox. But some tasks need a governed connection
          <em> out</em> of it: running a throw-away container to test something, filing tickets in a
          test-management system, updating a shared planning board.
        </P>
        <P>
          A <strong>plugin</strong> is exactly that connection, made safe. Installing a plugin gives
          the platform a new capability; granting it to a team or an agent lets those agents use it —
          by running a simple command — without ever handing them the underlying key, socket or
          password. Think of it as a controlled doorway: the agent can ask for something through the
          doorway, but the thing that holds the real privilege stays on the other side, where you can
          see and audit every request.
        </P>
        <P>
          Because a plugin is a deliberate, reviewed addition, capabilities don't appear by accident.
          A System Admin installs a plugin (a considered action — some plugins hold real power), and a
          Team Admin decides which of their agents may use it. Nothing an agent can reach was not first
          granted to it.
        </P>
      </Section>

      {/* AC6 — technical "what is a plugin" */}
      <Section Icon={ShieldCheck} title="How a plugin works, technically">
        <P>
          A plugin pairs two pieces. The first is a privilege-holding <strong>broker sidecar</strong>:
          a small service that runs beside the stack (not inside any agent) and holds the real
          capability — a host socket, a vendor API token, a database handle. The second is a
          <strong> dependency-free CLI</strong> that is seeded into the granted agent's workspace. The
          agent only ever runs the CLI; the CLI is a thin client that calls the broker over the
          network. The socket or credential lives <em>only</em> inside the sidecar, never in an agent
          container, so the isolation story stays intact even as the agent gains a new power.
        </P>
        <P>
          <strong>Security is enforced server-side, on every call.</strong> Each granted agent (or
          team) is issued a signed, per-scope token; the broker verifies that token before it does
          anything, so a forged or missing token is rejected before any work runs. One scope never
          sees another scope's resources — the broker stamps every object it creates with an ownership
          label and filters by it — and <strong>every call is written to an audit log</strong> the
          broker owns. A non-granted agent cannot even reach the sidecar: its container is only
          connected to the sidecar's network when the grant says so, so reachability matches the
          grant exactly.
        </P>
        <P>
          <strong>Platform plugin vs. agent plugin.</strong> Throughout the Admin Console, "plugin"
          means a <em>platform plugin</em> — this sidecar-plus-CLI extension of Agent Studio itself.
          It is not the same as a Claude Code "agent plugin" (the CLI's own marketplace format that
          bundles skills, commands and hooks for an agent). When both need distinguishing, the terms
          are <strong>platform plugin</strong> and <strong>agent plugin</strong>; unqualified, it is
          always the platform one.
        </P>
      </Section>

      {/* AC7 — typical use cases (distinct section, concrete plain-language examples) */}
      <Section Icon={Lightbulb} title="Typical use cases">
        <P>
          Plugins are the right tool whenever an agent needs a capability that shouldn't be baked into
          its container or given to it as a raw credential. Concrete examples of what teams use plugins
          for:
        </P>
        <ul style={ulStyle}>
          <li>
            <strong>Running a sandboxed container runtime</strong> — an agent spins up a throw-away
            container or a small multi-service stack to build, run or test something, then tears it
            down, without the agent ever touching the host's container socket (the podman sandbox).
          </li>
          <li>
            <strong>Driving a test-management system</strong> — creating test cases and triggering
            regression runs in a vendor tool (Xray, Zephyr, qTest), where the single vendor token lives
            only in the broker and never reaches the agent.
          </li>
          <li>
            <strong>Reading and writing a planning board</strong> — an agent shows the team's network
            plan, ticks off a milestone, or edits the board, gated by an autonomy ladder so read-only
            stays always-allowed while edits require a higher level.
          </li>
          <li>
            <strong>Working with GitHub issues and pull requests</strong> — a governed connection to a
            code-hosting backend for the parts of a flow that must act as a real, audited identity.
          </li>
          <li>
            <strong>Serving a reference catalog</strong> — a privilege-less, UI-only plugin that ships
            a browsable library of patterns or documentation as its own embedded page.
          </li>
        </ul>
        <P>
          The common thread: the capability carries real privilege or a secret, so it is delivered
          through a reviewed, audited broker rather than dropped into the agent's sandbox.
        </P>
      </Section>

      {/* What happens when you activate/grant a plugin */}
      <Section Icon={Boxes} title="What happens when you activate a plugin">
        <P>
          Activating a plugin for a team or agent is a <strong>grant</strong> — an entitlement on the
          agent construct, not a change to any Working Environment. (Installing a plugin, by contrast,
          is a separate System-Admin step that starts its broker but grants nothing; see below.)
        </P>
        <P>
          A grant takes effect <strong>live, without respawning the agent</strong>. The moment you
          activate it, the plugin's CLI script and a small config file are synced into the agent's
          workspace (under <Code>.agent-studio/</Code>), the sidecar is connected to that agent's
          network, and a one-line capability note is added to the agent's instructions
          (its <Code>CLAUDE.md</Code>) telling it the command exists. No restart, no re-seed of the
          whole workspace — the same additive sync used for skills.
        </P>
        <P>
          After that the agent simply calls the plugin like any ordinary command in its shell. There
          is no hidden channel and no special rendering: the call shows up as a normal Bash step in
          the session log, so you can always see exactly what the agent ran. Revoking the grant
          removes the CLI and config and disconnects the sidecar — just as live.
        </P>
      </Section>

      {/* Permissions, teams and agents */}
      <Section Icon={Users} title="Permissions, teams and agents">
        <P>
          Two roles divide the work. A <strong>System Admin installs</strong> a plugin (a deliberate,
          reviewed action — a sidecar can hold real privilege), which makes its broker available but
          entitles no one. A <strong>Team Admin grants</strong> an installed plugin within their own
          team. A grant on a team agent is <strong>inherited by that team's member agents</strong>,
          unless a member overrides it.
        </P>
        <P>
          Every grant carries a <strong>scope granularity</strong> — <strong>per team</strong> or
          <strong> per agent</strong> — which decides how the granted agents appear to the broker. At
          <strong> team</strong> granularity the whole squad shares one broker-side identity and one
          pool of resources (the right default for a shared, expensive backend). At <strong>agent</strong>
          {' '}granularity every member gets its own identity, so two agents on the same team are as
          isolated from each other as two different teams. Which granularities are offered is bounded
          by what the plugin's broker can actually honour, and the platform's default is per team unless
          the plugin declares otherwise.
        </P>
        <P>
          All of it is governed server-side: the broker verifies a per-scope token on every call (a
          forged or missing token is rejected before anything runs), one scope never sees another's
          resources, and <strong>every call is audited</strong> in the broker's own log for compliance.
        </P>
      </Section>

      {/* Plugins with their own UI */}
      <Section Icon={Layout} title="Plugins with their own UI">
        <P>
          Some plugins also serve a small web UI of their own (a dashboard, a planning board). When
          one does, the console <strong>embeds it inside the same window</strong> and adds a nav entry
          for it — it is proxied behind the <em>same</em> session login and role model as every other
          page, so there is no second login. That is why installing certain plugins makes a new item
          appear in the sidebar.
        </P>
        <P>
          The plugin UI inherits none of the console's internal state; the iframe boundary is the
          contract, and the console forwards only the signed viewer identity and effective role. A
          plugin may expose several pages behind its one mount, each declaring the minimum role it
          needs — so an admin-only page stays refused to an ordinary member on both the console side
          and the plugin side.
        </P>
      </Section>

      {/* AC8/AC9 — how to build a plugin, self-contained (no external/in-repo doc pointer) */}
      <Section Icon={Code2} title="How to build a plugin">
        <P>
          A plugin is a directory in the registry with four parts: a <strong>manifest</strong>, a
          <strong> broker sidecar</strong>, a dependency-free <strong>CLI</strong>, and, optionally, a
          <strong> web UI</strong> served from the sidecar. Building one means writing the manifest,
          implementing the broker against a small set of obligations, and shipping the CLI facade the
          agent will call. The rest of this section covers each building block to the depth needed to
          start.
        </P>

        <div>
          <SubHead>The manifest (<Code>plugin.json</Code>)</SubHead>
          <P>
            One JSON file declares everything the platform needs to install, secure and grant the
            plugin. Key fields:
          </P>
          <ul style={ulStyle}>
            <li><Code>id</Code> / <Code>name</Code> / <Code>description</Code> — identity and the operator-facing blurb shown on the registry.</li>
            <li><Code>sidecar</Code> — the broker's container <Code>image</Code>, its <Code>internalPort</Code>, and <Code>capabilities</Code>: a <strong>closed enum</strong> of privileged attachments the platform knows how to provide (<Code>podman-socket</Code>, <Code>host-mount:&lt;path&gt;</Code>, <Code>egress</Code>). A plugin cannot request an arbitrary mount, and a System Admin reviews these in plain language before installing.</li>
            <li><Code>cli</Code> — the CLI facade's <Code>name</Code>, <Code>entrypoint</Code> and <Code>runtime</Code> (<Code>python3</Code> or <Code>node</Code>).</li>
            <li><Code>scopes</Code> — the granularities the broker actually implements (<Code>["team"]</Code> or <Code>["team","agent"]</Code>, always including <Code>team</Code>); an optional <Code>defaultScopeGranularity</Code> sets the grant default.</li>
            <li><Code>credentials</Code> — secrets bound at install time from the platform's credential store and injected into the <em>sidecar's</em> environment, never into agents.</li>
            <li><Code>platforms</Code> — runtime requirements (<Code>podman</Code>, <Code>kubernetes</Code>, or both); the console shows an honest "not available on this stack" instead of a broken toggle.</li>
            <li><Code>requiresApproval</Code> — subcommands the broker must park for human confirmation before running (e.g. a destructive delete).</li>
            <li><Code>policy</Code> — optional per-subcommand authorisation keyed on the calling scope (e.g. only the flow-final agent may create test cases) — the one rule only <em>agent</em> granularity can express.</li>
            <li><Code>ui</Code> — optional embedded UI: a <Code>title</Code> and <Code>routes[]</Code>, each with the minimum role (<Code>minRole</Code>) it needs.</li>
            <li><Code>promptLine</Code> — the single gated line added to a granted agent's <Code>CLAUDE.md</Code> so it knows the command exists.</li>
          </ul>
        </div>

        <div>
          <SubHead Icon={ShieldCheck}>The broker sidecar's responsibilities</SubHead>
          <P>
            The broker is where all security lives. On <strong>every</strong> call it must: verify the
            signed per-scope token (reject forged/missing with 401); stamp every resource it creates
            with the caller's ownership label and filter by it so scopes never see each other; enforce
            any per-scope quota the manifest declares; write one audit line per call; mask secret values
            in its output; and answer the two plain-REST routes the orchestrator calls on every broker —
            a <strong>health</strong> probe and a <strong>scope-teardown</strong> route that reaps a
            scope's resources (on team or agent deletion) <em>before</em> the platform invalidates the
            token. If the manifest names <Code>requiresApproval</Code> subcommands, the broker holds them
            in an approval pen for a human confirm.
          </P>
        </div>

        <div>
          <SubHead Icon={Terminal}>CLI contract essentials</SubHead>
          <ul style={ulStyle}>
            <li>A single <strong>dependency-free file</strong> against the runtimes already in the agent image (<Code>python3</Code>, <Code>node</Code>, <Code>curl</Code>) — no installs, no compiled binaries.</li>
            <li><Code>--json</Code> on every subcommand, and <strong>standard exit codes</strong>: <Code>0</Code> ok, <Code>1</Code> domain error, <Code>2</Code> usage, <Code>3</Code> broker unreachable.</li>
            <li><Code>--help</Code> carries the complete, agent-readable documentation — the instructions stay lean and discovery is lazy.</li>
            <li>The CLI reads its endpoint URL + per-agent token from a <Code>0600</Code> config file at <Code>.agent-studio/plugins/&lt;id&gt;.json</Code>, written at grant time — so rotation is also a live sync.</li>
            <li>Long-running work uses submit → poll (e.g. <Code>run --async</Code> then <Code>status &lt;id&gt;</Code>), never an unbounded blocking call.</li>
          </ul>
        </div>

        <div>
          <SubHead Icon={Layout}>The optional UI extension</SubHead>
          <P>
            If your plugin serves a UI, the sidecar hosts it and the console proxies it behind the
            existing session login — you don't build a second auth system. The console forwards a signed
            viewer identity and effective role with each request; your pages read those headers and
            enforce the <Code>minRole</Code> you declared per route. A UI-only plugin can even declare no
            capabilities and no credentials at all (a reference catalog is exactly this).
          </P>
        </div>

        <div>
          <SubHead Icon={Code2}>The recommended Broker SDK</SubHead>
          <P>
            Because every broker owes the same obligations, the platform ships a <strong>Broker SDK</strong>:
            a small, dependency-free Node module a sidecar imports so each author does not re-implement
            (and re-break) them. It provides token verification, the ownership-label scope filter, the
            audit writer, secret masking, the health and teardown endpoints, and the approval holding
            pen — so a credential-backed broker becomes thin: import the SDK, add only your
            vendor-client and any policy. Using it is strongly recommended; the platform verifies the
            wire contract, not the implementation, so an SDK-free broker that speaks the same protocol is
            equally valid.
          </P>
        </div>
      </Section>

      {/* Footer — back to the management surface */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', alignItems: 'center' }}>
        <Link to="/plugins" style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          padding: '8px 14px', borderRadius: 'var(--eb-radius-md)',
          fontWeight: 600, textDecoration: 'none', fontSize: 'var(--eb-text-sm)',
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
        }}>
          <Puzzle size={16} /> Manage plugins <ArrowRight size={14} />
        </Link>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          Installing and removing plugins is a System-Admin action on the Plugins page.
        </span>
      </div>
    </div>
  );
}

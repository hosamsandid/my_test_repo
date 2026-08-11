import React from 'react';
import { Link } from 'react-router';
import {
  Puzzle, ShieldCheck, Users, Terminal, Code2, BookOpen,
  Boxes, ArrowRight, Layout,
} from 'lucide-react';

/**
 * Plugin System — a persistent, always-reachable concept/help page (#1620).
 *
 * The platform ships a governed Plugin System (docs/plugin-system-concept.md,
 * merged #1367) but nothing in the UI explained it: an operator landed on the
 * Plugins management page and saw a management surface without knowing what a
 * plugin actually is, what activating one does, how permissions relate to
 * teams and agents, or how a developer would build one. This page fills that
 * gap, mirroring the Getting Started concept-overview pattern (#1107).
 *
 * All content is curated plain-language explanation sourced from the concept
 * doc — it is static and does NOT read live plugin data, so it renders the same
 * whether or not any plugin is installed or granted (AC9). It is intentionally
 * un-gated (like Getting Started): a Team Member sees the same explanatory
 * content — the page explains permissions but is not itself privileged.
 *
 * "Plugin" here always means a **platform plugin** (a registered sidecar + CLI
 * extension of the Agent Studio platform), never a Claude Code "agent plugin"
 * (§3 Naming). The developer/SDK section stays a stable overview and defers the
 * deep technical reference to the in-repo concept doc so the in-UI copy cannot
 * drift silently.
 */

// Reference to the authoritative in-repo technical doc. It lives in the source
// tree (not a servable console URL), so we cite the path + sections rather than
// hyperlink to a file that would 404 in the browser — the pointer IS the
// reference (AC6: link out, don't duplicate).
const CONCEPT_DOC = 'docs/plugin-system-concept.md';

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
          <Puzzle size={26} style={{ color: 'var(--eb-accent-primary)' }} />
          <h1 style={{ margin: 0, fontSize: 'var(--eb-text-xl)', color: 'var(--eb-text-primary)' }}>
            Plugin System
          </h1>
        </div>
        <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-md)', lineHeight: 1.6 }}>
          Plugins are how agents reach the outside world safely. This page explains what a
          plugin is, what happens when you activate one, how permissions work, and — for
          developers — how to build one. It is a stable reference: everything here holds
          whether or not any plugin is currently installed.
        </p>
      </div>

      {/* AC3 — What is a plugin */}
      <Section Icon={Puzzle} title="What is a plugin">
        <P>
          Agents run inside locked-down containers with no direct path to the outside world —
          that isolation is what keeps one agent from touching another's workspace, credentials
          or network. But real work sometimes needs a governed connection <em>out</em>: spawning
          a container runtime, talking to a test-management system, reading a planning board. A
          <strong> platform plugin</strong> is exactly that connection, made safe.
        </P>
        <P>
          A plugin pairs a privilege-holding <strong>broker sidecar</strong> (a small service that
          runs beside the stack and holds the real capability — a host socket, a vendor API token)
          with a dependency-free <strong>CLI</strong> that is seeded into the agent's workspace. The
          agent only ever runs the CLI; the CLI is just a client that calls the broker. The socket
          or credential lives <em>only</em> inside the sidecar, never in an agent container, so the
          isolation story stays intact.
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

      {/* AC4 — What happens when you activate/grant a plugin */}
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

      {/* AC5 — Permissions, teams and agents */}
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

      {/* AC7 — Plugins with their own UI */}
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

      {/* AC6 — Develop your own plugin */}
      <Section Icon={Code2} title="Develop your own plugin">
        <P>
          A plugin is a directory in the registry with four parts: a <strong>manifest</strong>
          {' '}(<Code>plugin.json</Code> — id, the sidecar image, the closed set of privileged
          capabilities it requests, the scope granularities it supports); a <strong>broker sidecar</strong>
          {' '}(the service that holds the real capability and enforces all security); the dependency-free
          {' '}<strong>CLI</strong> agents call; and, optionally, a <strong>web UI</strong> served from
          the sidecar.
        </P>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)' }}>
            <Terminal size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              CLI contract essentials
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.7 }}>
            <li>A single <strong>dependency-free file</strong> against the runtimes already in the agent image (<Code>python3</Code>, <Code>node</Code>, <Code>curl</Code>) — no installs, no compiled binaries.</li>
            <li><Code>--json</Code> on every subcommand, and <strong>standard exit codes</strong>: <Code>0</Code> ok, <Code>1</Code> domain error, <Code>2</Code> usage, <Code>3</Code> broker unreachable.</li>
            <li><Code>--help</Code> carries the complete, agent-readable documentation — the instructions stay lean and discovery is lazy.</li>
            <li>Long-running work uses submit → poll (e.g. <Code>run --async</Code> then <Code>status &lt;id&gt;</Code>), never an unbounded blocking call.</li>
          </ul>
        </div>
        <P>
          Because every broker owes the same obligations — verifying the scope token, filtering
          resources by scope, writing the audit log, masking secrets in output, and answering the
          health and teardown probes — the platform ships a <strong>Broker SDK</strong>: a small,
          dependency-free Node module a sidecar imports so each author does not re-implement (and
          re-break) them. Using it is strongly recommended; the platform verifies the wire contract,
          not the implementation.
        </P>
        <div style={{
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          background: 'var(--eb-bg-app)',
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--eb-space-3)',
        }}>
          <BookOpen size={16} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
            The authoritative technical reference — full manifest schema, the identity/tenancy model,
            and the complete Broker SDK API — lives in the repository at{' '}
            <Code>{CONCEPT_DOC}</Code>. See <strong>§4.5 CLI contract</strong>, <strong>§4.6 Identity,
            tenancy, policy</strong>, and <strong>§4.9 Broker SDK</strong>. This page stays a stable
            overview and defers to that doc so it never drifts from the implementation.
          </div>
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

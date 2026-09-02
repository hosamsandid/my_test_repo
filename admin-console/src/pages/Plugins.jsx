import React, { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Puzzle, ShieldAlert, Download, Trash2, RefreshCw, BookOpen } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from '../components/IconButton';
import PluginTeamAssign from '../components/PluginTeamAssign';
import { pluginRegistryRow } from './plugin-registry-view.js';
import { notifyPluginsChanged } from '../components/plugin-nav';
import { grantableTeams } from './plugin-team-assign-view.js';
import { usePageActions } from '../context/PageActionsContext';

// Plugin registry (#1547) — the operator-facing install surface for the plugin
// system (docs/plugin-system-concept.md §4.1/§4.3).
//
// Installing a plugin is what makes the orchestrator start its privileged
// broker sidecar, so this page's job is to make the declared capabilities
// unmissable BEFORE the confirm. Installing still grants nothing to any agent —
// that happens per agent construct on the Agents page.
//
// Every render decision (capability wording, quota summary, button state,
// broker status) lives in the pure plugin-registry-view.js; this file is the
// renderer.

const RISK_TONE = {
  high: { bg: 'var(--eb-danger-bg, #fee)', fg: 'var(--eb-danger-fg, #a00)', border: '1px solid var(--eb-danger-fg, #a00)' },
  medium: { bg: 'var(--eb-warn-bg, #fff8e1)', fg: 'var(--eb-warn-fg, #8a6d00)', border: '1px solid var(--eb-warn-fg, #8a6d00)' },
  unknown: { bg: 'var(--eb-bg-app)', fg: 'var(--eb-text-muted)', border: '1px solid var(--eb-border-default)' },
};

const STATUS_TONE = {
  ok: 'var(--eb-success-fg, #0a7)',
  warn: 'var(--eb-warn-fg, #8a6d00)',
  muted: 'var(--eb-text-muted)',
};

// A labelled action button. IconButton is icon-only (tooltip on hover), and an
// install that hands out the host container runtime should not be a bare icon.
function ActionButton({ icon: Icon, label, onClick, danger, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title || ''}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        fontSize: 'var(--eb-text-sm)',
        fontFamily: 'inherit',
        borderRadius: 'var(--eb-radius-md)',
        border: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-app)',
        color: danger ? 'var(--eb-danger-fg, #a00)' : 'var(--eb-text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function CapabilityCard({ cap }) {
  const tone = RISK_TONE[cap.risk] || RISK_TONE.unknown;
  return (
    <div style={{
      display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: tone.bg, border: tone.border, borderRadius: 'var(--eb-radius-md)',
      marginBottom: 'var(--eb-space-2)',
    }}>
      <ShieldAlert size={16} style={{ color: tone.fg, flex: '0 0 auto', marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: tone.fg }}>{cap.title}</div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 2 }}>{cap.detail}</div>
      </div>
    </div>
  );
}

function PluginCard({ row, onInstall, onUninstall, busy, teams, stackRuntime, onAssignChanged }) {
  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-4)',
      marginBottom: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
        <Puzzle size={20} style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--eb-text-muted)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600 }}>{row.name}</span>
            <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{row.id}</code>
            {row.version && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>v{row.version}</span>
            )}
            <span style={{ fontSize: 'var(--eb-text-xs)', color: STATUS_TONE[row.status.tone] }}>
              {row.status.label}
            </span>
            {row.globalUi && (
              <span
                title="This plugin's UI is visible to every logged-in user once installed, independent of any team activation (#1599). Team activation is still the only way its agent CLI is granted."
                style={{
                  fontSize: 'var(--eb-text-xs)', padding: '1px 8px', borderRadius: 999,
                  border: '1px solid var(--eb-border)', color: 'var(--eb-text-secondary)',
                  background: 'var(--eb-bg-elevated)',
                }}
              >
                Global UI
              </span>
            )}
          </div>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 4 }}>
            {row.description}
          </div>

          <div style={{ display: 'flex', gap: 'var(--eb-space-4)', flexWrap: 'wrap', marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {row.cliName && <span>CLI: <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{row.cliName}</code></span>}
            <span>Scopes: {row.scopes.join(', ')}</span>
            <span>{row.quota}</span>
          </div>

          {!row.ok && (
            <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-danger-fg, #a00)' }}>
              {row.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {row.capabilities.length > 0 && (
            <div style={{ marginTop: 'var(--eb-space-3)' }}>
              <div style={{ fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
                Privileges this plugin's broker receives
              </div>
              {row.capabilities.map((c) => <CapabilityCard key={c.id} cap={c} />)}
            </div>
          )}
          {row.ok && row.capabilities.length === 0 && (
            <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Requests no host privileges.
            </div>
          )}

          {row.action.hint && (
            <div style={{ marginTop: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              {row.action.hint}
            </div>
          )}
        </div>

        <div style={{ flex: '0 0 auto' }}>
          {row.action.action !== 'none' && (
            <ActionButton
              icon={row.action.action === 'install' ? Download : Trash2}
              label={row.action.label}
              danger={row.action.action === 'uninstall'}
              disabled={row.action.disabled || busy}
              title={row.action.disabled ? row.action.hint : ''}
              onClick={() => (row.action.action === 'install' ? onInstall(row) : onUninstall(row))}
            />
          )}
        </div>
      </div>

      {/* Team assignment (#1691) — installed cards only, so it disappears with
          the card on uninstall (AC9). Reuses the existing activation path. */}
      {row.installed && (
        <PluginTeamAssign
          row={row}
          teams={teams}
          stackRuntime={stackRuntime}
          onChanged={onAssignChanged}
        />
      )}
    </div>
  );
}

export default function Plugins() {
  const { data, loading, error, refetch } = useApi('/api/plugins');
  // Grantable teams for the per-card assignment control (#1691). /api/agents is
  // already team-scoped server-side, so every team here is one the caller may
  // grant to; the activation proxy re-enforces the same visibility.
  const { data: agentsData, refetch: refetchAgents } = useApi('/api/agents');
  const teams = useMemo(() => grantableTeams(agentsData), [agentsData]);
  const [pending, setPending] = useState(null);   // row awaiting install confirm
  const [removing, setRemoving] = useState(null); // row awaiting uninstall confirm
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  // The stack runtime the plugin's `platforms` is checked against. The console
  // is served by the same compose stack the orchestrator runs in, so podman is
  // the honest default; a hosted deployment sets it explicitly.
  const stackRuntime = (data && data.stackRuntime) || 'podman';
  const canManage = !!(data && data.canManage);

  const installed = useMemo(
    () => ((data && data.installed) || []).map((e) => pluginRegistryRow(e, { canManage, stackRuntime })),
    [data, canManage, stackRuntime],
  );
  const available = useMemo(
    () => ((data && data.available) || []).map((e) => pluginRegistryRow(e, { canManage, stackRuntime })),
    [data, canManage, stackRuntime],
  );

  async function doInstall(row) {
    setBusy(true); setActionError('');
    try {
      const result = await apiCall('POST', `/api/plugins/${encodeURIComponent(row.id)}/install`);
      setPending(null);
      // The registry write succeeded, but the broker may still have failed to
      // start — most often because its image was never built. Saying "installed"
      // and leaving a dead broker behind would be the wrong kind of quiet.
      const startError = (result?.reconcile?.sidecars?.errors || [])
        .find((e) => e.pluginId === row.id && e.phase === 'start');
      if (startError) {
        setActionError(
          `${row.name} was installed, but its broker did not start: ${startError.error}. `
          + 'If the image is missing, run `make plugin-images` and press Refresh.',
        );
      } else if (result?.reconcile?.error) {
        setActionError(
          `${row.name} was installed, but the orchestrator could not be reached to start its `
          + `broker (${result.reconcile.error}). It will start at the next orchestrator boot.`,
        );
      }
      await refetch();
      // The installed set changed — let the sidebar re-discover its plugin nav
      // entries (it no longer refetches on navigation, #1679).
      notifyPluginsChanged();
    } catch (err) {
      setActionError(err.message || 'Install failed');
    } finally { setBusy(false); }
  }

  async function doUninstall(row) {
    setBusy(true); setActionError('');
    try {
      await apiCall('DELETE', `/api/plugins/${encodeURIComponent(row.id)}`);
      setRemoving(null);
      await refetch();
      // The installed set changed — refresh the sidebar plugin nav (#1679).
      notifyPluginsChanged();
    } catch (err) {
      setActionError(err.message || 'Uninstall failed');
    } finally { setBusy(false); }
  }

  const headerAction = usePageActions(
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
      <IconButton icon={RefreshCw} label="Refresh" onClick={() => { refetch(); refetchAgents(); }} disabled={loading} />
      <Link to="/plugin-system" style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', fontWeight: 500,
        color: 'var(--eb-accent-primary)', textDecoration: 'none',
      }}>
        <BookOpen size={15} /> Learn about plugins
      </Link>
    </div>
  );

  return (
    <>
      {headerAction}
      <div style={{ padding: 'var(--eb-space-6)', maxWidth: 960 }}>
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0, maxWidth: 720 }}>
        Plugins extend what agents can reach beyond their container — a container runtime, a
        test-management system — through a privileged broker that runs beside the stack, so the
        agent itself never holds the credential or the socket. Installing one starts its broker;
        it grants nothing until you activate it on an agent or team.
      </p>

      {error && (
        <div style={{ color: 'var(--eb-danger-fg, #a00)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-3)' }}>
          {String(error)}
        </div>
      )}
      {actionError && (
        <div style={{ color: 'var(--eb-danger-fg, #a00)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-3)' }}>
          {actionError}
        </div>
      )}
      {!canManage && !loading && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-3)' }}>
          You can see the registry, but only a System Admin can install or remove plugins.
        </div>
      )}

      <h2 style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600, marginTop: 'var(--eb-space-5)' }}>Installed</h2>
      {installed.length === 0 && !loading && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-4)' }}>
          No plugins installed.
        </div>
      )}
      {installed.map((row) => (
        <PluginCard
          key={row.id}
          row={row}
          busy={busy}
          onInstall={setPending}
          onUninstall={setRemoving}
          teams={teams}
          stackRuntime={stackRuntime}
          onAssignChanged={refetchAgents}
        />
      ))}

      <h2 style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600, marginTop: 'var(--eb-space-5)' }}>Available</h2>
      {available.length === 0 && !loading && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
          Nothing further in the pool. Reference plugins are seeded with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>make seed-plugins</code>.
        </div>
      )}
      {available.map((row) => (
        <PluginCard key={row.id} row={row} busy={busy} onInstall={setPending} onUninstall={setRemoving} />
      ))}

      <ConfirmDialog
        open={!!pending}
        title={pending ? `Install ${pending.name}?` : ''}
        confirmLabel="Install"
        busy={busy}
        // A plugin that receives the host container runtime gets the danger
        // treatment — the confirm should not look routine.
        variant={pending && pending.capabilities.some((c) => c.risk === 'high') ? 'danger' : 'warning'}
        onConfirm={() => pending && doInstall(pending)}
        onCancel={() => setPending(null)}
        message={pending ? (
          <div>
            <p style={{ fontSize: 'var(--eb-text-sm)', marginTop: 0 }}>
              This starts a broker container with the privileges below. It does not grant the
              plugin to any agent.
            </p>
            {pending.capabilities.length === 0
              ? <p style={{ fontSize: 'var(--eb-text-sm)' }}>This plugin requests no host privileges.</p>
              : pending.capabilities.map((c) => <CapabilityCard key={c.id} cap={c} />)}
            <p style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 0 }}>
              {pending.quota}
            </p>
          </div>
        ) : ''}
      />

      <ConfirmDialog
        open={!!removing}
        title={removing ? `Uninstall ${removing.name}?` : ''}
        confirmLabel="Uninstall"
        variant="danger"
        busy={busy}
        onConfirm={() => removing && doUninstall(removing)}
        onCancel={() => setRemoving(null)}
        message={
          'The broker stops and its containers stop being managed. Existing grants on agents are '
          + 'left in place — they simply seed nothing while the plugin is uninstalled, so '
          + 'reinstalling restores them.'
        }
      />
    </div>
    </>
  );
}

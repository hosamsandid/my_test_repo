import React, { useState, useEffect, useMemo } from 'react';
import { Wrench, PauseCircle, CheckCircle2, Activity } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import FormInput from '../components/FormInput';
import WhenCell from '../components/WhenCell';
import { countActiveSessions } from './active-sessions';
import { useAgentStatuses } from '../context/AgentStatusesContext.jsx';

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const cardStyle = {
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  padding: 'var(--eb-space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-4)',
  maxWidth: 480,
};

const primaryButtonStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-bg-app)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const dangerButtonStyle = {
  ...primaryButtonStyle,
  background: 'var(--eb-status-error)',
};

export default function MaintenanceMode() {
  const { data, loading, error, refetch } = useApi('/api/maintenance-mode');
  const [amount, setAmount] = useState('60');
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Platform-wide busy-session count, from the shared agent-status poll (#1677).
  const statuses = useAgentStatuses();
  const activeSessions = countActiveSessions(statuses);

  // The grace countdown only moves while maintenance is active (remainingSec is
  // 0 otherwise), so only run the 1s clock tick then — no point re-rendering the
  // whole page every second on an idle maintenance screen (#1680).
  useEffect(() => {
    if (!data?.active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data?.active]);

  const remainingSec = useMemo(() => {
    if (!data || !data.active || !data.graceEndsAt) return 0;
    return Math.max(0, Math.round((new Date(data.graceEndsAt).getTime() - now) / 1000));
  }, [data, now]);

  async function handleActivate(e) {
    e.preventDefault();
    setFormError(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      setFormError('Enter a positive whole number.');
      return;
    }
    const gracePeriodSec = n * 60;
    setSubmitting(true);
    try {
      await apiCall('POST', '/api/maintenance-mode/activate', { gracePeriodSec });
      await refetch();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate() {
    setFormError(null);
    setSubmitting(true);
    try {
      await apiCall('POST', '/api/maintenance-mode/deactivate');
      await refetch();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <Wrench size={20} /> Maintenance Mode
      </h1>
      <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', maxWidth: 560 }}>
        Signals an upcoming platform restart so in-flight agent sessions can wind down.
        This does not stop, restart, or lock anything by itself — the actual restart stays a manual, external step.
      </p>

      <div style={{
        ...cardStyle,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-4)',
        background: activeSessions === 0 ? 'var(--eb-status-success-bg)' : 'var(--eb-status-warning-bg)',
        border: `1px solid ${activeSessions === 0 ? 'var(--eb-status-success)' : 'var(--eb-status-warning)'}`,
      }}>
        {activeSessions === 0
          ? <CheckCircle2 size={24} color="var(--eb-status-success)" />
          : <Activity size={24} color="var(--eb-status-warning)" />}
        <div>
          <div style={{
            fontSize: 'var(--eb-text-lg, 18px)', fontWeight: 'var(--eb-font-semibold)',
            color: activeSessions === 0 ? 'var(--eb-status-success)' : 'var(--eb-status-warning)',
          }}>
            {activeSessions} active session{activeSessions === 1 ? '' : 's'}
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            {activeSessions === 0
              ? 'Safe to update — no agent is currently busy, across all teams.'
              : 'Not safe to update yet — at least one agent is still busy, across all teams.'}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ height: 160, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)', maxWidth: 480 }} />
      ) : (
        <div style={cardStyle}>
          {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
          {formError && data && data.active && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{formError}</span>}

          {data && data.active ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--eb-radius-full)',
                  fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
                  background: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning)',
                  border: '1px solid var(--eb-status-warning)',
                }}>
                  active
                </span>
                <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
                  since <WhenCell iso={data.activatedAt} />
                </span>
              </div>

              <div>
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                  Remaining grace period
                </div>
                <div style={{ fontSize: 'var(--eb-text-2xl, 28px)', fontWeight: 'var(--eb-font-semibold)', fontFamily: 'var(--eb-font-mono)' }}>
                  {formatDuration(remainingSec)}
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                  Wind-down window for in-flight sessions — it does not end maintenance mode on its own. Scheduled triggers stay suppressed and events keep queuing until you end it below.
                </div>
                {remainingSec === 0 && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                    Grace period has elapsed. Maintenance mode stays active until ended below.
                  </div>
                )}
              </div>

              <button
                type="button"
                style={dangerButtonStyle}
                disabled={submitting}
                onClick={handleDeactivate}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
                  <PauseCircle size={14} /> End Maintenance Mode
                </span>
              </button>
            </>
          ) : (
            <form onSubmit={handleActivate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
              <span style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--eb-radius-full)',
                fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
                background: 'var(--eb-bg-app)', color: 'var(--eb-text-secondary)',
                border: '1px solid var(--eb-border-default)', width: 'fit-content',
              }}>
                inactive
              </span>

              <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <FormInput
                    label="Grace period"
                    type="number"
                    value={amount}
                    onChange={setAmount}
                    required
                  />
                </div>
                <span
                  style={{
                    padding: 'var(--eb-space-2) var(--eb-space-3)',
                    color: 'var(--eb-text-secondary)',
                    fontSize: 'var(--eb-text-sm)',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  minutes
                </span>
              </div>

              <div style={{
                background: 'var(--eb-bg-app)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                padding: 'var(--eb-space-3)',
              }}>
                <div style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-2)' }}>
                  While active
                </div>
                <ul style={{ margin: 0, paddingLeft: '1.1em', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
                  <li>Scheduled (cron / once) triggers won't fire — exactly one catch-up run happens after you end it.</li>
                  <li>HTTP and GitHub events keep queuing and drain once you end it — they aren't dropped.</li>
                  <li>The grace period is the wind-down window for sessions still in flight; nothing is force-stopped.</li>
                </ul>
              </div>

              {formError && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{formError}</span>}

              <button type="submit" style={primaryButtonStyle} disabled={submitting}>
                Activate Maintenance Mode
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

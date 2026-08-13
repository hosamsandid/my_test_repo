import React, { useState, useCallback } from 'react';
import { Plus, Trash2, Clock, CalendarClock, Globe, Github, AlertCircle, Edit, Repeat } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import { summarizeLoopTrigger, eventLabel } from './agent-chat/trigger-summary.js';
import { humanizeCron, humanizeOnce } from './cron-humanize.js';

/* ── Type badge ─────────────────────────────────────────────────────── */
function TypeBadge({ type }) {
  const isCron   = type === 'cron' || type === 'recurring';
  const isOnce   = type === 'once';
  const isHttp   = type === 'http';
  const isGithub = type === 'github-event';
  const isLoop   = type === 'loop';
  const bg    = isLoop ? 'var(--eb-status-warning-bg)' : isCron ? 'var(--eb-accent-muted)'   : isOnce ? 'var(--eb-bg-elevated)'    : isHttp ? 'var(--eb-status-success-bg)' : isGithub ? 'var(--eb-status-info-bg, var(--eb-bg-elevated))' : 'var(--eb-status-warning-bg)';
  const color = isLoop ? 'var(--eb-status-warning)'    : isCron ? 'var(--eb-accent-primary)' : isOnce ? 'var(--eb-text-secondary)' : isHttp ? 'var(--eb-status-success)'    : isGithub ? 'var(--eb-text-primary)' : 'var(--eb-status-warning)';
  const label = isLoop ? 'loop'                        : isCron ? 'cron'                     : isOnce ? 'once'                     : isHttp ? 'http'                        : isGithub ? 'github-event' : type || 'unknown';
  const Icon  = isLoop ? Repeat                        : isCron ? Clock                      : isOnce ? CalendarClock              : isHttp ? Globe                         : isGithub ? Github : AlertCircle;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 6px', borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: bg, color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
    }}>
      <Icon size={10} />
      {label}
    </span>
  );
}

function generateSecret() {
  const arr = new Uint8Array(24);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Toggle switch ─────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      style={{
        width: 36, height: 20,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

const selectStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
};

const fieldLabelStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)',
  marginBottom: 'var(--eb-space-0-5)',
};

const fieldHintStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-1)',
  lineHeight: 1.4,
};

// Common github-event keys, used as the dropdown options for the
// `events[]` multi-select. Not exhaustive — the form lets the user add
// arbitrary extras via a free-form input below.
const COMMON_GITHUB_EVENTS = [
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.closed',
  'pull_request_review.submitted',
  'pull_request_review_comment.created',
  'issue_comment.created',
  'issues.opened',
  'issues.closed',
  'issues.labeled',
  'issues.unlabeled',
  'push',
  'release.published',
  'check_run.completed',
];

/* ── Trigger form ──────────────────────────────────────────────────── */
//
// Used for both "Add Trigger" and "Edit Trigger". When `initial` is
// passed, the form is pre-filled and the agent picker is locked (you
// can't move a trigger to a different agent — delete + re-create).
function TriggerForm({ onSave, onCancel, agentOptions, initial, lockAgent }) {
  const [form, setForm] = useState({
    agentId: initial?._agentId || agentOptions?.[0]?.id || '',
    id: initial?.id || '',
    type: initial?.type || 'cron',
    cron: initial?.cron || '',
    at: initial?.at || '',
    secret: initial?.secret || '',
    description: initial?.description || '',
    prompt: initial?.prompt || '',
    enabled: initial?.enabled !== false,
    // github-event fields
    repo: initial?.repo || '',
    events: Array.isArray(initial?.events) ? initial.events : [],
    // loop fields (kept as strings; parsed on save)
    maxIterations: initial?.maxIterations != null ? String(initial.maxIterations) : '',
    maxTokens:     initial?.maxTokens     != null ? String(initial.maxTokens)     : '',
    minGapSeconds: initial?.minGapSeconds != null ? String(initial.minGapSeconds) : '',
    untilCommand:  (initial?.until && typeof initial.until === 'object' && initial.until.command) || '',
    verifyMode:    (initial?.verify && typeof initial.verify === 'object')
      ? (initial.verify.agentId ? 'agent'
        : initial.verify.command ? 'command'
        : initial.verify.flow === true ? 'flow' : 'none')
      : 'none',
    verifyCommand: (initial?.verify && typeof initial.verify === 'object' && initial.verify.command) || '',
    verifyAgentId: (initial?.verify && typeof initial.verify === 'object' && initial.verify.agentId) || '',
  });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [formError, setFormError] = useState(null);
  const isEdit = !!initial;
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName: v => update('description', v),
    setId:   v => update('id', v),
    getName: () => form.description,
    initiallyAuto: !isEdit,
  });

  function changeType(next) {
    setForm(f => ({
      ...f,
      type: next,
      secret: next === 'http' && !f.secret ? generateSecret() : f.secret,
    }));
  }

  function toggleEvent(name) {
    setForm(f => ({
      ...f,
      events: f.events.includes(name)
        ? f.events.filter(e => e !== name)
        : [...f.events, name],
    }));
  }

  function buildSavePayload() {
    const body = {
      id: form.id || undefined,
      type: form.type,
      description: form.description,
      prompt: form.prompt,
      enabled: form.enabled,
    };
    if (form.type === 'cron') body.cron = form.cron;
    else if (form.type === 'once') body.at = form.at;
    else if (form.type === 'http') body.secret = form.secret;
    else if (form.type === 'loop') {
      body.maxIterations = Number(form.maxIterations);
      const untilCmd = form.untilCommand.trim();
      if (untilCmd) body.until = { command: untilCmd };
      if (form.verifyMode === 'command' && form.verifyCommand.trim()) {
        body.verify = { command: form.verifyCommand.trim() };
      } else if (form.verifyMode === 'agent' && form.verifyAgentId.trim()) {
        body.verify = { agentId: form.verifyAgentId.trim() };
      } else if (form.verifyMode === 'flow') {
        body.verify = { flow: true };
      }
      const mt = Number(form.maxTokens);
      if (form.maxTokens.trim() && Number.isFinite(mt) && mt > 0) body.maxTokens = mt;
      const mg = Number(form.minGapSeconds);
      if (form.minGapSeconds.trim() && Number.isFinite(mg) && mg >= 0) body.minGapSeconds = mg;
    }
    else if (form.type === 'github-event') {
      body.repo = form.repo;
      body.events = form.events;
    }
    return { agentId: form.agentId, body };
  }

  // Client-side gate: block save without a valid, positive maxIterations for a
  // loop (mirrors the shared TriggerForm / concept §4.4).
  function handleSaveClick() {
    setFormError(null);
    if (form.type === 'loop') {
      const n = Number(form.maxIterations);
      if (!Number.isInteger(n) || n <= 0) { setFormError('Max iterations is required and must be a positive whole number.'); return; }
      if (form.verifyMode === 'command' && !form.verifyCommand.trim()) { setFormError('Enter the verifier command, or choose a different verifier mode.'); return; }
      if (form.verifyMode === 'agent' && !form.verifyAgentId.trim()) { setFormError('Select the verifier agent, or choose a different verifier mode.'); return; }
    }
    onSave(buildSavePayload());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {agentOptions && agentOptions.length > 0 && (
        <div>
          <div style={fieldLabelStyle}>Agent</div>
          <select
            value={form.agentId}
            onChange={e => update('agentId', e.target.value)}
            disabled={!!lockAgent}
            style={{ ...selectStyle, opacity: lockAgent ? 0.6 : 1 }}
          >
            {agentOptions.map(a => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </div>
      )}

      <FormInput
        label="Description"
        value={form.description}
        onChange={isEdit ? v => update('description', v) : handleNameChange}
        placeholder="e.g. Daily morning report"
      />

      <IdField
        value={form.id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        disabled={isEdit}
        placeholder="e.g. daily-report"
        helpText={isEdit
          ? <>Cannot be changed after creation.</>
          : <>Auto-derived from Description; edit to override. {ID_FORMAT_HINT}</>}
      />

      <div>
        <div style={fieldLabelStyle}>Type</div>
        <select value={form.type} onChange={e => changeType(e.target.value)}
          disabled={isEdit}
          style={{ ...selectStyle, opacity: isEdit ? 0.6 : 1 }}
        >
          <option value="cron">Cron (recurring)</option>
          <option value="once">Once (one-shot)</option>
          <option value="loop">Loop (re-run until done)</option>
          <option value="http">HTTP webhook</option>
          <option value="github-event">GitHub event</option>
        </select>
        {isEdit && (
          <div style={fieldHintStyle}>Type and ID are immutable on edit — delete and re-create to change them.</div>
        )}
      </div>

      {form.type === 'cron' && (
        <div>
          <FormInput label="Cron expression" value={form.cron} onChange={v => update('cron', v)} placeholder="0 9 * * 1-5" />
          <div style={fieldHintStyle}>
            {humanizeCron(form.cron)
              ? <><strong style={{ color: 'var(--eb-text-secondary)' }}>Runs:</strong> {humanizeCron(form.cron)}</>
              : <>Five fields: minute, hour, day-of-month, month, day-of-week. Example <code>0 9 * * 1-5</code> = at 09:00, Monday to Friday.</>}
          </div>
        </div>
      )}
      {form.type === 'once' && (
        <div>
          <FormInput label="Run at (ISO timestamp)" value={form.at} onChange={v => update('at', v)} placeholder="2026-05-01T09:00:00Z" />
          <div style={fieldHintStyle}>
            {humanizeOnce(form.at)
              ? <><strong style={{ color: 'var(--eb-text-secondary)' }}>Runs once:</strong> {humanizeOnce(form.at)}</>
              : <>Date and time in ISO 8601, e.g. <code>2026-05-01T09:00:00Z</code> (append <code>Z</code> for UTC). Fires once, then removes itself.</>}
          </div>
        </div>
      )}
      {form.type === 'loop' && (
        <>
          <div style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
          }}>
            <Repeat size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--eb-status-warning)' }} />
            Re-runs the agent with the prompt below, chaining each iteration until
            <code> until</code> exits <code>0</code> (done), the iteration/token cap is
            reached (exhausted), or the safety backstop trips (paused).
          </div>
          <FormInput
            label="Max iterations (required)"
            type="number"
            value={form.maxIterations}
            onChange={v => update('maxIterations', v)}
            placeholder="e.g. 25"
          />
          <FormInput
            label="Stop condition — until command (optional)"
            value={form.untilCommand}
            onChange={v => update('untilCommand', v)}
            placeholder="e.g. npm test && test ! -s fix_plan.md"
          />
          <div>
            <div style={fieldLabelStyle}>Verifier (optional, recommended)</div>
            <select value={form.verifyMode} onChange={e => update('verifyMode', e.target.value)} style={selectStyle}>
              <option value="none">No verifier (self-graded)</option>
              <option value="command">Command — must exit 0 for the iteration to count</option>
              <option value="agent">Agent — a separate role grades the work</option>
              <option value="flow">Flow — the downstream QS chain checks each hand-off</option>
            </select>
            {form.verifyMode === 'flow' && (
              <div style={fieldHintStyle}>
                No inline gate between iterations — each iteration hands its work to
                the flow (PR / label) and the reviewers wired downstream verify it
                there. Use when the loop starts a QS chain, so the same reviewer
                does not check the work twice.
              </div>
            )}
            {form.verifyMode === 'command' && (
              <div style={{ marginTop: 'var(--eb-space-2)' }}>
                <FormInput label="" value={form.verifyCommand} onChange={v => update('verifyCommand', v)} placeholder="e.g. npm run lint && npm test" />
              </div>
            )}
            {form.verifyMode === 'agent' && (
              <div style={{ marginTop: 'var(--eb-space-2)' }}>
                {agentOptions && agentOptions.length > 0 ? (
                  <select value={form.verifyAgentId} onChange={e => update('verifyAgentId', e.target.value)} style={selectStyle}>
                    <option value="">— Select a verifier agent —</option>
                    {agentOptions.filter(a => a.id !== form.agentId).map(a => (
                      <option key={a.id} value={a.id}>{a.displayName || a.id}</option>
                    ))}
                  </select>
                ) : (
                  <FormInput label="" value={form.verifyAgentId} onChange={v => update('verifyAgentId', v)} placeholder="verifier agent id" />
                )}
                <div style={fieldHintStyle}>
                  Pick a role other than the worker — an agent must not grade its own work.
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-3)' }}>
            <div style={{ flex: 1 }}>
              <FormInput label="Token budget (optional)" type="number" value={form.maxTokens} onChange={v => update('maxTokens', v)} placeholder="e.g. 2000000" />
            </div>
            <div style={{ flex: 1 }}>
              <FormInput label="Min gap seconds (optional)" type="number" value={form.minGapSeconds} onChange={v => update('minGapSeconds', v)} placeholder="0 = chain immediately" />
            </div>
          </div>
        </>
      )}
      {form.type === 'http' && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-success-bg)',
          border: '1px solid var(--eb-status-success)',
          borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)', fontWeight: 'var(--eb-font-medium)' }}>
            Webhook endpoint (port 4003) — POST /hooks/{form.agentId || ':agentId'}/{form.id || ':id'}
          </div>
          <FormInput
            label="X-Hook-Secret (auto-generated, click to edit)"
            value={form.secret}
            onChange={v => update('secret', v)}
            placeholder="(required)"
          />
          <div style={fieldHintStyle}>
            Detailed view (with reveal / copy / regenerate) is available in the per-agent Triggers tab.
          </div>
        </div>
      )}

      {form.type === 'github-event' && (
        <>
          <FormInput
            label="Repository (owner/name)"
            value={form.repo}
            onChange={v => update('repo', v)}
            placeholder="acme/widgets"
          />
          <div>
            <div style={fieldLabelStyle}>Events</div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)',
              padding: 'var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
            }}>
              {[...new Set([...COMMON_GITHUB_EVENTS, ...form.events])].map(name => {
                const active = form.events.includes(name);
                return (
                  <button
                    type="button"
                    key={name}
                    onClick={() => toggleEvent(name)}
                    // Show the plain-language label (e.g. "PR opened") so the
                    // picker is legible without knowing the Events API keys;
                    // the raw key stays on hover for anyone who needs it.
                    title={name}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 'var(--eb-radius-full)',
                      border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                      background: active ? 'var(--eb-accent-primary)' : 'transparent',
                      color: active ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
                      fontSize: 'var(--eb-text-xs)',
                      cursor: 'pointer',
                    }}
                  >
                    {eventLabel(name)}
                  </button>
                );
              })}
            </div>
            <div style={fieldHintStyle}>
              Click to toggle. <code>pull_request.opened</code> = PullRequestEvent with action=opened. The GitHub Events API doesn't emit every webhook action — for example there's no <code>pull_request.synchronize</code>.
            </div>
          </div>

          <div style={fieldHintStyle}>
            The trigger fires on every matching event regardless of who caused it
            (a human, another agent, or this agent itself). Runaway loops are
            capped by the per-conversation rate throttle, not by origin filtering.
          </div>
        </>
      )}

      <FormInput label="Prompt" value={form.prompt} onChange={v => update('prompt', v)} multiline rows={6} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch checked={form.enabled} onChange={v => update('enabled', v)} label="Enabled" />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Enabled</span>
      </div>

      {formError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={handleSaveClick} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}>
          {isEdit ? 'Save Changes' : 'Add Trigger'}
        </button>
        <button onClick={onCancel} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function ScheduledJobs() {
  const { data: agents, loading: agentsLoading } = useApi('/api/agents');
  const [triggers, setTriggers] = useState([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadAllTriggers = useCallback(async (agentList) => {
    if (!agentList || agentList.length === 0) {
      setTriggers([]);
      return;
    }
    setTriggersLoading(true);
    const results = await Promise.all(
      agentList.map(async a => {
        try {
          const res = await fetch(`/api/agents/${a.id}/triggers`);
          const data = res.ok ? await res.json() : [];
          return (Array.isArray(data) ? data : []).map(t => ({
            ...t,
            _agentId: a.id,
            _agentName: a.displayName || a.id,
          }));
        } catch { return []; }
      })
    );
    setTriggers(results.flat());
    setTriggersLoading(false);
  }, []);

  React.useEffect(() => {
    if (agents) loadAllTriggers(agents);
  }, [agents, loadAllTriggers]);

  const COLS = [
    { key: '_agentName', label: 'Agent' },
    // ID column is hidden (no visible column) to keep the table within the
    // page width — but stays in the filter so a trigger id is still
    // searchable (#1643).
    { key: 'id',          label: 'ID', hidden: true },
    { key: 'type',        label: 'Type', render: v => <TypeBadge type={v} /> },
    { key: 'schedule',    label: 'Schedule / Trigger', wrap: true, render: (_, row) => {
      if (row.type === 'github-event') {
        const events = row.events || [];
        const raw = events.join(', ');
        const friendly = events.map(eventLabel).join(', ');
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--eb-text-xs)' }}>
            <span style={{ fontFamily: 'var(--eb-font-mono)' }}>{row.repo || '—'}</span>
            <span>{friendly || '—'}</span>
            {/* Raw event keys kept as a muted sub-line so the exact GitHub
                Events key stays visible for debugging (only when it differs
                from the friendly label). */}
            {raw && raw !== friendly && (
              <span style={{ color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{raw}</span>
            )}
          </div>
        );
      }
      if (row.type === 'http') {
        return <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>/hooks/{row._agentId}/{row.id}</span>;
      }
      if (row.type === 'loop') {
        return <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{summarizeLoopTrigger(row)}</span>;
      }
      const human = row.type === 'cron' ? humanizeCron(row.cron)
        : row.type === 'once' ? humanizeOnce(row.at)
        : '';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{row.cron || row.at || '—'}</span>
          {human && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{human}</span>}
        </div>
      );
    }},
    { key: 'description', label: 'Description', wrap: true },
    { key: 'enabled',     label: 'Enabled', sortable: false, render: (v, row) => (
      <ToggleSwitch
        checked={v !== false}
        label="Toggle enabled"
        onChange={async (val) => {
          await apiCall('PUT', `/api/agents/${row._agentId}/triggers/${row.id}`, { enabled: val });
          loadAllTriggers(agents);
        }}
      />
    )},
    { key: '_actions', label: '', sortable: false, render: (_, row) => (
      <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-1)' }}>
        <IconButton icon={Edit} label="Edit trigger" onClick={e => { e.stopPropagation(); setEditTarget(row); }} />
        <IconButton icon={Trash2} label="Delete trigger" danger onClick={e => { e.stopPropagation(); setDeleteTarget(row); }} />
      </div>
    )},
  ];

  const skeleton = agentsLoading || triggersLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Triggers
        </h1>
        <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', maxWidth: '60ch', lineHeight: 1.5 }}>
          All triggers across every agent — the same triggers you can edit from an agent's chat <strong>Triggers</strong> tab. Adding, editing, or deleting one here changes it for that agent everywhere.
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setAddOpen(true)} disabled={!agents || agents.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit', opacity: (!agents || agents.length === 0) ? 0.5 : 1 }}>
          <Plus size={14} /> Add Trigger
        </button>
      </div>

      {skeleton ? (
        <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable
          columns={COLS}
          data={triggers}
          getRowKey={r => `${r._agentId}/${r.id}`}
          emptyText="No triggers configured. Add one to schedule recurring runs, fire one-shot tasks, expose an HTTP webhook, or react to GitHub events."
        />
      )}

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          agentOptions={agents ?? []}
          onSave={async ({ agentId, body }) => {
            await apiCall('POST', `/api/agents/${agentId}/triggers`, body);
            setAddOpen(false);
            loadAllTriggers(agents);
          }}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

      <SidePanel
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={editTarget ? `Edit Trigger — ${editTarget.id}` : 'Edit Trigger'}
        width="560px"
      >
        {editTarget && (
          <TriggerForm
            agentOptions={agents ?? []}
            initial={editTarget}
            lockAgent
            onSave={async ({ body }) => {
              await apiCall('PUT', `/api/agents/${editTarget._agentId}/triggers/${editTarget.id}`, body);
              setEditTarget(null);
              loadAllTriggers(agents);
            }}
            onCancel={() => setEditTarget(null)}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Trigger"
        message={`Delete trigger "${deleteTarget?.id}" from agent "${deleteTarget?._agentName}"?`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={async () => {
          await apiCall('DELETE', `/api/agents/${deleteTarget._agentId}/triggers/${deleteTarget.id}`);
          setDeleteTarget(null);
          loadAllTriggers(agents);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

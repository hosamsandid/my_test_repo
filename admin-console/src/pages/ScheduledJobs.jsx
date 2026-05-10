import React, { useState, useCallback } from 'react';
import { Plus, Trash2, Clock, CalendarClock, Globe, Github, AlertCircle, Edit } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

/* ── Type badge ─────────────────────────────────────────────────────── */
function TypeBadge({ type }) {
  const isCron   = type === 'cron' || type === 'recurring';
  const isOnce   = type === 'once';
  const isHttp   = type === 'http';
  const isGithub = type === 'github-event';
  const bg    = isCron ? 'var(--eb-accent-muted)'   : isOnce ? 'var(--eb-bg-elevated)'    : isHttp ? 'var(--eb-status-success-bg)' : isGithub ? 'var(--eb-status-info-bg, var(--eb-bg-elevated))' : 'var(--eb-status-warning-bg)';
  const color = isCron ? 'var(--eb-accent-primary)' : isOnce ? 'var(--eb-text-secondary)' : isHttp ? 'var(--eb-status-success)'    : isGithub ? 'var(--eb-text-primary)' : 'var(--eb-status-warning)';
  const label = isCron ? 'cron'                     : isOnce ? 'once'                     : isHttp ? 'http'                        : isGithub ? 'github-event' : type || 'unknown';
  const Icon  = isCron ? Clock                      : isOnce ? CalendarClock              : isHttp ? Globe                         : isGithub ? Github : AlertCircle;
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
  const initialFromIsArray = Array.isArray(initial?.from);
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
    fromKind: typeof initial?.from === 'string' ? initial.from
      : initialFromIsArray ? 'allowlist'
      : (initial?.from && typeof initial.from === 'object' && Array.isArray(initial.from.exclude)) ? 'blocklist'
      : 'any-except-self',
    fromList: initialFromIsArray
      ? initial.from.join(', ')
      : (initial?.from?.exclude ? initial.from.exclude.join(', ') : ''),
  });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEdit = !!initial;

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
    else if (form.type === 'github-event') {
      body.repo = form.repo;
      body.events = form.events;
      // Translate the form's fromKind + fromList back into the wire shape
      // applyFromFilter expects.
      if (form.fromKind === 'any-except-self') body.from = 'any-except-self';
      else if (form.fromKind === 'humans') body.from = 'humans';
      else if (form.fromKind === 'agents') body.from = 'agents';
      else if (form.fromKind === 'team') body.from = 'team';
      else if (form.fromKind === 'allowlist') {
        body.from = form.fromList.split(',').map(s => s.trim()).filter(Boolean);
      } else if (form.fromKind === 'blocklist') {
        body.from = { exclude: form.fromList.split(',').map(s => s.trim()).filter(Boolean) };
      }
    }
    return { agentId: form.agentId, body };
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

      <FormInput label="ID" value={form.id} onChange={v => update('id', v)} placeholder="e.g. daily-report" disabled={isEdit} />

      <div>
        <div style={fieldLabelStyle}>Type</div>
        <select value={form.type} onChange={e => changeType(e.target.value)}
          disabled={isEdit}
          style={{ ...selectStyle, opacity: isEdit ? 0.6 : 1 }}
        >
          <option value="cron">Cron (recurring)</option>
          <option value="once">Once (one-shot)</option>
          <option value="http">HTTP webhook</option>
          <option value="github-event">GitHub event</option>
        </select>
        {isEdit && (
          <div style={fieldHintStyle}>Type and ID are immutable on edit — delete and re-create to change them.</div>
        )}
      </div>

      {form.type === 'cron' && (
        <FormInput label="Cron expression" value={form.cron} onChange={v => update('cron', v)} placeholder="0 9 * * 1-5" />
      )}
      {form.type === 'once' && (
        <FormInput label="Run at (ISO timestamp)" value={form.at} onChange={v => update('at', v)} placeholder="2026-05-01T09:00:00Z" />
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
                    style={{
                      padding: '2px 8px',
                      borderRadius: 'var(--eb-radius-full)',
                      border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                      background: active ? 'var(--eb-accent-primary)' : 'transparent',
                      color: active ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
                      fontSize: 'var(--eb-text-xs)',
                      fontFamily: 'var(--eb-font-mono)',
                      cursor: 'pointer',
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            <div style={fieldHintStyle}>
              Click to toggle. <code>pull_request.opened</code> = PullRequestEvent with action=opened. The GitHub Events API doesn't emit every webhook action — for example there's no <code>pull_request.synchronize</code>.
            </div>
          </div>

          <div>
            <div style={fieldLabelStyle}>Origin filter (Layer-2 loop protection)</div>
            <select
              value={form.fromKind}
              onChange={e => update('fromKind', e.target.value)}
              style={selectStyle}
            >
              <option value="any-except-self">Any (except self) — default</option>
              <option value="humans">Humans only</option>
              <option value="agents">Agents only</option>
              <option value="team">Team — humans or members of own team</option>
              <option value="allowlist">Allowlist — only these origins</option>
              <option value="blocklist">Blocklist — anyone except these</option>
            </select>
            {(form.fromKind === 'allowlist' || form.fromKind === 'blocklist') && (
              <div style={{ marginTop: 'var(--eb-space-2)' }}>
                <FormInput
                  label={form.fromKind === 'allowlist' ? 'Allowed origins (comma-separated agent ids; "humans" allows people too)' : 'Blocked agent ids (humans always pass)'}
                  value={form.fromList}
                  onChange={v => update('fromList', v)}
                  placeholder="business-analyst, developer, humans"
                />
              </div>
            )}
            <div style={fieldHintStyle}>
              Self-loops are blocked unconditionally regardless of this setting.
            </div>
          </div>
        </>
      )}

      <FormInput label="Description" value={form.description} onChange={v => update('description', v)} />
      <FormInput label="Prompt" value={form.prompt} onChange={v => update('prompt', v)} multiline rows={6} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch checked={form.enabled} onChange={v => update('enabled', v)} label="Enabled" />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Enabled</span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={() => onSave(buildSavePayload())} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}>
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
    { key: 'id',          label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'type',        label: 'Type', render: v => <TypeBadge type={v} /> },
    { key: 'schedule',    label: 'Schedule / Trigger', render: (_, row) => {
      if (row.type === 'github-event') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            <span>{row.repo || '—'}</span>
            <span style={{ color: 'var(--eb-text-muted)' }}>{(row.events || []).join(', ') || '—'}</span>
          </div>
        );
      }
      if (row.type === 'http') {
        return <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>/hooks/{row._agentId}/{row.id}</span>;
      }
      return <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{row.cron || row.at || '—'}</span>;
    }},
    { key: 'description', label: 'Description' },
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
      <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }}>
        <button
          onClick={e => { e.stopPropagation(); setEditTarget(row); }}
          title="Edit trigger"
          style={{ background: 'none', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)', cursor: 'pointer', padding: '2px 6px' }}
        >
          <Edit size={13} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); setDeleteTarget(row); }}
          title="Delete trigger"
          style={{ background: 'none', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)', cursor: 'pointer', padding: '2px 6px' }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    )},
  ];

  const skeleton = agentsLoading || triggersLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Triggers
      </h1>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setAddOpen(true)} disabled={!agents || agents.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit', opacity: (!agents || agents.length === 0) ? 0.5 : 1 }}>
          <Plus size={14} /> Add Trigger
        </button>
      </div>

      {skeleton ? (
        <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable columns={COLS} data={triggers} emptyText="No triggers configured. Add one to schedule recurring runs, fire one-shot tasks, expose an HTTP webhook, or react to GitHub events." />
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

import React, { useEffect, useRef, useState } from 'react';
import { Plus, ArrowUp, ArrowDown, X, ShieldCheck, GitPullRequest } from 'lucide-react';

// Stage/lane process view (#349). Operators arrange ordered stages; the wiring
// (stage labels, emits/listens, review steps, human gates) is generated under
// the hood by stage-model.js and written to the same draft bundle the graph
// view reads — the two views never diverge.
export default function StageView({ bundle, onApply }) {
  const [stages, setStages] = useState(() => (bundle?.stages || []).map(s => ({ ...s })));

  // Debounced persist so typing a stage name doesn't PUT on every keystroke.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => onApply(stages), 350);
    return () => clearTimeout(t);
  }, [stages]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (i, patch) => setStages(s => s.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  const move = (i, d) => setStages(s => {
    const j = i + d;
    if (j < 0 || j >= s.length) return s;
    const c = s.slice(); [c[i], c[j]] = [c[j], c[i]]; return c;
  });
  const remove = (i) => setStages(s => s.filter((_, j) => j !== i));
  const add = () => setStages(s => [...s, { id: `st${Date.now()}`, name: `Stage ${s.length + 1}`, requiresApproval: false, hasReview: false }]);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--eb-space-4)' }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-4)', lineHeight: 1.5 }}>
        Arrange the process as ordered stages. Each stage becomes a role woken by the previous stage;
        labels and wiring are generated for you. Switch to <strong>Graph</strong> to see (and fine-tune) the result.
      </div>

      {stages.length === 0 && (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', fontStyle: 'italic', marginBottom: 'var(--eb-space-3)' }}>
          No stages yet. Add the first stage to start the process (kicked off when an issue is opened).
        </div>
      )}

      {stages.map((s, i) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-2)' }}>
          <div style={{ width: 22, textAlign: 'right', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', paddingTop: 10 }}>{i + 1}</div>
          <div style={{ flex: 1, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <input
                value={s.name}
                onChange={e => update(i, { name: e.target.value })}
                placeholder={`Stage ${i + 1} name`}
                style={{
                  flex: 1, background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
                  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                  padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', outline: 'none',
                }}
              />
              <IconBtn title="Move up" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp size={14} /></IconBtn>
              <IconBtn title="Move down" onClick={() => move(i, 1)} disabled={i === stages.length - 1}><ArrowDown size={14} /></IconBtn>
              <IconBtn title="Remove stage" danger onClick={() => remove(i)}><X size={14} /></IconBtn>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-4)', marginTop: 'var(--eb-space-2)' }}>
              <label style={chk}>
                <input type="checkbox" checked={!!s.hasReview} onChange={e => update(i, { hasReview: e.target.checked })} />
                <GitPullRequest size={13} /> PR review
              </label>
              <label style={chk}>
                <input type="checkbox" checked={!!s.requiresApproval} onChange={e => update(i, { requiresApproval: e.target.checked })} />
                <ShieldCheck size={13} /> Human approval to advance
              </label>
            </div>
          </div>
        </div>
      ))}

      <button onClick={add} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 'var(--eb-space-2)', marginLeft: 34,
        background: 'var(--eb-bg-surface)', color: 'var(--eb-text-secondary)', border: '1px dashed var(--eb-border-hover)',
        borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
      }}>
        <Plus size={14} /> Add stage
      </button>
    </div>
  );
}

function IconBtn({ onClick, disabled, danger, title, children }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      background: 'none', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
      color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-muted)', cursor: disabled ? 'not-allowed' : 'pointer',
      padding: '4px 6px', display: 'flex', alignItems: 'center', opacity: disabled ? 0.4 : 1,
    }}>{children}</button>
  );
}
const chk = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' };

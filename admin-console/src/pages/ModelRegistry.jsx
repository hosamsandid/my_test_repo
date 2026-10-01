import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Plus, Pencil, Check, X, RefreshCw, PlugZap, Star, Lock, LogIn, ShieldAlert } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import WhenCell from '../components/WhenCell';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import OAuthLoginWizard from '../components/OAuthLoginWizard';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import ProviderOwnership from '../components/ProviderOwnership';
import {
  providerOwnershipOptions, defaultProviderOwnership, providerOwnershipFromRecord,
  providerOwnershipPayload, providerOwnershipReady, canManageProviderClient,
  providerScopeLabel, providerScopeShowsDetail,
} from './provider-ownership-view';
import { useAuth } from '../auth/AuthContext';
import {
  teamsById,
  canReassignCredentialClient, adminTeamIdsOf,
} from './credential-scope-view';
import {
  resolveProbeState,
  probeBlockedMessage,
  probeNote,
  probeTitle,
  probeRequest,
  probeResultMessage,
} from './llm-probe-state';
import { groupAgentsByTeam, hiddenAgentsNotice, boundAgentsLead, respawnFailureLead } from './group-agents-by-team.js';
import { describeSubmitState } from './model-provider-submit-state.js';
import { endpointAssistExclusion, assistExclusionInName, assistExclusionInBaseUrl } from '../context/assist-selector-exclusion.js';
import { usePageActions } from '../context/PageActionsContext';
import { healthCellModel, healthCellDetail, budgetCellModel } from './provider-health-view.js';
import { useHelpSubject } from '../context/HelperChatContext';
import { OVERLAY_MODEL_PROVIDER } from '../context/page-help-view.js';
import { MODELS_HELP_SECTIONS } from './models-help-sections.js';

/* ───────────────────────── auth types ───────────────────────── */

// #1138: the two ways a provider authenticates. `hint` is the short hover
// label; `desc` is the one-line explanation rendered inline under the selected
// radio so the choice isn't hidden behind a tooltip. The radios are a live
// choice, so `desc` stays SHORT (#1882) — why you would pick one over the other
// (proxy bypass, rate-limit sharing, the Consumer-Terms single-user rule) is in
// the Model Providers help topic (api/helper-chat/help-topics/models.md).
const AUTH_TYPE_OPTIONS = [
  {
    value: 'api-key',
    label: 'API key / proxy',
    hint: 'Bearer token against a Base URL (Anthropic API, LiteLLM, gateway)',
    desc: 'A secret token sent as a Bearer header to a Base URL you provide — the Anthropic API, or a proxy/gateway in front of it.',
  },
  {
    value: 'oauth-token',
    label: 'Anthropic subscription (OAuth)',
    hint: 'Claude Max / Enterprise seat via claude setup-token',
    desc: 'Your own Claude subscription seat via "claude setup-token" — no Base URL, and single-user only.',
  },
];

/* ───────────────────────── shared styles ───────────────────────── */

const buttonPrimary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const buttonSecondary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

const buttonGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
};

/* ─────────────────── Sub: per-endpoint model editor ─────────────────── */

function ModelEditor({ models, defaultModelId, onChange, onDefaultChange }) {
  const update = (i, patch) => {
    const next = models.map((m, idx) => idx === i ? { ...m, ...patch } : m);
    onChange(next);
  };
  const remove = (i) => {
    const removedId = models[i]?.id;
    onChange(models.filter((_, idx) => idx !== i));
    if (removedId && removedId === defaultModelId) onDefaultChange('');
  };
  const add = () => onChange([...models, { id: '', displayName: '' }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr 1fr 32px',
        gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        <div title="Default">Def</div>
        <div>Model ID</div>
        <div>Display name</div>
        <div></div>
      </div>

      {models.length === 0 && (
        <div style={{
          padding: 'var(--eb-space-3)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-md)',
          textAlign: 'center',
        }}>
          No models yet. Add one or import from the proxy.
        </div>
      )}

      {models.map((m, i) => {
        const isDefault = !!m.id && m.id === defaultModelId;
        return (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr 1fr 32px',
          gap: 'var(--eb-space-2)',
          alignItems: 'center',
        }}>
          <button
            type="button"
            onClick={() => onDefaultChange(isDefault ? '' : (m.id || ''))}
            disabled={!m.id || !m.id.trim()}
            aria-label={isDefault ? 'Clear default' : 'Make default'}
            title={
              !m.id || !m.id.trim()
                ? 'Set a model ID before marking it as the default'
                : isDefault ? 'Clear default (click to unset)' : 'Make this the default model'
            }
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32,
              background: isDefault ? 'var(--eb-accent-primary)' : 'transparent',
              border: `1px solid ${isDefault ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
              color: isDefault ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
              borderRadius: 'var(--eb-radius-md)',
              cursor: (!m.id || !m.id.trim()) ? 'not-allowed' : 'pointer',
              opacity: (!m.id || !m.id.trim()) ? 0.4 : 1,
            }}
          >
            <Star size={14} fill={isDefault ? 'currentColor' : 'none'} />
          </button>
          <input
            value={m.id || ''}
            onChange={e => update(i, { id: e.target.value })}
            placeholder="claude-sonnet-4-6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              outline: 'none',
            }}
          />
          <input
            value={m.displayName || ''}
            onChange={e => update(i, { displayName: e.target.value })}
            placeholder="Sonnet 4.6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              outline: 'none',
            }}
          />
          <button
            onClick={() => remove(i)}
            aria-label="Remove model"
            title="Remove"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32,
              background: 'transparent',
              border: '1px solid var(--eb-status-error)',
              color: 'var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>
      );})}

      <button
        type="button"
        onClick={add}
        style={{ ...buttonGhost, alignSelf: 'flex-start' }}
      >
        <Plus size={13} /> Add model
      </button>
    </div>
  );
}

/* ─────────────────── Sub: endpoint form (create + edit) ─────────────────── */

function EndpointForm({ endpoint, onSave, onCancel, saving, error,
                        teams = [], isSysAdmin = false, adminTeamIds = [] }) {
  // Rendered only while the side panel is slid out, so the subject needs no
  // `active` flag. Registering it is what lifts the help panel above this
  // SidePanel (z-index 60/61) — without it the three "?" buttons below would
  // open help *behind* the form they explain (#1988, same reason as the
  // MCP/Skills/Knowledge panels).
  useHelpSubject({ overlay: OVERLAY_MODEL_PROVIDER });

  const isEdit = Boolean(endpoint?.id);
  const [name, setName] = useState(endpoint?.name ?? '');
  const [id, setId] = useState(endpoint?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');

  // Team-scope ownership (#800), mirroring the SSH Keys / GitHub Tokens forms.
  // A System Admin picks system-scoped (assign to teams) vs team-scoped; a Team
  // Admin only ever creates team-scoped providers for a team they administer.
  // On edit only a System Admin may reassign — for everyone else the selector is
  // shown read-only and the ownership fields are omitted from the payload.
  const canReassign = canReassignCredentialClient({ isSysAdmin });
  // Ownership (#2360): ONE axis — Personal / Team / Global — replacing the old
  // "Global checkbox + System(assign to teams) / Team-owned" pair. Global is now
  // just the widest option of this control (provider-ownership-view.js). On edit
  // only a System Admin may re-tier; for everyone else it is shown read-only.
  const [ownership, setOwnership] = useState(() =>
    isEdit ? providerOwnershipFromRecord(endpoint) : defaultProviderOwnership({ isSysAdmin, adminTeamIds }));
  const sendOwnership = !isEdit || canReassign;
  const ownershipReady = !sendOwnership || providerOwnershipReady(ownership);
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
    initiallyAuto: !isEdit,
  });
  const [authToken, setAuthToken] = useState('');         // empty = leave as-is on edit
  const [clearToken, setClearToken] = useState(false);
  const [models, setModels] = useState(endpoint?.models ?? []);
  const [defaultModelId, setDefaultModelId] = useState(endpoint?.defaultModelId ?? '');

  // Auth type: classic api-key/proxy vs Claude subscription OAuth token.
  const wasOauth = endpoint?.authType === 'oauth-token';
  const [authType, setAuthType] = useState(endpoint?.authType ?? 'api-key');
  const isOauth = authType === 'oauth-token';
  // Compliance confirmation is demanded whenever subscription auth is being
  // (re-)established for this provider — i.e. on create, or when switching an
  // api-key provider over. Existing oauth providers carry their recorded ack.
  const requireCompliance = isOauth && (!isEdit || !wasOauth);
  const [complianceOk, setComplianceOk] = useState(false);
  // Completed login flow — the server claims the actual token on save.
  const [oauthFlowId, setOauthFlowId] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // The single-user subscription escape hatch (#2360, concept §9): an oauth (subscription) provider may be published
  // GLOBAL — runtime-only, agent runtime everywhere — iff the operator has
  // confirmed single-user use (complianceAck). The backend (PR2 #2353) already
  // accepts it; this unlocks the toggle the form disabled for every oauth
  // provider before. An existing oauth provider carries its recorded ack, so it
  // qualifies without re-confirming (mirrors the server PUT rule).
  const oauthGlobalOk = isOauth
    && (complianceOk || (wasOauth && endpoint?.complianceAck?.singleUser === true));

  // The Ownership radio-card options + the selectable team set for this caller
  // (#2360). Options carry their own enabled/disabledReason; a subscription
  // disables Team, and Global is System-Admin-only (shown disabled otherwise).
  const ownershipOptions = providerOwnershipOptions({ isOauth, isSysAdmin, adminTeamIds, canGlobalOauth: oauthGlobalOk });
  const selectableTeams = isSysAdmin ? teams : teams.filter(t => adminTeamIds.includes(t.id));

  // If the user removes the default model from the list (without using the
  // star toggle), drop the dangling pointer so we don't ship a server-rejected
  // value on save.
  useEffect(() => {
    if (defaultModelId && !models.some(m => m.id === defaultModelId)) {
      setDefaultModelId('');
    }
  }, [models, defaultModelId]);

  // A subscription (oauth) provider can never be Team, and can only be Global via
  // the single-user hatch (#2360). If the user switches an already-chosen
  // Personal/Team/Global state into an illegal one by flipping to subscription
  // auth, coerce it back to Personal so the payload stays valid.
  useEffect(() => {
    if (!isOauth) return;
    if (ownership.scope === 'team' || (ownership.scope === 'global' && !oauthGlobalOk)) {
      setOwnership({ scope: 'personal', teamId: '' });
    }
  }, [isOauth, oauthGlobalOk, ownership.scope]);

  // test / discover state
  const [probing, setProbing] = useState(null);            // 'test' | 'discover' | null
  const [probeMsg, setProbeMsg] = useState(null);          // { ok, text }
  const [discovered, setDiscovered] = useState(null);      // suggestion list pending merge

  // A subscription provider must end up with a token: an already-stored one
  // (edit), a completed login flow, or a manually pasted setup-token value.
  const oauthTokenReady = (isEdit && wasOauth && endpoint.hasToken && !clearToken)
    || !!oauthFlowId
    || !!authToken.trim();
  // Submit gate + the specific unmet requirements, derived in one pure place
  // (model-provider-submit-state.js) so the disabled button and the "why is
  // this disabled" hint can never disagree (#1302).
  const { canSubmit, reasons: submitBlockers } = describeSubmitState({
    name, ownershipReady, isOauth, requireCompliance, complianceOk,
    oauthTokenReady, baseUrl,
  });
  // Which credential a probe would use, and whether it may run at all —
  // resolved in one pure place (llm-probe-state.js) so the button state and the
  // request target cannot disagree. Notably, a completed-but-unsaved
  // subscription login blocks the probe instead of silently testing the old
  // stored token (#912): the fresh token is only claimed on save.
  const probeForm = {
    authType,
    endpointAuthType: endpoint?.authType ?? 'api-key',
    endpointId: endpoint?.id,
    isEdit,
    hasStoredToken: !!endpoint?.hasToken,
    pastedToken: authToken,
    clearToken,
    oauthFlowId,
    baseUrl,
  };
  const probe = resolveProbeState(probeForm);
  const canProbe = probe.canProbe;

  async function runTest() {
    if (!canProbe) {
      setProbeMsg({ ok: false, text: probeBlockedMessage(probe, 'test') });
      return;
    }
    setProbing('test'); setProbeMsg(null);
    try {
      const { path, body } = probeRequest(probeForm, 'test');
      const r = await apiCall('POST', path, body);
      setProbeMsg(probeResultMessage(r, 'test', { isOauth: probe.isOauth }));
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  async function runDiscover() {
    if (!canProbe) {
      setProbeMsg({ ok: false, text: probeBlockedMessage(probe, 'discover') });
      return;
    }
    setProbing('discover'); setProbeMsg(null);
    try {
      const { path, body } = probeRequest(probeForm, 'discover');
      const r = await apiCall('POST', path, body);
      if (r.noModelList) {
        setDiscovered(null);
        setProbeMsg({ ok: true, text: r.message });
      } else {
        setDiscovered(r.models || []);
        setProbeMsg({ ok: true, text: `Found ${r.count ?? r.models?.length ?? 0} model(s).` });
      }
    } catch (e) {
      // discover-models answers a failed probe with 502, so apiCall throws; the
      // verdict code rides on the thrown error (#2460) — render it the same way
      // the always-200 test route is rendered inline.
      setProbeMsg(probeResultMessage(
        { ok: false, reason: e.reason, error: e.serverMessage || e.message },
        'discover',
        { isOauth: probe.isOauth },
      ));
    } finally {
      setProbing(null);
    }
  }

  function applyDiscovered(mode) {
    if (!discovered) return;
    if (mode === 'replace') {
      setModels(discovered);
    } else {
      // merge: keep existing rows by id, add unknown ones from suggestion
      const existingIds = new Set(models.map(m => m.id));
      const additions = discovered.filter(m => !existingIds.has(m.id));
      setModels([...models, ...additions]);
    }
    setDiscovered(null);
  }

  function submit() {
    const cleanedModels = models
      .filter(m => m.id && m.id.trim())
      .map(m => ({
        id: m.id.trim(),
        displayName: (m.displayName || m.id).trim(),
        ...(m.kind ? { kind: m.kind } : {}),
        // #1717: preserve the provider-reported context window captured by
        // discovery so it round-trips to the server (and back into the chat
        // header) instead of being dropped on save.
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      }));
    const payload = {
      name: name.trim(),
      authType,
      baseUrl: isOauth ? '' : baseUrl.trim(),
      models: cleanedModels,
      // Always send defaultModelId — '' clears it on the server, a real id
      // sets/updates it. Skipping the field would leave the server's cached
      // value alone, which is wrong when the user just unstarred a model.
      defaultModelId: defaultModelId && cleanedModels.some(m => m.id === defaultModelId)
        ? defaultModelId
        : '',
    };
    if (!isEdit && id.trim()) payload.id = id.trim();
    // Ownership (#2360): the Personal / Team / Global choice, incl. the `global`
    // flag, in one payload. Sent on create, and on edit only when the caller may
    // re-tier (System Admin) — omitting it on a Team-Admin edit leaves the
    // scope/team untouched (the server would 403 a reassignment anyway). The
    // server re-enforces every rule (canCreateCredential / resolveGlobalFlag /
    // oauth-not-team).
    if (sendOwnership) Object.assign(payload, providerOwnershipPayload(ownership));
    if (isOauth && complianceOk) payload.complianceAck = true;
    // Token sources, in precedence order: manual paste > completed login flow
    // (claimed server-side) > keep/clear existing.
    if (authToken.trim())      payload.authToken = authToken.trim();
    else if (isOauth && oauthFlowId) payload.oauthFlowId = oauthFlowId;
    else if (clearToken)       payload.authToken = '';
    // else: undefined → server keeps existing token (only relevant on edit)
    onSave(payload);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput
        label="Name"
        required
        value={name}
        onChange={isEdit ? setName : handleNameChange}
        placeholder="e.g. LiteLLM Prod"
      />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        disabled={isEdit}
        placeholder="e.g. litellm-prod"
        helpText={isEdit
          ? <>Cannot be changed after creation.</>
          : <>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} <strong>Cannot be changed after creation.</strong></>}
      />

      {/* Auth type — classic API key / proxy vs Claude subscription OAuth */}
      <div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
          Authentication
          {/* #1988: the two auth types are two chapters, and this is one "?" —
              so it follows the selection. Asking about the choice you are
              currently looking at is the only reading that is never wrong; the
              other chapter is one scroll away, since the panel renders the whole
              topic and merely scrolls to the requested chapter. */}
          <PageHelpButton
            label={isOauth
              ? 'How Anthropic subscription authentication works'
              : 'How API key / proxy authentication works'}
            size={13}
            section={isOauth ? MODELS_HELP_SECTIONS.oauthAuth : MODELS_HELP_SECTIONS.apiKeyAuth}
            style={{ padding: 0 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
          {AUTH_TYPE_OPTIONS.map(opt => (
            <label key={opt.value} title={opt.hint} style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: authType === opt.value ? 'var(--eb-bg-elevated)' : 'transparent',
              border: `1px solid ${authType === opt.value ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
            }}>
              <input
                type="radio"
                name="llm-auth-type"
                value={opt.value}
                checked={authType === opt.value}
                onChange={() => { setAuthType(opt.value); setProbeMsg(null); }}
              />
              {opt.label}
            </label>
          ))}
        </div>
        {/* #1138: spell out the selected auth type inline instead of hiding it in a hover tooltip */}
        <div style={{
          marginTop: 'var(--eb-space-2)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          lineHeight: 1.5,
        }}>
          {AUTH_TYPE_OPTIONS.find(o => o.value === authType)?.desc}
        </div>
      </div>

      {/* Ownership (#2360): one axis — Personal / Team / Global — replacing the
          old Global-checkbox + System(assign)/Team-owned pair. On a non-admin
          edit the tier is fixed (re-tier is System-Admin-only), shown read-only. */}
      {sendOwnership ? (
        <ProviderOwnership
          value={ownership}
          onChange={setOwnership}
          options={ownershipOptions}
          teams={selectableTeams}
        />
      ) : (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Ownership is fixed for this provider — only a System Admin can change who can use it.
        </div>
      )}

      {!isOauth && (
        <div>
          <FormInput
            label="Base URL"
            required
            type="url"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://litellm.example/v1"
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
            Must speak the Anthropic Messages API — e.g. the Anthropic API directly, a LiteLLM proxy, or an internal gateway that exposes it.
          </div>
        </div>
      )}

      {isOauth && (
        <>
          <div style={{
            padding: 'var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-secondary)',
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
          }}>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start' }}>
              <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-status-warning)' }} />
              {/* This warning guards a REQUIRED confirmation, so the rule itself
                  stays here; the rationale and its consequences (per-seat
                  Enterprise tokens for a team, shared rate limits, assist calls
                  skipping this auth type) moved to the help topic (#1882).
                  #1988 pointed the "?" at those consequences directly — the
                  `###` inside the subscription chapter, not the chapter's top —
                  because that is what this button's label promises and what left
                  this box. The chapter itself is reachable from the auth-type
                  "?" above. */}
              <span>
                <strong>Single-user operation only.</strong> Anthropic's Consumer Terms permit OAuth tokens from
                Free/Pro/Max subscriptions solely for the subscription owner's own use — they must not serve
                other users or third parties.
                {' '}<PageHelpButton
                  label="What this means for a team"
                  size={13}
                  section={MODELS_HELP_SECTIONS.oauthSingleUser}
                  style={{ padding: 0, verticalAlign: '-2px' }}
                /></span>
            </div>
            {requireCompliance ? (
              // AC2: the confirmation is a REQUIRED input, not part of the
              // informational copy above — lift it into its own bordered,
              // filled row with a "Required" badge and a highlighted border
              // when still unticked, so it reads as something to act on (#1302).
              <label style={{
                display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
                cursor: 'pointer',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-surface)',
                border: `1px solid ${complianceOk ? 'var(--eb-status-success)' : 'var(--eb-status-error)'}`,
                borderRadius: 'var(--eb-radius-md)',
                color: 'var(--eb-text-primary)',
              }}>
                <input
                  type="checkbox"
                  checked={complianceOk}
                  onChange={e => setComplianceOk(e.target.checked)}
                  aria-required="true"
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <span style={{
                    display: 'inline-block',
                    fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
                    textTransform: 'uppercase', letterSpacing: '0.03em',
                    color: 'var(--eb-status-error)', marginBottom: 'var(--eb-space-1)',
                  }}>
                    Required confirmation
                  </span>
                  <br />
                  I confirm that every agent using this provider runs exclusively for me, the owner of this
                  Claude subscription (single-user operation).
                </span>
              </label>
            ) : (
              endpoint?.complianceAck?.confirmedAt && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  Single-user operation confirmed by <strong>{endpoint.complianceAck.confirmedBy}</strong> on {new Date(endpoint.complianceAck.confirmedAt).toLocaleString()}.
                </div>
              )
            )}
          </div>

          <div>
            <div style={{
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              color: 'var(--eb-text-secondary)',
              marginBottom: 'var(--eb-space-1)',
            }}>
              Subscription login
            </div>
            {isEdit && wasOauth && endpoint.hasToken && !oauthFlowId && (
              <div style={{
                fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                marginBottom: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)',
              }}>
                Current token: {endpoint.tokenPreview} · {endpoint.tokenFingerprint}
              </div>
            )}
            {oauthFlowId ? (
              <div style={{
                fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)',
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                marginBottom: 'var(--eb-space-2)',
              }}>
                <Check size={14} /> Login completed — the token is stored when you save.
                <button
                  type="button"
                  onClick={() => { setOauthFlowId(null); setWizardOpen(false); setProbeMsg(null); }}
                  style={buttonGhost}
                >
                  Discard
                </button>
              </div>
            ) : wizardOpen ? (
              <OAuthLoginWizard
                // Drop any earlier probe result: it describes the token the
                // fresh login is about to replace, and a lingering red 401
                // reads as "this login failed" (#912).
                onToken={(flowId) => { setOauthFlowId(flowId); setWizardOpen(false); setProbeMsg(null); }}
                onClose={() => setWizardOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                style={{ ...buttonPrimary, display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
              >
                <LogIn size={14} /> {isEdit && wasOauth && endpoint.hasToken ? 'Re-authenticate…' : 'Sign in with Anthropic…'}
              </button>
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-2)' }}>
              Runs <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code> on the orchestrator and issues a long-lived (~1 year) token.
              Alternatively, run it on any machine yourself and paste the resulting <code style={{ fontFamily: 'var(--eb-font-mono)' }}>sk-ant-oat…</code> token below.
            </div>
          </div>
        </>
      )}

      {/* Token field — different copy for create vs edit */}
      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
          {isOauth
            ? <>Setup token <span style={{ color: 'var(--eb-text-muted)', fontWeight: 'normal' }}>(manual alternative to the login above)</span></>
            : <>Auth token {!isEdit && <span style={{ color: 'var(--eb-text-muted)', fontWeight: 'normal' }}>(optional)</span>}</>}
        </div>
        {!isOauth && isEdit && endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            marginBottom: 'var(--eb-space-2)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            Current: {endpoint.tokenPreview} · {endpoint.tokenFingerprint}
          </div>
        )}
        {!isOauth && isEdit && !endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-status-warning)',
            marginBottom: 'var(--eb-space-2)',
          }}>
            No token stored — Test/Discover will hit the proxy unauthenticated. Paste the token below and save.
          </div>
        )}
        <textarea
          value={authToken}
          disabled={clearToken}
          onChange={e => setAuthToken(e.target.value)}
          rows={2}
          placeholder={
            isOauth
              ? 'sk-ant-oat… (output of `claude setup-token`)'
              : isEdit
                ? endpoint.hasToken
                  ? 'Leave empty to keep current token'
                  : 'Paste auth token (sent as Bearer to the proxy)'
                : 'sk-… (sent as Bearer token to the proxy)'
          }
          style={{
            width: '100%',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
            resize: 'vertical',
            outline: 'none',
            opacity: clearToken ? 0.5 : 1,
            boxSizing: 'border-box',
          }}
        />
        {!isOauth && isEdit && endpoint.hasToken && (
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
            marginTop: 'var(--eb-space-1)', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={clearToken}
              onChange={e => setClearToken(e.target.checked)}
            />
            Remove stored token on save
          </label>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Stored in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>/workspace/llm-endpoints/_keys/</code> (chmod 600). API never returns the raw value — only a preview and fingerprint.
        </div>
      </div>

      {/* Test + Discover */}
      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        flexWrap: 'wrap',
        alignItems: 'center',
        paddingTop: 'var(--eb-space-2)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button
          type="button"
          onClick={runTest}
          disabled={!canProbe || probing === 'test'}
          style={{ ...buttonGhost, opacity: !canProbe || probing === 'test' ? 0.6 : 1 }}
          title={probeTitle(probe, 'test')}
        >
          <PlugZap size={13} /> {probing === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          onClick={runDiscover}
          disabled={!canProbe || probing === 'discover'}
          style={{ ...buttonGhost, opacity: !canProbe || probing === 'discover' ? 0.6 : 1 }}
          title={probeTitle(probe, 'discover')}
        >
          <RefreshCw size={13} /> {probing === 'discover' ? 'Loading…' : 'Discover models'}
        </button>
        {/* #1988: what each probe does, and — the part the note below can only
            state, never explain — why it always names the credential it used. */}
        <PageHelpButton
          label="What Test connection and Discover models do"
          size={13}
          section={MODELS_HELP_SECTIONS.probes}
          style={{ padding: 0 }}
        />
        {probeMsg && (
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              fontSize: 'var(--eb-text-xs)',
              color: probeMsg.ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)',
            }}>{probeMsg.text}</span>
            {/* Raw HTTP/proxy detail kept secondary, never the headline (#2460
                AC2) — e.g. a LiteLLM "Budget exceeded" body still shows here. */}
            {probeMsg.detail && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                {probeMsg.detail}
              </span>
            )}
          </span>
        )}
        {/* Always name the credential a probe would use, so a 401 can never be
            mistaken for a failed login (#912). */}
        <span style={{
          flexBasis: '100%',
          fontSize: 'var(--eb-text-xs)',
          color: canProbe ? 'var(--eb-text-muted)' : 'var(--eb-status-warning)',
        }}>{probeNote(probe)}</span>
      </div>

      {discovered && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-accent-primary)',
          borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ fontSize: 'var(--eb-text-sm)' }}>
            {discovered.length} model(s) returned by the proxy. Apply to the catalog below?
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => applyDiscovered('merge')} style={buttonPrimary}>
              <Check size={13} /> Merge into catalog
            </button>
            <button type="button" onClick={() => applyDiscovered('replace')} style={buttonSecondary}>
              Replace catalog
            </button>
            <button type="button" onClick={() => setDiscovered(null)} style={buttonSecondary}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 'var(--eb-space-2)', gap: 'var(--eb-space-3)',
        }}>
          <div style={{
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)',
            color: 'var(--eb-text-secondary)',
          }}>
            Models
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {defaultModelId
              ? <>Default: <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{defaultModelId}</code></>
              : 'No default — new agents fall back to the first model.'}
          </div>
        </div>
        <ModelEditor
          models={models}
          defaultModelId={defaultModelId}
          onChange={setModels}
          onDefaultChange={setDefaultModelId}
        />
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          marginTop: 'var(--eb-space-2)',
        }}>
          Click the star to mark one model as the provider's default. New environments and agents bound to this provider start on that model unless they override it explicitly.
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-2)',
        paddingTop: 'var(--eb-space-3)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        {/* AC1: when the button is disabled (and not merely saving), spell out
            exactly which requirement is still unmet so the user isn't left
            guessing why the form looks broken (#1302). */}
        {!saving && submitBlockers.length > 0 && (
          <div style={{
            display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
          }}>
            <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1, color: 'var(--eb-status-warning)' }} />
            <span>
              {isEdit ? 'Save changes' : 'Create provider'} is disabled until you:
              <ul style={{ margin: 'var(--eb-space-1) 0 0', paddingLeft: 'var(--eb-space-4)' }}>
                {submitBlockers.map(r => (
                  <li key={r.field}>{r.message}</li>
                ))}
              </ul>
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <button
            onClick={submit}
            disabled={saving || !canSubmit}
            style={{
              ...buttonPrimary,
              cursor: saving ? 'wait' : (canSubmit ? 'pointer' : 'not-allowed'),
              // AC4: a disabled button must not read as "active/clickable" — dim
              // it hard and drop the primary fill so its state is unambiguous.
              opacity: saving ? 0.6 : (canSubmit ? 1 : 0.45),
              ...(!saving && !canSubmit ? {
                background: 'var(--eb-bg-elevated)',
                color: 'var(--eb-text-muted)',
                border: '1px solid var(--eb-border-default)',
              } : {}),
            }}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create provider'}
          </button>
          <button onClick={onCancel} style={buttonSecondary}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Sub: read-only view for the .env fallback ─────────────── */

function EnvProviderPanel({ provider, onClose }) {
  const readOnlyField = {
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-elevated)',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-sm)',
    minHeight: 'calc(var(--eb-text-sm) * 1.5)',
  };
  const labelStyle = {
    fontSize: 'var(--eb-text-sm)',
    fontWeight: 'var(--eb-font-medium)',
    color: 'var(--eb-text-secondary)',
    marginBottom: 'var(--eb-space-1)',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{
        padding: 'var(--eb-space-3)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
      }}>
        <Lock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          Read-only mirror of the <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_*</code> variables in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.env</code>. Environments that pick <em>“inherit from .env”</em> resolve to these values. To change them, edit <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.env</code> and restart the stack (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>make restart</code>).
        </span>
      </div>

      <div>
        <div style={labelStyle}>Name</div>
        <div style={readOnlyField}>{provider.name}</div>
      </div>

      <div>
        <div style={labelStyle}>Base URL</div>
        <div style={{ ...readOnlyField, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
          {provider.baseUrl || <span style={{ color: 'var(--eb-text-muted)' }}>(not set)</span>}
        </div>
      </div>

      <div>
        <div style={labelStyle}>Auth token</div>
        {provider.hasToken ? (
          <div style={{ ...readOnlyField, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            {provider.tokenPreview} · {provider.tokenFingerprint}
          </div>
        ) : (
          <div style={{ ...readOnlyField, color: 'var(--eb-text-muted)' }}>
            (none — <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_AUTH_TOKEN</code> not set)
          </div>
        )}
      </div>

      <div>
        <div style={labelStyle}>Models</div>
        {provider.models?.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {provider.models.map(m => {
              const isDefault = m.id === provider.defaultModelId;
              return (
                <div key={m.id} style={{
                  ...readOnlyField,
                  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                }}>
                  <Star
                    size={13}
                    fill={isDefault ? 'currentColor' : 'none'}
                    style={{ color: isDefault ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }}
                  />
                  <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{m.id}</code>
                  {isDefault && (
                    <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: 'auto' }}>
                      default
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ ...readOnlyField, color: 'var(--eb-text-muted)' }}>(no model defaults configured)</div>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-2)' }}>
          Derived from <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_DEFAULT_SONNET_MODEL</code> and <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ANTHROPIC_DEFAULT_HAIKU_MODEL</code>.
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 'var(--eb-space-2)',
        paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button onClick={onClose} style={buttonSecondary}>Close</button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function ModelRegistry() {
  const { data: endpoints, loading, error, refetch } = useApi('/api/llm-endpoints');
  const { data: envFallback } = useApi('/api/llm-env-fallback');
  const { data: teamsData } = useApi('/api/admin/teams');
  const { data: agentsData } = useApi('/api/agents');
  const { user } = useAuth();
  const humanTeams = Array.isArray(teamsData) ? teamsData : [];
  // #2360 re-key: "Team" means an AGENT TEAM (a role:'team' agent), not the
  // vestigial human-team collection — so the Ownership dropdown lists agent
  // teams. The table's name lookup merges both spaces so a legacy
  // 'default'-stamped provider still resolves to a readable name.
  const agentTeams = (Array.isArray(agentsData) ? agentsData : [])
    .filter(a => a && a.role === 'team')
    .map(a => ({ id: a.id, name: a.displayName || a.id }));
  const teams = agentTeams;
  const names = { ...teamsById(humanTeams), ...teamsById(agentTeams) };
  const isSysAdmin = !!user?.admin;
  const adminTeamIds = adminTeamIdsOf(user);
  // `userId` is REQUIRED for the personal-tier manage check: canManageCredentialClient
  // authorises a personal provider only when `c.userId === caller.userId`. Omitting
  // it made every personal provider look unmanageable even to its own owner — the
  // row showed a lock with no edit/delete (#2360 follow-up). The session carries the
  // id as `user.userId` (describeAuthz), not `user.id`.
  const caller = { isSysAdmin, adminTeamIds, userId: user?.userId };
  // User's team IDs for assist-exclusion badge computation (AC1/AC2, #1402).
  const userTeamIds = (user?.teams || []).map(t => t.teamId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState(null);    // endpoint object
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  // `hidden` is the #1501 blast-radius signal: `{count, teamCount, standalone}`
  // for the bound agents this caller may not see. Their ids never arrive — only
  // the counts — but they are restarted all the same, so the dialog says so.
  const [respawnPrompt, setRespawnPrompt] = useState(null); // { endpointId, agents, hidden } | null
  const [respawning, setRespawning]       = useState(false);
  const [respawnError, setRespawnError]   = useState(null);
  // Set when respawn-agents reports agents it failed to restart (still on the
  // old credentials) — surfaced as a follow-up alert so the operator can't
  // mistake "dialog closed" for "rotation fully applied" (only console.info'd
  // previously, which nobody watching the UI would ever see).
  const [respawnFailureNotice, setRespawnFailureNotice] = useState(null); // { failedAgents: Array<{id, displayName, role, teamId, teamName}>, hiddenSkipped: number } | null

  // When the endpoint list refetches after a successful edit, sync the open
  // panel with the fresh masked record (token preview/fingerprint, etc.).
  useEffect(() => {
    if (!editing || editing.readOnly || !endpoints) return;
    const fresh = endpoints.find(e => e.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
  }, [endpoints]); // eslint-disable-line react-hooks/exhaustive-deps

  // #2405: the leading ID column was dropped — it duplicated what Name already
  // identifies and widened the row. Removing it here also removes the provider
  // id from the filter (DataTable matches across every column's `key`) and from
  // the auto-derived filter placeholder, so an id value is no longer searchable
  // and "ID" no longer appears in the hint.
  const COLUMNS = [
    {
      key: 'name',
      label: 'Name',
      render: (v, row) => {
        if (row.readOnly) {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <span>{v}</span>
              <span style={{
                fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
                border: '1px solid var(--eb-border-default)',
              }}>read-only</span>
            </span>
          );
        }
        // Badge explaining why this provider is excluded from assist (#1402).
        // #2405: only the team-scope ("Not your teams") badge stays in the Name
        // column — the oauth ("Agents only") badge moved to the Base URL cell
        // next to "Subscription (OAuth)", the reason it exists.
        const exclusion = endpointAssistExclusion(row, userTeamIds, isSysAdmin);
        if (!assistExclusionInName(exclusion)) return v;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
            <span title="This provider is not assigned to any of your teams and will not appear in the assist model selector. A System Admin can assign it on this page." style={{
              fontSize: 'var(--eb-text-xs)',
              padding: '0 var(--eb-space-2)',
              borderRadius: 'var(--eb-radius-sm)',
              border: '1px solid var(--eb-status-warning)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              color: 'var(--eb-status-warning)',
            }}>Not your teams</span>
          </span>
        );
      },
    },
    {
      // #2360 follow-up: the "Ownership" column mirrors the edit dialog's one-axis
      // taxonomy (Personal / Team(s) / Global) via `providerScopeLabel`, which is
      // built on the SAME `providerOwnershipFromRecord` the dialog opens with — so
      // the row and the dialog can never disagree (the old credential scope label
      // showed a stale "System" for a team-assigned provider).
      key: '_scope', label: 'Ownership', sortable: false,
      // #2442: `_scope` is synthetic (no `row['_scope']`), so filter on the text
      // this column actually displays — the ownership label plus, for Team scope,
      // its detail (the assigned team name(s)), or "Global".
      filterValue: (_, row) => {
        if (row.readOnly) return '';
        const s = providerScopeLabel(row, names);
        if (s.scope === 'global') return 'Global';
        return [s.label, providerScopeShowsDetail(s.scope) ? s.detail : ''].filter(Boolean).join(' ');
      },
      render: (_, row) => {
        if (row.readOnly) return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
        const s = providerScopeLabel(row, names);
        // A global provider is usable by everyone, so its team assignment is moot
        // (#2136): a single accented "Global" pill instead of the scope/teams detail.
        if (s.scope === 'global') {
          return (
            <span style={{ fontSize: 'var(--eb-text-xs)' }} title={s.detail}>
              <span style={{
                display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-accent-subtle, var(--eb-bg-elevated))', color: 'var(--eb-accent, var(--eb-text-secondary))',
                fontWeight: 'var(--eb-font-medium)',
              }}>Global</span>
            </span>
          );
        }
        // #2405: keep the Team-scope detail (the assigned team name(s) — real
        // information) but drop the Personal detail ("Only you and the agents you
        // own"), which merely repeats what the "Personal" pill already conveys.
        const showDetail = providerScopeShowsDetail(s.scope);
        return (
          <span style={{ fontSize: 'var(--eb-text-xs)' }}>
            <span style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
              fontWeight: 'var(--eb-font-medium)', marginRight: showDetail ? 'var(--eb-space-2)' : 0,
            }}>{s.label}</span>
            {showDetail && <span style={{ color: 'var(--eb-text-muted)' }}>{s.detail}</span>}
          </span>
        );
      },
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      render: (v, row) => {
        if (row.authType !== 'oauth-token') {
          return <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>;
        }
        // #2405: the "Agents only" tag now sits next to the "Subscription (OAuth)"
        // label — the OAuth subscription is precisely why the provider is
        // agent-chat-only and excluded from server-side assist — instead of by
        // the provider name. Same visibility set it had in the Name column.
        const agentsOnly = assistExclusionInBaseUrl(endpointAssistExclusion(row, userTeamIds, isSysAdmin));
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <span title="Anthropic subscription (OAuth) — talks directly to api.anthropic.com" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
              fontSize: 'var(--eb-text-xs)',
            }}><LogIn size={11} /> Subscription (OAuth)</span>
            {agentsOnly && (
              <span title="A subscription (OAuth) provider drives agent chat, but can't be used for server-side assist features (Flow Copilot, suggestions). Add an API-key provider to use the assist selector." style={{
                fontSize: 'var(--eb-text-xs)',
                padding: '0 var(--eb-space-2)',
                borderRadius: 'var(--eb-radius-sm)',
                border: '1px solid var(--eb-border-default)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                color: 'var(--eb-text-secondary)',
              }}>Agents only</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'tokenPreview',
      label: 'Token',
      render: (v, row) => row.hasToken
        ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>
        : <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>(none)</span>,
    },
    {
      key: 'models',
      label: 'Models',
      render: (v, row) => {
        const count = Array.isArray(v) ? v.length : 0;
        const def = row.defaultModelId;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
            <span>{count}</span>
            {def
              ? <span title={`Default model: ${def}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '0 var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
                  background: 'var(--eb-bg-elevated)',
                  color: 'var(--eb-text-secondary)',
                  fontFamily: 'var(--eb-font-mono)',
                }}>
                  <Star size={11} fill="currentColor" /> {def}
                </span>
              : <span style={{ color: 'var(--eb-text-muted)' }}>(no default)</span>}
          </span>
        );
      },
    },
    {
      // Per-provider reachability (#1843), from the background health poller +
      // probe-on-save. Current on page load from the persisted status — no click
      // (AC3). Honest 'Unknown' when never probed (AC6).
      key: 'health',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
          Health
          {/* #1988: `Unknown` is the state that reads as a problem and is not
              one, so the column needs somewhere to say so. DataTable attaches
              an onClick to every header cell and lets `sortable: false` no-op it
              inside, so the "?" is inert-by-luck today; it keeps the
              stopPropagation wrapper the MCP/Token-Usage headers use so that
              making this column sortable later cannot turn asking what a status
              means into a re-sort. */}
          <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex' }}>
            <PageHelpButton
              label="What the Health column means"
              size={13}
              section={MODELS_HELP_SECTIONS.health}
              style={{ padding: 0 }}
            />
          </span>
        </span>
      ),
      sortable: false,
      render: (v, row) => {
        if (row.readOnly) return '—'; // the .env fallback row is not a probed endpoint
        const { label, tone } = healthCellModel(v);
        const color = tone === 'ok' ? 'var(--eb-status-success)'
                    : tone === 'warning' ? 'var(--eb-status-warning)'
                    : tone === 'error' ? 'var(--eb-status-error)'
                    : 'var(--eb-text-secondary)';
        const detail = healthCellDetail(v);
        return (
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 'var(--eb-text-xs)' }}>
            <span title={detail} style={{ color, fontWeight: 600 }}>{label}</span>
            {v && (v.status === 'error' || v.status === 'warning') && (
              <span title={detail} style={{
                color: 'var(--eb-text-secondary)', maxWidth: 220,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{detail}</span>
            )}
            {v && v.checkedAt && (
              <span style={{ color: 'var(--eb-text-muted)' }}><WhenCell iso={v.checkedAt} /></span>
            )}
          </span>
        );
      },
    },
    {
      // Provider spending budget (#2732), read with every health probe from
      // LiteLLM's /key/info + /team/info. The .env row carries it top-level
      // (`row.budget`); a registered provider on its health view. `—` when the
      // provider has no budget (or no budget API) — never a failure.
      key: 'budget',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
          Budget
          <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex' }}>
            <PageHelpButton
              label="What the Budget column means"
              size={13}
              section={MODELS_HELP_SECTIONS.budget}
              style={{ padding: 0 }}
            />
          </span>
        </span>
      ),
      sortable: false,
      render: (_, row) => {
        const budget = row.readOnly ? row.budget : row.health?.budget;
        const m = budgetCellModel(budget, row.readOnly ? null : row.health?.status);
        if (m.text === '—') {
          return (
            <span title={m.title} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              <span>—</span>
              {m.hint && <span style={{ color: 'var(--eb-text-secondary)' }}>{m.hint}</span>}
            </span>
          );
        }
        const pctColor = m.tone === 'error' ? 'var(--eb-status-error)'
                       : m.tone === 'warning' ? 'var(--eb-status-warning)'
                       : 'var(--eb-text-secondary)';
        return (
          <span title={m.title} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 'var(--eb-text-xs)' }}>
            <span style={{ fontFamily: 'var(--eb-font-mono)', whiteSpace: 'nowrap' }}>{m.text}</span>
            <span style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: pctColor, fontWeight: 600 }}>{m.pct}</span>
              <span style={{ color: 'var(--eb-text-muted)' }}> · {m.source}{m.reset ? ` · resets ${m.reset}` : ''}</span>
            </span>
          </span>
        );
      },
    },
    { key: 'createdAt', label: 'Added', render: (v, row) => row.readOnly ? '—' : <WhenCell iso={v} /> },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => {
        if (row.readOnly) return (
          <div style={{ display: 'flex', justifyContent: 'flex-end', color: 'var(--eb-text-muted)' }} title="Edit .env and restart to change">
            <Lock size={13} />
          </div>
        );
        // A Team Admin may see a system provider assigned to their team but not
        // manage it (#800) — show a lock, no edit/delete, matching the API gate.
        if (!canManageProviderClient(row, caller)) return (
          <div style={{ display: 'flex', justifyContent: 'flex-end', color: 'var(--eb-text-muted)' }} title="System-scoped provider — only a System Admin can manage it. You may use it.">
            <Lock size={13} />
          </div>
        );
        return (
          <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
            <IconButton icon={Pencil} label="Edit" onClick={() => { setEditing(row); setFormError(null); }} />
            <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />
          </div>
        );
      },
    },
  ];

  async function handleCreate(payload) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/llm-endpoints', payload);
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(payload) {
    if (!editing) return;
    setSaving(true); setFormError(null);
    try {
      await apiCall('PUT', `/api/llm-endpoints/${editing.id}`, payload);
      // Detect whether a spawn-time credential changed: new/cleared token, new
      // OAuth flow, or changed baseUrl — all are baked into the container env.
      const credentialChanged = 'authToken' in payload
        || 'oauthFlowId' in payload
        || payload.baseUrl !== (editing.baseUrl ?? '');
      if (credentialChanged) {
        try {
          const { agents, hidden } = await apiCall('GET', `/api/llm-endpoints/${editing.id}/bound-agents`);
          // Prompt on hidden-only too: a shared, system-scoped provider whose
          // only consumers sit in teams this caller is not in still has to be
          // restarted, and silently skipping the prompt would leave them on the
          // rotated-away credential (#1501).
          if ((agents && agents.length > 0) || (hidden && hidden.count > 0)) {
            setRespawnPrompt({ endpointId: editing.id, agents: agents || [], hidden });
            // Don't close the panel yet — dialog handles that on confirm/cancel.
            return;
          }
        } catch (e) {
          // bound-agents failure is non-blocking toward the user; the PUT
          // already succeeded — but leave a breadcrumb for developers.
          console.warn('[ModelRegistry] failed to fetch bound-agents for', editing.id, e);
        }
      }
      setEditing(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/llm-endpoints/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  async function handleRespawnConfirm() {
    if (!respawnPrompt) return;
    setRespawning(true); setRespawnError(null);
    try {
      const { respawned, skipped, hidden } = await apiCall('POST', `/api/llm-endpoints/${respawnPrompt.endpointId}/respawn-agents`);
      const agents = respawnPrompt.agents;
      // Failures among the agents this caller cannot see arrive as a count only
      // (#1501) — but they are still failures, so they must reach the alert.
      const hiddenSkipped = (hidden && hidden.skipped) || 0;
      setRespawnPrompt(null);
      refetch();
      if ((skipped && skipped.length > 0) || hiddenSkipped > 0) {
        // `skipped` means the orchestrator's respawn call returned
        // respawned:false for that agent id. That covers two different cases
        // it can't distinguish from here: the agent wasn't actually running
        // at the moment of the call (nothing to fix — it'll get the new
        // credential on its next start), or it WAS running and the restart
        // attempt itself failed (still on stale credentials — the exact
        // problem this feature exists to prevent). Since we can't tell which
        // occurred, don't close the panel silently; surface it as a
        // follow-up alert the operator must see and dismiss.
        const failedAgents = (skipped || []).map(id => agents.find(a => a.id === id) || { id, displayName: id, role: 'agent', teamId: null, teamName: null });
        setRespawnFailureNotice({ failedAgents, hiddenSkipped });
      } else {
        setEditing(null);
      }
    } catch (e) {
      setRespawnError(e.message);
    } finally {
      setRespawning(false);
    }
  }

  function handleRespawnCancel() {
    setRespawnPrompt(null);
    setRespawnError(null);
    setEditing(null);
    refetch();
  }

  function handleRespawnFailureAck() {
    setRespawnFailureNotice(null);
    setEditing(null);
    refetch();
  }

  const headerAction = usePageActions(
    <button
      onClick={() => { setCreating(true); setFormError(null); }}
      style={{ ...buttonPrimary, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
    >
      <Plus size={15} /> New provider
    </button>
  );

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      {/* One-line description + the "?" that opens this page's help topic. The
          intro paragraph that used to sit here — what a provider is, and the
          API-key-vs-subscription comparison — now lives in that topic
          (api/helper-chat/help-topics/models.md, #1882), together with the
          model-precedence chain, what the probe/health poller actually do, and
          the Consumer-Terms single-user constraint. Field-level hints inside the
          form stay where the decision is made.

          #1988 split that topic into chapters and pointed each surface at its
          own: this button opens chapter 1 (what a provider is, what the table
          shows, the model-precedence chain), the auth-type row chapters 2/3, the
          probe row chapter 4 and the Health column chapter 5. The slugs live in
          models-help-sections.js — never inline — so
          models-help-extraction.test.js can see them. */}
      <p style={{
        margin: 0,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          The LLM endpoints Agent Studio routes model traffic to — each with a URL, a credential
          and a catalog of models your agents can pick from.
        </span>
        <PageHelpButton
          label="How providers and auth types work"
          size={14}
          section={MODELS_HELP_SECTIONS.page}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </p>

      {actionError && (
        <div role="alert" style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={envFallback ? [envFallback, ...(endpoints ?? [])] : (endpoints ?? [])}
        emptyText="No model providers registered yet. Click 'New provider' to add one."
        onRowClick={row => {
          // The .env row opens its read-only panel; a manageable provider opens
          // the editor. A visible-but-unmanageable system provider (Team Admin)
          // is not clickable — its lock already explains why (#800).
          if (!row.readOnly && !canManageProviderClient(row, caller)) return;
          setEditing(row); setFormError(null);
        }}
      />

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="New model provider"
        width="640px"
      >
        {creating && (
          <EndpointForm
            endpoint={null}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            saving={saving}
            error={formError}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? (editing.readOnly ? editing.name : `Edit "${editing.name}"`) : ''}
        width="640px"
      >
        {editing && editing.readOnly && (
          <EnvProviderPanel provider={editing} onClose={() => setEditing(null)} />
        )}
        {editing && !editing.readOnly && (
          <EndpointForm
            endpoint={editing}
            onSave={handleUpdate}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={formError}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete model provider"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Environments using this provider must detach it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!respawnPrompt}
        variant="info"
        title="Restart agents to apply new credentials?"
        message={respawnPrompt && (
          <div>
            <p style={{ marginTop: 0 }}>
              {boundAgentsLead(respawnPrompt.agents.length, respawnPrompt.hidden)}
            </p>
            <div style={{
              margin: '0 0 var(--eb-space-3)',
              maxHeight: 240,
              overflowY: 'auto',
              fontSize: 'var(--eb-text-sm)',
            }}>
              {groupAgentsByTeam(respawnPrompt.agents).map(group => (
                <div key={group.key} style={{ marginBottom: 'var(--eb-space-2)' }}>
                  <div style={{
                    fontWeight: 600,
                    color: 'var(--eb-text-secondary)',
                    fontSize: 'var(--eb-text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.02em',
                    margin: '0 0 var(--eb-space-1)',
                  }}>
                    {group.name} ({group.agents.length})
                  </div>
                  <ul style={{ margin: 0, padding: '0 0 0 var(--eb-space-4)' }}>
                    {group.agents.map(a => (
                      <li key={a.id} style={{ marginBottom: 'var(--eb-space-1)' }}>
                        <strong>{a.displayName}</strong>
                        <span style={{ color: 'var(--eb-text-muted)', marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
                          {a.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {/* #1501: the caller may not see every consumer of a shared
                provider, but must still be told how far the restart reaches.
                Only shown when at least one agent IS listed — otherwise
                boundAgentsLead has already said it, in the lead. */}
            {respawnPrompt.agents.length > 0 && hiddenAgentsNotice(respawnPrompt.hidden) && (
              <p style={{ margin: '0 0 var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                {hiddenAgentsNotice(respawnPrompt.hidden)}
              </p>
            )}
            {respawnError && (
              <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>
                {respawnError} — you can retry or skip.
              </p>
            )}
            <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
              If you skip this, agents will keep using the old credentials until you manually disable and re-enable them.
            </p>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
              Restarting will interrupt any agent currently mid-task — you may need to manually restart or re-trigger interrupted work afterward.
            </p>
          </div>
        )}
        confirmLabel="Restart agents"
        cancelLabel="Skip for now"
        busy={respawning}
        onConfirm={handleRespawnConfirm}
        onCancel={handleRespawnCancel}
      />

      <ConfirmDialog
        open={!!respawnFailureNotice}
        variant="danger"
        alertOnly
        title="Some agents failed to restart"
        message={respawnFailureNotice && (
          <div>
            <p style={{ marginTop: 0 }}>
              {respawnFailureLead(respawnFailureNotice.failedAgents.length, respawnFailureNotice.hiddenSkipped)}
            </p>
            <div style={{ maxHeight: 240, overflowY: 'auto', fontSize: 'var(--eb-text-sm)' }}>
              {groupAgentsByTeam(respawnFailureNotice.failedAgents).map(group => (
                <div key={group.key} style={{ marginBottom: 'var(--eb-space-2)' }}>
                  <div style={{
                    fontWeight: 600,
                    color: 'var(--eb-text-secondary)',
                    fontSize: 'var(--eb-text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.02em',
                    margin: '0 0 var(--eb-space-1)',
                  }}>
                    {group.name} ({group.agents.length})
                  </div>
                  <ul style={{ margin: 0, padding: '0 0 0 var(--eb-space-4)' }}>
                    {group.agents.map(a => (
                      <li key={a.id} style={{ marginBottom: 'var(--eb-space-1)' }}>
                        <strong>{a.displayName}</strong>
                        <span style={{ color: 'var(--eb-text-muted)', marginLeft: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
                          {a.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)' }}>
              Reopen this provider and confirm the restart prompt again to retry.
            </p>
          </div>
        )}
        onConfirm={handleRespawnFailureAck}
        onCancel={handleRespawnFailureAck}
      />
    </div>
    </>
  );
}

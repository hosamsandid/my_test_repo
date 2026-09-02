import React, { Suspense, lazy, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useParams, useSearchParams, useLocation } from 'react-router';
import Shell from './components/Shell';
import { documentTitleForPath } from './route-title';
import SetupWizard from './pages/SetupWizard';
import Login from './pages/Login';
import { useAuth } from './auth/AuthContext';
import { useHelperChat } from './context/HelperChatContext';
import { canAccessCredentialPages } from './pages/credential-scope-view';

// Getting Started was retired (#1874): its six concept cards and CTAs are now the
// Help panel's Overview face. An old bookmark should not land on a blank route, so
// the path stays as a redirect to the app home and opens the Help panel — where
// /chats, having no dedicated topic, resolves to that very Overview.
function GettingStartedRedirect() {
  const { openHelpFor } = useHelperChat();
  useEffect(() => { openHelpFor(); }, [openHelpFor]);
  return <Navigate to="/chats" replace />;
}

// The Process Canvas now lives inside Flows; preserve old deep links.
function ProcessTeamRedirect() {
  const { teamId } = useParams();
  return <Navigate to={`/flows?proc=${encodeURIComponent(teamId)}`} replace />;
}

// The Extend-team wizard flow was removed (#588) — growing a team now happens in
// the Flow Editor. Old `?mode=extend` deep links redirect there; every other
// entry into the wizard is create-mode and renders normally.
function TeamSetupRoute() {
  const [params] = useSearchParams();
  if (params.get('mode') === 'extend') {
    const team = params.get('team');
    const target = team ? `/flows?proc=${encodeURIComponent(team)}` : '/flows';
    return <Navigate to={target} replace />;
  }
  return <TeamSetup />;
}

// Route guard for System-Admin-only pages (#584 AC8): Skills, MCP, Maintenance
// Mode, Agent Templates. A non-admin who navigates directly to one of these
// URLs is bounced to /chats — the nav entries are already hidden (Shell.jsx),
// so this only catches hand-typed / bookmarked links. The API is independently
// scoped, so this is UX, not the security boundary.
function AdminRoute({ children }) {
  const { user } = useAuth();
  if (!user?.admin) return <Navigate to="/chats" replace />;
  return children;
}

// Route guard for the credential pages (SSH Keys, GitHub Tokens, #798; Model
// Providers, #800). Unlike AdminRoute these are open to any Team Admin (of ≥1
// team) as well as System Admins, so a team can self-serve its own credentials
// / model providers. A plain Team Member (or a user in no team) is bounced to
// /chats. The API is independently scoped, so this is UX, not the security
// boundary.
function CredentialRoute({ children }) {
  const { user } = useAuth();
  if (!canAccessCredentialPages(user)) return <Navigate to="/chats" replace />;
  return children;
}

const Agents              = lazy(() => import('./pages/Agents'));
const AgentChat           = lazy(() => import('./pages/AgentChat'));
const QuickStart          = lazy(() => import('./pages/QuickStart'));
const Create              = lazy(() => import('./pages/Create'));
const TeamSetup           = lazy(() => import('./pages/TeamSetup'));
const WorkingEnvironments = lazy(() => import('./pages/WorkingEnvironments'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
const GithubTokens        = lazy(() => import('./pages/GithubTokens'));
const MyCredentials       = lazy(() => import('./pages/MyCredentials'));
const SkillsRegistry      = lazy(() => import('./pages/SkillsRegistry'));
const RoleTemplates       = lazy(() => import('./pages/RoleTemplates'));
const GithubEventLog      = lazy(() => import('./pages/GithubEventLog'));
const TokenUsage          = lazy(() => import('./pages/TokenUsage'));
const ModelRegistry       = lazy(() => import('./pages/ModelRegistry'));
const McpServers          = lazy(() => import('./pages/McpServers'));
const Plugins             = lazy(() => import('./pages/Plugins'));
const PluginUiPage        = lazy(() => import('./pages/PluginUiPage'));
const MaintenanceMode     = lazy(() => import('./pages/MaintenanceMode'));
const Teams               = lazy(() => import('./pages/Teams'));
const Users               = lazy(() => import('./pages/Users'));
const Briefings           = lazy(() => import('./pages/Briefings'));
const KnowledgeFlow       = lazy(() => import('./pages/KnowledgeFlow'));
const OrchestratorWizard  = lazy(() => import('./pages/OrchestratorWizard'));
const About = lazy(() => import('./pages/About'));
const PluginSystemHelp = lazy(() => import('./pages/PluginSystemHelp'));

// Keeps the browser tab title in step with the active route so tabs, history
// and bookmarks are distinguishable (route-title.js). Renders nothing; lives
// inside the Router so useLocation is available.
function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = documentTitleForPath(pathname);
  }, [pathname]);
  return null;
}

export default function App() {
  const { loading: authLoading, authenticated } = useAuth();
  const [setupComplete, setSetupComplete] = useState(null); // null = loading

  // Setup status is itself a protected endpoint, so only probe it once the
  // user is authenticated — otherwise the request 401s and tells us nothing.
  useEffect(() => {
    if (!authenticated) {
      setSetupComplete(null);
      return;
    }
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(data => setSetupComplete(data.isComplete))
      .catch(() => setSetupComplete(true)); // on error, don't block the UI
  }, [authenticated]);

  if (authLoading) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--eb-bg-app)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
      }}>
        Loading…
      </div>
    );
  }

  // The login screen replaces the entire console until a session exists.
  if (!authenticated) {
    return <Login />;
  }

  if (setupComplete === null) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--eb-bg-app)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
      }}>
        Loading…
      </div>
    );
  }

  if (setupComplete === false) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return (
    <Shell>
      <DocumentTitle />
      <Suspense fallback={<div style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)' }}>Loading...</div>}>
        <Routes>
          <Route path="/"             element={<Navigate to="/chats" replace />} />
          <Route path="/agents"       element={<Agents />} />
          <Route path="/blueprints"   element={<Navigate to="/agents" replace />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/create"      element={<Create />} />
          <Route path="/quickstart"   element={<QuickStart />} />
          <Route path="/team-setup"   element={<TeamSetupRoute />} />
          <Route path="/wizard/team"  element={<TeamSetupRoute />} />
          <Route path="/environments" element={<WorkingEnvironments />} />
          <Route path="/ssh-keys"     element={<CredentialRoute><SshKeys /></CredentialRoute>} />
          <Route path="/github-tokens" element={<CredentialRoute><GithubTokens /></CredentialRoute>} />
          {/* Self-service personal credentials (#1568) — open to any authenticated
              human, NOT gated on credAdmin (the personal tier is owner-only). */}
          <Route path="/my-credentials" element={<MyCredentials />} />
          <Route path="/skills"       element={<SkillsRegistry />} />
          <Route path="/role-templates" element={<AdminRoute><RoleTemplates /></AdminRoute>} />
          <Route path="/github-events" element={<GithubEventLog />} />
          <Route path="/token-usage"  element={<AdminRoute><TokenUsage /></AdminRoute>} />
          <Route path="/models"       element={<CredentialRoute><ModelRegistry /></CredentialRoute>} />
          <Route path="/mcp"          element={<AdminRoute><McpServers /></AdminRoute>} />
          <Route path="/plugins"      element={<AdminRoute><Plugins /></AdminRoute>} />
          {/* A granted UI plugin is viewable by any team member with the grant —
              NOT AdminRoute-gated (the registry page is). The console proxy at
              /plugins/:id/ui and the server both re-enforce access. */}
          <Route path="/plugins/:id/view" element={<PluginUiPage />} />
          <Route path="/maintenance-mode" element={<AdminRoute><MaintenanceMode /></AdminRoute>} />
          <Route path="/teams"        element={<Teams />} />
          <Route path="/users"        element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="/flows"         element={<Briefings />} />
          <Route path="/knowledge"     element={<KnowledgeFlow />} />
          <Route path="/briefings"    element={<Navigate to="/flows" replace />} />
          <Route path="/process"      element={<Navigate to="/flows" replace />} />
          <Route path="/process/:teamId" element={<ProcessTeamRedirect />} />
          <Route path="/orchestrator-wizard" element={<OrchestratorWizard />} />
          <Route path="/getting-started" element={<GettingStartedRedirect />} />
          {/* Static explanatory help — ungated so a Team Member sees the same
              content; the Plugins registry page stays admin-only. */}
          <Route path="/plugin-system" element={<PluginSystemHelp />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

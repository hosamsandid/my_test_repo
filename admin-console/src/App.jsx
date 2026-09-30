import React, { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate, useParams, useSearchParams, useLocation } from 'react-router';
import Shell from './components/Shell';
import { RouteErrorBoundary } from './components/ErrorBoundary.js';
import { documentTitleForPath } from './route-title';
import Login from './pages/Login';
import { useAuth } from './auth/AuthContext';
import { useHelperChat } from './context/HelperChatContext';

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

const AgentChat           = lazy(() => import('./pages/AgentChat'));
const QuickStart          = lazy(() => import('./pages/QuickStart'));
const Create              = lazy(() => import('./pages/Create'));
const TeamSetup           = lazy(() => import('./pages/TeamSetup'));
const EnvironmentTemplates  = lazy(() => import('./pages/EnvironmentTemplates'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
const GithubTokens        = lazy(() => import('./pages/GithubTokens'));
const PluginTokens        = lazy(() => import('./pages/PluginTokens'));
const SkillsRegistry      = lazy(() => import('./pages/SkillsRegistry'));
const RoleTemplates       = lazy(() => import('./pages/RoleTemplates'));
const GithubEventLog      = lazy(() => import('./pages/GithubEventLog'));
const TokenUsage          = lazy(() => import('./pages/TokenUsage'));
const ModelRegistry       = lazy(() => import('./pages/ModelRegistry'));
const McpServers          = lazy(() => import('./pages/McpServers'));
const Plugins             = lazy(() => import('./pages/Plugins'));
const PluginUiPage        = lazy(() => import('./pages/PluginUiPage'));
const MaintenanceMode     = lazy(() => import('./pages/MaintenanceMode'));
const Users               = lazy(() => import('./pages/Users'));
const Briefings           = lazy(() => import('./pages/Briefings'));
const KnowledgeFlow       = lazy(() => import('./pages/KnowledgeFlow'));
const FlowControl         = lazy(() => import('./pages/FlowControl'));
const About = lazy(() => import('./pages/About'));

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

  return (
    <Shell>
      <DocumentTitle />
      {/* Error containment (#1974): the boundary sits INSIDE Shell and around
          Suspense/Routes, so a render throw in any page shows a recoverable
          card in the content area while the navigation stays usable — instead
          of unmounting the tree up to #root and blanking the page. It resets
          itself on a route change (keyed on location.pathname), so navigating
          away clears the error without a manual reload. */}
      <RouteErrorBoundary>
      <Suspense fallback={<div style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)' }}>Loading...</div>}>
        <Routes>
          <Route path="/"             element={<Navigate to="/chats" replace />} />
          {/* The Agents page was removed (#1930): everyday agent management is
              the Agent Chat rail (#1928, #1929), creation is the `/create`
              launcher (#1956), and the Orchestrator/BriefingPack half of the
              page went with the model itself (#1961). Both the route and the
              older `/blueprints` alias that used to land here stay as redirects
              so a bookmark or an old link degrades to the surface that took the
              page's job over, rather than to a blank route. */}
          <Route path="/agents"       element={<Navigate to="/chats" replace />} />
          <Route path="/blueprints"   element={<Navigate to="/chats" replace />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/create"      element={<Create />} />
          <Route path="/quickstart"   element={<QuickStart />} />
          <Route path="/team-setup"   element={<TeamSetupRoute />} />
          <Route path="/wizard/team"  element={<TeamSetupRoute />} />
          {/* The general-purpose Working Environments page was removed (#2170,
              epic #2166 A4): a team now edits its own environment from the
              Agent Chat Settings tab (A1), and the general list an ordinary
              user could browse has no successor a redirect can usefully point
              at — so, like /agents → /chats (#1930), it lands on the app home. */}
          <Route path="/environments" element={<Navigate to="/chats" replace />} />
          {/* System-Admin curated copy-source catalog that replaced the other
              half of the old page (curating a shared environment). */}
          <Route path="/environment-templates" element={<AdminRoute><EnvironmentTemplates /></AdminRoute>} />
          {/* #2360: the credential pages (SSH Keys, GitHub Tokens, Model
              Providers) are open to every authenticated user — personal
              self-service folds in; rows are filtered server-side
              (`visibleCredential` / `providerReadVisible`). */}
          <Route path="/ssh-keys"     element={<SshKeys />} />
          <Route path="/github-tokens" element={<GithubTokens />} />
          <Route path="/plugin-tokens" element={<PluginTokens />} />
          {/* The former My Credentials page folded into SSH Keys (#2360); an old
              link or bookmark lands there. */}
          <Route path="/my-credentials" element={<Navigate to="/ssh-keys" replace />} />
          <Route path="/skills"       element={<SkillsRegistry />} />
          <Route path="/role-templates" element={<AdminRoute><RoleTemplates /></AdminRoute>} />
          <Route path="/github-events" element={<GithubEventLog />} />
          <Route path="/token-usage"  element={<AdminRoute><TokenUsage /></AdminRoute>} />
          <Route path="/models"       element={<ModelRegistry />} />
          <Route path="/mcp"          element={<AdminRoute><McpServers /></AdminRoute>} />
          <Route path="/plugins"      element={<AdminRoute><Plugins /></AdminRoute>} />
          {/* A granted UI plugin is viewable by any team member with the grant —
              NOT AdminRoute-gated (the registry page is). The console proxy at
              /plugins/:id/ui and the server both re-enforce access. */}
          <Route path="/plugins/:id/view" element={<PluginUiPage />} />
          <Route path="/maintenance-mode" element={<AdminRoute><MaintenanceMode /></AdminRoute>} />
          {/* #2085 (D10): the Access page is retired, not renamed. A bookmark
              lands on the Administration surface that absorbed its two
              System-Admin halves — the `/agents` → `/chats` precedent (#1930),
              so an old deep link degrades to the page holding the content
              rather than to a blank route. `AdminRoute` on the destination is
              what handles a non-System-Admin following one (edge case 1). */}
          <Route path="/teams"        element={<Navigate to="/users" replace />} />
          <Route path="/users"        element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="/flows"         element={<Briefings />} />
          <Route path="/knowledge"     element={<KnowledgeFlow />} />
          <Route path="/flow-control"  element={<FlowControl />} />
          <Route path="/briefings"    element={<Navigate to="/flows" replace />} />
          <Route path="/process"      element={<Navigate to="/flows" replace />} />
          <Route path="/process/:teamId" element={<ProcessTeamRedirect />} />
          <Route path="/getting-started" element={<GettingStartedRedirect />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </Suspense>
      </RouteErrorBoundary>
    </Shell>
  );
}

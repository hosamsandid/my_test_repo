import React, { Suspense, lazy, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import Shell from './components/Shell';
import SetupWizard from './pages/SetupWizard';
import Login from './pages/Login';
import { useAuth } from './auth/AuthContext';

// The Process Canvas now lives inside Flows; preserve old deep links.
function ProcessTeamRedirect() {
  const { teamId } = useParams();
  return <Navigate to={`/flows?proc=${encodeURIComponent(teamId)}`} replace />;
}

const Agents              = lazy(() => import('./pages/Agents'));
const AgentChat           = lazy(() => import('./pages/AgentChat'));
const QuickStart          = lazy(() => import('./pages/QuickStart'));
const TeamSetup           = lazy(() => import('./pages/TeamSetup'));
const WorkingEnvironments = lazy(() => import('./pages/WorkingEnvironments'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
const GithubTokens        = lazy(() => import('./pages/GithubTokens'));
const SkillsRegistry      = lazy(() => import('./pages/SkillsRegistry'));
const ScheduledJobs       = lazy(() => import('./pages/ScheduledJobs'));
const GithubEventLog      = lazy(() => import('./pages/GithubEventLog'));
const ModelRegistry       = lazy(() => import('./pages/ModelRegistry'));
const McpServers          = lazy(() => import('./pages/McpServers'));
const MaintenanceMode     = lazy(() => import('./pages/MaintenanceMode'));
const Teams               = lazy(() => import('./pages/Teams'));
const Briefings           = lazy(() => import('./pages/Briefings'));
const OrchestratorWizard  = lazy(() => import('./pages/OrchestratorWizard'));
const PatternsCatalog     = lazy(() => import('./pages/PatternsCatalog'));
const SdlcCatalogPage     = lazy(() => import('./pages/SdlcCatalogPage'));
const MainframeCatalogPage = lazy(() => import('./pages/MainframeCatalogPage'));

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
      <Suspense fallback={<div style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)' }}>Loading...</div>}>
        <Routes>
          <Route path="/"             element={<Navigate to="/chats" replace />} />
          <Route path="/agents"       element={<Agents />} />
          <Route path="/blueprints"   element={<Navigate to="/agents" replace />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/quickstart"   element={<QuickStart />} />
          <Route path="/team-setup"   element={<TeamSetup />} />
          <Route path="/wizard/team"  element={<TeamSetup />} />
          <Route path="/environments" element={<WorkingEnvironments />} />
          <Route path="/ssh-keys"     element={<SshKeys />} />
          <Route path="/github-tokens" element={<GithubTokens />} />
          <Route path="/skills"       element={<SkillsRegistry />} />
          <Route path="/jobs"         element={<ScheduledJobs />} />
          <Route path="/github-events" element={<GithubEventLog />} />
          <Route path="/models"       element={<ModelRegistry />} />
          <Route path="/mcp"          element={<McpServers />} />
          <Route path="/maintenance-mode" element={<MaintenanceMode />} />
          <Route path="/teams"        element={<Teams />} />
          <Route path="/flows"         element={<Briefings />} />
          <Route path="/briefings"    element={<Navigate to="/flows" replace />} />
          <Route path="/process"      element={<Navigate to="/flows" replace />} />
          <Route path="/process/:teamId" element={<ProcessTeamRedirect />} />
          <Route path="/orchestrator-wizard" element={<OrchestratorWizard />} />
          <Route path="/patterns"           element={<PatternsCatalog />} />
          <Route path="/patterns/sdlc"      element={<SdlcCatalogPage />} />
          <Route path="/patterns/mainframe" element={<MainframeCatalogPage />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

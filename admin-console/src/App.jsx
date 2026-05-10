import React, { Suspense, lazy, useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell';
import SetupWizard from './pages/SetupWizard';

const Dashboard           = lazy(() => import('./pages/Dashboard'));
const Agents              = lazy(() => import('./pages/Agents'));
const AgentChat           = lazy(() => import('./pages/AgentChat'));
const QuickStart          = lazy(() => import('./pages/QuickStart'));
const TeamSetup           = lazy(() => import('./pages/TeamSetup'));
const WorkingEnvironments = lazy(() => import('./pages/WorkingEnvironments'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
const GithubTokens        = lazy(() => import('./pages/GithubTokens'));
const SkillsRegistry      = lazy(() => import('./pages/SkillsRegistry'));
const ScheduledJobs       = lazy(() => import('./pages/ScheduledJobs'));
const ModelRegistry       = lazy(() => import('./pages/ModelRegistry'));
const McpServers          = lazy(() => import('./pages/McpServers'));
const Briefings           = lazy(() => import('./pages/Briefings'));

export default function App() {
  const [setupComplete, setSetupComplete] = useState(null); // null = loading

  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(data => setSetupComplete(data.isComplete))
      .catch(() => setSetupComplete(true)); // on error, don't block the UI
  }, []);

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
          <Route path="/"             element={<Dashboard />} />
          <Route path="/agents"       element={<Agents />} />
          <Route path="/blueprints"   element={<Navigate to="/agents" replace />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/quickstart"   element={<QuickStart />} />
          <Route path="/team-setup"   element={<TeamSetup />} />
          <Route path="/environments" element={<WorkingEnvironments />} />
          <Route path="/ssh-keys"     element={<SshKeys />} />
          <Route path="/github-tokens" element={<GithubTokens />} />
          <Route path="/skills"       element={<SkillsRegistry />} />
          <Route path="/jobs"         element={<ScheduledJobs />} />
          <Route path="/models"       element={<ModelRegistry />} />
          <Route path="/mcp"          element={<McpServers />} />
          <Route path="/flows"         element={<Briefings />} />
          <Route path="/briefings"    element={<Navigate to="/flows" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

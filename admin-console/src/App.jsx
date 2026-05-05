import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell';

const Dashboard           = lazy(() => import('./pages/Dashboard'));
const Agents              = lazy(() => import('./pages/Agents'));
const AgentChat           = lazy(() => import('./pages/AgentChat'));
const WorkingEnvironments = lazy(() => import('./pages/WorkingEnvironments'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
const GithubTokens        = lazy(() => import('./pages/GithubTokens'));
const SkillsRegistry      = lazy(() => import('./pages/SkillsRegistry'));
const ScheduledJobs       = lazy(() => import('./pages/ScheduledJobs'));
const ModelRegistry       = lazy(() => import('./pages/ModelRegistry'));
const McpServers          = lazy(() => import('./pages/McpServers'));
const KnowledgeBase       = lazy(() => import('./pages/KnowledgeBase'));
const Logs                = lazy(() => import('./pages/Logs'));

export default function App() {
  return (
    <Shell>
      <Suspense fallback={<div style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)' }}>Loading...</div>}>
        <Routes>
          <Route path="/"             element={<Dashboard />} />
          <Route path="/agents"       element={<Agents />} />
          <Route path="/blueprints"   element={<Navigate to="/agents" replace />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/environments" element={<WorkingEnvironments />} />
          <Route path="/ssh-keys"     element={<SshKeys />} />
          <Route path="/github-tokens" element={<GithubTokens />} />
          <Route path="/skills"       element={<SkillsRegistry />} />
          <Route path="/jobs"         element={<ScheduledJobs />} />
          <Route path="/models"       element={<ModelRegistry />} />
          <Route path="/mcp"          element={<McpServers />} />
          <Route path="/knowledge"    element={<KnowledgeBase />} />
          <Route path="/logs"         element={<Logs />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

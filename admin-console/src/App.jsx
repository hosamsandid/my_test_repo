import React, { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Shell from './components/Shell';

const Dashboard           = lazy(() => import('./pages/Dashboard'));
const AgentManager        = lazy(() => import('./pages/AgentManager'));
const AgentChat           = lazy(() => import('./pages/AgentChat'));
const WorkingEnvironments = lazy(() => import('./pages/WorkingEnvironments'));
const SshKeys             = lazy(() => import('./pages/SshKeys'));
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
          <Route path="/agents"       element={<AgentManager />} />
          <Route path="/chats"           element={<AgentChat />} />
          <Route path="/chats/:agentId"  element={<AgentChat />} />
          <Route path="/environments" element={<WorkingEnvironments />} />
          <Route path="/ssh-keys"     element={<SshKeys />} />
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

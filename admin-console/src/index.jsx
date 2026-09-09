import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MaintenanceModeProvider } from './context/MaintenanceModeContext';
import { ModelSelectionProvider } from './context/ModelSelectionContext';
import { AgentStatusesProvider } from './context/AgentStatusesContext.jsx';
import { TranscriptionSessionProvider } from './context/TranscriptionSessionContext.jsx';
import { HelperChatProvider } from './context/HelperChatContext.jsx';
import { FlowCopilotProvider } from './context/FlowCopilotContext.jsx';
import './theme/tokens.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <ModelSelectionProvider>
        <MaintenanceModeProvider>
          {/* Shared agent-status poll (#1677): one /api/agents/statuses request
              per interval feeds the Shell badge, Agent-Chat list and
              Maintenance Mode. */}
          <AgentStatusesProvider>
            {/* Meeting Note-Taker session (#1296): mounted above the router so the
                mic + segment loop survive all client-side navigation. */}
            <TranscriptionSessionProvider>
              {/* Helper Chat (#1735): app-level so the help panel + its
                  conversation survive all client-side navigation. */}
              <HelperChatProvider>
                {/* Flow Copilot turn (#2087): app-level so a running turn — and
                    the proposal it produces — survives route navigation, closing
                    the Copilot panel and switching flow. */}
                <FlowCopilotProvider>
                  <App />
                </FlowCopilotProvider>
              </HelperChatProvider>
            </TranscriptionSessionProvider>
          </AgentStatusesProvider>
        </MaintenanceModeProvider>
      </ModelSelectionProvider>
    </AuthProvider>
  </BrowserRouter>
);

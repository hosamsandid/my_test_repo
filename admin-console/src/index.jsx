import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MaintenanceModeProvider } from './context/MaintenanceModeContext';
import { ModelSelectionProvider } from './context/ModelSelectionContext';
import { AgentStatusesProvider } from './context/AgentStatusesContext.jsx';
import { AgentBackNotificationProvider } from './context/AgentBackNotificationContext.jsx';
import { TranscriptionSessionProvider } from './context/TranscriptionSessionContext.jsx';
import { HelperChatProvider } from './context/HelperChatContext.jsx';
import { FlowCopilotProvider } from './context/FlowCopilotContext.jsx';
import {
  RELOAD_MARK_KEY,
  isStaleChunkError,
  shouldReloadForChunkError,
} from './stale-chunk-reload.js';
import './theme/tokens.css';

// Auto-recover a tab left open across a server redeploy (see
// ./stale-chunk-reload.js). A page whose lazy chunk hash no longer exists would
// otherwise crash opaquely; one guarded reload re-fetches the current build.
(function installStaleChunkReload(win) {
  if (!win) return;
  const recover = (reason, { forced = false } = {}) => {
    if (!forced && !isStaleChunkError(reason)) return;
    let ss = null;
    try { ss = win.sessionStorage; } catch { /* private mode / disabled */ }
    let last = 0;
    try { last = Number(ss?.getItem(RELOAD_MARK_KEY)) || 0; } catch { /* ignore */ }
    if (!shouldReloadForChunkError({ now: Date.now(), lastReloadAt: last })) return;
    try { ss?.setItem(RELOAD_MARK_KEY, String(Date.now())); } catch { /* ignore */ }
    win.location.reload();
  };
  // Vite's dedicated signal: the payload IS the chunk error, so recover
  // unconditionally (preventDefault stops Vite re-throwing it into the console).
  win.addEventListener('vite:preloadError', (e) => {
    e.preventDefault?.();
    recover(e?.payload, { forced: true });
  });
  // Browsers that don't emit the Vite event still reject the import; match on
  // the message so unrelated rejections never trigger a reload.
  win.addEventListener('unhandledrejection', (e) => recover(e?.reason));
})(typeof window !== 'undefined' ? window : null);

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <ModelSelectionProvider>
        <MaintenanceModeProvider>
            {/* Shared agent-status poll (#1677): one /api/agents/statuses request
                per interval feeds the Shell badge, Agent-Chat list and
                Maintenance Mode. */}
            <AgentStatusesProvider>
             {/* "Agent you messaged is back" browser notification (#2397): reads
                 the shared status poll above, survives navigation, and routes to
                 the agent on a notification click. */}
             <AgentBackNotificationProvider>
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
             </AgentBackNotificationProvider>
            </AgentStatusesProvider>
        </MaintenanceModeProvider>
      </ModelSelectionProvider>
    </AuthProvider>
  </BrowserRouter>
);

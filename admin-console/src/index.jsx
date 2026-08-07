import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MaintenanceModeProvider } from './context/MaintenanceModeContext';
import { ModelSelectionProvider } from './context/ModelSelectionContext';
import { TranscriptionSessionProvider } from './context/TranscriptionSessionContext.jsx';
import './theme/tokens.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <ModelSelectionProvider>
        <MaintenanceModeProvider>
          {/* Meeting Note-Taker session (#1296): mounted above the router so the
              mic + segment loop survive all client-side navigation. */}
          <TranscriptionSessionProvider>
            <App />
          </TranscriptionSessionProvider>
        </MaintenanceModeProvider>
      </ModelSelectionProvider>
    </AuthProvider>
  </BrowserRouter>
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MaintenanceModeProvider } from './context/MaintenanceModeContext';
import { ModelSelectionProvider } from './context/ModelSelectionContext';
import './theme/tokens.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <ModelSelectionProvider>
        <MaintenanceModeProvider>
          <App />
        </MaintenanceModeProvider>
      </ModelSelectionProvider>
    </AuthProvider>
  </BrowserRouter>
);

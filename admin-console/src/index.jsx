import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MaintenanceModeProvider } from './context/MaintenanceModeContext';
import './theme/tokens.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <MaintenanceModeProvider>
        <App />
      </MaintenanceModeProvider>
    </AuthProvider>
  </BrowserRouter>
);

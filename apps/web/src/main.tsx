/**
 * Entry point.
 *
 * Provider order matters:
 *   ToastProvider wraps SessionProvider so a session failure can raise a toast;
 *   SessionProvider wraps the router so route guards can read the session;
 *   BrowserRouter wraps everything else so navigation is available to both.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { SessionProvider } from './lib/session.js';
import { ToastProvider } from './components/toast.js';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </ToastProvider>
  </StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { SessionProvider } from './session.js';
const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <SessionProvider><App /></SessionProvider>
    </React.StrictMode>
  );
}

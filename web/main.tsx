import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { hydrateClientStore } from './clientStore';
import './styles.css';

// Load persisted client state from the server before rendering, then import the
// app — its store modules read the (now-hydrated) cache synchronously at import.
void hydrateClientStore().then(async () => {
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

import { Component, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getState, initStore } from './lib/store';
import { downloadBackup } from './ui/downloadBackup';
import './styles.css';

// The router restores scroll positions itself (see router.ts).
history.scrollRestoration = 'manual';

/**
 * What is left when the app can't be drawn. An app opened from the Home Screen
 * has no reload button of its own, and whatever broke it, the data is worth
 * getting out first.
 */
function Crashed() {
  return (
    <div className="empty" role="alert">
      <h1>Something went wrong</h1>
      <p>The app ran into a problem it couldn't get past. Reload to try again; if it keeps happening, download a backup first, so there is a copy of what you logged.</p>
      <button className="btn btn-primary btn-inline" onClick={() => window.location.reload()}>Reload</button>
      <button className="btn btn-tinted btn-inline" onClick={() => downloadBackup(getState())}>Download Backup</button>
    </div>
  );
}

/** Without one of these, React answers an error in any screen by removing the whole page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <Crashed /> : this.props.children;
  }
}

const root = createRoot(document.getElementById('root')!);

void initStore()
  .then(() => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  })
  .catch(() => root.render(<Crashed />));

// Keeps a copy of the app in the browser so it opens without a connection.
// Browsers only allow this on https and on localhost.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}

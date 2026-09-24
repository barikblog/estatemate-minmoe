import { Component, ErrorInfo, ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

interface BoundaryState { error: Error | null }

// Catches render-time errors so a bug never leaves the user with a blank page.
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('EstateMate UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" style={{ maxWidth: 520, margin: '12vh auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: '#475569', marginBottom: 16 }}>
          The page hit an unexpected error. Reload to try again. If it keeps happening, send the message below to your administrator.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f1f5f9', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          {this.state.error.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 18px', borderRadius: 8, border: 0, background: '#1769e0', color: '#fff', cursor: 'pointer' }}>
          Reload page
        </button>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

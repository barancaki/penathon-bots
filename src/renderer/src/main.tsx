import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './manage.css';
import './projects.css';
import './routines.css';
import './rooms.css';
import './telegram.css';

async function start() {
  // Outside Electron (design review in a plain browser) there is no preload bridge.
  if (import.meta.env.DEV && !('api' in window)) {
    const { mockApi } = await import('./dev/mock-api');
    Object.assign(window, { api: mockApi });
  }
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();

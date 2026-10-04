import { render } from 'preact';
import { App } from './app';
import { initI18n } from './i18n';
import { initMonitoring } from './ui/monitoring';
import { registerServiceWorker } from './ui/pwa/register';
import './ui/fonts.css';
import './ui/tokens.css';
import './ui/base.css';
import './ui/ui.css';

async function start(): Promise<void> {
  initMonitoring();
  // Arabic is bundled; another saved language is loaded (from the precache when offline) before the first paint.
  await initI18n();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app element');
  root.textContent = '';
  render(<App />, root);
  // After the first render: registration must never delay the application.
  registerServiceWorker().catch(() => undefined);
}

void start();

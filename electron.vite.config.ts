import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: {
    server: { host: 'localhost' },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'dev-csp',
        transformIndexHtml: (html, context) =>
          context.server
            ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            : html,
      },
    ],
  },
});

import { defineConfig } from 'vite';

// Tauri loads the dev server at a fixed port and embeds `dist/` in the packaged app.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext' },
});

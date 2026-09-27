import { defineConfig } from 'vite';

// Relative base so the build works from any path (required for YouTube Playables).
export default defineConfig({
  base: './',
  // Marketing assets are generated into the repo; never watch them (large PNG writes crash the watcher on Windows).
  server: { watch: { ignored: ['**/marketing/**', '**/youtube-playables-*/**'] } },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});

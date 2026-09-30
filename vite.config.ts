import { defineConfig } from 'vite';

// Web portals must not load the YouTube SDK: its mute state can disable audio there.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'playables' ? [{
    name: 'playables-sdk',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('<!-- PLAYABLES_SDK -->', '<script src="https://www.youtube.com/game_api/v1"></script>');
      },
    },
  }] : [],
  // Marketing assets are generated into the repo; never watch them (large PNG writes crash the watcher on Windows).
  server: { watch: { ignored: ['**/marketing/**', '**/youtube-playables-*/**'] } },
  build: {
    outDir: mode === 'playables' ? 'dist-playables' : 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
}));

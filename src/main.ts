import './style.css';
import { Game } from './game';
import { Platform } from './platform/youtube';
import { parseSave } from './save';

const platform = new Platform();

window.addEventListener('error', () => platform.logError());
window.addEventListener('unhandledrejection', () => platform.logWarning());

async function boot(): Promise<void> {
  // Start loading the save right away; it's tiny and needed before the first run.
  const savePromise = Promise.race([
    platform.loadRaw(),
    new Promise<string>((r) => setTimeout(() => r(''), 3000)),
  ]);

  const game = new Game(document.getElementById('app')!, platform);
  if (!platform.inPlayables && new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { __game: Game }).__game = game; // local testing hook only
  }

  platform.bindSystemEvents({
    onPause: () => game.setPaused(true),
    onResume: () => game.setPaused(false),
    onAudioEnabled: (enabled) => game.audio.setPlatformEnabled(enabled),
  });
  // Local/dev fallback for tab switching (YouTube sends onPause/onResume itself).
  if (!platform.inPlayables) {
    document.addEventListener('visibilitychange', () => game.setPaused(document.hidden));
  }

  // First visible game frame.
  game.renderOnce();
  document.getElementById('boot')?.remove();
  platform.firstFrameReady();

  game.applySave(parseSave(await savePromise));

  requestAnimationFrame((t) => {
    game.frame(t);
    // Scene is rendered and input is live: the player can interact now.
    platform.gameReady();
  });
}

void boot();

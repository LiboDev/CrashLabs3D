/**
 * Thin platform adapter. All `ytgame` access goes through here so the game
 * core runs identically on localhost and inside YouTube Playables.
 */

const SAVE_KEY = 'CRASH_LAB_SAVE';

export class Platform {
  readonly inPlayables: boolean =
    typeof ytgame !== 'undefined' && !!ytgame && ytgame.IN_PLAYABLES_ENV === true;

  /** Dev-only: `?fakeads=1` simulates successful rewarded ads outside Playables. */
  readonly fakeAds: boolean =
    !this.inPlayables && new URLSearchParams(location.search).has('fakeads');

  private firstFrameSent = false;
  private gameReadySent = false;

  get adsAvailable(): boolean {
    return this.inPlayables || this.fakeAds;
  }

  firstFrameReady(): void {
    if (this.firstFrameSent) return;
    this.firstFrameSent = true;
    if (this.inPlayables) ytgame!.game.firstFrameReady();
  }

  gameReady(): void {
    if (this.gameReadySent) return;
    this.firstFrameReady(); // guarantee ordering
    this.gameReadySent = true;
    if (this.inPlayables) ytgame!.game.gameReady();
  }

  bindSystemEvents(opts: {
    onPause: () => void;
    onResume: () => void;
    onAudioEnabled: (enabled: boolean) => void;
  }): void {
    if (!this.inPlayables) {
      opts.onAudioEnabled(true);
      return;
    }
    try {
      opts.onAudioEnabled(ytgame!.system.isAudioEnabled());
      ytgame!.system.onAudioEnabledChange(opts.onAudioEnabled);
      ytgame!.system.onPause(opts.onPause);
      ytgame!.system.onResume(opts.onResume);
    } catch {
      opts.onAudioEnabled(false);
    }
  }

  async loadRaw(): Promise<string> {
    try {
      if (this.inPlayables) return (await ytgame!.game.loadData()) ?? '';
      return localStorage.getItem(SAVE_KEY) ?? '';
    } catch {
      return '';
    }
  }

  async saveRaw(raw: string): Promise<void> {
    try {
      if (this.inPlayables) await ytgame!.game.saveData(raw);
      else localStorage.setItem(SAVE_KEY, raw);
    } catch {
      this.logWarning();
    }
  }

  async sendScore(value: number): Promise<void> {
    if (!this.inPlayables) return;
    const v = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
    try {
      await ytgame!.engagement.sendScore({ value: v });
    } catch {
      // Score submission must never block play.
    }
  }

  /** Resolves true only when the reward was actually earned. */
  async rewarded(rewardId: string): Promise<boolean> {
    if (this.fakeAds) {
      await new Promise((r) => setTimeout(r, 600));
      return true;
    }
    if (!this.inPlayables) return false;
    try {
      return (await ytgame!.ads.requestRewardedAd(rewardId)) === true;
    } catch {
      return false;
    }
  }

  logError(): void {
    try {
      if (this.inPlayables) ytgame!.health.logError();
    } catch {
      /* best effort */
    }
  }

  logWarning(): void {
    try {
      if (this.inPlayables) ytgame!.health.logWarning();
    } catch {
      /* best effort */
    }
  }
}

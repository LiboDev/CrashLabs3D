// Minimal typings for the subset of the YouTube Playables SDK (ytgame) used by Crash Lab.
// Reconcile against https://developers.google.com/youtube/gaming/playables/reference/sdk
export {};

declare global {
  // eslint-disable-next-line no-var
  var ytgame:
    | {
        IN_PLAYABLES_ENV: boolean;
        game: {
          firstFrameReady(): void;
          gameReady(): void;
          loadData(): Promise<string>;
          saveData(data: string): Promise<void>;
        };
        system: {
          isAudioEnabled(): boolean;
          onAudioEnabledChange(cb: (enabled: boolean) => void): () => void;
          onPause(cb: () => void): () => void;
          onResume(cb: () => void): () => void;
          getLanguage(): Promise<string>;
        };
        engagement: {
          sendScore(score: { value: number }): Promise<void>;
        };
        ads: {
          requestInterstitialAd(): Promise<void>;
          requestRewardedAd(rewardId: string): Promise<boolean>;
        };
        health: {
          logError(): void;
          logWarning(): void;
        };
      }
    | undefined;
}

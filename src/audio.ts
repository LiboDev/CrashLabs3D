/**
 * Procedural Web Audio engine (no audio files, zero download cost).
 *
 * Mix graph:
 *   music voices -> musicIn -> musicFilter -> musicDuck -> musicVol -+
 *   pad/bass     -> pump (sidechain) -> musicIn                     |
 *   leads        -> delay (dotted 8th) -> musicIn                   +-> master -> glue comp -> limiter -> out
 *   sfx voices   -> [panner] -> sfx bus ---------------------------+
 *   ui voices    -> ui bus -----------------------------------------+
 *   sends        -> reverb (generated IR) ------------------------- +
 *
 * YouTube mute and game pause gate the master; nothing in-game overrides a YouTube mute.
 */
export type Material = 'wood' | 'metal' | 'glass' | 'concrete' | 'plastic';
export type PowerSfx = 'speed' | 'bomb' | 'flame';
type MusicMode = 'menu' | 'play' | 'end';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const semis = (s: number) => Math.pow(2, s / 12);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// i - VI - III - VII in A minor: Am  F  C  G
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [55, 60, 64],
  [55, 59, 62],
];
const ROOTS = [33, 29, 36, 31];
// Four-bar hook (16th-note grid, 0 = rest).
const MELODY = [
  [76, 0, 0, 74, 0, 0, 72, 0, 74, 0, 76, 0, 0, 0, 0, 0],
  [72, 0, 0, 72, 0, 0, 74, 0, 76, 0, 74, 0, 72, 0, 0, 0],
  [79, 0, 0, 76, 0, 0, 74, 0, 76, 0, 79, 0, 81, 0, 0, 0],
  [74, 0, 0, 71, 0, 0, 74, 0, 79, 0, 0, 0, 76, 0, 74, 0],
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];

interface Loop {
  stop: () => void;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private musicIn!: GainNode;
  private pump!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private musicDuck!: GainNode;
  private delayIn!: GainNode;
  private delay!: DelayNode;
  private revSend!: GainNode;
  private noise!: AudioBuffer;

  private flameLoop: Loop | null = null;
  private windLoop: Loop | null = null;

  private platformEnabled = true;
  private userMuted = false;
  private paused = false;
  private hitT = 0;
  private hitN = 0;
  private tingT = 0;
  private tingChain = 0;

  // Music state
  private mode: MusicMode = 'menu';
  private level = 0;
  private targetLevel = 0;
  private crashPending = false;
  private step = 0;
  private bar = 0;
  private nextTime = 0;
  private bpm = 118;

  // ------------------------------------------------------------------ lifecycle
  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.build();
      this.setMusicMode(this.mode);
      this.nextTime = this.ctx.currentTime + 0.1;
      window.setInterval(() => this.schedule(), 25);
    }
    this.applyState();
  }

  setPlatformEnabled(enabled: boolean): void {
    this.platformEnabled = enabled;
    this.applyState();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyState();
  }

  /** In-game mute. Unmuting can never override YouTube's mute (both must allow audio). */
  setUserMuted(muted: boolean): void {
    this.userMuted = muted;
    this.applyState();
  }

  private get audible(): boolean {
    return this.platformEnabled && !this.userMuted && !this.paused;
  }

  private applyState(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.setTargetAtTime(this.audible ? 1 : 0, ctx.currentTime, 0.03);
    if (this.audible) {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    } else if (ctx.state === 'running') {
      setTimeout(() => {
        if (!this.audible && ctx.state === 'running') void ctx.suspend().catch(() => {});
      }, 150);
    }
  }

  private ready(): boolean {
    // A start cue scheduled during resume will play as soon as the context runs.
    return !!this.ctx && this.audible && this.ctx.state !== 'closed';
  }

  private get now(): number {
    return this.ctx!.currentTime + 0.004;
  }

  // ------------------------------------------------------------------ graph
  private build(): void {
    const c = this.ctx!;
    this.master = c.createGain();
    this.master.gain.value = 0;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.22;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    this.master.connect(glue);
    glue.connect(lim);
    lim.connect(c.destination);

    this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Reverb: generated stereo impulse response (bright, ~1.8 s tail).
    const rev = c.createConvolver();
    const len = Math.floor(c.sampleRate * 1.8);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.55 - t * 0.4);
        d[i] = lp * Math.pow(1 - t, 2.6) * (i < 60 ? i / 60 : 1);
      }
    }
    rev.buffer = ir;
    this.revSend = c.createGain();
    const revRet = c.createGain();
    revRet.gain.value = 0.35;
    this.revSend.connect(rev);
    rev.connect(revRet);
    revRet.connect(this.master);

    // Buses — SFX sit a little under the music so chaos doesn't overwhelm.
    this.sfx = c.createGain();
    this.sfx.gain.value = 0.42;
    this.sfx.connect(this.master);
    const sfxRev = c.createGain();
    sfxRev.gain.value = 0.18;
    this.sfx.connect(sfxRev);
    sfxRev.connect(this.revSend);

    this.ui = c.createGain();
    this.ui.gain.value = 0.4;
    this.ui.connect(this.master);
    const uiRev = c.createGain();
    uiRev.gain.value = 0.25;
    this.ui.connect(uiRev);
    uiRev.connect(this.revSend);

    // Music chain
    this.musicIn = c.createGain();
    this.musicFilter = c.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 1400;
    this.musicFilter.Q.value = 0.9;
    this.musicDuck = c.createGain();
    const musicVol = c.createGain();
    musicVol.gain.value = 0.34;
    this.musicIn.connect(this.musicFilter);
    this.musicFilter.connect(this.musicDuck);
    this.musicDuck.connect(musicVol);
    musicVol.connect(this.master);
    const musicRev = c.createGain();
    musicRev.gain.value = 0.12;
    musicVol.connect(musicRev);
    musicRev.connect(this.revSend);

    this.pump = c.createGain();
    this.pump.connect(this.musicIn);

    this.delayIn = c.createGain();
    this.delay = c.createDelay(1.5);
    const fb = c.createGain();
    fb.gain.value = 0.32;
    const fbLp = c.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 2800;
    const delOut = c.createGain();
    delOut.gain.value = 0.28;
    this.delayIn.connect(this.delay);
    this.delay.connect(fbLp);
    fbLp.connect(fb);
    fb.connect(this.delay);
    fbLp.connect(delOut);
    delOut.connect(this.musicIn);

  }

  // ------------------------------------------------------------------ voice helpers
  private out(bus: AudioNode, pan = 0, gain = 1): GainNode {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.value = gain;
    if (pan !== 0 && typeof c.createStereoPanner === 'function') {
      const p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(bus);
    } else g.connect(bus);
    return g;
  }

  private env(p: AudioParam, t: number, peak: number, a: number, d: number): void {
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, out: AudioNode, a = 0.002, detune = 0): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + a + dur);
    if (detune) o.detune.value = detune;
    const g = c.createGain();
    this.env(g.gain, t, peak, a, dur);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + a + dur + 0.03);
  }

  private hiss(t: number, dur: number, peak: number, out: AudioNode, type: BiquadFilterType, f0: number, f1 = f0, q = 1, a = 0.002): void {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + dur);
    const g = c.createGain();
    this.env(g.gain, t, peak, a, dur);
    s.connect(f);
    f.connect(g);
    g.connect(out);
    s.start(t, Math.random() * 1.8);
    s.stop(t + a + dur + 0.03);
  }

  /** Filtered (optionally detuned) oscillator stack with a filter sweep. */
  private synth(t: number, notes: number[], type: OscillatorType, dur: number, peak: number, out: AudioNode, f0: number, f1: number, a = 0.004, q = 1, spread = 0): void {
    const c = this.ctx!;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + a + dur);
    const g = c.createGain();
    this.env(g.gain, t, peak, a, dur);
    f.connect(g);
    g.connect(out);
    for (const n of notes) {
      for (const dt of spread ? [-spread, spread] : [0]) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = mtof(n);
        o.detune.value = dt;
        o.connect(f);
        o.start(t);
        o.stop(t + a + dur + 0.03);
      }
    }
  }

  duck(depth: number, hold: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.musicDuck.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(depth, t, 0.02);
    g.setTargetAtTime(1, t + hold, 0.3);
  }

  // ------------------------------------------------------------------ loops
  private noiseLoop(bp: number, q: number, level: number, lfoRate: number, lfoDepth: number, crackle: boolean): Loop {
    const c = this.ctx!;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = bp;
    f.Q.value = q;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = bp * 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.12);
    const lfo = c.createOscillator();
    lfo.frequency.value = lfoRate;
    const lg = c.createGain();
    lg.gain.value = lfoDepth;
    lfo.connect(lg);
    lg.connect(f.frequency);
    const lfo2 = c.createOscillator();
    lfo2.frequency.value = lfoRate * 0.61;
    const lg2 = c.createGain();
    lg2.gain.value = level * 0.3;
    lfo2.connect(lg2);
    lg2.connect(g.gain);
    s.connect(f);
    f.connect(lp);
    lp.connect(g);
    g.connect(this.sfx);
    s.start(t, Math.random());
    lfo.start(t);
    lfo2.start(t);
    let iv: number | null = null;
    if (crackle) {
      iv = window.setInterval(() => {
        if (this.ready() && Math.random() < 0.55) this.hiss(this.now, rand(0.008, 0.025), rand(0.05, 0.12), this.sfx, 'highpass', rand(2500, 5000));
      }, 45);
    }
    return {
      stop: () => {
        const t2 = c.currentTime;
        g.gain.cancelScheduledValues(t2);
        g.gain.setTargetAtTime(0.0001, t2, 0.08);
        for (const n of [s, lfo, lfo2]) n.stop(t2 + 0.4);
        if (iv !== null) clearInterval(iv);
      },
    };
  }

  setFlame(on: boolean): void {
    if (!this.ctx) return;
    if (on && !this.flameLoop) {
      this.flameLoop = this.noiseLoop(850, 0.6, 0.2, 9, 380, true);
      if (this.ready()) {
        const t = this.now;
        this.hiss(t, 0.4, 0.4, this.sfx, 'lowpass', 200, 2600, 0.8, 0.03);
        this.tone(t, 'sine', 55, 110, 0.3, 0.3, this.sfx);
      }
    } else if (!on && this.flameLoop) {
      this.flameLoop.stop();
      this.flameLoop = null;
    }
  }

  setWind(on: boolean): void {
    if (!this.ctx) return;
    if (on && !this.windLoop) this.windLoop = this.noiseLoop(1500, 0.8, 0.12, 0.8, 700, false);
    else if (!on && this.windLoop) {
      this.windLoop.stop();
      this.windLoop = null;
    }
  }

  stopLoops(): void {
    this.setFlame(false);
    this.setWind(false);
  }

  // ------------------------------------------------------------------ gameplay SFX
  /** size01: 0 (cone) .. 1 (tower). pan: -1..1 screen position. */
  impact(mat: Material, size01: number, pan = 0): void {
    if (!this.ready()) return;
    const t = this.now;
    if (t - this.hitT > 0.05) {
      this.hitT = t;
      this.hitN = 0;
    }
    if (++this.hitN > 5) return; // voice limiting
    const p = semis(rand(-2, 2)) * (1.25 - size01 * 0.55);
    const o = this.out(this.sfx, pan * 0.7, 0.9);
    const big = size01 > 0.5;
    switch (mat) {
      case 'wood':
        this.tone(t, 'triangle', 210 * p, 90 * p, 0.09, 0.32, o);
        this.hiss(t, 0.07, 0.35, o, 'bandpass', 1100 * p, 700 * p, 1.6);
        this.hiss(t, 0.012, 0.2, o, 'highpass', 4500);
        break;
      case 'plastic':
        this.tone(t, 'sine', 620 * p, 250 * p, 0.06, 0.28, o);
        this.hiss(t, 0.05, 0.2, o, 'bandpass', 2300 * p, 1500 * p, 3);
        break;
      case 'metal': {
        const f = 330 * p;
        const parts: Array<[number, number, number]> = [[1, 0.16, 0.35], [2.76, 0.09, 0.25], [5.4, 0.05, 0.16], [8.93, 0.025, 0.1]];
        for (const [m, g, d] of parts) this.tone(t, 'sine', f * m, f * m * 0.99, d * (1 + size01), g, o);
        this.hiss(t, 0.04, 0.22, o, 'highpass', 3200);
        this.tone(t, 'sine', 120 * p, 55 * p, 0.12, 0.35, o);
        break;
      }
      case 'glass':
        this.hiss(t, 0.25 * (1 + size01), 0.28, o, 'highpass', 5200, 3500);
        this.hiss(t, 0.12, 0.14, o, 'bandpass', 8000, 6000, 4);
        for (let i = 0; i < 6; i++) this.tone(t + rand(0, 0.2), 'sine', rand(2600, 6200) * p, rand(2000, 5000), rand(0.05, 0.12), 0.045, o);
        this.tone(t, 'sine', 90, 45, 0.25, 0.3, o);
        break;
      case 'concrete':
        this.hiss(t, 0.35 + size01 * 0.4, 0.45, o, 'lowpass', 1500, 180, 0.8);
        this.tone(t, 'sine', 85 * p, 34, 0.25 + size01 * 0.25, 0.5, o);
        for (let i = 0; i < 4; i++) this.hiss(t + rand(0.03, 0.32), 0.05, 0.12, o, 'bandpass', rand(400, 1300), rand(300, 900), 2);
        break;
    }
    if (big) this.tone(t, 'sine', 70, 30, 0.35, 0.35, o);
  }

  /** Extra chime layered on gold objects / capped-out smashes. */
  sparkle(level = 0): void {
    if (!this.ready()) return;
    const t = this.now;
    const base = 84 + level * 2;
    [0, 4, 7, 12].forEach((s, i) => this.tone(t + i * 0.035, 'sine', mtof(base + s), mtof(base + s), 0.22, 0.05, this.ui));
    this.hiss(t, 0.18, 0.05, this.ui, 'highpass', 8000);
  }

  /** Scrap orb collected: rising pentatonic ting chain. */
  scrapTing(): void {
    if (!this.ready()) return;
    const t = this.now;
    if (t - this.tingT < 0.04) return;
    this.tingChain = t - this.tingT < 0.4 ? Math.min(this.tingChain + 1, PENTA.length - 1) : 0;
    this.tingT = t;
    const f = mtof(81 + PENTA[this.tingChain]);
    this.tone(t, 'sine', f, f, 0.12, 0.045, this.ui);
    this.tone(t, 'triangle', f * 2, f * 2, 0.05, 0.015, this.ui);
  }

  /** Combo multiplier went up (level 1..4). */
  combo(level: number): void {
    if (!this.ready()) return;
    const t = this.now;
    const root = 69 + level * 2;
    this.synth(t, [root, root + 4, root + 7, root + 12], 'sawtooth', 0.28, 0.06, this.ui, 5000, 1200, 0.004, 2, 8);
    this.tone(t, 'sine', mtof(root + 12), mtof(root + 24), 0.14, 0.06, this.ui);
    this.hiss(t, 0.16, 0.06, this.ui, 'highpass', 7500);
  }

  blocked(pan = 0): void {
    if (!this.ready()) return;
    const t = this.now;
    const o = this.out(this.sfx, pan * 0.6);
    this.tone(t, 'sine', 420, 140, 0.09, 0.25, o);
    this.tone(t, 'triangle', 130, 60, 0.16, 0.28, o);
    this.hiss(t, 0.1, 0.25, o, 'lowpass', 600, 200);
  }

  nearMiss(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.hiss(t, 0.2, 0.12, this.sfx, 'bandpass', 1800, 6500, 2, 0.02);
    this.tone(t + 0.05, 'sine', 1400, 2100, 0.1, 0.04, this.ui);
  }

  launch(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.hiss(t, 0.45, 0.18, this.sfx, 'bandpass', 500, 2600, 1.2, 0.08);
    this.tone(t, 'triangle', 300, 600, 0.3, 0.04, this.ui);
  }

  land(size01: number): void {
    if (!this.ready()) return;
    const t = this.now;
    this.tone(t, 'sine', 110 - size01 * 40, 38, 0.22, 0.4, this.sfx);
    this.hiss(t, 0.16, 0.3, this.sfx, 'lowpass', 800, 200);
  }

  /** Through a speed hoop: whoosh + bell that climbs on consecutive hoops. */
  hoop(chain: number): void {
    if (!this.ready()) return;
    const t = this.now;
    this.hiss(t, 0.32, 0.2, this.sfx, 'bandpass', 700, 4200, 1.4, 0.03);
    const f = mtof(79 + [0, 4, 7, 12, 16][Math.min(chain, 4)]);
    this.tone(t, 'sine', f, f, 0.6, 0.11, this.ui);
    this.tone(t, 'sine', f * 2.01, f * 2.01, 0.3, 0.04, this.ui);
    this.tone(t, 'triangle', f * 1.5, f * 1.5, 0.2, 0.03, this.ui);
  }

  transform(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.duck(0.35, 0.7);
    this.tone(t, 'sine', 130, 30, 1.0, 0.6, this.sfx);
    this.hiss(t, 0.6, 0.45, this.sfx, 'lowpass', 3500, 200, 0.7);
    this.hiss(t, 0.5, 0.14, this.ui, 'highpass', 900, 9000, 0.7, 0.02);
    this.synth(t, [57, 64, 69, 72, 76, 79], 'sawtooth', 1.2, 0.07, this.ui, 900, 5000, 0.03, 1.5, 10);
    [81, 84, 88, 91, 93, 96].forEach((n, i) => this.tone(t + 0.06 + i * 0.05, 'triangle', mtof(n), mtof(n), 0.3, 0.06, this.ui));
    this.crashPending = true;
  }

  powerPickup(kind: PowerSfx): void {
    if (!this.ready()) return;
    const t = this.now;
    [72, 76, 79, 84, 88].forEach((n, i) => this.synth(t + i * 0.045, [n], 'square', 0.14, 0.05, this.ui, 4000, 1500));
    this.hiss(t + 0.2, 0.25, 0.06, this.ui, 'highpass', 8000);
    if (kind === 'speed') {
      this.hiss(t, 0.7, 0.28, this.sfx, 'bandpass', 300, 3800, 1.2, 0.05);
      this.synth(t, [40], 'sawtooth', 0.6, 0.06, this.sfx, 400, 2400, 0.02);
    }
  }

  bomb(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.duck(0.2, 1.1);
    this.tone(t, 'sine', 95, 22, 1.6, 0.85, this.sfx);
    this.hiss(t, 1.8, 0.7, this.sfx, 'lowpass', 2800, 80, 0.7);
    this.hiss(t, 0.08, 0.5, this.sfx, 'highpass', 2000);
    for (let i = 0; i < 12; i++) this.hiss(t + rand(0.1, 1.3), rand(0.04, 0.12), rand(0.05, 0.14), this.sfx, 'bandpass', rand(300, 1600), rand(200, 900), 2);
  }

  /** Barrel explosion (rare). */
  explosion(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.tone(t, 'sine', 110, 30, 0.5, 0.5, this.sfx);
    this.hiss(t, 0.6, 0.45, this.sfx, 'lowpass', 2000, 150);
    this.hiss(t, 0.05, 0.3, this.sfx, 'highpass', 2500);
  }

  megaSmash(): void {
    if (!this.ready()) return;
    this.bomb();
    this.synth(this.now, [45, 57, 64, 69], 'sawtooth', 0.9, 0.06, this.ui, 500, 4000, 0.02, 1.5, 8);
  }

  finaleStart(): void {
    if (!this.ready()) return;
    const t = this.now;
    for (const dt of [0, 0.26]) this.synth(t + dt, [45, 57, 64, 69], 'sawtooth', 0.42, 0.07, this.ui, 400, 3200, 0.01, 1.2, 10);
    this.hiss(t + 0.26, 1.2, 0.08, this.ui, 'highpass', 5000);
    this.crashPending = true;
  }

  tick(last: boolean): void {
    if (!this.ready()) return;
    const t = this.now;
    this.tone(t, 'sine', last ? 2100 : 1600, last ? 2100 : 1600, 0.04, 0.12, this.ui);
    this.hiss(t, 0.02, 0.08, this.ui, 'bandpass', 3000, 3000, 3);
  }

  timeUp(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.synth(t, [45, 46], 'square', 0.5, 0.05, this.ui, 1400, 600);
    [79, 76, 72, 67].forEach((n, i) => this.tone(t + 0.35 + i * 0.09, 'triangle', mtof(n), mtof(n), 0.2, 0.07, this.ui));
  }

  /** Invincibility starts: bright rising shimmer. */
  invincible(): void {
    if (!this.ready()) return;
    const t = this.now;
    [0, 4, 7, 11, 14, 19].forEach((s, i) => this.tone(t + i * 0.04, 'triangle', mtof(79 + s), mtof(79 + s), 0.25, 0.05, this.ui));
    this.hiss(t, 0.5, 0.06, this.ui, 'highpass', 6000, 11000);
  }

  // ------------------------------------------------------------------ boss
  /** Boss tank appears: low menacing horn + rumble. */
  bossIntro(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.duck(0.4, 1.4);
    this.synth(t, [33, 40, 45], 'sawtooth', 1.1, 0.09, this.sfx, 250, 1100, 0.12, 2, 12);
    this.synth(t + 0.55, [34, 41, 46], 'sawtooth', 1.0, 0.09, this.sfx, 250, 1200, 0.1, 2, 12);
    this.hiss(t, 1.6, 0.18, this.sfx, 'lowpass', 180, 120, 1, 0.3);
    this.tone(t, 'sine', 45, 38, 1.6, 0.35, this.sfx, 0.2);
  }

  /** The two vehicles collide. */
  bossHit(): void {
    if (!this.ready()) return;
    this.bomb();
    this.impact('metal', 1, -0.3);
    this.impact('metal', 0.8, 0.3);
    const t = this.now;
    for (const f of [220, 311, 523]) this.tone(t, 'sine', f, f * 0.97, 0.9, 0.06, this.sfx);
  }

  bossWin(): void {
    if (!this.ready()) return;
    const t = this.now + 0.1;
    [67, 72, 76, 79].forEach((n, i) => this.synth(t + i * 0.12, [n], 'square', 0.16, 0.06, this.ui, 4000, 1500));
    this.synth(t + 0.5, [72, 76, 79, 84], 'sawtooth', 1.4, 0.06, this.ui, 1200, 5500, 0.02, 1.2, 9);
    this.tone(t + 0.5, 'sine', mtof(48), mtof(48), 1.2, 0.2, this.sfx);
    this.hiss(t + 0.5, 1.0, 0.06, this.ui, 'highpass', 8000);
  }

  /** Comic "wah wah wah wahhh" when the boss wins. */
  bossLose(): void {
    if (!this.ready()) return;
    const t = this.now + 0.25;
    const notes = [62, 61, 60];
    notes.forEach((n, i) => this.synth(t + i * 0.32, [n], 'sawtooth', 0.26, 0.06, this.ui, 1400, 500, 0.02, 3));
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1200;
    f.Q.value = 3;
    const g = c.createGain();
    const s = t + 0.96;
    o.frequency.setValueAtTime(mtof(59), s);
    o.frequency.linearRampToValueAtTime(mtof(57), s + 0.9);
    const lfo = c.createOscillator();
    lfo.frequency.value = 6;
    const lg = c.createGain();
    lg.gain.value = 6;
    lfo.connect(lg);
    lg.connect(o.frequency);
    this.env(g.gain, s, 0.06, 0.03, 0.9);
    o.connect(f);
    f.connect(g);
    g.connect(this.ui);
    o.start(s);
    lfo.start(s);
    o.stop(s + 1);
    lfo.stop(s + 1);
  }

  // ------------------------------------------------------------------ UI SFX
  uiClick(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.tone(t, 'sine', 680, 1150, 0.05, 0.12, this.ui);
    this.hiss(t, 0.012, 0.05, this.ui, 'highpass', 6000);
  }

  uiConfirm(): void {
    if (!this.ready()) return;
    const t = this.now;
    this.tone(t, 'triangle', mtof(79), mtof(79), 0.08, 0.1, this.ui);
    this.tone(t + 0.07, 'triangle', mtof(86), mtof(86), 0.16, 0.1, this.ui);
    this.hiss(t + 0.07, 0.15, 0.04, this.ui, 'highpass', 8000);
  }

  bannerWhoosh(): void {
    if (!this.ready()) return;
    this.hiss(this.now, 0.25, 0.06, this.ui, 'bandpass', 600, 3200, 1.2, 0.03);
  }

  countTick(frac: number): void {
    if (!this.ready()) return;
    const f = mtof(72 + Math.round(frac * 24));
    this.tone(this.now, 'triangle', f, f, 0.03, 0.05, this.ui);
  }

  countDone(): void {
    if (!this.ready()) return;
    const t = this.now;
    for (const n of [84, 88, 91]) this.tone(t, 'sine', mtof(n), mtof(n), 0.7, 0.05, this.ui);
    this.tone(t, 'triangle', mtof(72), mtof(72), 0.5, 0.06, this.ui);
  }

  newBest(): void {
    if (!this.ready()) return;
    const t = this.now + 0.15;
    [72, 76, 79].forEach((n, i) => this.synth(t + i * 0.1, [n], 'square', 0.12, 0.05, this.ui, 3500, 1500));
    this.synth(t + 0.3, [72, 76, 79, 84], 'sawtooth', 0.9, 0.05, this.ui, 1200, 5000, 0.02, 1.2, 8);
    this.hiss(t + 0.3, 0.6, 0.05, this.ui, 'highpass', 8000);
  }

  // ------------------------------------------------------------------ music
  setMusicMode(mode: MusicMode): void {
    this.mode = mode;
    if (mode !== 'play') this.targetLevel = 0;
    if (!this.ctx) return;
    const f = mode === 'play' ? 18000 : mode === 'menu' ? 1500 : 900;
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, mode === 'play' ? 0.15 : 0.4);
  }

  /** 1..7 follow the vehicle tier; 8 = finale. Applied on the next beat. */
  setIntensity(n: number): void {
    if (this.mode !== 'play') return;
    if (n > this.targetLevel && this.targetLevel > 0) this.crashPending = true;
    this.targetLevel = n;
  }

  private schedule(): void {
    const c = this.ctx;
    if (!c) return;
    if (c.state !== 'running') {
      this.nextTime = c.currentTime + 0.05;
      return;
    }
    if (this.nextTime < c.currentTime - 0.2) this.nextTime = c.currentTime + 0.05;
    while (this.nextTime < c.currentTime + 0.15) {
      if (this.step % 4 === 0 && this.level !== this.targetLevel) {
        this.level = this.targetLevel;
        this.bpm = this.level >= 8 ? 138 : 118 + this.level * 2.5;
        this.delay.delayTime.setTargetAtTime((3 * 60) / this.bpm / 4, this.nextTime, 0.05);
      }
      this.playStep(this.step, this.bar, this.nextTime);
      const sd = 60 / this.bpm / 4;
      // Gentle swing on off-16ths.
      this.nextTime += sd * (this.step % 2 === 0 ? 1.04 : 0.96);
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar = (this.bar + 1) % 4;
    }
  }

  private playStep(s: number, bar: number, t: number): void {
    const L = this.level;
    const sd = 60 / this.bpm / 4;
    const chord = CHORDS[bar];
    const root = ROOTS[bar];
    const M = this.musicIn;

    if (s === 0) this.pad(t, chord, sd * 16, L);
    if (this.crashPending && s % 4 === 0 && L > 0) {
      this.crash(t);
      this.crashPending = false;
    } else if (s === 0 && bar === 0 && L >= 4) this.crash(t);

    if (L === 0) {
      // Menu / results: soft plucks and a warm sub.
      if (s === 0 || s === 3 || s === 6 || s === 10 || s === 12) {
        const n = chord[(s / 3) % 3 | 0] + 12;
        this.synth(t, [n], 'triangle', 0.4, 0.05, this.out(M, s % 2 ? 0.3 : -0.3), 2600, 500);
      }
      if (s % 8 === 0) this.tone(t, 'sine', mtof(root + 12), mtof(root + 12), sd * 6, 0.07, this.pump, 0.02);
      return;
    }

    if (s % 4 === 0) {
      this.tone(t, 'sine', 155, 44, 0.24, 0.85, M);
      this.hiss(t, 0.006, 0.12, M, 'highpass', 4500);
      const g = this.pump.gain;
      g.setValueAtTime(0.35, t);
      g.linearRampToValueAtTime(1, t + sd * 3.3);
    }

    if (L < 3) {
      if (s % 4 === 2) this.bass(t, root + 12, sd * 1.8);
    } else if (s % 4 !== 0) {
      this.bass(t, root + (s % 4 === 2 ? 12 : 0), sd * 0.9);
    }

    if (L >= 2 && (s === 4 || s === 12)) this.clap(t, 0.2);
    if (L >= 8 && bar === 3 && s >= 8 && s % 2 === 0) this.clap(t, 0.08 + (s - 8) * 0.012);

    if (L >= 2) {
      if (s % 4 === 2) this.hiss(t, 0.09, 0.07, M, 'highpass', 7500);
      else if (L >= 4) this.hiss(t, 0.025, s % 2 ? 0.035 : 0.025, M, 'highpass', 9000);
    }

    if (L >= 3) {
      const every = L >= 6 ? 1 : 2;
      if (s % every === 0) {
        const ext = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24];
        const n = ext[ARP[(every === 1 ? s : s >> 1) % 8]];
        const o = this.out(M, s % 4 < 2 ? -0.35 : 0.35);
        o.connect(this.delayIn);
        this.synth(t, [n], 'square', sd * 0.8, 0.022, o, 3400, 900);
      }
    }

    if (L >= 5) {
      const n = MELODY[bar][s];
      if (n) {
        const o = this.out(M, 0, 1);
        o.connect(this.delayIn);
        this.synth(t, [n + 12], 'square', sd * 2.4, 0.03, o, 4200, 1600, 0.008, 1, 6);
        this.tone(t, 'triangle', mtof(n), mtof(n), sd * 2.4, 0.03, o, 0.008);
      }
    }

    if (L >= 7) {
      if (s % 2 === 0) this.hiss(t, 0.1, 0.025, M, 'highpass', 10000);
      if (bar === 3 && s >= 12) this.tone(t, 'sine', s % 2 ? 140 : 190, 70, 0.18, 0.3, M);
    }
  }

  private pad(t: number, chord: number[], dur: number, L: number): void {
    const c = this.ctx!;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700 + L * 220;
    f.Q.value = 0.7;
    const g = c.createGain();
    const peak = L === 0 ? 0.06 : 0.045;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.35);
    g.gain.setValueAtTime(peak, t + dur - 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    f.connect(g);
    g.connect(this.pump);
    for (const n of [...chord, chord[0] - 12]) {
      for (const dt of [-9, 9]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = dt;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.55);
      }
    }
  }

  private bass(t: number, m: number, dur: number): void {
    this.synth(t, [m], 'sawtooth', dur, 0.085, this.pump, 1500, 220, 0.004, 3);
    this.tone(t, 'sine', mtof(m), mtof(m), dur, 0.09, this.pump);
  }

  private clap(t: number, peak: number): void {
    const M = this.musicIn;
    for (const dt of [0, 0.011, 0.023]) this.hiss(t + dt, 0.02, peak, M, 'bandpass', 1400, 1400, 1.2);
    this.hiss(t + 0.03, 0.15, peak * 0.8, M, 'bandpass', 1200, 900, 0.9);
  }

  private crash(t: number): void {
    this.hiss(t, 1.5, 0.09, this.musicIn, 'highpass', 4500, 3500);
    this.hiss(t, 0.8, 0.05, this.musicIn, 'bandpass', 8500, 7000, 0.5);
  }
}

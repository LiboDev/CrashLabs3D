/** DOM/CSS HUD: crisp at any DPI, cheap to update, responsive via CSS. */
import { POWERS, type PowerKind } from './config';
import { drawPowerIcon } from './icons';

export const fmt = (n: number) => '$' + Math.floor(n).toLocaleString('en-US');

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.6"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.6"/></svg>';
const SPEAKER = '<path d="M3.5 9.2h3.8L12 5.2v13.6l-4.7-4H3.5z"/>';
const ICON_SOUND = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.2 9a4.2 4.2 0 0 1 0 6M17.8 6.5a7.8 7.8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_MUTED = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

export interface EndStats {
  damage: number;
  victory: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const restart = (e: HTMLElement, cls: string) => {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
};

export type EffectKind = 'invincible' | 'flame';

export class HUD {
  root: HTMLDivElement;
  private speedLines: HTMLDivElement;
  private damage: HTMLDivElement;
  private damagePulse = 0;
  private shownDamage = 0;
  private targetDamage = 0;
  private meterFill: HTMLDivElement;
  private meterLabel: HTMLDivElement;
  private meter: HTMLDivElement;
  private effects = new Map<EffectKind, { pill: HTMLDivElement; fill: HTMLDivElement; on: boolean }>();
  private combo: HTMLDivElement;
  private comboNum: HTMLDivElement;
  private comboChain: HTMLDivElement;
  private comboFill: HTMLDivElement;
  private banner: HTMLDivElement;
  private bannerSub: HTMLDivElement;
  private bannerTimer = 0;
  private hint: HTMLDivElement;
  private flash: HTMLDivElement;
  private pops: HTMLDivElement[] = [];
  private popIndex = 0;
  private end: HTMLDivElement;
  private endEls!: {
    result: HTMLDivElement;
    damage: HTMLDivElement;
    again: HTMLButtonElement;
  };
  private count: { target: number; t: number; dur: number; newBest: boolean; lastTick: number; done: boolean } | null = null;

  private pauseBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private pauseOverlay!: HTMLDivElement;
  private pauseSound!: HTMLButtonElement;
  private resumeBtn!: HTMLButtonElement;
  private muted = false;

  onAgain: () => void = () => {};
  onPauseToggle: () => void = () => {};
  onMuteToggle: () => void = () => {};
  onUi: () => void = () => {};
  onCountTick: (frac: number) => void = () => {};
  onCountDone: (newBest: boolean) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.speedLines = el('div', 'speedlines', this.root);
    const top = el('div', 'hud-top', this.root);
    this.damage = el('div', 'hud-damage', top, '$0');
    this.meter = el('div', 'hud-meter', top);
    this.meterFill = el('div', 'hud-meter-fill', this.meter);
    this.meterLabel = el('div', 'hud-meter-label', this.meter, '');

    // Active effects stack on the right, under the combo multiplier.
    const fxCol = el('div', 'hud-effects', this.root);
    const effectDefs: Array<[EffectKind, PowerKind, string, string]> = [
      ['invincible', 'speed', 'INVINCIBLE', 'rainbow'],
      ['flame', 'flame', 'FLAMETHROWER', ''],
    ];
    for (const [kind, icon, label, cls] of effectDefs) {
      const pill = el('div', `hud-effect ${cls}`, fxCol);
      pill.style.setProperty('--pc', POWERS[icon].css);
      const img = el('img', 'hud-effect-icon', pill);
      img.alt = '';
      img.src = drawPowerIcon(icon).toDataURL();
      const col = el('div', 'hud-effect-col', pill);
      el('div', 'hud-effect-label', col, label);
      const bar = el('div', 'hud-effect-bar', col);
      const fill = el('div', 'hud-effect-fill', bar);
      this.effects.set(kind, { pill, fill, on: false });
    }

    this.combo = el('div', 'combo', this.root);
    el('div', 'combo-rays', this.combo);
    this.comboNum = el('div', 'combo-num', this.combo, 'x2');
    this.comboChain = el('div', 'combo-chain', this.combo, '');
    const cbar = el('div', 'combo-bar', this.combo);
    this.comboFill = el('div', 'combo-bar-fill', cbar);

    this.banner = el('div', 'hud-banner', this.root);
    this.bannerSub = el('div', 'hud-banner-sub', this.root);
    this.hint = el('div', 'hud-hint', this.root);
    el('div', 'hud-hint-arrows', this.hint, '◀  ●  ▶');
    el('div', 'hud-hint-text', this.hint, 'DRAG TO STEER');
    this.flash = el('div', 'hud-flash', this.root);
    const popLayer = el('div', 'hud-pops', this.root);
    for (let i = 0; i < 40; i++) this.pops.push(el('div', 'pop', popLayer));
    this.end = this.buildEnd();
    this.buildControls();
  }

  private buildControls(): void {
    const stop = (e: Event) => e.stopPropagation();
    this.pauseBtn = el('button', 'hud-btn hud-btn-left', this.root);
    this.pauseBtn.innerHTML = ICON_PAUSE;
    this.pauseBtn.setAttribute('aria-label', 'Pause');
    this.muteBtn = el('button', 'hud-btn hud-btn-right', this.root);
    this.muteBtn.setAttribute('aria-label', 'Mute');
    this.muteBtn.innerHTML = ICON_SOUND;

    this.pauseOverlay = el('div', 'pause hidden', this.root);
    const card = el('div', 'pause-card', this.pauseOverlay);
    el('div', 'pause-title', card, 'PAUSED');
    this.resumeBtn = el('button', 'btn btn-primary', card, 'RESUME');
    this.pauseSound = el('button', 'btn btn-ad', card, '');

    for (const b of [this.pauseBtn, this.muteBtn, this.pauseOverlay]) b.addEventListener('pointerdown', stop);
    this.pauseBtn.addEventListener('click', () => {
      this.onUi();
      this.onPauseToggle();
    });
    this.resumeBtn.addEventListener('click', () => {
      this.onUi();
      this.onPauseToggle();
    });
    const mute = () => {
      this.onMuteToggle();
      this.onUi();
    };
    this.muteBtn.addEventListener('click', mute);
    this.pauseSound.addEventListener('click', mute);
    this.setMuted(false);
  }

  setPauseAvailable(v: boolean): void {
    this.pauseBtn.classList.toggle('hidden', !v);
  }

  showPause(v: boolean): void {
    this.pauseOverlay.classList.toggle('hidden', !v);
    if (v) this.resumeBtn.focus({ preventScroll: true });
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.muteBtn.innerHTML = m ? ICON_MUTED : ICON_SOUND;
    this.muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
    this.muteBtn.classList.toggle('off', m);
    this.pauseSound.textContent = m ? 'SOUND: OFF' : 'SOUND: ON';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private buildEnd(): HTMLDivElement {
    const end = el('div', 'end hidden', this.root);
    const card = el('div', 'end-card', end);
    const result = el('div', 'end-result', card, '');
    el('div', 'end-title', card, 'TOTAL DAMAGE');
    const damage = el('div', 'end-damage', card, '$0');
    const again = el('button', 'btn btn-primary', card, 'SMASH AGAIN');
    again.addEventListener('click', () => {
      this.onUi();
      this.onAgain();
    });
    end.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.endEls = { result, damage, again };
    return end;
  }

  setDamage(v: number, instant = false): void {
    if (v > this.targetDamage) this.damagePulse = 1;
    this.targetDamage = v;
    if (instant) this.shownDamage = v;
  }

  setMeter(frac: number, label: string, mega: boolean): void {
    this.meterFill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    if (this.meterLabel.textContent !== label) this.meterLabel.textContent = label;
    this.meter.classList.toggle('mega', mega);
    this.meter.classList.toggle('full', frac > 0.85);
  }

  pulseMeter(): void {
    restart(this.meter, 'bump');
  }

  /** frac = remaining time 0..1, or null to hide the effect. */
  setEffect(kind: EffectKind, frac: number | null): void {
    const e = this.effects.get(kind)!;
    const on = frac !== null && frac > 0;
    if (on !== e.on) {
      e.on = on;
      e.pill.classList.toggle('show', on);
    }
    if (on) e.fill.style.transform = `scaleX(${Math.min(1, frac!).toFixed(3)})`;
  }

  setSpeedLines(a: number, rainbow = false): void {
    this.speedLines.style.opacity = a.toFixed(2);
    this.speedLines.classList.toggle('rainbow', rainbow);
  }

  setCombo(mult: number, count: number, t01: number, chain: number): void {
    if (mult <= 1 && count < 3) {
      this.combo.classList.remove('show');
      return;
    }
    this.combo.classList.add('show');
    const txt = mult > 1 ? `x${mult}` : `${count}`;
    if (this.comboNum.textContent !== txt) this.comboNum.textContent = txt;
    const ch = fmt(chain);
    if (this.comboChain.textContent !== ch) this.comboChain.textContent = ch;
    this.comboFill.style.transform = `scaleX(${t01})`;
    const lvl = String(mult);
    if (this.combo.dataset.level !== lvl) this.combo.dataset.level = lvl;
  }

  comboLevelUp(): void {
    restart(this.combo, 'levelup');
  }

  /** Chain finished: fling its total out of the combo badge. */
  chainEnd(amount: number): void {
    const r = this.combo.getBoundingClientRect();
    this.popup(`CHAIN +${fmt(amount)}`, r.left + r.width / 2, r.top + r.height * 0.8, 'chain', 1.1);
  }

  showBanner(text: string, sub = '', seconds = 1.4, cls = ''): void {
    this.banner.textContent = text;
    this.bannerSub.textContent = sub;
    this.banner.className = 'hud-banner ' + cls;
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this.bannerSub.className = 'hud-banner-sub' + (sub ? ' show' : '');
    this.bannerTimer = seconds;
  }

  showHint(v: boolean): void {
    this.hint.classList.toggle('show', v);
  }

  doFlash(color = '#ffffff', strength = 0.8): void {
    this.flash.style.background = color;
    this.flash.style.transition = 'none';
    this.flash.style.opacity = String(strength);
    void this.flash.offsetWidth;
    this.flash.style.transition = 'opacity 0.35s ease-out';
    this.flash.style.opacity = '0';
  }

  /** Floating text at screen coords (CSS px). */
  popup(text: string, x: number, y: number, cls = '', scale = 1): void {
    const p = this.pops[this.popIndex];
    this.popIndex = (this.popIndex + 1) % this.pops.length;
    p.textContent = text;
    p.className = 'pop';
    p.style.left = `${x + (Math.random() - 0.5) * 50}px`;
    p.style.top = `${y + (Math.random() - 0.5) * 24}px`;
    p.style.setProperty('--s', scale.toFixed(2));
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 40}px`);
    void p.offsetWidth;
    p.className = 'pop go ' + cls;
  }

  update(realDt: number): void {
    const diff = this.targetDamage - this.shownDamage;
    if (Math.abs(diff) < 1) this.shownDamage = this.targetDamage;
    else this.shownDamage += diff * Math.min(1, realDt * 12);
    this.damage.textContent = fmt(this.shownDamage);
    if (this.damagePulse > 0.01) {
      this.damagePulse *= Math.exp(-realDt * 10);
      this.damage.style.transform = `scale(${1 + this.damagePulse * 0.12})`;
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= realDt;
      if (this.bannerTimer <= 0) {
        this.banner.classList.remove('show');
        this.bannerSub.classList.remove('show');
      }
    }
    const c = this.count;
    if (c && !c.done) {
      c.t = Math.min(c.dur, c.t + realDt);
      const f = c.t / c.dur;
      const eased = 1 - Math.pow(1 - f, 3);
      this.endEls.damage.textContent = fmt(c.target * eased);
      if (c.t - c.lastTick > 0.05 && f < 1) {
        c.lastTick = c.t;
        this.onCountTick(eased);
      }
      if (f >= 1) {
        c.done = true;
        restart(this.endEls.damage, 'land');
        this.onCountDone(c.newBest);
      }
    }
  }

  setPlayingVisible(v: boolean): void {
    this.root.classList.toggle('playing', v);
  }

  showEnd(s: EndStats): void {
    const E = this.endEls;
    E.result.textContent = s.victory ? 'VICTORY!' : 'DEFEAT';
    E.result.classList.toggle('win', s.victory);
    E.damage.textContent = '$0';
    this.end.classList.remove('hidden');
    this.count = { target: s.damage, t: 0, dur: 1.3, newBest: s.victory, lastTick: -1, done: false };
    E.again.focus({ preventScroll: true });
  }

  hideEnd(): void {
    this.end.classList.add('hidden');
    this.count = null;
  }

  get endVisible(): boolean {
    return !this.end.classList.contains('hidden');
  }
}

/**
 * Unified steering input: touch / mouse drag (Pointer Events) + keyboard.
 * Produces a single `steer` target in [-1, 1].
 */
export class Input {
  /** Raw target steering from the active device, [-1, 1]. */
  target = 0;
  pointerDown = false;
  private anchorX = 0;
  private pointerId: number | null = null;
  private keys = new Set<string>();
  private listeners: Array<() => void> = [];

  constructor(el: HTMLElement) {
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.reset());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Fires on any gameplay press (pointer or steering/confirm key). */
  onPress(fn: () => void): void {
    this.listeners.push(fn);
  }

  reset(): void {
    this.pointerDown = false;
    this.pointerId = null;
    this.keys.clear();
    this.target = 0;
  }

  private get range(): number {
    return Math.max(50, Math.min(window.innerWidth, window.innerHeight) * 0.2);
  }

  private emitPress(): void {
    for (const fn of this.listeners) fn();
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerDown = true;
    this.pointerId = e.pointerId;
    this.anchorX = e.clientX;
    this.target = 0;
    this.emitPress();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointerDown || e.pointerId !== this.pointerId) return;
    let off = (e.clientX - this.anchorX) / this.range;
    // Re-anchor past the edge so reversing direction responds instantly.
    if (off > 1) {
      this.anchorX = e.clientX - this.range;
      off = 1;
    } else if (off < -1) {
      this.anchorX = e.clientX + this.range;
      off = -1;
    }
    this.target = off;
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerDown = false;
    this.pointerId = null;
    this.target = this.keyTarget();
  };

  private keyTarget(): number {
    let t = 0;
    if (this.keys.has('left')) t -= 1;
    if (this.keys.has('right')) t += 1;
    return t;
  }

  private mapKey(e: KeyboardEvent): string | null {
    switch (e.code) {
      case 'KeyA':
      case 'ArrowLeft':
        return 'left';
      case 'KeyD':
      case 'ArrowRight':
        return 'right';
      case 'Space':
      case 'Enter':
        return 'confirm';
      default:
        return null;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = this.mapKey(e);
    if (!k) return; // never swallow Esc or other keys
    // Let focused buttons (end screen) handle Space/Enter natively.
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    if (!this.pointerDown) this.target = this.keyTarget();
    this.emitPress();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = this.mapKey(e);
    if (!k) return;
    this.keys.delete(k);
    if (!this.pointerDown) this.target = this.keyTarget();
  };
}

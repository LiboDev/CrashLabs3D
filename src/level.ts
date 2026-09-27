/**
 * Procedural course generation in fixed-length chunks.
 * Lanes get roles: easy (safe, low reward), heavy (risky, high reward), mix.
 * Ramps (each with a speed hoop in front) can appear in any lane.
 */
import { GOLD_CHANCE, LANES, PROPS, type PowerKind, type PropId } from './config';

export interface Spawn {
  id: PropId;
  x: number;
  d: number;
  y: number;
  variant: number;
  gold: boolean;
  rotY: number;
  vd: number;
  finale: boolean;
}

export interface RampSpawn {
  x: number;
  d: number;
}

export interface PowerSpawn {
  x: number;
  d: number;
  kind: PowerKind;
}

export interface ChunkResult {
  props: Spawn[];
  ramps: RampSpawn[];
  powerups: PowerSpawn[];
  gate?: number;
}

export const CHUNK = 12;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const ALL: PropId[] = ['box', 'cone', 'trash', 'fence', 'bench', 'tree', 'car', 'wall', 'bus', 'shop', 'tower'];
const KINDS: PowerKind[] = ['speed', 'bomb', 'flame'];
const BARREL_CHANCE = 0.04;

type Role = 'easy' | 'heavy' | 'mix';

export class LevelGen {
  private chunkIndex = 0;
  private roles: Role[] = ['easy', 'mix', 'heavy'];
  private sinceRamp = 0;
  private sincePower = 0;
  private lastKind: PowerKind | null = null;
  private skipLane = -1;
  finaleStarted = false;

  reset(): void {
    this.chunkIndex = 0;
    this.skipLane = -1;
    this.roles = ['easy', 'mix', 'heavy'];
    this.sinceRamp = 0;
    this.sincePower = 8; // first powerup comes a little sooner
    this.lastKind = null;
    this.finaleStarted = false;
  }

  private pools(power: number, t: number): { easy: PropId[]; heavy: PropId[] } {
    const easyAll = ALL.filter((id) => PROPS[id].power <= power);
    const top = easyAll.filter((id) => PROPS[id].power >= power - 2);
    // Early on, blockers are only one step above what you can break.
    const reach = t < 30 ? 1 : 2;
    let heavy = ALL.filter((id) => PROPS[id].power > power && PROPS[id].power <= power + reach);
    if (heavy.length === 0) heavy = ['tower', 'shop', 'bus'];
    return { easy: top.length ? top : easyAll, heavy };
  }

  private nextKind(): PowerKind {
    const k = pick(KINDS.filter((x) => x !== this.lastKind));
    this.lastKind = k;
    return k;
  }

  /** t = seconds into the run (drives the difficulty ramp). */
  generate(d0: number, power: number, finale: boolean, t = 0): ChunkResult {
    const out: ChunkResult = { props: [], ramps: [], powerups: [] };
    const i = this.chunkIndex++;

    if (finale && !this.finaleStarted) {
      this.finaleStarted = true;
      out.gate = d0 + 2;
      out.powerups.push({ x: pick(LANES), d: d0 + 5, kind: this.nextKind() });
      this.finaleChunk(d0 + 9, power, out);
      return out;
    }
    if (finale) {
      this.finaleChunk(d0, power, out);
      return out;
    }

    // Opening: guaranteed smashables straight ahead.
    if (i < 3) {
      const d = d0 + 6;
      if (i === 0) this.cluster('box', 0, d + 4, out, false, 'big');
      if (i === 1) this.cluster('cone', 0, d, out, false);
      if (i === 2) this.cluster('trash', 0, d, out, false);
      this.cluster(i === 1 ? 'box' : 'cone', LANES[i % 2 === 0 ? 0 : 2], d, out, false);
      if (i === 2) this.cluster('fence', LANES[2], d + 3, out, false);
      return out;
    }

    if (i % 4 === 3) this.roles = Math.random() < 0.5 ? ['easy', 'mix', 'heavy'] : ['heavy', 'mix', 'easy'];

    // Difficulty ramps gently over the run: fewer blockers early, tougher ones later.
    const diff = Math.min(1, Math.max(0, t / 75));
    const { easy, heavy } = this.pools(power, t);
    this.sinceRamp++;
    this.sincePower++;
    const skip = this.skipLane;
    this.skipLane = -1;

    let rampLane = -1;
    if (i >= 6 && this.sinceRamp > 14 && skip < 0 && Math.random() < 0.3) {
      this.sinceRamp = 0;
      rampLane = Math.floor(Math.random() * 3);
      const x = LANES[rampLane];
      out.ramps.push({ x, d: d0 + 8 });
      // Reward landing zone beyond the ramp.
      const land = d0 + CHUNK + 14;
      if (Math.random() < 0.2) this.cluster('barrel', x, land, out, false);
      else this.cluster(pick(easy), x + rnd(-1, 1), land, out, true, 'big');
    }

    if (i >= 6 && this.sincePower >= 14 + power * 2 && Math.random() < 0.6) {
      this.sincePower = 0;
      let lane = Math.floor(Math.random() * 3);
      if (lane === rampLane) lane = (lane + 1 + Math.floor(Math.random() * 2)) % 3;
      out.powerups.push({ x: LANES[lane], d: d0 + 6, kind: this.nextKind() });
    }

    const weak = power <= 1;
    for (let lane = 0; lane < 3; lane++) {
      if (lane === rampLane || lane === skip) continue;
      const role = this.roles[lane];
      const x = LANES[lane] + rnd(-1, 1);
      const d = d0 + rnd(2, CHUNK - 2);
      const heavyChance = weak ? 0.25 : 0.25 + diff * 0.3;
      const chance = role === 'easy' ? 0.95 : role === 'heavy' ? heavyChance : weak ? 0.85 : 0.55;
      if (Math.random() > chance) continue;
      let id: PropId;
      if (role === 'easy' || (weak && role === 'mix' && Math.random() < 0.7)) id = pick(easy);
      else if (role === 'heavy') id = pick(heavy);
      else id = Math.random() < BARREL_CHANCE ? 'barrel' : Math.random() < 0.2 + diff * 0.3 ? pick(heavy) : pick(easy);
      this.cluster(id, x, d, out, true);
    }
    // The chunk after a ramp keeps the ramp lane clear so nothing sits on the ramp.
    if (rampLane >= 0) this.skipLane = rampLane;

    // Oncoming traffic arrives later in the run.
    if (power >= 4 && t > 30 && Math.random() < 0.1 + diff * 0.2) {
      out.props.push(this.spawn('car', pick(LANES), d0 + CHUNK - 1, 0, Math.PI, -rnd(5, 9), true));
    } else if (power >= 5 && t > 40 && Math.random() < 0.1) {
      out.props.push(this.spawn('bus', pick(LANES), d0 + CHUNK - 1, 0, Math.PI, -rnd(4, 7), true));
    }
    return out;
  }

  private finaleChunk(d0: number, power: number, out: ChunkResult): void {
    const breakable = ALL.filter((id) => PROPS[id].power <= power && id !== 'cone');
    const top = breakable.filter((id) => PROPS[id].power >= power - 2);
    const heavier = ALL.filter((id) => PROPS[id].power === power + 1);
    for (let lane = 0; lane < 3; lane++) {
      const x = LANES[lane] + rnd(-0.7, 0.7);
      const d = d0 + rnd(2, CHUNK - 2);
      const r = Math.random();
      const id = r < 0.05 ? 'barrel' : r < 0.18 && heavier.length ? pick(heavier) : pick(top.length ? top : breakable);
      this.cluster(id, x, d, out, true, 'big', true);
    }
  }

  private spawn(id: PropId, x: number, d: number, y: number, rotY: number, vd: number, allowGold: boolean, finale = false): Spawn {
    return { id, x, d, y, rotY, vd, variant: Math.floor(Math.random() * 8), gold: allowGold && Math.random() < GOLD_CHANCE, finale };
  }

  private cluster(id: PropId, x: number, d: number, out: ChunkResult, gold: boolean, size: 'normal' | 'big' = 'normal', finale = false): void {
    const add = (px: number, pd: number, py = 0, rot = 0) => out.props.push(this.spawn(id, px, pd, py, rot, 0, gold, finale));
    const big = size === 'big';
    switch (id) {
      case 'box': {
        const base = big ? 4 : Math.random() < 0.5 ? 3 : 2;
        for (let row = 0; row < base; row++)
          for (let c = 0; c < base - row; c++) add(x + (c - (base - row - 1) / 2) * 1.05, d + rnd(-0.05, 0.05), row, rnd(-0.2, 0.2));
        if (big) for (let c = 0; c < 3; c++) add(x + (c - 1) * 1.05, d - 2.2, 0, rnd(-0.3, 0.3));
        break;
      }
      case 'cone':
        for (let k = 0; k < 4; k++) add(x + (k - 1.5) * 1.3, d + (k % 2) * 0.8);
        break;
      case 'trash':
        for (let k = 0; k < 3; k++) add(x + (k - 1) * 1.2, d + rnd(-0.4, 0.4), 0, rnd(0, 6));
        break;
      case 'fence':
        add(x - 1.62, d);
        add(x + 1.62, d);
        break;
      case 'bench':
        add(x - 1.2, d, 0, rnd(-0.1, 0.1));
        if (Math.random() < 0.6 || big) add(x + 1.2, d + 0.3, 0, rnd(-0.1, 0.1));
        break;
      case 'tree':
        add(x + rnd(-1.5, 1.5), d, 0, rnd(0, 6));
        if (Math.random() < 0.5 || big) add(x + rnd(-2, 2), d - 4, 0, rnd(0, 6));
        break;
      case 'barrel':
        for (let k = 0; k < (big ? 3 : 2); k++) add(x + (k - 0.5) * 1.2, d + (k % 2) * 1.1);
        break;
      case 'car':
        add(x, d, 0, rnd(-0.15, 0.15));
        if (Math.random() < 0.5 || big) add(x + rnd(-0.5, 0.5), d - 5, 0, rnd(-0.15, 0.15));
        if (big && Math.random() < 0.5) add(x, d, 1, rnd(-0.3, 0.3));
        break;
      case 'wall':
        add(x, d);
        if (big) add(x, d - 3.5);
        break;
      case 'bus':
      case 'shop':
      case 'tower':
        add(x, d);
        break;
    }
  }
}

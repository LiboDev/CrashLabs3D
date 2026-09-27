import type { Material } from './audio';

export type VehicleId = 'cart' | 'golf' | 'car' | 'pickup' | 'monster' | 'tank' | 'dozer';

export interface VehicleDef {
  id: VehicleId;
  name: string;
  short: string;
  power: number;
  mass: number;
  /** Lateral speed at full steer (units/s). */
  steering: number;
  /** Forward max speed (units/s). */
  speed: number;
  /** Target collision half-width; the model is auto-scaled to this. */
  halfW: number;
  /** Scrap needed to evolve to the NEXT tier (last tier: MEGA SMASH meter). */
  scrapToNext: number;
}

export const VEHICLES: VehicleDef[] = [
  { id: 'cart', name: 'SHOPPING CART', short: 'CART', power: 1, mass: 1, steering: 12, speed: 15, halfW: 0.6, scrapToNext: 50 },
  { id: 'golf', name: 'GOLF CART', short: 'GOLF CART', power: 2, mass: 2, steering: 13, speed: 18, halfW: 0.85, scrapToNext: 190 },
  { id: 'car', name: 'COMPACT CAR', short: 'CAR', power: 3, mass: 3.5, steering: 14, speed: 21, halfW: 1.1, scrapToNext: 420 },
  { id: 'pickup', name: 'PICKUP TRUCK', short: 'PICKUP', power: 4, mass: 5, steering: 15, speed: 24, halfW: 1.4, scrapToNext: 700 },
  { id: 'monster', name: 'MONSTER TRUCK', short: 'MONSTER', power: 5, mass: 8, steering: 16, speed: 26, halfW: 1.8, scrapToNext: 1050 },
  { id: 'tank', name: 'ARMORED TANK', short: 'TANK', power: 6, mass: 12, steering: 17, speed: 28, halfW: 2.3, scrapToNext: 1500 },
  { id: 'dozer', name: 'MEGA DOZER', short: 'DOZER', power: 7, mass: 20, steering: 18, speed: 30, halfW: 3.9, scrapToNext: 1500 },
];

/** Hoops grant a short burst of invincibility (in seconds). */
export const HOOP_INVINCIBLE = 2.5;
/** Reward for beating the boss tank at the end of the run. */
export const BOSS_BONUS = 100_000;

/**
 * Max money per smash for each tier. A great run earns roughly $50–80k from smashing,
 * with beating the boss (BOSS_BONUS) as the biggest single reward.
 */
export const TIER_CAPS = [9, 19, 49, 99, 149, 199, 299];
export const tierCap = (tier: number): number => TIER_CAPS[Math.min(tier, TIER_CAPS.length - 1)];
/** Base value unit per tier (a value-1 object at x1 combo earns about this much). */
export const tierBase = (tier: number): number => (tierCap(tier) + 1) / 10;

export type PropId =
  | 'box'
  | 'cone'
  | 'trash'
  | 'barrel'
  | 'fence'
  | 'bench'
  | 'tree'
  | 'car'
  | 'wall'
  | 'bus'
  | 'shop'
  | 'tower';

export type BreakStyle = 'burst' | 'launch' | 'fracture';

export interface PropDef {
  id: PropId;
  power: number;
  scrap: number;
  /** Base digit (1..9); multiplied by 10^tier for money. */
  value: number;
  mass: number;
  hw: number;
  hd: number;
  h: number;
  material: Material;
  breakStyle: BreakStyle;
  debris: number[];
  debrisCount: number;
  debrisSize: number;
  explosive?: boolean;
}

export const PROPS: Record<PropId, PropDef> = {
  box: { id: 'box', power: 1, scrap: 2, value: 1, mass: 0.2, hw: 0.5, hd: 0.5, h: 1, material: 'wood', breakStyle: 'burst', debris: [0xd89a5b, 0xf0c27f], debrisCount: 7, debrisSize: 0.28 },
  cone: { id: 'cone', power: 1, scrap: 1, value: 1, mass: 0.1, hw: 0.35, hd: 0.35, h: 0.9, material: 'plastic', breakStyle: 'launch', debris: [0xff6a2b, 0xffffff], debrisCount: 4, debrisSize: 0.2 },
  trash: { id: 'trash', power: 1, scrap: 3, value: 2, mass: 0.3, hw: 0.45, hd: 0.45, h: 1.1, material: 'metal', breakStyle: 'launch', debris: [0x3fbf6a, 0xd8d8d8, 0xf2e3a0], debrisCount: 8, debrisSize: 0.22 },
  barrel: { id: 'barrel', power: 1, scrap: 4, value: 3, mass: 0.2, hw: 0.55, hd: 0.55, h: 1.3, material: 'metal', breakStyle: 'burst', debris: [0xff3b3b, 0xffd23f, 0x333333], debrisCount: 10, debrisSize: 0.3, explosive: true },
  fence: { id: 'fence', power: 2, scrap: 4, value: 2, mass: 0.4, hw: 1.6, hd: 0.2, h: 1.2, material: 'wood', breakStyle: 'burst', debris: [0xffffff, 0xf0ece0], debrisCount: 10, debrisSize: 0.3 },
  bench: { id: 'bench', power: 2, scrap: 5, value: 3, mass: 0.5, hw: 1.1, hd: 0.4, h: 1, material: 'wood', breakStyle: 'launch', debris: [0x2e9e5b, 0x8a5a36, 0x333333], debrisCount: 8, debrisSize: 0.28 },
  tree: { id: 'tree', power: 3, scrap: 7, value: 3, mass: 0.8, hw: 0.6, hd: 0.6, h: 4, material: 'wood', breakStyle: 'launch', debris: [0x3fae4a, 0x2e8b3d, 0x8a5a36], debrisCount: 12, debrisSize: 0.45 },
  car: { id: 'car', power: 4, scrap: 12, value: 5, mass: 1.2, hw: 1.1, hd: 2.0, h: 1.6, material: 'metal', breakStyle: 'launch', debris: [0x444a55, 0xbfe8ff, 0xdddddd], debrisCount: 12, debrisSize: 0.35 },
  wall: { id: 'wall', power: 5, scrap: 16, value: 5, mass: 1.4, hw: 2.4, hd: 0.45, h: 2.2, material: 'concrete', breakStyle: 'fracture', debris: [0xc4553a, 0xa84430, 0xe6d6c0], debrisCount: 20, debrisSize: 0.5 },
  bus: { id: 'bus', power: 5, scrap: 20, value: 7, mass: 1.8, hw: 1.3, hd: 4.5, h: 3, material: 'metal', breakStyle: 'launch', debris: [0xff9f1c, 0xbfe8ff, 0xffffff], debrisCount: 18, debrisSize: 0.45 },
  shop: { id: 'shop', power: 6, scrap: 28, value: 8, mass: 2, hw: 3, hd: 2.6, h: 5, material: 'concrete', breakStyle: 'fracture', debris: [0xff8a7a, 0xffe08a, 0x9fe3ff, 0xffffff], debrisCount: 32, debrisSize: 0.75 },
  tower: { id: 'tower', power: 7, scrap: 45, value: 9, mass: 2.5, hw: 2.6, hd: 2.6, h: 13, material: 'glass', breakStyle: 'fracture', debris: [0x7fd6ff, 0xe9f4ff, 0x9aa7b8], debrisCount: 44, debrisSize: 0.9 },
};

export type PowerKind = 'speed' | 'bomb' | 'flame';

export const POWERS: Record<PowerKind, { name: string; color: number; css: string; dur: number }> = {
  speed: { name: 'SUPER SPEED', color: 0x20c8ff, css: '#20c8ff', dur: 5 },
  bomb: { name: 'MEGA BOMB', color: 0xff3b6b, css: '#ff3b6b', dur: 0 },
  flame: { name: 'FLAMETHROWER', color: 0xff8a1f, css: '#ff8a1f', dur: 6 },
};

export const ROAD_HALF = 12;
export const SIDEWALK = 4;
export const BUILD_X = ROAD_HALF + SIDEWALK + 0.5;
export const LANES = [-7.5, 0, 7.5];

export const COURSE_TIME = 50;
export const FINALE_TIME = 15;
export const CONTINUE_TIME = 15;

export const COMBO_WINDOW = 2.0;
export const COMBO_STEPS: Array<[number, number]> = [
  [0, 1],
  [4, 2],
  [10, 3],
  [18, 5],
  [30, 8],
];

export const GOLD_CHANCE = 0.04;

export const PLAYER_COLOR = 0x2f7bff;
export const PLAYER_ACCENT = 0xffd23f;

/**
 * Procedural low-poly geometry. Every object is baked into ONE merged geometry with
 * vertex colors so each costs a single draw call and nothing is downloaded.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropId, VehicleId } from './config';
import { PLAYER_ACCENT, PLAYER_COLOR } from './config';

type Part = THREE.BufferGeometry;

function colorize(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = ng.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return ng;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const ONE = new THREE.Vector3(1, 1, 1);

function place(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Part {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(x, y, z), _q, ONE);
  const out = colorize(g, color);
  out.applyMatrix4(_m);
  return out;
}

const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  place(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
const cyl = (rt: number, rb: number, h: number, seg: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  place(new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z, rx, ry, rz);
const ico = (r: number, color: number, x: number, y: number, z: number) => place(new THREE.IcosahedronGeometry(r, 0), color, x, y, z);

function merge(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

const K = 0x2b2b33;

// ---------------------------------------------------------------- Props

const CAR_COLORS = [0xff4d4d, 0xffc53d, 0x39c28a, 0xb36bff, 0xff8fc7];
const SHOP_COLORS = [0xff8a7a, 0x7fd1c7, 0x9aa8ff, 0xffc46b];
const AWNING = [0xff4d5e, 0x2fb9a8, 0x3a7bff, 0xffb020, 0xb45cff];

function buildCar(color: number): THREE.BufferGeometry {
  const p: Part[] = [];
  p.push(box(2.1, 0.8, 4, color, 0, 0.75, 0));
  p.push(box(1.8, 0.7, 2.1, 0xbfe8ff, 0, 1.5, -0.1));
  p.push(box(1.85, 0.12, 2.0, color, 0, 1.9, -0.1));
  p.push(box(2.15, 0.25, 0.25, 0xdddddd, 0, 0.5, 2.05));
  p.push(box(2.15, 0.25, 0.25, 0xdddddd, 0, 0.5, -2.05));
  p.push(box(0.4, 0.2, 0.08, 0xfff4b0, -0.65, 0.85, 2.02));
  p.push(box(0.4, 0.2, 0.08, 0xfff4b0, 0.65, 0.85, 2.02));
  for (const [x, z] of [[-1, 1.3], [1, 1.3], [-1, -1.3], [1, -1.3]]) p.push(cyl(0.42, 0.42, 0.35, 10, K, x, 0.42, z, 0, 0, Math.PI / 2));
  return merge(p);
}

function buildShop(v: number): THREE.BufferGeometry {
  const col = SHOP_COLORS[v % SHOP_COLORS.length];
  const awn = AWNING[v % AWNING.length];
  const p: Part[] = [];
  p.push(box(6, 4.6, 5.2, col, 0, 2.3, 0));
  p.push(box(6.2, 0.4, 5.4, 0xffffff, 0, 4.8, 0));
  p.push(box(3.6, 1.9, 0.08, 0x9fe3ff, -0.9, 1.3, 2.62));
  p.push(box(1, 2.1, 0.08, 0x8a5a36, 2.0, 1.05, 2.62));
  for (let i = 0; i < 6; i++) p.push(box(1, 0.12, 1.2, i % 2 ? 0xffffff : awn, -2.5 + i, 2.85, 3.1, 0.35));
  p.push(box(3.8, 0.8, 0.12, 0xffe08a, 0, 3.75, 2.66));
  p.push(box(1.2, 0.6, 1, 0xcccccc, 1.5, 5.3, -1));
  p.push(box(0.8, 0.5, 0.8, 0xbbbbbb, -1.6, 5.25, -0.6));
  return merge(p);
}

function buildBus(): THREE.BufferGeometry {
  const p: Part[] = [];
  p.push(box(2.6, 2.4, 9, 0xff9f1c, 0, 1.65, 0));
  p.push(box(2.64, 0.85, 8, 0xbfe8ff, 0, 2.25, -0.2));
  p.push(box(2.5, 0.2, 8.8, 0xffffff, 0, 2.95, 0));
  p.push(box(2.3, 1.2, 0.06, 0xbfe8ff, 0, 2.1, 4.51));
  p.push(box(2.64, 0.22, 9.02, 0xffffff, 0, 1.2, 0));
  p.push(box(0.5, 0.2, 0.08, 0xfff4b0, -0.8, 0.9, 4.52));
  p.push(box(0.5, 0.2, 0.08, 0xfff4b0, 0.8, 0.9, 4.52));
  for (const [x, z] of [[-1.25, 3], [1.25, 3], [-1.25, -3], [1.25, -3]]) p.push(cyl(0.55, 0.55, 0.4, 10, K, x, 0.55, z, 0, 0, Math.PI / 2));
  return merge(p);
}

export interface PropGeoms {
  get(id: PropId, variant: number): THREE.BufferGeometry;
  variants(id: PropId): number;
}

export function buildPropGeometries(): PropGeoms {
  const map = new Map<PropId, THREE.BufferGeometry[]>();

  map.set('box', [merge([box(1, 1, 1, 0xd89a5b, 0, 0.5, 0), box(1.02, 0.12, 0.3, 0xf0d8a8, 0, 1.0, 0), box(0.3, 0.9, 1.02, 0xb57b45, 0, 0.5, 0)])]);

  map.set('cone', [
    merge([box(0.75, 0.08, 0.75, 0x333333, 0, 0.04, 0), cyl(0.06, 0.34, 0.85, 10, 0xff6a2b, 0, 0.5, 0), cyl(0.19, 0.24, 0.16, 10, 0xffffff, 0, 0.5, 0)]),
  ]);

  map.set('trash', [merge([cyl(0.42, 0.36, 1.0, 10, 0x3fbf6a, 0, 0.5, 0), cyl(0.46, 0.46, 0.1, 10, 0x2e8f50, 0, 1.05, 0), box(0.25, 0.08, 0.08, 0x236b3c, 0, 1.14, 0)])]);

  const fence: Part[] = [];
  for (let i = 0; i < 8; i++) {
    const x = -1.4 + i * 0.4;
    fence.push(box(0.16, 1.0, 0.1, 0xffffff, x, 0.5, 0));
    fence.push(box(0.12, 0.12, 0.1, 0xffffff, x, 1.04, 0, 0, 0, Math.PI / 4));
  }
  fence.push(box(3.2, 0.12, 0.08, 0xf0ece0, 0, 0.35, -0.08));
  fence.push(box(3.2, 0.12, 0.08, 0xf0ece0, 0, 0.8, -0.08));
  map.set('fence', [merge(fence)]);

  const bench: Part[] = [];
  for (const z of [-0.2, 0, 0.2]) bench.push(box(2.2, 0.08, 0.16, 0x2e9e5b, 0, 0.55, z));
  for (const y of [0.78, 0.98]) bench.push(box(2.2, 0.14, 0.07, 0x2e9e5b, 0, y, -0.3));
  for (const x of [-0.95, 0.95]) {
    bench.push(box(0.1, 0.55, 0.5, K, x, 0.28, 0));
    bench.push(box(0.1, 0.5, 0.08, K, x, 0.8, -0.3));
  }
  map.set('bench', [merge(bench)]);

  map.set('tree', [
    merge([box(1.3, 0.35, 1.3, 0xc9a27a, 0, 0.17, 0), cyl(0.2, 0.3, 1.8, 7, 0x8a5a36, 0, 0.9, 0), ico(1.3, 0x3fbe4a, 0, 2.6, 0), ico(0.9, 0x5cd65c, 0.2, 3.5, 0.1)]),
    merge([box(1.3, 0.35, 1.3, 0xc9a27a, 0, 0.17, 0), cyl(0.2, 0.3, 1.6, 7, 0x8a5a36, 0, 0.8, 0), place(new THREE.ConeGeometry(1.3, 3, 7), 0x2e9b45, 0, 2.8, 0)]),
  ]);

  map.set('barrel', [
    merge([
      cyl(0.5, 0.5, 1.2, 12, 0xff3b3b, 0, 0.6, 0),
      cyl(0.52, 0.52, 0.22, 12, 0xffd23f, 0, 0.6, 0),
      cyl(0.52, 0.52, 0.08, 12, 0x333333, 0, 1.18, 0),
      cyl(0.52, 0.52, 0.08, 12, 0x333333, 0, 0.04, 0),
    ]),
  ]);

  map.set('car', CAR_COLORS.map(buildCar));

  const wall: Part[] = [box(4.8, 2.1, 0.9, 0xc4553a, 0, 1.05, 0), box(5.0, 0.2, 1.0, 0xe6d6c0, 0, 2.2, 0)];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      if ((r + c) % 2) continue;
      wall.push(box(1.0, 0.4, 0.05, 0xa84430, -1.8 + c * 1.2 + (r % 2) * 0.6, 0.35 + r * 0.5, 0.46));
    }
  map.set('wall', [merge(wall)]);

  map.set('bus', [buildBus()]);
  map.set('shop', [0, 1, 2, 3].map(buildShop));

  const tower: Part[] = [box(5, 12, 5, 0x7fd6ff, 0, 6, 0)];
  for (let i = 1; i < 6; i++) tower.push(box(5.2, 0.3, 5.2, 0xe9f4ff, 0, i * 2, 0));
  tower.push(box(5.4, 0.5, 5.4, 0x9aa7b8, 0, 12.2, 0));
  tower.push(cyl(0.08, 0.12, 2.2, 6, 0xdddddd, 1.2, 13.5, 1.2));
  tower.push(box(1.6, 0.6, 1.2, 0x9aa7b8, -1, 12.7, -1));
  map.set('tower', [merge(tower)]);

  return {
    get: (id, variant) => {
      const arr = map.get(id)!;
      return arr[variant % arr.length];
    },
    variants: (id) => map.get(id)!.length,
  };
}

// ---------------------------------------------------------------- City decor

const BUILD_COLORS = [0xff9a8a, 0xffc873, 0x7fd8c9, 0x9fb0ff, 0xf4ead8, 0xd0b0ff, 0x8fd0ff, 0xffb3d1, 0xb8e986];

export interface BuildingVariant {
  geo: THREE.BufferGeometry;
  /** Depth along x (away from the road). */
  w: number;
  /** Length along the road. */
  len: number;
}

/** City blocks. Windows are single boxes slightly wider than the body, so they show on both faces. */
export function buildBuildingVariants(n: number): BuildingVariant[] {
  const out: BuildingVariant[] = [];
  const win = () => (Math.random() < 0.18 ? 0xffe28a : 0x9fe3ff);
  for (let i = 0; i < n; i++) {
    const w = 9 + (i % 3) * 1.5;
    const len = 8 + ((i * 7) % 5) * 1.5;
    const h = 9 + ((i * 11) % 7) * 4.2;
    const color = BUILD_COLORS[i % BUILD_COLORS.length];
    const p: Part[] = [box(w, h, len, color, 0, h / 2, 0)];
    p.push(box(w + 0.08, 2.6, len - 1.2, 0x9fe3ff, 0, 1.6, 0));
    p.push(box(w + 0.1, 0.45, len - 0.4, 0xffffff, 0, 3.15, 0));
    p.push(box(w + 1.8, 0.18, len * 0.7, AWNING[i % AWNING.length], 0, 2.95, 0));
    for (let y = 5; y < h - 1.5; y += 2.6) {
      for (let z = -len / 2 + 1.4; z <= len / 2 - 1.39; z += 2.2) p.push(box(w + 0.08, 1.4, 1.2, win(), 0, y, z));
    }
    p.push(box(w + 0.5, 0.5, len + 0.5, 0xffffff, 0, h + 0.1, 0));
    switch (i % 3) {
      case 0: {
        const tx = w * 0.15, tz = len * 0.1;
        for (const [a, b] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) p.push(box(0.15, 1.6, 0.15, 0x5a3b28, tx + a, h + 1.1, tz + b));
        p.push(cyl(1.1, 1.1, 1.8, 10, 0x9a6a44, tx, h + 2.8, tz));
        p.push(place(new THREE.ConeGeometry(1.25, 0.9, 10), 0x6b4a33, tx, h + 4.15, tz));
        break;
      }
      case 1:
        p.push(box(1.6, 0.9, 1.3, 0xd8dde6, -w * 0.2, h + 0.8, len * 0.15));
        p.push(box(1.2, 0.7, 1.0, 0xc8ced8, w * 0.2, h + 0.7, -len * 0.2));
        break;
      default:
        p.push(box(2.2, 1.6, 2.2, 0xe6e1d6, 0, h + 1.1, 0));
        p.push(cyl(0.06, 0.1, 4, 5, 0xdddddd, 0.5, h + 3.8, 0.5));
        p.push(box(0.25, 0.25, 0.25, 0xff4d4d, 0.5, h + 5.9, 0.5));
    }
    out.push({ geo: merge(p), w, len });
  }
  return out;
}

/** Street lamp with its arm pointing toward -x (road side for the right sidewalk). */
export function buildLampGeometry(): THREE.BufferGeometry {
  const c = 0x3b4a66;
  return merge([
    box(0.4, 0.3, 0.4, c, 0, 0.15, 0),
    cyl(0.09, 0.12, 5.2, 6, c, 0, 2.6, 0),
    box(1.6, 0.1, 0.1, c, -0.8, 5.15, 0),
    box(0.6, 0.18, 0.34, c, -1.5, 5.05, 0),
    box(0.5, 0.06, 0.28, 0xfff4b0, -1.5, 4.95, 0),
  ]);
}

// ---------------------------------------------------------------- Ramp & hoop

export const RAMP = { hw: 2.2, hl: 3.5, h: 1.7 };

export function buildRampGeometry(): THREE.BufferGeometry {
  const { hw: w, hl: l, h } = RAMP;
  const A = [-w, 0, l], B = [w, 0, l], C = [-w, 0, -l], D = [w, 0, -l], E = [-w, h, -l], F = [w, h, -l];
  const tris = [A, B, F, A, F, E, C, E, F, C, F, D, A, E, C, B, D, F, A, C, D, A, D, B];
  const pos = new Float32Array(tris.flat());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const col = new Float32Array(pos.length);
  const yellow = new THREE.Color(0xffd23f), dark = new THREE.Color(K);
  for (let t = 0; t < tris.length / 3; t++) {
    const c = t < 2 ? yellow : dark;
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t * 3 + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const parts: Part[] = [g];
  for (let i = 0; i < 3; i++) {
    const z = l - 1.4 - i * 2.1;
    const y = (h * (l - z)) / (2 * l) + 0.02;
    parts.push(box(w * 1.6, 0.04, 0.5, 0xff6a2b, 0, y, z, Math.atan2(h, 2 * l)));
  }
  return merge(parts);
}

/** Unit-radius striped torus standing upright, facing the direction of travel. */
export function buildHoopGeometry(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(1, 0.1, 8, 48).toNonIndexed();
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color(0xffe14d), b = new THREE.Color(0xff4d6d);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const stripe = Math.floor(((Math.atan2(cy, cx) + Math.PI) / (Math.PI * 2)) * 14) % 2;
    const c = stripe ? a : b;
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ---------------------------------------------------------------- Vehicles

export interface VehicleMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  wheels: THREE.Mesh[];
  wheelRadius: number;
  /** Model scale that maps the geometry onto the configured half-width. */
  baseScale: number;
  /** Unscaled-by-growth collision sizes (already include baseScale). */
  halfW: number;
  halfL: number;
  height: number;
}

export interface VehiclePalette {
  body: number;
  accent: number;
  glass: number;
}

export function buildVehicle(
  id: VehicleId,
  targetHalfW: number,
  mat: THREE.Material,
  wheelMat: THREE.Material,
  palette: VehiclePalette = { body: PLAYER_COLOR, accent: PLAYER_ACCENT, glass: 0xbfe8ff },
): VehicleMesh {
  const B = palette.body, Y = palette.accent, W = 0xffffff, G = palette.glass, L = 0xfff4b0;
  const p: Part[] = [];
  let wheelR = 0.2, wheelW = 0.12;
  let wheelPos: number[][] = [];

  switch (id) {
    case 'cart': {
      wheelR = 0.14; wheelW = 0.08;
      p.push(box(1.1, 0.06, 1.5, B, 0, 0.55, 0));
      for (const x of [-0.53, 0.53]) for (const z of [-0.72, 0.72]) p.push(box(0.07, 0.75, 0.07, B, x, 0.9, z));
      for (const y of [0.85, 1.05, 1.26]) {
        p.push(box(1.12, 0.05, 0.05, B, 0, y, 0.72));
        p.push(box(1.12, 0.05, 0.05, B, 0, y, -0.72));
        p.push(box(0.05, 0.05, 1.5, B, 0.53, y, 0));
        p.push(box(0.05, 0.05, 1.5, B, -0.53, y, 0));
      }
      for (const x of [-0.3, 0, 0.3]) {
        p.push(box(0.04, 0.7, 0.04, B, x, 0.9, -0.72));
        p.push(box(0.04, 0.7, 0.04, B, x, 0.9, 0.72));
      }
      p.push(box(1.2, 0.12, 0.12, Y, 0, 1.45, 0.95));
      p.push(box(0.06, 0.4, 0.06, B, -0.5, 1.3, 0.85, -0.4));
      p.push(box(0.06, 0.4, 0.06, B, 0.5, 1.3, 0.85, -0.4));
      p.push(box(0.9, 0.05, 1.3, 0x888888, 0, 0.3, 0));
      for (const x of [-0.45, 0.45]) for (const z of [-0.6, 0.6]) p.push(box(0.05, 0.3, 0.05, 0x888888, x, 0.3, z));
      wheelPos = [[-0.45, -0.6], [0.45, -0.6], [-0.45, 0.6], [0.45, 0.6]];
      break;
    }
    case 'golf': {
      wheelR = 0.34; wheelW = 0.22;
      p.push(box(1.7, 0.45, 2.7, W, 0, 0.55, 0));
      p.push(box(1.72, 0.12, 2.72, B, 0, 0.35, 0));
      p.push(box(1.5, 0.5, 0.7, Y, 0, 1.0, 0.25));
      p.push(box(1.5, 0.7, 0.2, Y, 0, 1.35, 0.6));
      p.push(box(1.5, 0.6, 0.8, W, 0, 0.9, -0.9));
      p.push(box(1.3, 0.5, 0.05, G, 0, 1.4, -1.1, -0.3));
      for (const x of [-0.8, 0.8]) for (const z of [-1.0, 1.1]) p.push(box(0.07, 1.3, 0.07, K, x, 1.65, z));
      p.push(box(1.9, 0.12, 2.5, B, 0, 2.33, 0.05));
      p.push(box(0.8, 0.5, 0.6, 0xdddddd, 0, 1.0, 1.2));
      wheelPos = [[-0.82, -0.9], [0.82, -0.9], [-0.82, 0.95], [0.82, 0.95]];
      break;
    }
    case 'car': {
      wheelR = 0.45; wheelW = 0.32;
      p.push(box(2.2, 0.8, 4, B, 0, 0.8, 0));
      p.push(box(1.9, 0.7, 2.1, G, 0, 1.55, 0.2));
      p.push(box(1.95, 0.12, 1.9, B, 0, 1.95, 0.25));
      p.push(box(0.5, 0.82, 4.02, Y, -0.45, 0.8, 0));
      p.push(box(0.5, 0.82, 4.02, Y, 0.45, 0.8, 0));
      p.push(box(0.5, 0.14, 1.92, Y, -0.45, 1.97, 0.25));
      p.push(box(0.5, 0.14, 1.92, Y, 0.45, 1.97, 0.25));
      p.push(box(2.3, 0.3, 0.3, K, 0, 0.5, -2.05));
      p.push(box(2.3, 0.3, 0.3, K, 0, 0.5, 2.05));
      p.push(box(0.45, 0.22, 0.08, L, -0.7, 0.9, -2.02));
      p.push(box(0.45, 0.22, 0.08, L, 0.7, 0.9, -2.02));
      p.push(box(1.8, 0.12, 0.4, K, 0, 1.25, 2.0));
      wheelPos = [[-1.05, -1.3], [1.05, -1.3], [-1.05, 1.3], [1.05, 1.3]];
      break;
    }
    case 'pickup': {
      wheelR = 0.55; wheelW = 0.4;
      p.push(box(2.1, 0.35, 4.6, K, 0, 0.6, 0));
      p.push(box(2.3, 0.8, 4.8, B, 0, 1.1, 0));
      p.push(box(0.45, 0.82, 4.82, Y, -0.5, 1.1, 0));
      p.push(box(0.45, 0.82, 4.82, Y, 0.5, 1.1, 0));
      p.push(box(2.1, 0.9, 1.9, B, 0, 1.95, -0.5));
      p.push(box(2.14, 0.55, 1.4, G, 0, 2.0, -0.5));
      p.push(box(1.9, 0.6, 0.08, G, 0, 1.95, -1.46));
      p.push(box(0.12, 0.5, 2.3, B, -1.09, 1.75, 1.2));
      p.push(box(0.12, 0.5, 2.3, B, 1.09, 1.75, 1.2));
      p.push(box(2.3, 0.5, 0.12, B, 0, 1.75, 2.35));
      for (const x of [-0.9, 0.9]) p.push(box(0.12, 0.8, 0.12, K, x, 2.8, 0.45));
      p.push(box(1.92, 0.12, 0.12, K, 0, 3.2, 0.45));
      for (const x of [-0.6, -0.2, 0.2, 0.6]) p.push(box(0.3, 0.25, 0.2, L, x, 3.35, 0.45));
      p.push(box(2.5, 0.3, 0.3, K, 0, 0.75, -2.45));
      p.push(box(2.5, 0.3, 0.3, K, 0, 0.75, 2.45));
      p.push(box(0.45, 0.22, 0.08, L, -0.75, 1.2, -2.42));
      p.push(box(0.45, 0.22, 0.08, L, 0.75, 1.2, -2.42));
      wheelPos = [[-1.15, -1.55], [1.15, -1.55], [-1.15, 1.55], [1.15, 1.55]];
      break;
    }
    case 'monster': {
      wheelR = 1.15; wheelW = 0.95;
      p.push(box(1.6, 0.4, 3.8, K, 0, 1.3, 0));
      p.push(box(2.8, 1.1, 4.6, B, 0, 2.3, 0));
      p.push(box(2.4, 0.9, 2.2, G, 0, 3.3, 0.5));
      p.push(box(2.45, 0.15, 2.0, B, 0, 3.8, 0.55));
      for (const x of [-1.0, 1.0]) p.push(box(0.15, 1.2, 0.15, K, x, 4.2, 1.2));
      p.push(box(2.2, 0.15, 0.15, K, 0, 4.8, 1.2));
      for (const x of [-0.75, -0.25, 0.25, 0.75]) p.push(box(0.35, 0.3, 0.2, L, x, 4.95, 1.2));
      for (const s of [-1, 1]) {
        p.push(box(0.05, 0.35, 3.2, Y, s * 1.42, 2.3, 0));
        for (let i = 0; i < 3; i++) p.push(box(0.05, 0.3, 0.6, Y, s * 1.42, 2.55, -1.5 + i * 0.5, (s * Math.PI) / 5));
      }
      p.push(box(3.0, 0.5, 0.5, Y, 0, 1.9, -2.45));
      p.push(box(3.0, 0.4, 0.4, K, 0, 1.9, 2.45));
      wheelPos = [[-1.85, -1.6], [1.85, -1.6], [-1.85, 1.6], [1.85, 1.6]];
      break;
    }
    case 'tank': {
      wheelR = 0.75; wheelW = 0.5;
      p.push(box(2.9, 0.3, 5.4, K, 0, 0.9, 0));
      p.push(box(2.8, 1.3, 5.6, B, 0, 1.6, 0));
      p.push(box(2.8, 0.9, 1.2, B, 0, 1.6, -2.95, -0.6));
      p.push(box(2.84, 0.25, 5.62, Y, 0, 1.95, 0));
      p.push(box(1.9, 0.85, 2.3, new THREE.Color(B).multiplyScalar(0.8).getHex(), 0, 2.65, 0.3));
      p.push(cyl(0.17, 0.17, 3.4, 8, K, 0, 2.75, -2.1, Math.PI / 2));
      p.push(cyl(0.26, 0.26, 0.5, 8, Y, 0, 2.75, -3.7, Math.PI / 2));
      p.push(cyl(0.4, 0.4, 0.15, 8, Y, 0, 3.12, 0.7));
      p.push(cyl(0.03, 0.03, 1.8, 4, K, 0.7, 3.9, 1.2));
      p.push(box(0.4, 0.2, 0.08, L, -0.9, 1.7, -3.2));
      p.push(box(0.4, 0.2, 0.08, L, 0.9, 1.7, -3.2));
      wheelPos = [[-1.55, -1.9], [1.55, -1.9], [-1.55, 0], [1.55, 0], [-1.55, 1.9], [1.55, 1.9]];
      break;
    }
    case 'dozer': {
      wheelR = 0.5; wheelW = 0.2;
      for (const s of [-1, 1]) {
        p.push(box(1.0, 1.3, 5.2, K, s * 1.6, 0.8, 0));
        p.push(box(1.02, 0.1, 5.22, 0x4a4a55, s * 1.6, 1.45, 0));
      }
      p.push(box(2.4, 1.4, 3.6, B, 0, 2.0, 0.4));
      p.push(box(2.44, 0.3, 3.62, Y, 0, 2.4, 0.4));
      p.push(box(1.8, 1.4, 1.6, B, 0, 3.4, 0.8));
      p.push(box(1.84, 0.8, 1.4, G, 0, 3.55, 0.8));
      p.push(box(2.0, 0.15, 1.8, Y, 0, 4.15, 0.8));
      p.push(cyl(0.15, 0.15, 1.6, 8, K, 0.8, 3.6, -0.4));
      for (const s of [-1, 1]) p.push(box(0.25, 0.3, 2.2, K, s * 1.3, 1.5, -2.3));
      p.push(box(3.4, 1.8, 0.3, Y, 0, 1.3, -3.4, 0.15));
      for (const s of [-1, 1]) p.push(box(1.2, 1.8, 0.3, Y, s * 2.2, 1.3, -3.2, 0.15, -s * 0.35));
      p.push(box(5.4, 0.22, 0.35, 0x9a9aa5, 0, 0.35, -3.45));
      for (const x of [-1.2, -0.4, 0.4, 1.2]) p.push(box(0.3, 1.5, 0.05, K, x, 1.35, -3.58, 0.15, 0, 0.5));
      for (const s of [-1, 1]) p.push(box(0.3, 0.3, 0.3, 0xff6a2b, s * 0.7, 4.35, 0.8));
      wheelPos = [[-2.15, -1.8], [2.15, -1.8], [-2.15, -0.6], [2.15, -0.6], [-2.15, 0.6], [2.15, 0.6], [-2.15, 1.8], [2.15, 1.8]];
      break;
    }
  }

  const group = new THREE.Group();
  const body = new THREE.Mesh(merge(p), mat);
  body.castShadow = true;
  group.add(body);

  const wg = merge([
    cyl(wheelR, wheelR, wheelW, 12, K, 0, 0, 0, 0, 0, Math.PI / 2),
    cyl(wheelR * 0.5, wheelR * 0.5, wheelW * 1.05, 8, Y, 0, 0, 0, 0, 0, Math.PI / 2),
  ]);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of wheelPos) {
    const w = new THREE.Mesh(wg, wheelMat);
    w.position.set(x, wheelR, z);
    w.castShadow = true;
    body.add(w);
    wheels.push(w);
  }
  group.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(group);
  const naturalHalfW = (bb.max.x - bb.min.x) / 2;
  const baseScale = targetHalfW / naturalHalfW;
  return {
    group,
    body,
    wheels,
    wheelRadius: wheelR,
    baseScale,
    halfW: targetHalfW,
    halfL: ((bb.max.z - bb.min.z) / 2) * baseScale,
    height: bb.max.y * baseScale,
  };
}

// ---------------------------------------------------------------- Textures

export function roadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4f5566';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(255,255,255,0.04)';
  for (let i = 0; i < 60; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 6, 6);
  g.fillStyle = '#f4f4f4';
  for (const x of [256 / 3, (2 * 256) / 3]) g.fillRect(x - 3, 0, 6, 128);
  g.fillStyle = '#ffd23f';
  g.fillRect(4, 0, 6, 256);
  g.fillRect(246, 0, 6, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function bannerTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  const sq = 32;
  for (let y = 0; y < 128; y += sq)
    for (let x = 0; x < 512; x += sq) {
      g.fillStyle = ((x + y) / sq) % 2 ? '#111' : '#fff';
      g.fillRect(x, y, sq, sq);
    }
  g.fillStyle = '#ff3b3b';
  g.fillRect(40, 18, 432, 92);
  g.font = '900 72px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

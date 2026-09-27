/**
 * Pooled effects. Everything is an InstancedMesh (one draw call per pool):
 *  - debris/confetti: lit boxes
 *  - glow: additive camera-facing quads (sparks, fire, flames, flashes)
 *  - dust: soft alpha quads
 *  - stars: additive sparkle quads
 *  - scrap orbs: additive glow + bright core
 * Additive particles fade by darkening their instance colour.
 */
import * as THREE from 'three';

interface Bit {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  w: THREE.Vector3;
  sc: THREE.Vector3;
  s: number;
  life: number;
  max: number;
  color: THREE.Color;
  kind: number;
  rot: number;
  spin: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qz = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);
const C_WHITE = new THREE.Color(0xffffff);
const C_YEL = new THREE.Color(0xffe066);
const C_ORA = new THREE.Color(0xff7a1a);
const C_RED = new THREE.Color(0xd9261c);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function canvasTex(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const radial = (stops: Array<[number, string]>) =>
  canvasTex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, c] of stops) r.addColorStop(o, c);
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });

class Pool {
  mesh: THREE.InstancedMesh;
  items: Bit[] = [];
  private cursor = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly max: number, shadow = false) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, C_WHITE);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.count = 0;
  }
  add(): Bit {
    let b: Bit;
    if (this.items.length < this.max) {
      b = {
        p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), sc: new THREE.Vector3(1, 1, 1),
        s: 1, life: 0, max: 1, color: new THREE.Color(), kind: 0, rot: 0, spin: 0,
      };
      this.items.push(b);
    } else {
      b = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
    }
    b.life = 0;
    b.rot = Math.random() * 6.28;
    b.spin = 0;
    b.sc.set(1, 1, 1);
    return b;
  }
  kill(i: number): void {
    const last = this.items.pop()!;
    if (i < this.items.length) this.items[i] = last;
  }
  clear(): void {
    this.items.length = 0;
    this.mesh.count = 0;
  }
  flush(n: number): void {
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

interface Ring { mesh: THREE.Mesh; life: number; max: number; size: number }

export class FX {
  private debris: Pool;
  private glow: Pool;
  private dustP: Pool;
  private starP: Pool;
  private orbGlow: Pool;
  private rings: Ring[] = [];
  private spheres: Ring[] = [];
  /** Where scrap orbs fly to. */
  target = new THREE.Vector3();
  onOrbArrive: () => void = () => {};

  constructor(scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const glowTex = radial([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)']]);
    const softTex = radial([[0, 'rgba(255,255,255,0.95)'], [0.55, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    const starTex = canvasTex((g, s) => {
      const c = s / 2;
      const r = g.createRadialGradient(c, c, 0, c, c, c * 0.5);
      r.addColorStop(0, 'rgba(255,255,255,0.9)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(c, 1);
      g.quadraticCurveTo(c, c, s - 1, c);
      g.quadraticCurveTo(c, c, c, s - 1);
      g.quadraticCurveTo(c, c, 1, c);
      g.quadraticCurveTo(c, c, c, 1);
      g.fill();
    });
    const add = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    this.debris = new Pool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 700, true);
    this.glow = new Pool(quad, add(glowTex), 900);
    this.dustP = new Pool(quad, new THREE.MeshBasicMaterial({ map: softTex, transparent: true, depthWrite: false, opacity: 0.85 }), 320);
    this.starP = new Pool(quad, add(starTex), 260);
    this.orbGlow = new Pool(quad, add(glowTex), 200);
    this.glow.mesh.renderOrder = 2;
    this.starP.mesh.renderOrder = 3;
    this.orbGlow.mesh.renderOrder = 3;
    scene.add(this.debris.mesh, this.dustP.mesh, this.glow.mesh, this.starP.mesh, this.orbGlow.mesh);

    const ringGeo = new THREE.RingGeometry(0.78, 1, 48);
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, life: 1, max: 1, size: 1 });
    }
    const sphGeo = new THREE.SphereGeometry(1, 24, 14);
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(sphGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.visible = false;
      scene.add(mesh);
      this.spheres.push({ mesh, life: 1, max: 1, size: 1 });
    }
  }

  clear(): void {
    for (const p of [this.debris, this.glow, this.dustP, this.starP, this.orbGlow]) p.clear();
    for (const r of [...this.rings, ...this.spheres]) {
      r.mesh.visible = false;
      r.life = r.max;
    }
  }

  /** Chunky debris thrown forward from an object. */
  burst(pos: THREE.Vector3, palette: number[], count: number, size: number, force: number, spread: THREE.Vector3): void {
    for (let i = 0; i < count; i++) {
      const b = this.debris.add();
      b.p.set(pos.x + (Math.random() - 0.5) * spread.x, pos.y + Math.random() * spread.y * 0.5, pos.z + (Math.random() - 0.5) * spread.z);
      const a = Math.random() * Math.PI * 2;
      const out = 3 + Math.random() * 6;
      b.v.set(Math.cos(a) * out, 6 + Math.random() * 9 * Math.min(2, force), -force * (5 + Math.random() * 10) + Math.sin(a) * out);
      b.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      b.w.set(rnd(-14, 14), rnd(-14, 14), rnd(-14, 14));
      b.s = size * (0.5 + Math.random() * 0.9);
      b.max = 1.2 + Math.random() * 0.8;
      b.kind = 0;
      b.color.setHex(palette[i % palette.length]);
    }
  }

  /** Flat fluttering confetti pieces. */
  confetti(pos: THREE.Vector3, count: number, size = 0.35, palette = [0xff4d6d, 0xffe14d, 0x4dd8ff, 0x7dffb0, 0xb45cff, 0xffffff]): void {
    for (let i = 0; i < count; i++) {
      const b = this.debris.add();
      b.p.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const out = rnd(4, 12);
      b.v.set(Math.cos(a) * out, rnd(8, 18), Math.sin(a) * out);
      b.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      b.w.set(rnd(-10, 10), rnd(-10, 10), rnd(-10, 10));
      b.s = size * rnd(0.7, 1.2);
      b.sc.set(1, 0.08, 0.6);
      b.max = rnd(1.6, 2.4);
      b.kind = 1;
      b.color.setHex(palette[i % palette.length]);
    }
  }

  dust(pos: THREE.Vector3, count: number, size: number, color = 0xf1e6d2): void {
    for (let i = 0; i < count; i++) {
      const b = this.dustP.add();
      b.p.set(pos.x + (Math.random() - 0.5) * size * 2, pos.y + Math.random() * size * 0.6, pos.z + (Math.random() - 0.5) * size * 2);
      b.v.set(rnd(-3, 3), rnd(1, 3), rnd(-3, 3));
      b.s = size * rnd(0.8, 1.4);
      b.max = rnd(0.5, 0.9);
      b.spin = rnd(-1, 1);
      b.color.setHex(color);
    }
  }

  sparks(pos: THREE.Vector3, count: number, color = 0xffe36b, speed = 1): void {
    for (let i = 0; i < count; i++) {
      const b = this.glow.add();
      b.p.copy(pos);
      b.v.set(rnd(-9, 9) * speed, rnd(3, 13) * speed, rnd(-9, 9) * speed);
      b.s = rnd(0.35, 0.6);
      b.max = rnd(0.25, 0.55);
      b.kind = 0;
      b.color.setHex(color);
    }
  }

  stars(pos: THREE.Vector3, count: number, color = 0xffffff, size = 1): void {
    for (let i = 0; i < count; i++) {
      const b = this.starP.add();
      b.p.set(pos.x + rnd(-0.6, 0.6), pos.y + rnd(0, 0.8), pos.z + rnd(-0.6, 0.6));
      b.v.set(rnd(-6, 6), rnd(4, 11), rnd(-6, 6));
      b.s = size * rnd(0.7, 1.4);
      b.max = rnd(0.5, 0.9);
      b.spin = rnd(-6, 6);
      b.color.setHex(color);
    }
  }

  /** Bright one-off flash billboard. */
  flash(pos: THREE.Vector3, size: number, color = 0xffffff, dur = 0.18): void {
    const b = this.glow.add();
    b.p.copy(pos);
    b.v.set(0, 0, 0);
    b.s = size;
    b.max = dur;
    b.kind = 2;
    b.color.setHex(color);
  }

  fireball(pos: THREE.Vector3, radius: number): void {
    for (let i = 0; i < 30; i++) {
      const b = this.glow.add();
      b.p.set(pos.x + rnd(-0.5, 0.5) * radius, pos.y + Math.random() * radius * 0.6, pos.z + rnd(-0.5, 0.5) * radius);
      b.v.set(rnd(-6, 6), rnd(3, 9), rnd(-6, 6));
      b.s = radius * rnd(0.5, 0.9);
      b.max = rnd(0.4, 0.75);
      b.kind = 1;
      b.color.copy(C_WHITE);
    }
    this.flash(pos, radius * 3.5, 0xfff1c4, 0.22);
    this.dust(pos, 10, radius * 0.6, 0x6b6470);
  }

  /** One frame of flamethrower output from `origin`, travelling toward -z. */
  flame(origin: THREE.Vector3, carrySpeed: number, width: number, reach: number): void {
    for (let i = 0; i < 4; i++) {
      const b = this.glow.add();
      b.p.set(origin.x + rnd(-0.3, 0.3) * width, origin.y + rnd(-0.2, 0.2), origin.z);
      b.v.set(rnd(-1, 1) * width * 2.2, rnd(0.3, 2.5), -(carrySpeed + reach * rnd(2.2, 3.2)));
      b.s = width * rnd(0.55, 0.9);
      b.max = rnd(0.3, 0.42);
      b.kind = 3;
      b.spin = rnd(-3, 3);
      b.color.copy(C_WHITE);
    }
    if (Math.random() < 0.3) {
      const d = this.dustP.add();
      d.p.set(origin.x, origin.y + 1, origin.z - reach * 0.7);
      d.v.set(rnd(-1, 1), rnd(2, 4), -carrySpeed * 0.8);
      d.s = width * 1.6;
      d.max = 0.6;
      d.color.setHex(0x55505a);
    }
  }

  /** Glowing streak segment: laid down every frame behind a moving car it forms a ribbon. */
  streak(pos: THREE.Vector3, color: number, size: number, life = 0.45): void {
    const b = this.glow.add();
    b.p.copy(pos);
    b.v.set(rnd(-0.3, 0.3), rnd(0, 0.4), rnd(0.5, 1.5));
    b.s = size;
    b.max = life;
    b.kind = 4;
    b.color.setHex(color);
  }

  /** Short glowing trail puff (speed boosts). */
  trail(pos: THREE.Vector3, color: number, size: number): void {
    const b = this.glow.add();
    b.p.copy(pos);
    b.v.set(rnd(-0.5, 0.5), rnd(0, 0.5), rnd(1, 3));
    b.s = size;
    b.max = 0.35;
    b.kind = 2;
    b.color.setHex(color);
  }

  ring(pos: THREE.Vector3, size: number, color: number, duration = 0.45, vertical = false): void {
    const r = this.rings.find((x) => x.life >= x.max) ?? this.rings[0];
    r.mesh.position.set(pos.x, vertical ? pos.y : 0.08, pos.z);
    r.mesh.rotation.set(vertical ? 0 : -Math.PI / 2, 0, 0);
    (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.life = 0;
    r.max = duration;
    r.size = size;
    r.mesh.visible = true;
  }

  sphere(pos: THREE.Vector3, radius: number, color: number, duration = 0.5): void {
    const r = this.spheres.find((x) => x.life >= x.max) ?? this.spheres[0];
    r.mesh.position.copy(pos);
    (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.life = 0;
    r.max = duration;
    r.size = radius;
    r.mesh.visible = true;
  }

  orbsFrom(pos: THREE.Vector3, n: number, gold = false): void {
    const count = Math.min(Math.ceil(n / 2), 6);
    for (let i = 0; i < count; i++) {
      const b = this.orbGlow.add();
      b.p.copy(pos);
      b.p.y += 1;
      b.v.set(rnd(-6, 6), rnd(6, 12), rnd(-6, 6));
      b.s = gold ? 0.9 : 0.55;
      b.max = rnd(0.3, 0.5); // delay before homing
      b.color.setHex(gold ? 0xffc62b : 0x4dffa0);
    }
  }

  update(dt: number, camQ: THREE.Quaternion): void {
    // ---- debris & confetti
    const d = this.debris;
    for (let i = d.items.length - 1; i >= 0; i--) {
      const b = d.items[i];
      b.life += dt;
      if (b.life >= b.max) {
        d.kill(i);
        continue;
      }
      if (b.kind === 1) {
        b.v.y -= 14 * dt;
        b.v.multiplyScalar(1 - 1.8 * dt);
      } else b.v.y -= 32 * dt;
      b.p.addScaledVector(b.v, dt);
      const half = b.s * 0.5 * b.sc.y;
      if (b.p.y < half) {
        b.p.y = half;
        b.v.y *= -0.35;
        b.v.x *= 0.7;
        b.v.z *= 0.7;
        b.w.multiplyScalar(0.7);
      }
      b.r.x += b.w.x * dt;
      b.r.y += b.w.y * dt;
      b.r.z += b.w.z * dt;
    }
    let n = 0;
    for (const b of d.items) {
      const k = Math.min(1, (b.max - b.life) / 0.3);
      _q.setFromEuler(b.r);
      _s.copy(b.sc).multiplyScalar(b.s * k);
      _m.compose(b.p, _q, _s);
      d.mesh.setMatrixAt(n, _m);
      d.mesh.setColorAt(n, b.color);
      n++;
    }
    d.flush(n);

    // ---- additive glow
    const g = this.glow;
    n = 0;
    for (let i = g.items.length - 1; i >= 0; i--) {
      const b = g.items[i];
      b.life += dt;
      if (b.life >= b.max) {
        g.kill(i);
        continue;
      }
      if (b.kind === 0) b.v.y -= 28 * dt;
      else if (b.kind === 1 || b.kind === 3) {
        b.v.multiplyScalar(1 - (b.kind === 3 ? 2.4 : 3) * dt);
        b.v.y += 4 * dt;
      }
      b.p.addScaledVector(b.v, dt);
      b.rot += b.spin * dt;
    }
    for (const b of g.items) {
      const t = b.life / b.max;
      let scale: number;
      switch (b.kind) {
        case 0:
          scale = b.s * (1 - t * 0.7);
          _c.copy(b.color).multiplyScalar(1 - t * t);
          break;
        case 2:
          scale = b.s * (0.6 + t * 0.8);
          _c.copy(b.color).multiplyScalar((1 - t) * (1 - t));
          break;
        case 4:
          scale = b.s * (1 - t * 0.6);
          _c.copy(b.color).multiplyScalar(1 - t);
          break;
        default: {
          // Fire/flame: white-hot -> yellow -> orange -> red, fading out.
          scale = b.s * (b.kind === 3 ? 0.45 + t * 2.4 : 0.6 + t * 1.2);
          if (t < 0.2) _c.copy(C_WHITE).lerp(C_YEL, t / 0.2);
          else if (t < 0.55) _c.copy(C_YEL).lerp(C_ORA, (t - 0.2) / 0.35);
          else _c.copy(C_ORA).lerp(C_RED, (t - 0.55) / 0.45);
          _c.multiplyScalar(Math.pow(1 - t, 1.3));
        }
      }
      _qz.setFromAxisAngle(Z, b.rot);
      _q.copy(camQ).multiply(_qz);
      _s.setScalar(Math.max(0.001, scale));
      _m.compose(b.p, _q, _s);
      g.mesh.setMatrixAt(n, _m);
      g.mesh.setColorAt(n, _c);
      n++;
    }
    g.flush(n);

    // ---- dust (alpha): grow then shrink
    const du = this.dustP;
    n = 0;
    for (let i = du.items.length - 1; i >= 0; i--) {
      const b = du.items[i];
      b.life += dt;
      if (b.life >= b.max) {
        du.kill(i);
        continue;
      }
      b.v.multiplyScalar(1 - 3 * dt);
      b.p.addScaledVector(b.v, dt);
      b.rot += b.spin * dt;
    }
    for (const b of du.items) {
      const t = b.life / b.max;
      _qz.setFromAxisAngle(Z, b.rot);
      _q.copy(camQ).multiply(_qz);
      _s.setScalar(Math.max(0.001, b.s * (0.6 + t) * (1 - t * t)));
      _m.compose(b.p, _q, _s);
      du.mesh.setMatrixAt(n, _m);
      du.mesh.setColorAt(n, b.color);
      n++;
    }
    du.flush(n);

    // ---- stars
    const st = this.starP;
    n = 0;
    for (let i = st.items.length - 1; i >= 0; i--) {
      const b = st.items[i];
      b.life += dt;
      if (b.life >= b.max) {
        st.kill(i);
        continue;
      }
      b.v.y -= 12 * dt;
      b.v.multiplyScalar(1 - 1.5 * dt);
      b.p.addScaledVector(b.v, dt);
      b.rot += b.spin * dt;
    }
    for (const b of st.items) {
      const t = b.life / b.max;
      const pop = t < 0.12 ? t / 0.12 : 1;
      _qz.setFromAxisAngle(Z, b.rot);
      _q.copy(camQ).multiply(_qz);
      _s.setScalar(Math.max(0.001, b.s * pop * (1 - t * 0.6)));
      _m.compose(b.p, _q, _s);
      st.mesh.setMatrixAt(n, _m);
      st.mesh.setColorAt(n, _c.copy(b.color).multiplyScalar(1 - t * t));
      n++;
    }
    st.flush(n);

    // ---- scrap orbs: pop out, then home in on the vehicle.
    const o = this.orbGlow;
    for (let i = o.items.length - 1; i >= 0; i--) {
      const b = o.items[i];
      b.life += dt;
      if (b.life < b.max) {
        b.v.y -= 20 * dt;
        b.p.addScaledVector(b.v, dt);
      } else {
        const to = _s.copy(this.target).sub(b.p);
        const dist = to.length();
        if (dist < 1.2 || b.life > 3) {
          o.kill(i);
          if (dist < 1.2) this.onOrbArrive();
          continue;
        }
        const speed = 28 + (b.life - b.max) * 100;
        b.v.lerp(to.multiplyScalar(speed / dist), Math.min(1, dt * 10));
        b.p.addScaledVector(b.v, dt);
      }
    }
    n = 0;
    _q.copy(camQ);
    for (const b of o.items) {
      const tw = 1 + Math.sin(b.life * 30) * 0.15;
      _s.setScalar(b.s * tw);
      _m.compose(b.p, _q, _s);
      o.mesh.setMatrixAt(n, _m);
      o.mesh.setColorAt(n, b.color);
      n++;
    }
    o.flush(n);

    for (const r of this.rings) {
      if (r.life >= r.max) continue;
      r.life += dt;
      const t = Math.min(1, r.life / r.max);
      const s = r.size * (0.15 + (1 - Math.pow(1 - t, 3)) * 0.85);
      r.mesh.scale.set(s, s, s);
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 1 - t;
      if (t >= 1) r.mesh.visible = false;
    }
    for (const r of this.spheres) {
      if (r.life >= r.max) continue;
      r.life += dt;
      const t = Math.min(1, r.life / r.max);
      r.mesh.scale.setScalar(r.size * (0.3 + (1 - Math.pow(1 - t, 2)) * 0.7));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - t) * (1 - t);
      if (t >= 1) r.mesh.visible = false;
    }
  }
}

import * as THREE from 'three';
import { AudioManager } from './audio';
import { HORIZON, createSky } from './sky';
import {
  BOSS_BONUS,
  HOOP_INVINCIBLE,
  BUILD_X,
  COMBO_STEPS,
  COMBO_WINDOW,
  COURSE_TIME,
  FINALE_TIME,
  POWERS,
  PROPS,
  ROAD_HALF,
  SIDEWALK,
  VEHICLES,
  tierBase,
  tierCap,
  type PowerKind,
  type PropDef,
  type PropId,
} from './config';
import { FX } from './fx';
import { HUD, fmt } from './hud';
import { drawPowerIcon } from './icons';
import { Input } from './input';
import { CHUNK, LevelGen, type ChunkResult } from './level';
import {
  RAMP,
  bannerTexture,
  buildBuildingVariants,
  buildHoopGeometry,
  buildLampGeometry,
  buildPropGeometries,
  buildRampGeometry,
  buildVehicle,
  roadTexture,
  type PropGeoms,
  type VehicleMesh,
} from './meshes';
import { Platform } from './platform/youtube';
import { parseSave, type SaveV1 } from './save';

type State = 'attract' | 'playing' | 'boss' | 'end';

interface Boss {
  vm: VehicleMesh;
  x: number;
  d: number;
  y: number;
  vel: THREE.Vector3; // x, y, d
  spin: THREE.Vector3;
  phase: 'intro' | 'charge' | 'after';
  t: number;
  playerWins: boolean;
  exploded: boolean;
  /** Player knock-back velocity (x, y, d) when the boss wins. */
  pv: THREE.Vector3;
  tumbleSpin: number;
}
type Cause = 'hit' | 'chain' | 'shock' | 'power';

interface Prop {
  def: PropDef;
  mesh: THREE.Mesh;
  poolKey: string;
  x: number;
  d: number;
  y: number;
  gold: boolean;
  finale: boolean;
  vd: number;
  state: 'idle' | 'flying' | 'dead';
  vel: THREE.Vector3; // x, y, d
  spin: THREE.Vector3;
  life: number;
  wobble: number;
  passChecked: boolean;
}

interface Ramp { mesh: THREE.Mesh; x: number; d: number; s: number }
interface Hoop { mesh: THREE.Mesh; x: number; d: number; y: number; r: number; passed: boolean }
interface Pickup { group: THREE.Group; kind: PowerKind; x: number; d: number; s: number; t: number }
interface Deco { mesh: THREE.Mesh; d: number; len: number; key: string }
interface ActivePower { kind: PowerKind; t: number; dur: number }

const MAX_TIER = VEHICLES.length - 1;
const GROWTH = 0.25; // vehicle grows up to +25% as its meter fills

/**
 * Patches a Lambert material with an animated world-space rainbow (used for invincibility).
 * uRainbow = 0 leaves the material untouched.
 */
function rainbowify(mat: THREE.MeshLambertMaterial, u: { uTime: { value: number }; uRainbow: { value: number } }): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uRainbow = u.uRainbow;
    sh.vertexShader =
      'varying vec3 vRbPos;\n' +
      sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vRbPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader =
      'uniform float uTime;\nuniform float uRainbow;\nvarying vec3 vRbPos;\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec3 rb = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + vRbPos.y * 0.3 + vRbPos.z * 0.1 + vRbPos.x * 0.08 - uTime * 1.4));
  diffuseColor.rgb = mix(diffuseColor.rgb, rb, uRainbow * 0.85);`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += rb * uRainbow * 0.5;');
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 520);
  private sun!: THREE.DirectionalLight;
  private road!: THREE.Mesh;
  private ground!: THREE.Mesh;
  private walks: THREE.Mesh[] = [];
  private deco: Deco[] = [];
  private decoFront = new Map<string, number>();
  private gateMesh!: THREE.Group;
  private fog!: THREE.Fog;

  private propMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private goldMat = new THREE.MeshLambertMaterial({ color: 0xffc62b, emissive: 0x8a5a00 });
  private geoms!: PropGeoms;
  private rampGeo!: THREE.BufferGeometry;
  private hoopGeo!: THREE.BufferGeometry;
  private hoopMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private hoopGlowMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  private pool = new Map<string, THREE.Mesh[]>();
  private rampPool: THREE.Mesh[] = [];
  private hoopPool: THREE.Mesh[] = [];
  private pickupPool = new Map<PowerKind, THREE.Group[]>();
  private dangerRing!: THREE.InstancedMesh;
  private dangerFill!: THREE.InstancedMesh;

  private vehicles: VehicleMesh[] = [];
  private fx: FX;
  private hud: HUD;
  private input: Input;
  private level = new LevelGen();
  readonly audio = new AudioManager();

  save: SaveV1 = parseSave('');

  // ---- run state ----
  private state: State = 'attract';
  private userPaused = false;
  private platformPaused = false;
  private get paused(): boolean {
    return this.userPaused || this.platformPaused;
  }
  private boss: Boss | null = null;
  private bossWon = false;
  private tumble = 0;
  /** Seconds of rainbow invincibility left (super speed / hoops). */
  private invT = 0;
  private rainbowAmt = 0;
  private invMax = 1;
  private readonly rainbowU = { uTime: { value: 0 }, uRainbow: { value: 0 } };
  private sky!: THREE.Mesh;
  private rim!: THREE.DirectionalLight;
  private readonly _col = new THREE.Color();
  private props: Prop[] = [];
  private ramps: Ramp[] = [];
  private hoops: Hoop[] = [];
  private pickups: Pickup[] = [];
  private genD = 0;
  private gateD = Infinity;
  private time = 0;
  private finaleActive = false;
  private finaleTimer = 0;
  private finaleAnnounced = false;
  private lastTickSec = 0;

  private tier = 0;
  private x = 0;
  private y = 0;
  private vy = 0;
  private d = 0;
  private speed = 0;
  private steer = 0;
  private vxImp = 0;
  private airborne = false;
  private airTime = 0;
  private onRamp: Ramp | null = null;
  private invuln = 0;
  private growAnim = 1;
  private growth = 0;
  private squash = 0;
  private jolt = 0;
  private hoopBoost = 0;
  private hoopHold = 0;
  private hoopChain = 0;
  private lastHoopT = -10;
  private power: ActivePower | null = null;

  private scrap = 0;
  private runScrap = 0;
  private damage = 0;
  private comboCount = 0;
  private comboTimer = 0;
  private comboMult = 1;
  private chainDollars = 0;
  private destroyed = 0;
  private finaleTotal = new Set<Prop>();
  private finaleDestroyed = 0;
  private lastBlockedPop = 0;
  private popBudget = 6;
  private pendingBlasts: { x: number; d: number; t: number; r: number }[] = [];

  private firstRun = true;
  private steeredOnce = false;

  // ---- feel (reserved for important moments) ----
  private hitstop = 0;
  private slowmo = 0;
  private shake = 0;
  private camPos = new THREE.Vector3();
  private camX = 0;
  private camScale = 1;
  private camBack = 20;
  private shadowScale = 0;
  private last = performance.now();

  private analytics = { runStartMs: 0, firstUpgradeS: -1, tierReached: 0, blocked: 0, powerups: 0, hoops: 0 };

  private readonly _v = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _qId = new THREE.Quaternion();

  // Adaptive resolution: step pixel ratio down on slow devices.
  private dpr = 1;
  private dprMin = 0.6;
  private perfAcc = 0;
  private perfFrames = 0;

  constructor(container: HTMLElement, private platform: Platform) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.dpr = dpr;
    this.dprMin = Math.min(dpr, 0.6);
    const q = new URLSearchParams(location.search).get('dpr');
    if (q && !platform.inPlayables) this.dpr = this.dprMin = Number(q) || dpr; // local testing
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 1.5, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.hud = new HUD(document.body);
    this.input = new Input(this.renderer.domElement);
    this.fx = new FX(this.scene);
    this.fx.onOrbArrive = () => this.audio.scrapTing();

    this.buildWorld();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());

    this.input.onPress(() => this.onPress());
    this.hud.onAgain = () => this.restart();
    this.hud.onUi = () => this.audio.uiClick();
    this.hud.onCountTick = (f) => this.audio.countTick(f);
    this.hud.onCountDone = (nb) => {
      this.audio.countDone();
      if (nb) this.audio.newBest();
    };
    this.hud.onPauseToggle = () => this.togglePause();
    this.hud.onMuteToggle = () => this.toggleMute();
    window.addEventListener('keydown', (e) => {
      // Esc resumes / pauses; never preventDefault on Esc.
      if (e.code === 'Escape') {
        if (this.userPaused) this.togglePause();
        else if (this.canPause) this.togglePause();
      } else if (e.code === 'KeyP' && (this.userPaused || this.canPause)) this.togglePause();
      else if (e.code === 'KeyM') this.toggleMute();
    });

    this.audio.setMusicMode('menu');
    this.resetRun();
    this.hud.showHint(true);
  }

  // =====================================================================
  // World setup
  // =====================================================================
  private buildWorld(): void {
    const s = this.scene;
    // Sunset: sky dome + warm key light from behind the camera + pink rim light from the sun ahead.
    s.background = HORIZON.clone();
    this.fog = new THREE.Fog(HORIZON.clone(), 100, 230);
    s.fog = this.fog;
    this.sky = createSky();
    s.add(this.sky);

    s.add(new THREE.HemisphereLight(0xffd9cc, 0x6e5a86, 1.75));
    this.sun = new THREE.DirectionalLight(0xffc690, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0015;
    s.add(this.sun, this.sun.target);
    this.rim = new THREE.DirectionalLight(0xff7a8a, 1.1);
    s.add(this.rim, this.rim.target);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 700), new THREE.MeshLambertMaterial({ color: 0xa8939c }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.ground.receiveShadow = true;
    s.add(this.ground);

    const tex = roadTexture();
    tex.repeat.set(1, 440 / 16);
    this.road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 440), new THREE.MeshLambertMaterial({ map: tex }));
    this.road.rotation.x = -Math.PI / 2;
    this.road.receiveShadow = true;
    s.add(this.road);

    const walkMat = new THREE.MeshLambertMaterial({ color: 0xe8e2d6 });
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(SIDEWALK, 0.25, 440), walkMat);
      w.position.set(side * (ROAD_HALF + SIDEWALK / 2), 0.1, 0);
      w.receiveShadow = true;
      s.add(w);
      this.walks.push(w);
    }

    this.geoms = buildPropGeometries();
    this.rampGeo = buildRampGeometry();
    this.hoopGeo = buildHoopGeometry();

    // City blocks + street furniture on both sides (recycled as we drive).
    const variants = buildBuildingVariants(12);
    const bMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const lampGeo = buildLampGeometry();
    for (const side of [-1, 1]) {
      let cursor = -80;
      const key = `b${side}`;
      for (let i = 0; i < 26; i++) {
        const v = variants[Math.floor(Math.random() * variants.length)];
        const mesh = new THREE.Mesh(v.geo, bMat);
        mesh.position.x = side * (BUILD_X + v.w / 2);
        const len = v.len + rnd(0.4, 2.2);
        this.deco.push({ mesh, d: cursor + len / 2, len, key });
        cursor += len;
        s.add(mesh);
      }
      this.decoFront.set(key, cursor);
      const k2 = `l${side}`;
      let c2 = -80;
      for (let i = 0; i < 22; i++) {
        const lamp = i % 2 === 0;
        const mesh = new THREE.Mesh(lamp ? lampGeo : this.geoms.get('tree', i), this.propMat);
        mesh.position.x = side * (ROAD_HALF + (lamp ? 0.7 : 2.6));
        if (lamp) mesh.rotation.y = side < 0 ? Math.PI : 0;
        else mesh.scale.setScalar(0.85);
        this.deco.push({ mesh, d: c2 + 7, len: 14, key: k2 });
        c2 += 14;
        s.add(mesh);
      }
      this.decoFront.set(k2, c2);
    }

    // Finale gate
    this.gateMesh = new THREE.Group();
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0xff3b3b });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 9, 1.2), pillarMat);
      p.position.set(side * (ROAD_HALF + 1), 4.5, 0);
      p.castShadow = true;
      this.gateMesh.add(p);
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5), new THREE.MeshBasicMaterial({ map: bannerTexture('FINALE'), side: THREE.DoubleSide }));
    banner.position.set(0, 8.5, 0);
    this.gateMesh.add(banner);
    this.gateMesh.visible = false;
    s.add(this.gateMesh);

    // Red "danger" rings under anything the current ride can't break.
    const ringGeo = new THREE.RingGeometry(0.84, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const fillGeo = new THREE.CircleGeometry(0.86, 40);
    fillGeo.rotateX(-Math.PI / 2);
    this.dangerRing = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.95, depthWrite: false }), 160);
    this.dangerFill = new THREE.InstancedMesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.2, depthWrite: false }), 160);
    for (const m of [this.dangerRing, this.dangerFill]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 1;
      s.add(m);
    }

    const wheelMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const vehMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    rainbowify(wheelMat, this.rainbowU);
    rainbowify(vehMat, this.rainbowU);
    for (const v of VEHICLES) {
      const vm = buildVehicle(v.id, v.halfW, vehMat, wheelMat);
      vm.group.visible = false;
      s.add(vm.group);
      this.vehicles.push(vm);
    }
  }

  // =====================================================================
  // Boss
  // =====================================================================
  private bossMesh: VehicleMesh | null = null;

  private getBossMesh(): VehicleMesh {
    if (!this.bossMesh) {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const vm = buildVehicle('tank', 3.3, mat, mat, { body: 0x3b3f4c, accent: 0xff2d3d, glass: 0xff8a8a });
      vm.group.visible = false;
      this.scene.add(vm.group);
      this.bossMesh = vm;
    }
    return this.bossMesh;
  }

  private startBoss(): void {
    this.state = 'boss';
    this.endPower();
    this.endChain();
    this.invT = 0;
    this.hoopBoost = 0;
    this.comboCount = 0;
    this.comboMult = 1;
    this.comboTimer = 0;
    this.clearRoadForBoss();
    const vm = this.getBossMesh();
    const playerWins = this.tier === MAX_TIER;
    this.boss = {
      vm,
      x: 0,
      d: this.d + 55 + 12 * this.camScale,
      y: 0,
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      phase: 'intro',
      t: 0,
      playerWins,
      exploded: false,
      pv: new THREE.Vector3(),
      tumbleSpin: 0,
    };
    vm.group.visible = true;
    vm.group.rotation.set(0, Math.PI, 0);
    vm.group.scale.setScalar(vm.baseScale);
    this.hud.showBanner('BOSS TANK!', playerWins ? 'SMASH IT, DOZER!' : 'ONLY A MEGA DOZER CAN WIN', 1.6, 'red');
    this.hud.doFlash('#ff4d4d', 0.35);
    this.audio.bossIntro();
    this.shake = Math.max(this.shake, 0.5);
  }

  /** Empty the road for the showdown: everything left poofs away. */
  private clearRoadForBoss(): void {
    let puffs = 0;
    for (const p of this.props) {
      if (p.state === 'dead') continue;
      if (p.state === 'idle' && puffs < 40 && p.d > this.d - 5 && p.d < this.d + 120) {
        this.fx.dust(this._v.set(p.x, p.def.h * 0.4, -p.d), 3, Math.max(0.6, p.def.hw * 0.8));
        puffs++;
      }
      p.state = 'dead';
      p.mesh.visible = false;
    }
    for (const r of this.ramps) this.releaseRamp(r);
    this.ramps.length = 0;
    for (const h of this.hoops) this.releaseHoop(h);
    this.hoops.length = 0;
    for (const p of this.pickups) this.releasePickup(p);
    this.pickups.length = 0;
    this.pendingBlasts.length = 0;
  }

  /** Lay the roadside city out again from the start line (d resets to 0 on replay). */
  private resetDeco(): void {
    const cursors = new Map<string, number>();
    for (const dec of this.deco) {
      const c = cursors.get(dec.key) ?? -80;
      dec.d = c + dec.len / 2;
      dec.mesh.position.z = -dec.d;
      cursors.set(dec.key, c + dec.len);
    }
    for (const [k, c] of cursors) this.decoFront.set(k, c);
  }

  private hideBoss(): void {
    if (this.bossMesh) this.bossMesh.group.visible = false;
    this.boss = null;
    this.tumble = 0;
  }

  /** Knock a prop out of the way without scoring (cutscene only). */
  private knock(p: Prop, dir: number): void {
    const pos = new THREE.Vector3(p.x, p.y + p.def.h * 0.5, -p.d);
    this.fx.burst(pos, p.def.debris, Math.ceil(p.def.debrisCount * 0.6), p.def.debrisSize, 0.4, new THREE.Vector3(p.def.hw * 2, p.def.h, p.def.hd * 2));
    this.audio.impact(p.def.material, p.def.power / 7, this.pan(p.x));
    if (p.def.breakStyle === 'launch') {
      p.state = 'flying';
      p.life = 0;
      const side = Math.sign(p.x) || (Math.random() < 0.5 ? -1 : 1);
      p.vel.set(side * rnd(4, 9), rnd(9, 14), dir * rnd(8, 14));
      p.spin.set(rnd(-8, 8), rnd(-6, 6), rnd(-8, 8));
    } else {
      p.state = 'dead';
      p.mesh.visible = false;
      this.fx.dust(pos, 4, p.def.hw);
    }
  }

  private updateBoss(dt: number): void {
    const b = this.boss;
    if (!b) return;
    const def = VEHICLES[this.tier];
    const bw = b.vm.halfW, bl = b.vm.halfL;
    b.t += dt;
    this.steer = lerp(this.steer, 0, Math.min(1, dt * 4));

    if (b.phase === 'intro' || b.phase === 'charge') {
      // Player lines up in the centre and rolls toward the boss.
      this.x = lerp(this.x, 0, Math.min(1, dt * 2.5));
      this.speed = lerp(this.speed, def.speed * 0.85, Math.min(1, dt * 2));
      this.d += this.speed * dt;
      if (b.phase === 'intro') {
        // Boss revs in place, kicking up dust.
        b.vm.group.position.x = b.x + Math.sin(b.t * 60) * 0.08;
        if (Math.random() < 0.5) this.fx.dust(this._v.set(b.x + rnd(-bw, bw), 0.3, -(b.d + bl)), 1, 1.5, 0x9a8a8a);
        if (b.t > 0.9) {
          b.phase = 'charge';
          b.t = 0;
        }
      } else {
        b.d -= 16 * dt;
        b.vm.group.position.x = b.x;
      }
      for (const w of b.vm.wheels) w.rotation.x += (b.phase === 'charge' ? 16 : 4) * dt;
      // Both vehicles plough through whatever is left on the road.
      for (const p of this.props) {
        if (p.state !== 'idle') continue;
        if (Math.abs(p.d - b.d) < p.def.hd + bl && Math.abs(p.x - b.x) < p.def.hw + bw) this.knock(p, -1);
        else if (Math.abs(p.d - this.d) < p.def.hd + this.halfL && Math.abs(p.x - this.x) < p.def.hw + this.halfW) this.knock(p, 1);
      }
      const gap = b.d - this.d - bl - this.halfL;
      if (b.phase === 'charge' && gap < 7 && this.slowmo <= 0) this.slowmo = 0.35; // dramatic lead-in
      if (gap <= 0) this.bossImpact(b);
    } else {
      // Aftermath.
      if (b.playerWins) {
        this.speed = Math.max(0, this.speed - 18 * dt);
        this.d += this.speed * dt;
        b.vel.y -= 30 * dt;
        b.x += b.vel.x * dt;
        b.y = Math.max(0, b.y + b.vel.y * dt);
        b.d += b.vel.z * dt;
        const g = b.vm.group;
        g.rotation.x += b.spin.x * dt;
        g.rotation.z += b.spin.z * dt;
        if (!b.exploded && b.t > 0.65) {
          b.exploded = true;
          const pos = this._v.set(b.x, b.y + 2, -b.d);
          this.fx.fireball(pos, 6);
          this.fx.sphere(pos, 12, 0xffb347, 0.45);
          this.fx.ring(pos, 26, 0xffd23f, 0.6);
          this.fx.confetti(pos, 50, 0.55);
          this.fx.burst(pos, [0x3b3f4c, 0xff2d3d, 0x222222], 36, 1, 1, new THREE.Vector3(6, 3, 6));
          this.fx.stars(pos, 20, 0xffe14d, 1.6);
          this.hud.doFlash('#fff1c4', 0.8);
          this.audio.bomb();
          this.audio.bossWin();
          this.shake = Math.max(this.shake, 1.3);
          g.visible = false;
        }
      } else {
        // Player gets launched backwards, tumbling; the boss rolls on and stops.
        b.pv.y -= 30 * dt;
        this.x += b.pv.x * dt;
        this.y += b.pv.y * dt;
        this.d += b.pv.z * dt;
        this.tumble += b.tumbleSpin * dt;
        if (this.y <= 0) {
          this.y = 0;
          if (b.pv.y < -5) {
            b.pv.y *= -0.35;
            b.pv.x *= 0.5;
            b.pv.z *= 0.5;
            b.tumbleSpin *= 0.4;
            this.fx.dust(this._v.set(this.x, 0, -this.d), 10, 1.2 * this.camScale);
            this.audio.land(this.tier / MAX_TIER);
            this.shake = Math.max(this.shake, 0.5);
          } else {
            b.pv.set(0, 0, 0);
            b.tumbleSpin = 0;
            this.tumble = lerp(this.tumble, Math.round(this.tumble / (Math.PI * 2)) * Math.PI * 2, Math.min(1, dt * 6));
          }
        }
        const lim = ROAD_HALF - this.halfW - 0.2;
        this.x = clamp(this.x, -lim, lim);
        const roll = Math.max(0, 6 - b.t * 4);
        b.d -= roll * dt;
        for (const w of b.vm.wheels) w.rotation.x += roll * dt;
        b.vm.group.position.x = b.x;
      }
      if (b.t > 2.8) void this.showEndScreen();
    }
    b.vm.group.position.set(b.vm.group.position.x, b.y, -b.d);
  }

  private bossImpact(b: Boss): void {
    b.phase = 'after';
    b.t = 0;
    this.slowmo = 0;
    this.hitstop = 0.16;
    this.shake = Math.max(this.shake, 1.5);
    const cd = this.d + this.halfL;
    const pos = this._v.set(0, 1.5, -cd);
    this.fx.flash(pos, 14, 0xffffff, 0.25);
    this.fx.sparks(pos, 60, 0xffe36b, 2.2);
    this.fx.fireball(pos, 3.5);
    this.fx.ring(pos, 20, 0xffffff, 0.5);
    this.hud.doFlash('#ffffff', 0.7);
    this.audio.bossHit();
    if (b.playerWins) {
      b.vel.set(rnd(-2, 2), 17, 26);
      b.spin.set(rnd(-4, -2), 0, rnd(-3, 3));
      if (!this.bossWon) {
        this.bossWon = true;
        this.addDamage(BOSS_BONUS);
        this.popupWorld(this._v.set(0, 6, -cd), `BOSS +${fmt(BOSS_BONUS)}`, 'pmax', 1.7, true);
      }
      this.hud.showBanner('YOU WIN!', 'BOSS DESTROYED', 2.2, 'gold');
    } else {
      b.pv.set(rnd(-4, 4), 15, -22);
      b.tumbleSpin = -7;
      this.speed = 0;
      this.hud.showBanner('BOSS WINS!', 'BECOME A MEGA DOZER TO BEAT IT', 2.4, 'red');
      this.audio.bossLose();
    }
  }

  onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- derived vehicle size ----
  private get sizeMul(): number {
    return 1 + GROWTH * this.growth;
  }
  private get halfW(): number {
    return this.vehicles[this.tier].halfW * this.sizeMul;
  }
  private get halfL(): number {
    return this.vehicles[this.tier].halfL * this.sizeMul;
  }
  private get height(): number {
    return this.vehicles[this.tier].height * this.sizeMul;
  }
  private get effPower(): number {
    return this.invT > 0 ? Infinity : VEHICLES[this.tier].power;
  }

  private get canPause(): boolean {
    return this.state === 'playing' || this.state === 'boss';
  }

  private togglePause(): void {
    if (!this.userPaused && !this.canPause) return;
    this.userPaused = !this.userPaused;
    this.applyPause();
    if (this.userPaused) void this.persist();
  }

  private toggleMute(): void {
    this.audio.unlock();
    this.save.muted = !this.save.muted;
    this.audio.setUserMuted(this.save.muted);
    this.hud.setMuted(this.save.muted);
    void this.persist();
  }

  private applyPause(): void {
    this.input.reset();
    this.audio.setPaused(this.paused);
    this.hud.showPause(this.userPaused);
    this.last = performance.now();
  }

  // =====================================================================
  // Run lifecycle
  // =====================================================================
  private resetRun(): void {
    for (const p of this.props) this.releaseProp(p);
    this.props.length = 0;
    for (const r of this.ramps) this.releaseRamp(r);
    this.ramps.length = 0;
    for (const h of this.hoops) this.releaseHoop(h);
    this.hoops.length = 0;
    for (const p of this.pickups) this.releasePickup(p);
    this.pickups.length = 0;
    this.fx.clear();
    this.level.reset();
    this.pendingBlasts.length = 0;
    this.gateMesh.visible = false;
    this.endPower();

    this.genD = 0;
    this.gateD = Infinity;
    this.time = 0;
    this.finaleActive = false;
    this.finaleTimer = 0;
    this.finaleAnnounced = false;
    this.lastTickSec = 0;
    this.tier = this.save.pendingBoost ? 1 : 0;
    this.x = 0;
    this.y = 0;
    this.vy = 0;
    this.d = 0;
    this.speed = 0;
    this.steer = 0;
    this.vxImp = 0;
    this.airborne = false;
    this.onRamp = null;
    this.invuln = 0;
    this.growAnim = 1;
    this.growth = 0;
    this.squash = 0;
    this.jolt = 0;
    this.hoopBoost = 0;
    this.hoopHold = 0;
    this.hoopChain = 0;
    this.scrap = 0;
    this.runScrap = 0;
    this.runScrapTotal = 0;
    this.damage = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMult = 1;
    this.chainDollars = 0;
    this.destroyed = 0;
    this.finaleTotal.clear();
    this.finaleDestroyed = 0;
    this.hitstop = 0;
    this.slowmo = 0;
    this.shake = 0;
    this.invT = 0;
    this.bossWon = false;
    this.hideBoss();
    this.analytics = { runStartMs: performance.now(), firstUpgradeS: -1, tierReached: this.tier, blocked: 0, powerups: 0, hoops: 0 };

    this.showVehicle();
    this.hud.setDamage(0, true);
    this.camScale = this.targetCamScale();
    this.resetDeco();
    this.generateAhead();
    this.updateCamera(1, true);
    this.updateWorldFollow();
  }

  private startRun(): void {
    if (this.save.pendingBoost) {
      this.save.pendingBoost = false;
      void this.persist();
    }
    this.state = 'playing';
    this.analytics.runStartMs = performance.now();
    this.hud.setPlayingVisible(true);
    this.audio.setMusicMode('play');
    this.audio.setIntensity(this.tier + 1);
    this.audio.uiConfirm();
    if (this.tier > 0) this.hud.showBanner(VEHICLES[this.tier].name, 'BOOST START', 1.4, 'gold');
  }

  restart(): void {
    this.hud.hideEnd();
    this.resetRun();
    this.input.reset();
    this.hud.showHint(false);
    this.startRun();
  }

  private onPress(): void {
    this.audio.unlock();
    if (this.paused) return;
    if (this.state === 'attract') this.startRun();
  }

  private finalePct(): number {
    return this.finaleTotal.size ? this.finaleDestroyed / this.finaleTotal.size : 0;
  }

  private finaleBonus(): number {
    return Math.round(this.finalePct() * 20 * tierBase(this.tier));
  }

  private async showEndScreen(): Promise<void> {
    if (this.state === 'end') return;
    this.state = 'end';
    this.hud.setPlayingVisible(false);
    this.audio.setMusicMode('end');
    const total = Math.round(this.damage + this.finaleBonus());
    this.save.totalScrap += this.runScrap;
    this.save.bestDamage = Math.max(this.save.bestDamage, total);
    this.save.bestTier = Math.max(this.save.bestTier, this.tier);
    this.save.runs++;
    this.hud.showEnd({ damage: total, victory: this.bossWon });
    this.runScrap = 0;
    if (import.meta.env.DEV) {
      console.info('[crash-lab analytics]', {
        ...this.analytics,
        runSeconds: (performance.now() - this.analytics.runStartMs) / 1000,
        destroyed: this.destroyed,
        tier: this.tier,
        damage: total,
        finalePct: this.finalePct(),
        bossWon: this.bossWon,
      });
    }
    await this.persist();
    void this.platform.sendScore(this.save.bestDamage);
  }

  /** Scrap earned across the whole run. */
  private runScrapTotal = 0;

  applySave(save: SaveV1): void {
    this.save = save;
    this.audio.setUserMuted(save.muted);
    this.hud.setMuted(save.muted);
    if (this.state === 'attract') this.resetRun();
  }

  async persist(): Promise<void> {
    await this.platform.saveRaw(JSON.stringify(this.save));
  }
  /** Platform (YouTube) pause/resume. Separate from the in-game pause button. */
  setPaused(p: boolean): void {
    if (this.platformPaused === p) return;
    this.platformPaused = p;
    this.applyPause();
    if (p) void this.persist();
  }

  // =====================================================================
  // Spawning & pools
  // =====================================================================
  private acquireMesh(id: PropId, variant: number, gold: boolean): { mesh: THREE.Mesh; key: string } {
    const v = variant % this.geoms.variants(id);
    const key = `${id}:${v}:${gold ? 1 : 0}`;
    let mesh = this.pool.get(key)?.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.geoms.get(id, v), gold ? this.goldMat : this.propMat);
      mesh.castShadow = true;
      mesh.receiveShadow = id === 'shop' || id === 'wall' || id === 'tower' || id === 'bus';
      this.scene.add(mesh);
    }
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.rotation.set(0, 0, 0);
    return { mesh, key };
  }

  private releaseProp(p: Prop): void {
    p.mesh.visible = false;
    let list = this.pool.get(p.poolKey);
    if (!list) this.pool.set(p.poolKey, (list = []));
    list.push(p.mesh);
  }

  private releaseRamp(r: Ramp): void {
    r.mesh.visible = false;
    this.rampPool.push(r.mesh);
  }

  private releaseHoop(h: Hoop): void {
    h.mesh.visible = false;
    this.hoopPool.push(h.mesh);
  }

  private releasePickup(p: Pickup): void {
    p.group.visible = false;
    let list = this.pickupPool.get(p.kind);
    if (!list) this.pickupPool.set(p.kind, (list = []));
    list.push(p.group);
  }

  private makePickup(kind: PowerKind): THREE.Group {
    const g = new THREE.Group();
    const color = POWERS[kind].color;
    const tex = new THREE.CanvasTexture(drawPowerIcon(kind));
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.scale.set(2.3, 2.3, 1);
    sprite.position.y = 2.2;
    sprite.name = 'icon';
    g.add(sprite);
    const add = { color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    const ringGeo = new THREE.RingGeometry(1.1, 1.55, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ ...add, opacity: 0.9 }));
    ring.position.y = 0.08;
    ring.name = 'ring';
    g.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.95, 10, 20, 1, true), new THREE.MeshBasicMaterial({ ...add, map: this.beamTex(), opacity: 0.55 }));
    beam.position.y = 5;
    g.add(beam);
    this.scene.add(g);
    return g;
  }

  private _beamTex: THREE.Texture | null = null;
  /** Vertical fade (bright at the base, transparent at the top) for pickup light beams. */
  private beamTex(): THREE.Texture {
    if (this._beamTex) return this._beamTex;
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 64, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 64);
    this._beamTex = new THREE.CanvasTexture(c);
    return this._beamTex;
  }

  private rampScale(): number {
    return clamp(this.halfW / 1.1, 1, 3.2);
  }

  private generateAhead(): void {
    if (this.state === 'boss' || this.state === 'end') return;
    const ahead = 160 + 28 * this.camScale;
    while (this.genD < this.d + ahead) {
      const finale = this.state === 'playing' && this.time >= COURSE_TIME;
      this.spawnChunk(this.level.generate(this.genD, VEHICLES[this.tier].power, finale, this.time));
      this.genD += CHUNK;
    }
  }

  private clearArea(x: number, d0: number, d1: number, hw: number): void {
    for (const p of this.props) {
      if (p.state !== 'idle' || p.vd !== 0) continue;
      if (p.d + p.def.hd > d0 && p.d - p.def.hd < d1 && Math.abs(p.x - x) < hw + p.def.hw) {
        p.state = 'dead';
        p.mesh.visible = false;
      }
    }
  }

  private spawnChunk(res: ChunkResult): void {
    for (const s of res.props) {
      const def = PROPS[s.id];
      const { mesh, key } = this.acquireMesh(s.id, s.variant, s.gold);
      const x = clamp(s.x, -ROAD_HALF + def.hw, ROAD_HALF - def.hw);
      const p: Prop = {
        def, mesh, poolKey: key, x, d: s.d, y: s.y * def.h, gold: s.gold, finale: s.finale, vd: s.vd,
        state: 'idle', vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, wobble: 0, passChecked: false,
      };
      mesh.position.set(x, p.y, -p.d);
      mesh.rotation.y = s.rotY;
      this.props.push(p);
    }
    for (const r of res.ramps) {
      const s = this.rampScale();
      const mesh = this.rampPool.pop() ?? this.newRampMesh();
      mesh.visible = true;
      mesh.scale.setScalar(s);
      mesh.position.set(r.x, 0, -r.d);
      this.ramps.push({ mesh, x: r.x, d: r.d, s });
      // Speed hoop floating midair at the apex of the jump off this ramp.
      const v = VEHICLES[this.tier];
      const vy = 8 + v.speed * 0.32; // matches the launch in updateRampsAndAir
      const tApex = vy / 30;
      const R = Math.max(1.8, this.halfW * 1.25, this.height * 0.7) + 0.6;
      const hd = r.d + RAMP.hl * s + v.speed * tApex;
      const hy = RAMP.h * s + (vy * vy) / 60 + this.height * 0.5;
      const hm = this.hoopPool.pop() ?? this.newHoopMesh();
      hm.visible = true;
      hm.scale.setScalar(R);
      hm.position.set(r.x, hy, -hd);
      this.hoops.push({ mesh: hm, x: r.x, d: hd, y: hy, r: R, passed: false });
      this.clearArea(r.x, r.d - RAMP.hl * s - 3, r.d + RAMP.hl * s + 1, RAMP.hw * s);
    }
    for (const pu of res.powerups) {
      const s = clamp(this.halfW / 0.9, 1, 2.4);
      const group = this.pickupPool.get(pu.kind)?.pop() ?? this.makePickup(pu.kind);
      group.visible = true;
      group.scale.setScalar(s);
      group.position.set(pu.x, 0, -pu.d);
      this.pickups.push({ group, kind: pu.kind, x: pu.x, d: pu.d, s, t: Math.random() * 6 });
      this.clearArea(pu.x, pu.d - 3 * s, pu.d + 3 * s, 2 * s);
    }
    if (res.gate !== undefined) {
      this.gateD = res.gate;
      this.gateMesh.position.set(0, 0, -res.gate);
      this.gateMesh.visible = true;
    }
  }

  private newRampMesh(): THREE.Mesh {
    const m = new THREE.Mesh(this.rampGeo, this.propMat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  }

  private newHoopMesh(): THREE.Mesh {
    const m = new THREE.Mesh(this.hoopGeo, this.hoopMat);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 6, 40), this.hoopGlowMat);
    m.add(glow);
    this.scene.add(m);
    return m;
  }

  // =====================================================================
  // Main loop
  // =====================================================================
  /** Dev-only (?capture): the clock only advances via step(), for smooth recorded previews. */
  private manualClock = !this.platform.inPlayables && new URLSearchParams(location.search).has('capture');

  /** Dev/capture helper: fill the meter exactly enough for ONE upgrade. */
  debugUpgrade(): void {
    if (this.platform.inPlayables || this.tier >= MAX_TIER) return;
    this.scrap = VEHICLES[this.tier].scrapToNext;
  }

  step(dt: number): void {
    if (!this.manualClock) return;
    this.tick(dt);
  }

  frame = (now: number): void => {
    const realDt = Math.min(1 / 15, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.manualClock) {
      requestAnimationFrame(this.frame);
      return;
    }
    this.tick(realDt);
    requestAnimationFrame(this.frame);
  };

  private tick(realDt: number): void {
    if (this.paused) return;
    let scale = 1;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      scale = 0.05;
    } else if (this.slowmo > 0) {
      this.slowmo -= realDt;
      scale = 0.35;
    }
    this.update(realDt * scale, realDt);
    this.renderer.render(this.scene, this.camera);
    if (!this.manualClock) this.adaptResolution(realDt);
  }

  private adaptResolution(realDt: number): void {
    if (this.dpr <= this.dprMin || this.state !== 'playing') return;
    this.perfAcc += realDt;
    this.perfFrames++;
    if (this.perfAcc < 2) return;
    const avg = this.perfAcc / this.perfFrames;
    this.perfAcc = 0;
    this.perfFrames = 0;
    if (avg > 1 / 45) {
      this.dpr = Math.max(this.dprMin, this.dpr - 0.25);
      this.renderer.setPixelRatio(this.dpr);
      this.onResize();
    }
  }

  renderOnce(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private update(dt: number, realDt: number): void {
    const def = VEHICLES[this.tier];
    this.popBudget = Math.min(6, this.popBudget + realDt * 12);

    if (this.state === 'playing') {
      this.time += dt;
      this.updateTimers(dt);
    }
    if (this.state === 'boss') this.updateBoss(dt);
    if (this.invT > 0) this.invT = Math.max(0, this.invT - dt);

    const driving = this.state === 'playing';
    const superOn = this.power?.kind === 'speed';
    if (this.state === 'playing') {
      const tgt = this.input.target;
      const rate = this.input.pointerDown || tgt !== 0 ? 12 : 4;
      this.steer = lerp(this.steer, tgt, Math.min(1, dt * rate));
      if (Math.abs(tgt) > 0.3 && !this.steeredOnce) {
        this.steeredOnce = true;
        this.hud.showHint(false);
      }
      if (this.hoopHold > 0) this.hoopHold -= dt;
      else this.hoopBoost = Math.max(0, this.hoopBoost - 4 * dt);
      const maxSpeed = Math.min(def.speed * 1.9, def.speed * (superOn ? 1.7 : 1) + this.hoopBoost);
      const accel = superOn || this.hoopBoost > 0 ? 45 : 9 + this.tier * 2.5;
      if (this.speed < maxSpeed) this.speed = Math.min(maxSpeed, this.speed + accel * dt);
      else this.speed = Math.max(maxSpeed, this.speed - 12 * dt);
    } else if (this.state === 'end') {
      this.speed = 0;
    }

    const prevD = this.d;
    if (driving) {
      this.x += (this.steer * def.steering + this.vxImp) * dt;
      this.vxImp *= Math.exp(-6 * dt);
      const lim = ROAD_HALF - this.halfW - 0.2;
      if (this.x > lim) { this.x = lim; this.vxImp = Math.min(0, this.vxImp); }
      if (this.x < -lim) { this.x = -lim; this.vxImp = Math.max(0, this.vxImp); }
      this.d += this.speed * dt;
      this.updateRampsAndAir(dt);
      this.collide();
      this.collectPickups();
      this.checkHoops(prevD);
      this.updatePower(dt);
      this.invuln -= dt;
    }

    this.updateProps(dt);
    this.updateBlasts(dt);
    this.updateCombo(dt);
    this.generateAhead();
    this.cleanup();

    if (this.state === 'playing' && this.scrap >= def.scrapToNext) {
      if (this.tier < MAX_TIER) this.transform();
      else this.megaSmash();
    }

    const targetGrowth = clamp(this.scrap / VEHICLES[this.tier].scrapToNext, 0, 1);
    this.growth = lerp(this.growth, targetGrowth, Math.min(1, realDt * 4));

    this.updateVehicleVisual(dt, realDt);
    this.fx.target.set(this.x, this.y + this.height * 0.6, -this.d);
    this.updateCamera(realDt, false);
    this.updateWorldFollow();
    this.updateDangerRings();
    this.updatePickupsVisual(realDt);
    this.fx.update(dt, this.camera.quaternion);
    this.updateRainbow(realDt, driving);
    this.updateHud(realDt);
  }

  /** Rainbow body shader + rainbow streaks while invincible. */
  private updateRainbow(realDt: number, driving: boolean): void {
    const now = performance.now() / 1000;
    this.rainbowU.uTime.value = now;
    // Blink in the last 0.8 s as a warning that it's about to end.
    let target = this.invT > 0 ? 1 : 0;
    if (this.invT > 0 && this.invT < 0.8 && Math.sin(now * 28) < 0) target = 0.25;
    this.rainbowAmt = lerp(this.rainbowAmt, target, Math.min(1, realDt * 14));
    this.rainbowU.uRainbow.value = this.rainbowAmt;
    if (this.invT <= 0 || !driving) return;
    const hue = (now * 0.9) % 1;
    const back = -(this.d - this.halfL * 0.9);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        this._col.setHSL((hue + k * 0.33 + (side > 0 ? 0.16 : 0)) % 1, 1, 0.6);
        this._v2.set(this.x + side * this.halfW * 0.85, this.y + this.height * (0.2 + k * 0.4), back);
        this.fx.streak(this._v2, this._col.getHex(), 0.45 + this.halfW * 0.28);
      }
    }
  }

  private updateTimers(dt: number): void {
    if (!this.finaleAnnounced && this.time >= COURSE_TIME) {
      this.finaleAnnounced = true;
      this.hud.showBanner('FINALE AHEAD!', 'GET READY', 1.5, 'gold');
      this.audio.bannerWhoosh();
    }
    if (!this.finaleActive && this.d >= this.gateD) {
      this.finaleActive = true;
      this.finaleTimer = FINALE_TIME;
      this.hud.showBanner('FINALE!', 'SMASH EVERYTHING', 1.6, 'red');
      this.hud.doFlash('#ffffff', 0.6);
      this.audio.finaleStart();
      this.audio.setIntensity(8);
      this.shake = Math.max(this.shake, 0.6);
    }
    if (!this.finaleActive && this.time > COURSE_TIME + 20) {
      this.finaleActive = true;
      this.finaleTimer = 5;
    }
    if (this.finaleActive) {
      this.finaleTimer -= dt;
      const sec = Math.ceil(this.finaleTimer);
      if (sec <= 5 && sec >= 1 && sec !== this.lastTickSec) {
        this.lastTickSec = sec;
        this.audio.tick(sec === 1);
      }
      if (this.finaleTimer <= 0) {
        this.finaleTimer = 0;
        this.audio.timeUp();
        this.startBoss();
      }
    }
  }

  private updateRampsAndAir(dt: number): void {
    if (!this.airborne) {
      let on: Ramp | null = null;
      for (const r of this.ramps) {
        const hl = RAMP.hl * r.s;
        if (Math.abs(this.x - r.x) < RAMP.hw * r.s + this.halfW * 0.5 && this.d > r.d - hl && this.d < r.d + hl) {
          on = r;
          break;
        }
      }
      if (on) {
        this.onRamp = on;
        const hl = RAMP.hl * on.s;
        this.y = (RAMP.h * on.s * (this.d - (on.d - hl))) / (2 * hl);
      } else if (this.onRamp) {
        const r = this.onRamp;
        if (this.d >= r.d + RAMP.hl * r.s - 0.5) {
          this.airborne = true;
          this.airTime = 0;
          this.vy = 8 + this.speed * 0.32;
          this.audio.launch();
        } else this.y = 0;
        this.onRamp = null;
      } else this.y = 0;
    }
    if (this.airborne) {
      this.airTime += dt;
      this.vy -= 30 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.airborne = false;
        this.land();
      }
    }
  }

  private land(): void {
    const pos = this._v.set(this.x, 0, -this.d);
    this.fx.dust(pos, 14, 1.2 * this.camScale);
    this.fx.ring(pos, 6 + this.camScale * 3, 0xffffff, 0.4);
    this.squash = 1;
    this.audio.land(this.tier / MAX_TIER);
    this.shockwave(this.x, this.d, 3.5 + this.halfW * 2, VEHICLES[this.tier].power);
    if (this.airTime > 0.35) {
      const bonus = Math.round(this.airTime * 3 * tierBase(this.tier));
      this.addDamage(bonus);
      this.popupWorld(this._v.set(this.x, 3, -this.d), `AIR ${this.airTime.toFixed(1)}s +${fmt(bonus)}`, 'pink', 1.1, true);
    }
  }

  // =====================================================================
  // Pickups, hoops, powers
  // =====================================================================
  private collectPickups(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (Math.abs(p.x - this.x) < this.halfW + 1.5 * p.s && Math.abs(p.d - this.d) < this.halfL + 1.3 * p.s) {
        this.pickups.splice(i, 1);
        this.releasePickup(p);
        this.activatePower(p.kind, this._v2.set(p.x, 2, -p.d));
      }
    }
  }

  private activatePower(kind: PowerKind, pos: THREE.Vector3): void {
    this.analytics.powerups++;
    const info = POWERS[kind];
    this.fx.stars(pos, 16, info.color, 1.2);
    this.fx.ring(pos, 8, info.color, 0.5);
    this.audio.powerPickup(kind);
    const cls = kind === 'speed' ? 'rainbow' : kind === 'bomb' ? 'red' : 'orange';
    this.hud.showBanner(info.name + '!', kind === 'speed' ? 'INVINCIBLE — SMASH ANYTHING' : '', 1.3, cls);
    if (kind === 'bomb') {
      this.detonate();
      return;
    }
    this.endPower();
    this.power = { kind, t: info.dur, dur: info.dur };
    this.shake = Math.max(this.shake, 0.35);
    this.slowmo = Math.max(this.slowmo, 0.15);
    this.hud.doFlash(info.css, 0.3);
    if (kind === 'speed') {
      this.audio.setWind(true);
      this.startInvincible(info.dur);
    } else this.audio.setFlame(true);
  }

  private endPower(): void {
    this.power = null;
    this.audio.stopLoops();
  }

  private detonate(): void {
    const R = 14 + this.halfW * 4;
    const cd = this.d + R * 0.3;
    const pos = this._v2.set(this.x, 1.5, -cd);
    this.fx.sphere(pos, R, 0xffb347, 0.4);
    this.fx.ring(pos, R * 2.2, 0xffd23f, 0.6);
    this.fx.ring(pos, R * 1.4, 0xffffff, 0.4);
    this.fx.fireball(pos, 4 + this.halfW);
    this.fx.sparks(pos, 40, 0xffd23f, 2);
    this.fx.confetti(pos, 30, 0.5);
    this.hud.doFlash('#fff1c4', 0.8);
    this.audio.bomb();
    this.shake = Math.max(this.shake, 1.3);
    this.hitstop = 0.08;
    this.slowmo = 0.5;
    const from = { x: this.x, d: cd };
    const before = this.damage;
    this.quietPops = true;
    for (const p of this.props) {
      if (p.state !== 'idle') continue;
      const dx = p.x - this.x, dd = p.d - cd;
      if (dx * dx + dd * dd < R * R) this.smash(p, 'power', from);
    }
    this.quietPops = false;
    const total = this.damage - before;
    if (total > 0) this.popupWorld(this._v2.set(this.x, 4, -cd), `BOOM! +${fmt(total)}`, 'pmax', 1.6, true);
  }

  /** Suppresses per-object popups during mass destruction (a summary is shown instead). */
  private quietPops = false;

  private checkHoops(prevD: number): void {
    for (const h of this.hoops) {
      if (h.passed || h.d <= prevD || h.d > this.d) continue;
      h.passed = true;
      // Must actually fly through the ring (it floats midair past the ramp).
      const cy = this.y + this.height * 0.5;
      if (Math.abs(this.x - h.x) > h.r * 1.0 || Math.abs(cy - h.y) > h.r * 1.05) continue;
      const t = this.time;
      this.hoopChain = t - this.lastHoopT < 6 ? this.hoopChain + 1 : 0;
      this.lastHoopT = t;
      this.analytics.hoops++;
      const def = VEHICLES[this.tier];
      this.hoopBoost = Math.min(def.speed * 0.8, this.hoopBoost + def.speed * 0.45);
      this.hoopHold = 1.4;
      const pos = this._v2.set(h.x, h.y, -h.d);
      this.fx.ring(pos, h.r * 2.2, 0xffe14d, 0.45, true);
      this.fx.stars(pos, 16, 0xffffff, 1.2);
      this.audio.hoop(this.hoopChain);
      this.startInvincible(HOOP_INVINCIBLE);
      this.popupWorld(pos, this.hoopChain > 0 ? `INVINCIBLE x${this.hoopChain + 1}` : 'INVINCIBLE!', 'rainbow', 1.3, true);
    }
  }

  private updatePower(dt: number): void {
    const pw = this.power;
    if (!pw) return;
    pw.t -= dt;
    if (pw.kind === 'flame') {
      const reach = 7 + this.halfW * 3.5;
      const origin = this._v2.set(this.x, this.y + this.height * 0.45, -(this.d + this.halfL));
      this.fx.flame(origin, this.speed, 0.8 + this.halfW * 0.6, reach);
      for (const p of this.props) {
        if (p.state !== 'idle') continue;
        const dd = p.d - this.d;
        if (dd < this.halfL * 0.3 - p.def.hd || dd > this.halfL + reach + p.def.hd) continue;
        const width = this.halfW + 0.6 + Math.max(0, dd - this.halfL) * 0.3;
        if (Math.abs(p.x - this.x) < width + p.def.hw) this.smash(p, 'power');
      }
    }
    if (pw.t <= 0) this.endPower();
  }

  private startInvincible(seconds: number): void {
    if (this.invT <= 0) this.audio.invincible();
    if (seconds > this.invT) {
      this.invT = seconds;
      this.invMax = seconds;
    }
  }

  // =====================================================================
  // Collision & destruction
  // =====================================================================
  private collide(): void {
    const hw = this.halfW, hl = this.halfL;
    const power = this.effPower;
    for (const p of this.props) {
      if (p.state !== 'idle') continue;
      if (Math.abs(p.d - this.d) > p.def.hd + hl) continue;
      if (Math.abs(p.x - this.x) > p.def.hw + hw) continue;
      if (this.y > p.y + p.def.h * 0.8) continue;
      if (power >= p.def.power) this.smash(p, this.invT > 0 ? 'power' : 'hit');
      else this.blocked(p);
    }
    for (const p of this.props) {
      if (p.passChecked || p.state !== 'idle') continue;
      if (p.d > this.d - p.def.hd - hl) continue;
      p.passChecked = true;
      if (p.def.power <= power || this.airborne) continue;
      const gap = Math.abs(p.x - this.x) - p.def.hw - hw;
      if (gap >= 0 && gap < 0.9) {
        const bonus = 2 * tierBase(this.tier);
        this.addDamage(bonus);
        this.audio.nearMiss();
        this.popupWorld(this._v.set(this.x, 2.5, -this.d), `NEAR MISS +${fmt(bonus)}`, 'green', 1, true);
      }
    }
  }

  private currentMult(): number {
    let m = 1;
    for (const [n, mult] of COMBO_STEPS) if (this.comboCount >= n) m = mult;
    return m;
  }

  private addDamage(v: number): void {
    this.damage = Math.min(Number.MAX_SAFE_INTEGER, this.damage + v);
  }

  private pan(x: number): number {
    return clamp((x - this.camX) / (8 * this.camScale), -1, 1);
  }

  private smash(p: Prop, cause: Cause, from?: { x: number; d: number }): void {
    if (p.state !== 'idle') return;
    const def = p.def;
    const v = VEHICLES[this.tier];

    this.comboCount++;
    this.comboTimer = COMBO_WINDOW;
    const mult = this.currentMult();
    if (mult > this.comboMult) {
      const lvl = COMBO_STEPS.findIndex(([, m]) => m === mult);
      this.audio.combo(lvl);
      this.hud.comboLevelUp();
      if (mult === 8) this.hud.showBanner('MAX COMBO!', 'x8', 0.9, 'pink');
    }
    this.comboMult = mult;

    // Money: base digit x 10^tier, capped to the tier's digit count (tier 0 => max $9).
    const speed01 = clamp(this.speed / v.speed, 0, 1);
    const impact = cause === 'hit' ? 1 + speed01 * 0.3 : cause === 'chain' ? 1.2 : 1;
    const goldMult = p.gold ? 5 : 1;
    const cap = tierCap(this.tier);
    const dollars = clamp(Math.round(def.value * tierBase(this.tier) * rnd(0.85, 1.2) * mult * impact * goldMult), 1, cap);
    const scrapGain = Math.ceil(def.scrap * goldMult * (1 + (mult - 1) * 0.15));
    this.addDamage(dollars);
    this.chainDollars += dollars;
    this.scrap += scrapGain;
    this.runScrap += scrapGain;
    this.runScrapTotal += scrapGain;
    this.destroyed++;
    if (p.finale) {
      this.finaleDestroyed++;
      this.finaleTotal.add(p);
    }
    this.hud.pulseMeter();

    const pos = new THREE.Vector3(p.x, p.y + def.h * 0.5, -p.d);
    const force = cause === 'hit' ? 0.6 + speed01 * 0.8 : 0.5;
    this.fx.orbsFrom(pos, scrapGain, p.gold);
    this.audio.impact(def.material, def.power / 7, this.pan(p.x));
    this.fx.flash(pos, 1.5 + Math.max(def.hw, def.h * 0.4) * 1.6, p.gold ? 0xffd23f : 0xfff6d8, 0.14);
    if (cause === 'hit') this.squash = Math.max(this.squash, 0.4 + def.power * 0.06);
    const maxed = dollars === cap;
    if (p.gold) {
      this.fx.stars(pos, 12, 0xffd23f, 1.2);
      this.audio.sparkle(1);
    } else if (maxed) this.fx.stars(pos, 5, 0xfff1a8, 0.9);

    const frac = dollars / cap;
    const cls = p.gold ? 'gold' : maxed ? 'pmax' : frac > 0.5 ? 'p3' : frac > 0.2 ? 'p2' : '';
    const text = `+${fmt(dollars)}`;
    if (!this.quietPops) this.popupWorld(pos, text, cls, 0.8 + frac * 0.5 + (maxed || p.gold ? 0.25 : 0), p.gold);

    const spread = new THREE.Vector3(def.hw * 2, def.h, def.hd * 2);
    switch (def.breakStyle) {
      case 'burst':
        this.fx.burst(pos, def.debris, def.debrisCount, def.debrisSize, force, spread);
        this.fx.dust(pos, 3, 0.6);
        p.state = 'dead';
        p.mesh.visible = false;
        break;
      case 'launch': {
        p.state = 'flying';
        p.life = 0;
        const massRatio = clamp(v.mass / (def.mass + 0.5), 0.6, 4);
        if (from) {
          const dx = p.x - from.x, dd = p.d - from.d;
          const len = Math.hypot(dx, dd) || 1;
          p.vel.set((dx / len) * rnd(10, 18), rnd(10, 18), (dd / len) * rnd(10, 18));
        } else if (cause === 'hit' || cause === 'power') {
          const side = Math.sign(p.x - this.x) || (Math.random() < 0.5 ? -1 : 1);
          p.vel.set(side * rnd(2, 6) * massRatio * 0.6, rnd(7, 12) * Math.sqrt(massRatio) * 0.7, this.speed * rnd(0.9, 1.4) + 4);
        } else p.vel.set(rnd(-6, 6), rnd(8, 14), rnd(-2, 8));
        p.spin.set(rnd(-8, 8), rnd(-6, 6), rnd(-8, 8));
        this.fx.burst(pos, def.debris, Math.ceil(def.debrisCount * 0.5), def.debrisSize, force, spread);
        break;
      }
      case 'fracture':
        this.fx.burst(pos, def.debris, def.debrisCount, def.debrisSize, force, spread);
        this.fx.dust(new THREE.Vector3(p.x, 0.5, -p.d), 10, def.hw * 0.9);
        this.fx.ring(new THREE.Vector3(p.x, 0, -p.d), def.hw * 3, 0xffffff, 0.5);
        this.fx.confetti(pos, 8, 0.4, def.debris);
        p.state = 'dead';
        p.mesh.visible = false;
        break;
    }
    if (def.material === 'metal' && cause === 'hit') this.fx.sparks(pos, 8);
    if (cause === 'power' && this.power?.kind === 'flame') this.fx.fireball(pos, 1 + def.hw * 0.5);
    if (def.explosive) this.pendingBlasts.push({ x: p.x, d: p.d, t: 0.06, r: 6.5 });
  }

  private blocked(p: Prop): void {
    if (this.invuln > 0) return;
    this.invuln = 0.35;
    this.speed *= 0.35;
    this.hoopBoost = 0;
    this.analytics.blocked++;
    let side = Math.sign(this.x - p.x) || (Math.random() < 0.5 ? -1 : 1);
    const lim = ROAD_HALF - this.halfW - 0.2;
    let nx = p.x + side * (p.def.hw + this.halfW + 0.1);
    if (Math.abs(nx) > lim) {
      side = -side;
      nx = p.x + side * (p.def.hw + this.halfW + 0.1);
    }
    this.x = clamp(nx, -lim, lim);
    this.vxImp = side * 9;
    this.endChain();
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMult = 1;
    p.wobble = 1;
    this.jolt = 1;
    this.fx.sparks(new THREE.Vector3(p.x - side * p.def.hw, 0.8, -p.d + p.def.hd), 12);
    this.fx.flash(new THREE.Vector3(p.x - side * p.def.hw, 1, -p.d + p.def.hd), 3, 0xff4d4d, 0.2);
    this.audio.blocked(this.pan(p.x));
    const now = performance.now();
    if (now - this.lastBlockedPop > 700) {
      this.lastBlockedPop = now;
      this.popupWorld(new THREE.Vector3(p.x, p.def.h + 0.5, -p.d), 'TOO BIG!', 'red', 1.1, true);
    }
  }

  private updateBlasts(dt: number): void {
    for (let i = this.pendingBlasts.length - 1; i >= 0; i--) {
      const b = this.pendingBlasts[i];
      b.t -= dt;
      if (b.t > 0) continue;
      this.pendingBlasts.splice(i, 1);
      const pos = new THREE.Vector3(b.x, 1, -b.d);
      this.fx.fireball(pos, 3);
      this.fx.ring(pos, b.r * 2, 0xffc53d, 0.45);
      this.audio.explosion();
      this.shockwave(b.x, b.d, b.r, Math.max(VEHICLES[this.tier].power + 1, 3), 'chain');
      const dx = this.x - b.x, dd = this.d - b.d;
      if (dx * dx + dd * dd < b.r * b.r) this.vxImp += Math.sign(dx || 1) * 6;
    }
  }

  private shockwave(x: number, d: number, r: number, power: number, cause: Cause = 'shock'): void {
    for (const p of this.props) {
      if (p.state !== 'idle' || p.def.power > power) continue;
      const dx = p.x - x, dd = p.d - d;
      const rr = r + Math.max(p.def.hw, p.def.hd) * 0.5;
      if (dx * dx + dd * dd < rr * rr) this.smash(p, cause);
    }
  }

  private transform(): void {
    const from = VEHICLES[this.tier];
    this.scrap -= from.scrapToNext;
    this.tier++;
    this.growth = 0;
    const to = VEHICLES[this.tier];
    if (this.analytics.firstUpgradeS < 0) this.analytics.firstUpgradeS = this.time;
    this.analytics.tierReached = this.tier;
    this.showVehicle();
    this.growAnim = 0;
    this.slowmo = 0.45;
    this.shake = Math.max(this.shake, 1.1);
    const pos = new THREE.Vector3(this.x, 1, -this.d);
    this.fx.ring(pos, 14 * this.camScale, 0x7dffb0, 0.6);
    this.fx.ring(pos, 9 * this.camScale, 0xffffff, 0.4);
    this.fx.sphere(pos, 4 + this.halfW * 2, 0x7dffb0, 0.45);
    this.fx.sparks(pos, 30, 0x7dffb0, 1.5);
    this.fx.stars(pos, 20, 0xffffff, 1.3);
    this.fx.confetti(pos.setY(2), 40, 0.4);
    this.fx.dust(pos, 14, 1.5);
    this.hud.doFlash('#fffbe0', 0.75);
    this.hud.showBanner(to.name + '!', '', 1.6, 'gold');
    this.audio.transform();
    this.audio.setIntensity(this.tier + 1);
    // Objects that just became breakable get a green "go" ring.
    let shown = 0;
    for (const p of this.props) {
      if (shown >= 10 || p.state !== 'idle') continue;
      if (p.def.power > from.power && p.def.power <= to.power && p.d > this.d && p.d < this.d + 90) {
        this.fx.ring(new THREE.Vector3(p.x, 0, -p.d), Math.max(p.def.hw, p.def.hd) * 3, 0x4dff9a, 0.7);
        shown++;
      }
    }
    const bonus = 5 * tierBase(this.tier);
    this.addDamage(bonus);
    this.popupWorld(this._v.set(this.x, this.height + 1, -this.d), `UPGRADE +${fmt(bonus)}`, 'pmax', 1.3, true);
    this.shockwave(this.x, this.d, 5 + this.halfW * 2, to.power);
  }

  private megaSmash(): void {
    const v = VEHICLES[this.tier];
    this.scrap -= v.scrapToNext;
    this.hud.showBanner('MEGA SMASH!', '', 1.2, 'pink');
    this.hud.doFlash('#ffe0f0', 0.7);
    this.shake = Math.max(this.shake, 1.2);
    this.slowmo = 0.3;
    this.audio.megaSmash();
    const pos = new THREE.Vector3(this.x, 1, -this.d - 8);
    this.fx.ring(pos, 30, 0xff3b8d, 0.7);
    this.fx.sphere(pos, 16, 0xff5ce1, 0.5);
    this.fx.fireball(pos, 4);
    this.fx.confetti(pos, 40, 0.5);
    const bonus = 10 * tierBase(this.tier);
    this.addDamage(bonus);
    this.popupWorld(this._v.set(this.x, 4, -this.d - 6), `MEGA +${fmt(bonus)}`, 'pmax', 1.5, true);
    const from = { x: this.x, d: this.d + 8 };
    this.quietPops = true;
    for (const p of this.props) {
      if (p.state !== 'idle') continue;
      const dx = p.x - this.x, dd = p.d - (this.d + 10);
      if (dx * dx + dd * dd < 16 * 16) this.smash(p, 'power', from);
    }
    this.quietPops = false;
  }

  // =====================================================================
  // Props, combo, cleanup
  // =====================================================================
  private updateProps(dt: number): void {
    const t = performance.now() / 1000;
    const power = VEHICLES[this.tier].power;
    for (const p of this.props) {
      if (p.state === 'idle') {
        if (p.vd !== 0 && this.state !== 'attract') {
          p.d += p.vd * dt;
          p.mesh.position.z = -p.d;
        }
        if (p.wobble > 0) {
          p.wobble = Math.max(0, p.wobble - dt * 3);
          p.mesh.rotation.z = Math.sin(t * 45) * 0.08 * p.wobble;
        }
        if (p.gold) p.mesh.rotation.y += dt * 1.5;
        if (p.finale && p.d < this.d) this.finaleTotal.add(p);
      } else if (p.state === 'flying') {
        p.life += dt;
        p.vel.y -= 30 * dt;
        p.x += p.vel.x * dt;
        p.y += p.vel.y * dt;
        p.d += p.vel.z * dt;
        if (p.y < 0) {
          p.y = 0;
          p.vel.y *= -0.3;
          p.vel.x *= 0.6;
          p.vel.z *= 0.6;
          p.spin.multiplyScalar(0.6);
        }
        p.mesh.position.set(p.x, p.y, -p.d);
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
        if (p.life > 1.6) p.mesh.scale.setScalar(Math.max(0.01, 1 - (p.life - 1.6) / 0.5));
        if (p.life > 2.1) {
          p.state = 'dead';
          p.mesh.visible = false;
        }
        // Heavy flying debris knocks over what it lands on.
        if (p.def.mass >= 0.8 && p.life < 1.2 && this.state === 'playing') {
          for (const o of this.props) {
            if (o.state !== 'idle' || o.def.power > power) continue;
            if (Math.abs(o.d - p.d) < o.def.hd + p.def.hd && Math.abs(o.x - p.x) < o.def.hw + p.def.hw && p.y < o.y + o.def.h) this.smash(o, 'chain');
          }
        }
      }
      if (p.finale && p.state !== 'idle') this.finaleTotal.add(p);
    }
  }

  private endChain(): void {
    if (this.comboCount >= 6 && this.chainDollars > 0) {
      this.hud.chainEnd(this.chainDollars);
      this.audio.sparkle(0);
    }
    this.chainDollars = 0;
  }

  private updateCombo(dt: number): void {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.endChain();
        this.comboCount = 0;
        this.comboMult = 1;
      }
    }
  }

  private cleanup(): void {
    const behind = this.d - (this.camBack + 12);
    let w = 0;
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.d < behind || p.state === 'dead') {
        this.releaseProp(p);
        continue;
      }
      this.props[w++] = p;
    }
    this.props.length = w;
    for (let i = this.ramps.length - 1; i >= 0; i--) {
      if (this.ramps[i].d < behind) {
        this.releaseRamp(this.ramps[i]);
        this.ramps.splice(i, 1);
      }
    }
    for (let i = this.hoops.length - 1; i >= 0; i--) {
      if (this.hoops[i].d < behind) {
        this.releaseHoop(this.hoops[i]);
        this.hoops.splice(i, 1);
      }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      if (this.pickups[i].d < behind) {
        this.releasePickup(this.pickups[i]);
        this.pickups.splice(i, 1);
      }
    }
    if (this.gateMesh.visible && this.gateD < behind - 20) this.gateMesh.visible = false;
  }

  // =====================================================================
  // Visuals
  // =====================================================================
  private showVehicle(): void {
    this.vehicles.forEach((v, i) => (v.group.visible = i === this.tier));
  }

  private updateVehicleVisual(dt: number, realDt: number): void {
    const vm = this.vehicles[this.tier];
    const g = vm.group;
    g.position.set(this.x, this.y, -this.d);
    g.rotation.y = -this.steer * 0.32;
    this.jolt = Math.max(0, this.jolt - realDt * 4);
    vm.body.rotation.z = this.steer * 0.07 + Math.sin(performance.now() * 0.05) * 0.08 * this.jolt;
    const rampPitch = this.onRamp ? Math.atan2(RAMP.h, RAMP.hl * 2) : 0;
    vm.body.rotation.x = (this.airborne ? clamp(this.vy * 0.025, -0.35, 0.35) : rampPitch) + this.tumble;
    vm.body.position.y = this.airborne || this.speed < 1 ? 0 : (Math.abs(Math.sin(this.d * 0.9)) * 0.04) / vm.baseScale;
    for (const w of vm.wheels) w.rotation.x -= (this.speed / (vm.wheelRadius * vm.baseScale * this.sizeMul)) * dt;
    let burst = 1;
    if (this.growAnim < 1) {
      this.growAnim = Math.min(1, this.growAnim + realDt / 0.55);
      const t = this.growAnim;
      burst = t < 0.35 ? lerp(0.3, 1.35, t / 0.35) : 1 + 0.35 * Math.exp(-(t - 0.35) * 8) * Math.cos((t - 0.35) * 20);
    }
    this.squash = Math.max(0, this.squash - realDt * 6);
    const s = vm.baseScale * this.sizeMul * burst;
    g.scale.set(s * (1 + this.squash * 0.05), s * (1 - this.squash * 0.07), s * (1 + this.squash * 0.06));
  }

  private targetCamScale(): number {
    return 0.55 + this.halfW * 0.7;
  }

  private updateCamera(realDt: number, snap: boolean): void {
    const v = VEHICLES[this.tier];
    this.camScale = snap ? this.targetCamScale() : lerp(this.camScale, this.targetCamScale(), Math.min(1, realDt * 2.5));
    const size = this.camScale;
    const aspect = this.camera.aspect;
    const portrait = clamp((1.3 - aspect) / 0.75, 0, 1);
    const speedKick = clamp((this.speed - v.speed) / v.speed, 0, 1);
    const fov = lerp(55, 66, portrait) + clamp(this.speed / v.speed, 0, 1) * 5 + speedKick * 12;
    this.camera.fov = lerp(this.camera.fov, fov, snap ? 1 : Math.min(1, realDt * 4));
    this.camera.updateProjectionMatrix();

    const halfW = lerp(7, 5.0, portrait) * size;
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect;
    const dist = clamp(halfW / tanH, 9 * size, 24 * size);
    const pitch = THREE.MathUtils.degToRad(lerp(24, 32, portrait));
    const back = Math.cos(pitch) * dist;
    this.camBack = back;
    const up = Math.sin(pitch) * dist + 1.2 * size;

    this.camX = lerp(this.camX, this.x * 0.8 + this.steer * 1.2 * size, snap ? 1 : Math.min(1, realDt * 5));
    const target = this._v.set(this.camX, up, -this.d + back);
    if (snap) this.camPos.copy(target);
    else {
      this.camPos.x = target.x;
      this.camPos.z = target.z;
      this.camPos.y = lerp(this.camPos.y, target.y + this.y * 0.5, Math.min(1, realDt * 4));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camX * 0.9 + this.steer * 0.8, 1.2 * size + this.y * 0.3, -this.d - 7 * size);
    if (this.shake > 0.01) {
      const s = this.shake * 0.35 * size;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.rotation.z += (Math.random() - 0.5) * this.shake * 0.02;
      this.shake *= Math.exp(-7 * realDt);
    }

    this.fog.near = 70 + 45 * size;
    this.fog.far = this.fog.near + 140;
    // Nothing past the fog is visible: cull it.
    if (Math.abs(this.camera.far - (this.fog.far + 10)) > 5) {
      this.camera.far = this.fog.far + 10;
      this.camera.updateProjectionMatrix();
    }
    if (Math.abs(size - this.shadowScale) > 0.05) {
      this.shadowScale = size;
      const sc = this.sun.shadow.camera;
      sc.left = -24 * size;
      sc.right = 24 * size;
      sc.top = 30 * size;
      sc.bottom = -30 * size;
      sc.near = 1;
      sc.far = 60 + 40 * size;
      sc.updateProjectionMatrix();
    }
  }

  private updateWorldFollow(): void {
    const snapD = Math.floor(this.d / 16) * 16;
    this.road.position.set(0, 0, -(snapD + 130));
    for (const w of this.walks) w.position.z = -(snapD + 130);
    this.ground.position.set(0, -0.02, -(this.d + 150));
    const size = this.camScale;
    this.sun.position.set(this.x + 10 * size, 30 * size, -this.d + 14 * size);
    this.sun.target.position.set(this.x, 0, -this.d - 12 * size);
    this.rim.position.set(this.x + 6, 10 * size, -this.d - 60 * size);
    this.rim.target.position.set(this.x, 0, -this.d);
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.9);
    const behind = this.d - this.camBack - 15;
    for (const dec of this.deco) {
      if (dec.d + dec.len / 2 < behind) {
        const f = this.decoFront.get(dec.key)!;
        dec.d = f + dec.len / 2;
        this.decoFront.set(dec.key, f + dec.len);
      }
      dec.mesh.position.z = -dec.d;
    }
  }

  private updateDangerRings(): void {
    const power = this.effPower;
    const pulse = 1 + Math.sin(performance.now() * 0.008) * 0.06;
    let n = 0;
    if (this.state !== 'end' && power !== Infinity) {
      for (const p of this.props) {
        if (n >= 160) break;
        if (p.state !== 'idle' || p.def.power <= power || p.y > 0.5) continue;
        if (p.d < this.d - 4 || p.d > this.d + 150) continue;
        this._v.set(p.x, 0.07, -p.d);
        this._v2.set((p.def.hw * 1.25 + 0.5) * pulse, 1, (p.def.hd * 1.25 + 0.5) * pulse);
        this._m.compose(this._v, this._qId, this._v2);
        this.dangerRing.setMatrixAt(n, this._m);
        this.dangerFill.setMatrixAt(n, this._m);
        n++;
      }
    }
    for (const m of [this.dangerRing, this.dangerFill]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  private updatePickupsVisual(realDt: number): void {
    for (const p of this.pickups) {
      p.t += realDt;
      const icon = p.group.getObjectByName('icon')!;
      icon.position.y = 2.2 + Math.sin(p.t * 3) * 0.3;
      const ring = p.group.getObjectByName('ring')!;
      ring.scale.setScalar(1 + Math.sin(p.t * 5) * 0.1);
    }
    for (const h of this.hoops) h.mesh.rotation.z += realDt * 1.2;
  }

  private popupWorld(pos: THREE.Vector3, text: string, cls = '', scale = 1, important = false): void {
    if (!important) {
      if (this.popBudget < 1) return;
      this.popBudget -= 1;
    }
    const v = this._v.copy(pos).project(this.camera);
    if (v.z > 1) return;
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    this.hud.popup(text, clamp(x, 70, window.innerWidth - 70), clamp(y, 140, window.innerHeight - 40), cls, scale);
  }

  private updateHud(realDt: number): void {
    const v = VEHICLES[this.tier];
    const max = this.tier === MAX_TIER;
    this.hud.setDamage(this.damage + (this.state === 'end' ? this.finaleBonus() : 0));
    this.hud.setMeter(this.scrap / v.scrapToNext, max ? 'MEGA SMASH' : `NEXT: ${VEHICLES[this.tier + 1].name}`, max);
    const flame = this.power?.kind === 'flame' ? this.power : null;
    this.hud.setEffect('flame', flame ? flame.t / flame.dur : null);
    this.hud.setEffect('invincible', this.invT > 0 ? this.invT / this.invMax : null);
    const def = VEHICLES[this.tier];
    const lines = this.state === 'playing' ? clamp((this.speed - def.speed * 1.05) / (def.speed * 0.4), 0, 1) * 0.8 : 0;
    this.hud.setSpeedLines(Math.max(lines, this.invT > 0 && this.state === 'playing' ? 0.55 : 0), this.invT > 0);
    this.hud.setPauseAvailable(this.canPause);
    this.hud.setCombo(this.comboMult, this.comboCount, clamp(this.comboTimer / COMBO_WINDOW, 0, 1), this.chainDollars);
    if (this.state === 'attract' && this.firstRun) this.hud.showHint(true);
    if (this.state === 'playing' && this.firstRun && this.time > 4) {
      this.firstRun = false;
      this.hud.showHint(false);
    }
    this.hud.update(realDt);
  }
}

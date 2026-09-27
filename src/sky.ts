/**
 * Procedural sunset sky dome: gradient, low sun with glow, streaky clouds and a
 * two-layer city skyline silhouette with lit windows. One draw call, no textures.
 * The dome is centred on the camera and never fogged.
 */
import * as THREE from 'three';

/** Colour at the horizon; the scene fog uses it so the ground melts into the sky. */
export const HORIZON = new THREE.Color(1.0, 0.72, 0.5);

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uHorizon;
varying vec3 vDir;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  float t = max(e, 0.0);

  vec3 orange = vec3(1.0, 0.52, 0.3);
  vec3 pink = vec3(0.94, 0.4, 0.56);
  vec3 violet = vec3(0.44, 0.3, 0.64);
  vec3 zenith = vec3(0.13, 0.14, 0.36);
  vec3 col = mix(uHorizon, orange, smoothstep(0.0, 0.07, t));
  col = mix(col, pink, smoothstep(0.06, 0.18, t));
  col = mix(col, violet, smoothstep(0.16, 0.38, t));
  col = mix(col, zenith, smoothstep(0.34, 0.85, t));

  // Sun glow + disc (drawn before the skyline so buildings silhouette against it).
  float sd = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.55, 0.28) * pow(sd, 6.0) * 0.5;
  col += vec3(1.0, 0.82, 0.5) * pow(sd, 90.0) * 0.8;
  col = mix(col, vec3(1.0, 0.96, 0.78), smoothstep(0.9986, 0.9991, sd));

  // Long pink/orange cloud streaks.
  float az = atan(d.x, -d.z);
  float b1 = smoothstep(0.018, 0.0, abs(e - 0.1 - 0.018 * sin(az * 3.0)));
  float b2 = smoothstep(0.012, 0.0, abs(e - 0.21 - 0.025 * sin(az * 2.0 + 1.3)));
  float b3 = smoothstep(0.01, 0.0, abs(e - 0.15 - 0.02 * sin(az * 4.0 + 2.1)));
  float breakup = 0.45 + 0.55 * sin(az * 7.0 + sin(az * 19.0) * 1.5);
  float clouds = (b1 * 0.7 + b2 * 0.5 + b3 * 0.4) * max(breakup, 0.0);
  vec3 cloudCol = mix(vec3(1.0, 0.62, 0.55), vec3(1.0, 0.85, 0.6), pow(sd, 3.0));
  col = mix(col, cloudCol, clamp(clouds, 0.0, 1.0) * 0.75);

  // Skyline: far (hazy) and near (darker, with windows) layers.
  float kf = az * 55.0;
  float hf = 0.012 + 0.035 * hash(floor(kf) + 7.0);
  float kn = az * 26.0;
  float idn = floor(kn);
  float hn = 0.01 + 0.06 * hash(idn) * (0.35 + 0.65 * hash(idn * 1.7 + 3.0));
  // Occasional spire on tall buildings.
  float spire = step(0.85, hash(idn + 91.0)) * step(abs(fract(kn) - 0.5), 0.05) * 0.03;
  float farSil = step(e, hf);
  float nearSil = step(e, hn + spire) * step(abs(fract(kn) - 0.5), 0.47);
  vec3 farCol = mix(uHorizon, vec3(0.75, 0.42, 0.55), 0.55);
  vec3 nearCol = vec3(0.34, 0.2, 0.4);
  col = mix(col, farCol, farSil);
  col = mix(col, nearCol, nearSil);
  vec2 g = vec2(kn * 7.0, e * 420.0);
  float lit = step(0.72, hash(floor(g.x) * 7.1 + floor(g.y) * 13.3))
            * step(0.35, fract(g.x)) * step(0.4, fract(g.y));
  col = mix(col, vec3(1.0, 0.82, 0.45), lit * nearSil * step(e, hn - 0.004) * 0.8);

  // Haze where the skyline meets the ground.
  col = mix(col, uHorizon, smoothstep(0.012, 0.0, e) * 0.85);
  if (e < 0.0) col = uHorizon;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function createSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: new THREE.Vector3(0.12, 0.045, -1).normalize() },
      uHorizon: { value: HORIZON.clone() },
    },
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

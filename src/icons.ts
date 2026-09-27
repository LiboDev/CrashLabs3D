import type { PowerKind } from './config';
import { POWERS } from './config';

const cache = new Map<PowerKind, HTMLCanvasElement>();

/** Round badge icon for a powerup, drawn procedurally (used for world sprites and the HUD). */
export function drawPowerIcon(kind: PowerKind): HTMLCanvasElement {
  const hit = cache.get(kind);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(64, 64, 54, 0, Math.PI * 2);
  const grd = g.createLinearGradient(0, 10, 0, 118);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.18, POWERS[kind].css);
  grd.addColorStop(1, POWERS[kind].css);
  g.fillStyle = grd;
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = '#ffffff';
  g.stroke();

  g.lineJoin = 'round';
  g.lineWidth = 7;
  g.strokeStyle = '#1b2a4a';
  if (kind === 'speed') {
    g.beginPath();
    const pts = [[74, 14], [34, 72], [60, 72], [50, 114], [96, 50], [68, 50], [82, 14]];
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    g.closePath();
    g.stroke();
    g.fillStyle = '#fff36b';
    g.fill();
  } else if (kind === 'bomb') {
    g.beginPath();
    g.arc(58, 74, 28, 0, Math.PI * 2);
    g.fillStyle = '#1b2a4a';
    g.fill();
    g.beginPath();
    g.arc(48, 64, 8, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fill();
    g.fillStyle = '#1b2a4a';
    g.fillRect(68, 40, 14, 12);
    g.beginPath();
    g.moveTo(76, 42);
    g.quadraticCurveTo(84, 24, 96, 26);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.stroke();
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 6 : 14;
      const a = (i / 10) * Math.PI * 2;
      g.lineTo(98 + Math.cos(a) * r, 24 + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = '#fff36b';
    g.fill();
  } else {
    const flame = (s: number, color: string) => {
      g.save();
      g.translate(64, 108);
      g.scale(s, s);
      g.beginPath();
      g.moveTo(0, 0);
      g.bezierCurveTo(-34, -6, -34, -40, -14, -62);
      g.bezierCurveTo(-12, -44, -4, -44, -2, -50);
      g.bezierCurveTo(-6, -70, 6, -84, 14, -92);
      g.bezierCurveTo(12, -66, 36, -54, 30, -26);
      g.bezierCurveTo(28, -8, 16, 0, 0, 0);
      g.closePath();
      g.fillStyle = color;
      g.fill();
      if (s === 1) g.stroke();
      g.restore();
    };
    flame(1, '#fff36b');
    flame(0.55, '#ff5a1f');
  }
  cache.set(kind, c);
  return c;
}

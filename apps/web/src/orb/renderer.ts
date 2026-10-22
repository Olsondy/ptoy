import type { AudioReading } from './audioMeter';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

export const ORB_STATES: readonly OrbState[] = ['idle', 'listening', 'thinking', 'speaking'];

type RGB = readonly [number, number, number];
type Slot = 0 | 1 | 2;
const SLOTS: readonly Slot[] = [0, 1, 2];

/** Every visual knob of the orb. The renderer eases all of them toward the target state's look. */
interface Look {
  readonly hues: readonly [RGB, RGB, RGB];
  readonly body: RGB;
  readonly glow: number;
  readonly brightness: number;
  readonly breathRate: number;
  readonly breathDepth: number;
  readonly swirl: number;
  readonly churn: number;
  readonly wobble: number;
  readonly micGain: number;
  readonly agentGain: number;
  readonly pulse: number;
  readonly comet: number;
  readonly ring: number;
}

const LOOKS: Record<OrbState, Look> = {
  idle: {
    hues: [
      [64, 86, 138],
      [84, 74, 140],
      [42, 104, 118],
    ],
    body: [14, 19, 32],
    glow: 0.22,
    brightness: 0.42,
    breathRate: 0.17,
    breathDepth: 0.03,
    swirl: 0.12,
    churn: 0.3,
    wobble: 0.05,
    micGain: 0,
    agentGain: 0,
    pulse: 0,
    comet: 0,
    ring: 0.18,
  },
  listening: {
    hues: [
      [52, 214, 140],
      [38, 182, 220],
      [128, 236, 196],
    ],
    body: [8, 30, 34],
    glow: 0.5,
    brightness: 0.82,
    breathRate: 0.32,
    breathDepth: 0.018,
    swirl: 0.3,
    churn: 0.7,
    wobble: 0.06,
    micGain: 1,
    agentGain: 0,
    pulse: 0,
    comet: 0,
    ring: 0.65,
  },
  thinking: {
    hues: [
      [138, 104, 255],
      [84, 124, 255],
      [204, 120, 250],
    ],
    body: [20, 14, 44],
    glow: 0.42,
    brightness: 0.78,
    breathRate: 0.5,
    breathDepth: 0.012,
    swirl: 1.7,
    churn: 1.4,
    wobble: 0.09,
    micGain: 0,
    agentGain: 0,
    pulse: 1,
    comet: 1,
    ring: 0.28,
  },
  speaking: {
    hues: [
      [255, 146, 108],
      [250, 104, 168],
      [255, 200, 122],
    ],
    body: [40, 16, 26],
    glow: 0.66,
    brightness: 0.95,
    breathRate: 0.3,
    breathDepth: 0.015,
    swirl: 0.45,
    churn: 0.9,
    wobble: 0.06,
    micGain: 0,
    agentGain: 1.25,
    pulse: 0,
    comet: 0,
    ring: 0.85,
  },
};

type LiveLook = { -readonly [K in keyof Look]: Look[K] };
type Scalar = Exclude<keyof Look, 'hues' | 'body'>;
const SCALARS = (Object.keys(LOOKS.idle) as (keyof Look)[]).filter(
  (k): k is Scalar => k !== 'hues' && k !== 'body',
);

const TRANSITION_SECONDS = 0.45;
const LEVEL_ATTACK_SECONDS = 0.05;
const LEVEL_RELEASE_SECONDS = 0.2;
const TAU = Math.PI * 2;

const ease = (from: number, to: number, k: number) => from + (to - from) * k;
const rgba = ([r, g, b]: RGB, a: number) =>
  `rgba(${r | 0},${g | 0},${b | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mix = ([r1, g1, b1]: RGB, [r2, g2, b2]: RGB, t: number): RGB => [
  ease(r1, r2, t),
  ease(g1, g2, t),
  ease(b1, b2, t),
];

export interface FrameInput {
  readonly mic: AudioReading;
  readonly agent: AudioReading;
  readonly reducedMotion: boolean;
}

/** Draws the orb on a 2D canvas. Owns all animation state; callers only set the target state and tick frames. */
export class OrbRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private target: Look;
  private look: LiveLook;
  private width = 0;
  private height = 0;
  private time = 0;
  private breathPhase = 0;
  private swirlPhase = 0;
  private churnPhase = 0;
  private level = 0;
  private bands: [number, number, number, number] = [0, 0, 0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    state: OrbState,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.target = LOOKS[state];
    this.look = { ...this.target };
  }

  setState(state: OrbState): void {
    this.target = LOOKS[state];
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const scale = Math.min(dpr, 2);
    this.width = cssWidth;
    this.height = cssHeight;
    this.canvas.width = Math.max(1, Math.round(cssWidth * scale));
    this.canvas.height = Math.max(1, Math.round(cssHeight * scale));
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  frame(dt: number, input: FrameInput): void {
    const step = Math.min(dt, 0.1);
    this.easeLook(step);
    this.followLevel(step, input);

    const motion = input.reducedMotion ? 0.25 : 1;
    this.time += step;
    this.breathPhase += TAU * this.look.breathRate * step * (input.reducedMotion ? 0.6 : 1);
    this.swirlPhase += this.look.swirl * step * motion;
    this.churnPhase += this.look.churn * step * motion;

    this.draw(input.reducedMotion);
  }

  private easeLook(dt: number): void {
    const k = 1 - Math.exp(-dt / TRANSITION_SECONDS);
    const { look, target } = this;
    const next: LiveLook = { ...look };
    for (const key of SCALARS) next[key] = ease(look[key], target[key], k);
    next.hues = [mix(look.hues[0], target.hues[0], k), mix(look.hues[1], target.hues[1], k), mix(look.hues[2], target.hues[2], k)];
    next.body = mix(look.body, target.body, k);
    this.look = next;
  }

  private followLevel(dt: number, { mic, agent }: FrameInput): void {
    const { micGain, agentGain } = this.look;
    const raw = Math.min(1, mic.level * micGain + agent.level * agentGain);
    const tau = raw > this.level ? LEVEL_ATTACK_SECONDS : LEVEL_RELEASE_SECONDS;
    const k = 1 - Math.exp(-dt / tau);
    this.level = ease(this.level, raw, k);
    const band = (prev: number, m: number, a: number) => {
      const b = Math.min(1, m * micGain + a * agentGain);
      return ease(prev, b, 1 - Math.exp(-dt / (b > prev ? 0.06 : 0.25)));
    };
    const [p0, p1, p2, p3] = this.bands;
    this.bands = [
      band(p0, mic.bands[0], agent.bands[0]),
      band(p1, mic.bands[1], agent.bands[1]),
      band(p2, mic.bands[2], agent.bands[2]),
      band(p3, mic.bands[3], agent.bands[3]),
    ];
  }

  private draw(reducedMotion: boolean): void {
    const { ctx, look, width: w, height: h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.29;
    const level = this.level;
    const pulseWave = 0.5 + 0.5 * Math.sin(this.time * TAU * 0.9);
    const pulse = look.pulse * (reducedMotion ? 0.4 : 1);
    const breath = 1 + look.breathDepth * Math.sin(this.breathPhase);
    const r = base * breath * (1 + 0.11 * level + 0.025 * pulse * pulseWave);
    const light = look.brightness * (1 + 0.25 * level) * (1 - 0.18 * pulse * (1 - pulseWave));
    const glowHue = mix(mix(look.hues[0], look.hues[1], 0.5), look.hues[2], 0.33);

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    // Halo
    const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, Math.min(r * 1.7, Math.min(w, h) * 0.5));
    const haloAlpha = look.glow * (0.7 + 0.9 * level) * (1 - 0.25 * pulse * (1 - pulseWave));
    halo.addColorStop(0, rgba(glowHue, haloAlpha));
    halo.addColorStop(0.45, rgba(glowHue, haloAlpha * 0.32));
    halo.addColorStop(1, rgba(glowHue, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // Sphere body
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.05);
    body.addColorStop(0, rgba(mix(look.body, [255, 255, 255], 0.08), 1));
    body.addColorStop(1, rgba(mix(look.body, [0, 0, 0], 0.45), 1));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = body;
    ctx.fill();

    // Moving light inside the glass
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (const i of SLOTS) this.drawBlob(i, cx, cy, r, light);
    ctx.restore();

    // Glass shading: darker rim, soft specular, hairline edge
    ctx.globalCompositeOperation = 'source-over';
    const rim = ctx.createRadialGradient(cx, cy, r * 0.62, cx, cy, r);
    rim.addColorStop(0, 'rgba(6,8,14,0)');
    rim.addColorStop(1, 'rgba(6,8,14,0.5)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = rim;
    ctx.fill();

    const sx = cx - r * 0.34;
    const sy = cy - r * 0.42;
    const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.5);
    spec.addColorStop(0, 'rgba(255,255,255,0.20)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fill();

    const edge = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    edge.addColorStop(0, 'rgba(255,255,255,0.22)');
    edge.addColorStop(1, rgba(glowHue, 0.12));
    ctx.lineWidth = 1;
    ctx.strokeStyle = edge;
    ctx.stroke();

    // Waveform rings and the thinking comet
    ctx.globalCompositeOperation = 'lighter';
    this.drawRing(0, cx, cy, r, reducedMotion);
    this.drawRing(1, cx, cy, r, reducedMotion);
    if (look.comet > 0.01) this.drawComet(cx, cy, r);
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawBlob(i: Slot, cx: number, cy: number, r: number, light: number): void {
    const { ctx, look } = this;
    const orbit = this.swirlPhase * (1 + i * 0.37) + i * 2.1;
    const reach = r * (0.3 + 0.06 * i) * (1 + 0.35 * look.pulse);
    const bx = cx + Math.cos(orbit) * reach;
    const by = cy + Math.sin(orbit * 0.9 + i) * reach;
    const [b0, b1, b2, b3] = this.bands;
    const own = i === 0 ? b0 : i === 1 ? b1 : b2;
    const next = i === 0 ? b1 : i === 1 ? b2 : b3;
    const radius = r * (0.78 + 0.07 * i) * (1 + 0.18 * own);
    const churn = this.churnPhase * (1 + 0.3 * i) + i * 1.3;
    const wobble = look.wobble + 0.12 * next;

    ctx.beginPath();
    const steps = 48;
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * TAU;
      const d = 1 + wobble * Math.sin(3 * a + churn) + wobble * 0.6 * Math.sin(5 * a - churn * 1.3 + i * 1.7);
      const x = bx + Math.cos(a) * radius * d;
      const y = by + Math.sin(a) * radius * d;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const fill = ctx.createRadialGradient(bx, by, 0, bx, by, radius * 1.1);
    const hue = look.hues[i];
    fill.addColorStop(0, rgba(hue, light * 0.8));
    fill.addColorStop(0.55, rgba(hue, light * 0.32));
    fill.addColorStop(1, rgba(hue, 0));
    ctx.fillStyle = fill;
    ctx.fill();
  }

  private drawRing(i: 0 | 1, cx: number, cy: number, r: number, reducedMotion: boolean): void {
    const { ctx, look } = this;
    const [b0, b1, b2, b3] = this.bands;
    const strength = look.ring * (0.35 + 0.65 * Math.min(1, this.level * 1.4));
    if (strength < 0.01) return;
    const amp = (0.008 + 0.17 * this.level) * (reducedMotion ? 0.5 : 1);
    const ringR = r * (1.1 + 0.05 * i);
    const phase = this.churnPhase * (i ? -1.6 : 1.9) + i * 0.8;
    const steps = 160;
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * TAU;
      const wave =
        (0.5 + b0) * Math.sin(3 * a + phase) * 0.45 +
        (0.3 + b1) * Math.sin(5 * a - phase * 1.3) * 0.3 +
        (0.2 + b2) * Math.sin(8 * a + phase * 0.7 + i) * 0.18 +
        b3 * Math.sin(13 * a - phase * 2.1) * 0.1;
      const d = ringR * (1 + amp * wave);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = i ? 1 : 1.5;
    ctx.strokeStyle = rgba(look.hues[i], strength * (i ? 0.45 : 0.7));
    ctx.stroke();
  }

  private drawComet(cx: number, cy: number, r: number): void {
    const { ctx, look } = this;
    const ringR = r * 1.13;
    const segments = 26;
    const span = 1.5;
    for (let k = 0; k < 2; k++) {
      const head = this.swirlPhase * 1.25 + k * Math.PI;
      for (let s = 0; s < segments; s++) {
        const t = s / segments;
        const a0 = head - span * t;
        const a1 = head - span * (t + 1 / segments);
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, a1, a0);
        ctx.lineWidth = 2.2 * (1 - t) + 0.4;
        ctx.strokeStyle = rgba(look.hues[k ? 2 : 0], look.comet * 0.85 * (1 - t) * (1 - t));
        ctx.stroke();
      }
    }
  }
}

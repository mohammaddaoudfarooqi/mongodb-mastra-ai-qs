/**
 * Decorative hero leaf — Canvas-2D particle system.
 *
 * Particles assemble scatter → the official MongoDB leaf silhouette, then
 * HOLD it as the brand signature with a gentle shimmer and pointer
 * parallax. Colour ramps over the data-viz palette; additive compositing
 * gives the glow on the dark hero.
 *
 * Decorative ONLY: `pointer-events:none` + `aria-hidden`, skipped entirely
 * under `prefers-reduced-motion`, and it pauses its rAF loop when the tab
 * is hidden or the hero scrolls offscreen. Degrades to nothing when the 2D
 * canvas is unavailable — the hero's static backdrop shows through.
 *
 * Ported from the MongoDB Partner Library hero leaf (Canvas-2D variant).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { rasterizeLeaf } from './leafSilhouette';
import { sampleSilhouette, mulberry32 } from './leafSampler';

/** Official MongoDB brand greens + slate. */
const BRAND = {
  springGreen: '#00ED64',
  forestGreen: '#00684A',
  slateNavy: '#001E2B',
  blue: '#0078FF',
} as const;

/** Official MongoDB data-visualization palette (charts/graphs only). */
const DATAVIZ = {
  sky: '#00D2FF',
  clearBlue: '#006EFF',
  lime: '#E9FF99',
} as const;

const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
};

const PARTICLE_COUNT = 2600;
const MORPH_SECONDS = 3.6;
const ZOOM_SECONDS = 2;
// Mask raster height in px — finer mask → cleaner silhouette edges.
const MASK_RESOLUTION = 280;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Soft radial sprite (core → transparent) for one ramp colour. */
function makeSprite(color: string, alpha: number): HTMLCanvasElement | null {
  try {
    const size = 64;
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const ctx = sprite.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Tight core with a short falloff — a wide halo smears the
    // silhouette edge and the leaf stops reading as the logomark.
    g.addColorStop(0, color);
    g.addColorStop(0.55, color);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return sprite;
  } catch {
    return null;
  }
}

export interface HeroLeafProps {
  /** Dark hero → additive glow + neon ramp. Light hero → normal blend +
   *  darker on-brand colours so the leaf reads on a pale background. */
  isDark?: boolean;
}

export default function HeroLeaf({ isDark = true }: HeroLeafProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enabled] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / blocked canvas → static backdrop only

    const mask = rasterizeLeaf(MASK_RESOLUTION);
    if (!mask) return;
    // Sampler output is centred at the origin, y-up, longest axis ∈ [-1, 1].
    const leaf = sampleSilhouette(mask, PARTICLE_COUNT, { scale: 1, seed: 11 });

    // Per-particle scatter start (shell), seed and colour bucket —
    // mirrors the old GPU field's distribution.
    const rand = mulberry32(21);
    const scatter = new Float32Array(PARTICLE_COUNT * 2);
    const seeds = new Float32Array(PARTICLE_COUNT);
    const buckets = new Uint8Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = rand() * Math.PI * 2;
      const r = 1.6 + rand() * 1.2;
      scatter[i * 2] = Math.cos(theta) * r;
      scatter[i * 2 + 1] = Math.sin(theta) * r;
      seeds[i] = rand();
      const b = rand();
      buckets[i] = b < 0.82 ? 0 : b < 0.92 ? 1 : b < 0.97 ? 2 : 3;
    }

    // Predominantly spring green so the assembled shape reads as the
    // actual logomark; blue/lime stay as sparse accent sparkle.
    const ramp = isDark
      ? [BRAND.springGreen, '#7CF5A5', DATAVIZ.sky, DATAVIZ.lime]
      : [BRAND.forestGreen, BRAND.springGreen, DATAVIZ.clearBlue, BRAND.blue];
    const baseAlpha = isDark ? 0.8 : 0.85;
    const sprites = ramp.map((c) => makeSprite(c, baseAlpha));
    if (sprites.some((s) => s === null)) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    const resize = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(container);

    // Pause when the tab is hidden or the hero scrolls offscreen —
    // same battery etiquette the WebGL layer had.
    let visible = true;
    let intersecting = true;
    const onVis = () => {
      visible = document.visibilityState !== 'hidden';
    };
    document.addEventListener('visibilitychange', onVis);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries[0]) intersecting = entries[0].isIntersecting;
        },
        { threshold: 0.01 },
      );
      io.observe(container);
    }

    // Subtle pointer parallax (translate-only — the old scene used a
    // small rotation; in 2D a few px of drift reads the same).
    let parallaxX = 0;
    let parallaxY = 0;
    let targetPX = 0;
    let targetPY = 0;
    const onPointer = (e: PointerEvent) => {
      targetPX = (e.clientX / window.innerWidth - 0.5) * 18;
      targetPY = (e.clientY / window.innerHeight - 0.5) * 12;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    let elapsed = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      if (!visible || !intersecting) return;
      elapsed += dt;

      // One-shot cinematic pull-in (old camera z 14 → 8) as a scale ease.
      const zoom = 1 - Math.pow(1 - Math.min(elapsed / ZOOM_SECONDS, 1), 3);
      const assembled = smoothstep(0, 0.7, Math.min(elapsed / MORPH_SECONDS, 1));
      parallaxX += (targetPX - parallaxX) * 0.05;
      parallaxY += (targetPY - parallaxY) * 0.05;

      // Leaf height ≈ 60% of the hero, like the WebGL framing; sampler
      // units are normalised by the LONGEST axis (the leaf's height).
      // On wide bands (≥1840px container ≈ 1920px viewport) the height
      // term dominates and the leaf reads small — let it take 72% there.
      const wide = width >= 1840;
      const unit =
        (Math.min(height * (wide ? 0.72 : 0.6), width * (wide ? 0.3 : 0.34)) / 2) *
        (0.78 + 0.22 * zoom);
      const cx = width / 2 + parallaxX;
      const cy = height / 2 - height * 0.04 + parallaxY; // old y +0.2 offset

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = isDark ? 'lighter' : 'source-over';

      const t = elapsed * 0.4;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const phase = t + seeds[i] * Math.PI * 2;
        // Keep the shimmer well under the inter-particle spacing or the
        // silhouette edge smears into a blob.
        const shimmer = 0.012 * assembled;
        const x =
          scatter[i * 2] * (1 - assembled) +
          leaf[i * 3] * assembled +
          Math.sin(phase) * shimmer;
        const y =
          scatter[i * 2 + 1] * (1 - assembled) +
          leaf[i * 3 + 1] * assembled +
          Math.cos(phase * 1.3) * shimmer;
        // y-up sampler → y-down canvas; z jitter varies the sprite size.
        const px = cx + x * unit;
        const py = cy - y * unit;
        const s = (1.5 + seeds[i] * 2.0) * (1 + leaf[i * 3 + 2] * 1.2);
        const sprite = sprites[buckets[i]];
        if (sprite) ctx.drawImage(sprite, px - s / 2, py - s / 2, s, s);
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVis);
      ro?.disconnect();
      io?.disconnect();
    };
  }, [enabled, isDark]);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      data-testid="hero-leaf"
      style={layerStyle}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

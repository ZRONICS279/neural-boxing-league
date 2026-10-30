"use client";

import { useEffect, useRef } from "react";

/* The between-cards reel, drawn live instead of taped.
 *
 * This replaces the looping mp4 that used to sit here. A tape has two problems
 * a drawing does not: it is cut to one aspect, so it either letterboxes or
 * stretches on the wide stage, and its loading bar is a lie — ten looping
 * seconds of a bar that never fills. Drawn in code, the reel fits whatever the
 * stage gives it, the stars actually twinkle and flare, the grid actually
 * rolls, and the bar actually runs empty to full before it flashes and starts
 * over.
 *
 * Same school as the fight canvas: one low-resolution buffer, whole pixels,
 * blown up with image-rendering: pixelated. Nothing here reads league state —
 * it is a test card, not a broadcast. */

const BUFFER_W = 640;
const BUFFER_H = 256;

/* The canvas cannot read a CSS variable, so the stage's display stack is
 * repeated here verbatim from globals.css --display. */
const DISPLAY_FONT = '"DIN Condensed", "Arial Narrow", "Roboto Condensed", Impact, sans-serif';
const MONO_FONT = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

/** Deterministic scatter, same trick the fight renderer leans on: the same
 *  index always lands the same star, so re-mounting does not reshuffle the
 *  sky. */
function scatter(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

interface Star {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
  // The sky is in the venue's colours: mostly white, seasoned with corner
  // blue and corner red.
  rgb: string;
  // A handful of stars are four-point flares that periodically bloom instead
  // of merely twinkling.
  flare: boolean;
  flarePeriod: number;
}

const STAR_RGBS = ["235, 242, 255", "235, 242, 255", "110, 170, 255", "255, 110, 100"];

const STARS: Star[] = Array.from({ length: 110 }, (_, i) => ({
  x: scatter(i * 3 + 1),
  // Kept out of the grid floor; the bottom of the sky is the horizon.
  y: scatter(i * 3 + 2) * 0.55,
  size: scatter(i * 3 + 3) < 0.8 ? 1 : 2,
  phase: scatter(i * 7 + 4) * Math.PI * 2,
  speed: 0.6 + scatter(i * 7 + 5) * 2.2,
  rgb: STAR_RGBS[Math.floor(scatter(i * 13 + 9) * STAR_RGBS.length)],
  flare: i % 19 === 0,
  flarePeriod: 4 + scatter(i * 11 + 6) * 6,
}));

const BAR_CELLS = 18;
/** One lap of the loading bar: fill, hold flashing full, one beat of black. */
const BAR_FILL_S = 8;
const BAR_FLASH_S = 1.3;
const BAR_CYCLE_S = BAR_FILL_S + BAR_FLASH_S + 0.7;

/** Blue through violet to red, the same sweep the bar frame wears. */
function cellColor(f: number, lit: number) {
  return `hsl(${215 + f * 140}, 95%, ${46 + lit * 22}%)`;
}

function stageGradient(ctx: CanvasRenderingContext2D, w: number) {
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, "#2f7ff0");
  g.addColorStop(0.5, "#3d2a66");
  g.addColorStop(1, "#f0392f");
  return g;
}

/** The show lettering: dark extrusion below, chrome gradient on the face, and
 *  gradient stops that drift a little so the metal breathes. */
function drawChrome(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  baseline: number,
  size: number,
  stops: [number, string][],
  t: number,
) {
  ctx.font = `italic 700 ${size}px ${DISPLAY_FONT}`;
  ctx.textAlign = "center";
  const depth = Math.max(2, Math.round(size * 0.07));
  for (let d = depth; d >= 1; d -= 1) {
    ctx.fillStyle = d > depth * 0.5 ? "#0a0d1e" : "#141a3a";
    ctx.fillText(text, cx + d * 0.5, baseline + d);
  }
  const wob = Math.sin(t * 0.7) * 0.035;
  const g = ctx.createLinearGradient(0, baseline - size * 0.92, 0, baseline + size * 0.1);
  for (const [at, color] of stops) {
    g.addColorStop(Math.min(1, Math.max(0, at + wob * (at > 0 && at < 1 ? 1 : 0))), color);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#05070f";
  ctx.strokeText(text, cx, baseline);
  ctx.fillStyle = g;
  ctx.fillText(text, cx, baseline);
}

/** Canvas letter spacing where the browser has it; silently normal tracking
 *  where it does not. TS's dom lib is behind the browsers on this one. */
function spacing(ctx: CanvasRenderingContext2D, px: number) {
  if ("letterSpacing" in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
  }
}

/** h:mm:ss above the hour, m:ss below it — a bell five hours out should not
 *  read like a sprint. */
function bellClock(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function drawReel(ctx: CanvasRenderingContext2D, t: number, bellInSeconds: number | null) {
  const W = BUFFER_W;
  const H = BUFFER_H;
  const cx = W / 2;
  const horizon = H * 0.58;

  ctx.fillStyle = "#04050a";
  ctx.fillRect(0, 0, W, H);

  /* ------------------------------------------------------------------ sky */
  for (const star of STARS) {
    const x = Math.round(star.x * W);
    const y = Math.round(star.y * H);
    const lit = 0.25 + 0.75 * Math.abs(Math.sin(star.phase + t * star.speed));
    ctx.fillStyle = `rgba(${star.rgb}, ${lit})`;
    ctx.fillRect(x, y, star.size, star.size);
    if (star.flare) {
      // pow keeps the flare rare and sharp: a star blooms for a moment, throws
      // rays in its own colour, and goes back to being a dot.
      const bloom = Math.pow(Math.max(0, Math.sin((t / star.flarePeriod) * Math.PI * 2 + star.phase)), 14);
      if (bloom > 0.05) {
        const ray = Math.round(2 + bloom * 5);
        ctx.fillStyle = `rgba(${star.rgb}, ${0.6 * bloom})`;
        ctx.fillRect(x - ray, y, ray * 2 + 1, 1);
        ctx.fillRect(x, y - ray, 1, ray * 2 + 1);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * bloom})`;
        ctx.fillRect(x, y, star.size, star.size);
      }
    }
  }

  /* ---------------------------------------------------------------- floor */
  const grad = stageGradient(ctx, W);
  // The glow line the whole floor hangs from.
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = grad;
  ctx.fillRect(0, Math.round(horizon), W, 1);
  ctx.globalAlpha = 0.18;
  ctx.fillRect(0, Math.round(horizon) - 2, W, 2);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = grad;
  // Rows roll toward the viewer on a squared curve, so they bunch at the
  // horizon and stride near the bottom the way a real grid recedes.
  for (let r = 0; r < 9; r += 1) {
    const f = ((r + t * 0.55) % 9) / 9;
    const y = Math.round(horizon + (H - horizon) * f * f) + 0.5;
    ctx.globalAlpha = 0.08 + f * 0.42;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  // Verticals fan out from the vanishing point. Static on purpose: only the
  // rows carry the motion, which is what sells the crawl.
  for (let i = -8; i <= 8; i += 1) {
    ctx.globalAlpha = 0.3 - Math.abs(i) * 0.012;
    ctx.beginPath();
    ctx.moveTo(cx + i * W * 0.014, horizon);
    ctx.lineTo(cx + i * W * 0.115, H);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  /* ---------------------------------------------------------------- ropes */
  // A corner of ring each side, cool corner and hot corner: a turnbuckle post
  // with a ball on top, a short stub of rope running off the screen edge, and
  // three long ropes sagging inward until they melt into the horizon glow.
  // Everything else about the ring stays implied.
  for (const side of [-1, 1] as const) {
    const rgb = side < 0 ? "47, 127, 240" : "240, 57, 47";
    const postX = cx + side * W * 0.47;
    const edgeX = cx + side * W * 0.53;
    const innerX = cx + side * W * 0.17;
    const postTop = H * 0.4;

    // The post, neon over its own spill.
    ctx.strokeStyle = `rgba(${rgb}, 0.2)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(postX, postTop);
    ctx.lineTo(postX, horizon + 4);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(postX, postTop);
    ctx.lineTo(postX, horizon + 4);
    ctx.stroke();
    // The ball on top.
    ctx.fillStyle = `rgba(${rgb}, 0.35)`;
    ctx.fillRect(Math.round(postX) - 3, Math.round(postTop) - 5, 7, 6);
    ctx.fillStyle = `rgba(${rgb}, 1)`;
    ctx.fillRect(Math.round(postX) - 2, Math.round(postTop) - 4, 5, 4);
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(Math.round(postX) - 1, Math.round(postTop) - 3, 1, 1);

    for (let rope = 0; rope < 3; rope += 1) {
      const yPost = H * (0.45 + rope * 0.052);
      // Fades on its way in: the rope belongs to the corner, and the middle of
      // the ring belongs to the lettering.
      const fade = ctx.createLinearGradient(postX, 0, innerX, 0);
      fade.addColorStop(0, `rgba(${rgb}, 0.9)`);
      fade.addColorStop(1, `rgba(${rgb}, 0)`);
      // Glow pass, then the bright core over it.
      for (const [width, alpha] of [[3, 0.22], [1, 1]] as const) {
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = fade;
        ctx.beginPath();
        ctx.moveTo(postX, yPost);
        ctx.quadraticCurveTo(
          (postX + innerX) / 2,
          yPost + (horizon - yPost) * 0.72,
          innerX,
          horizon - 1,
        );
        ctx.stroke();
        // The stub the other way, off the edge of the screen.
        ctx.strokeStyle = `rgba(${rgb}, 0.75)`;
        ctx.beginPath();
        ctx.moveTo(postX, yPost);
        ctx.quadraticCurveTo((postX + edgeX) / 2, yPost + 2, edgeX, yPost + 1);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  /* ------------------------------------------------------------ the badge */
  const badgeW = 46;
  const badgeH = 32;
  const badgeY = H * 0.05;
  ctx.fillStyle = "#0a0f1a";
  ctx.fillRect(cx - badgeW / 2, badgeY, badgeW, badgeH);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#e8f1fb";
  ctx.strokeRect(cx - badgeW / 2 + 1, badgeY + 1, badgeW - 2, badgeH - 2);
  ctx.fillStyle = "#2f7ff0";
  ctx.fillRect(cx - badgeW / 2 - 6, badgeY + 7, 3, badgeH - 14);
  ctx.fillStyle = "#f0392f";
  ctx.fillRect(cx + badgeW / 2 + 3, badgeY + 7, 3, badgeH - 14);
  ctx.font = `700 22px ${DISPLAY_FONT}`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#dff0ff";
  ctx.fillText("F", cx - 6, badgeY + 24);
  ctx.fillStyle = "#ff5545";
  ctx.fillText("L", cx + 7, badgeY + 24);

  /* ---------------------------------------------------------- the letters */
  drawChrome(ctx, "FORGE", cx, H * 0.4, 62, [
    [0, "#eef8ff"],
    [0.3, "#9fd4ff"],
    [0.52, "#3f8ded"],
    [0.78, "#1a4fc0"],
    [1, "#12318c"],
  ], t);
  drawChrome(ctx, "LEAGUE", cx, H * 0.63, 62, [
    [0, "#dff0ff"],
    [0.34, "#5aa9ff"],
    [0.5, "#f4f7ff"],
    [0.64, "#ff6a5a"],
    [1, "#b81a12"],
  ], t);

  /* ------------------------------------------------------------- captions */
  ctx.font = `700 17px ${DISPLAY_FONT}`;
  ctx.fillStyle = "#f2f6fb";
  ctx.fillText("WE'LL BE RIGHT BACK", cx, H * 0.745);
  const wbrbHalf = ctx.measureText("WE'LL BE RIGHT BACK").width / 2;
  for (const side of [-1, 1] as const) {
    ctx.fillStyle = side < 0 ? "#2f7ff0" : "#f0392f";
    for (let bar = 0; bar < 3; bar += 1) {
      // Each dash blinks on its own clock — broadcast bumper, not wallpaper.
      const blink = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.7 + bar * 1.1 + (side < 0 ? 0 : 2)));
      ctx.globalAlpha = blink;
      const w = 10 - bar * 2;
      const x = cx + side * (wbrbHalf + 8 + bar * 5);
      ctx.fillRect(side < 0 ? x - w : x, Math.round(H * 0.745) - 8 + bar * 3, w, 2);
    }
  }
  ctx.globalAlpha = 1;

  /* One caption line: the slogan, and beside it the only live number on the
   * card — the real countdown to the first bell, on the league clock rather
   * than this canvas's own. Drawn as two runs so the slogan can breathe while
   * the clock holds steady; a countdown that pulses reads as a gimmick. */
  ctx.font = `700 11px ${MONO_FONT}`;
  spacing(ctx, 3);
  const taping = "TAPING UP THE NEXT CARD";
  if (bellInSeconds !== null) {
    const bell = `FIRST BELL ${bellClock(bellInSeconds)}`;
    const gapRun = "   ";
    const tapingW = ctx.measureText(taping + gapRun).width;
    const left = cx - (tapingW + ctx.measureText(bell).width) / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = "#7ad2ff";
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 2.1);
    ctx.fillText(taping + gapRun, left, H * 0.815);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffe45c";
    ctx.fillText(bell, left + tapingW, H * 0.815);
    ctx.textAlign = "center";
  } else {
    ctx.fillStyle = "#7ad2ff";
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 2.1);
    ctx.fillText(taping, cx, H * 0.815);
    ctx.globalAlpha = 1;
  }
  spacing(ctx, 0);

  /* -------------------------------------------------------------- the bar */
  const cycle = t % BAR_CYCLE_S;
  const filling = cycle < BAR_FILL_S;
  const flashing = !filling && cycle < BAR_FILL_S + BAR_FLASH_S;
  // Lit cells count up one at a time through the fill; the flash holds them
  // all and strobes; the last beat runs empty before the next lap.
  const fillFrac = filling ? cycle / BAR_FILL_S : flashing ? 1 : 0;
  const litCells = Math.floor(fillFrac * BAR_CELLS);
  const strobe = flashing ? (Math.sin((cycle - BAR_FILL_S) * Math.PI * 8) > 0 ? 1 : 0.4) : 1;

  const barW = W * 0.42;
  const barH = 17;
  const barX = cx - barW / 2;
  const barY = H * 0.865;
  ctx.lineWidth = 2;
  ctx.globalAlpha = flashing ? strobe : 0.9;
  ctx.strokeStyle = stageGradient(ctx, W);
  ctx.strokeRect(barX, barY, barW, barH);
  // The soft neon spill around the frame.
  ctx.globalAlpha = (flashing ? strobe : 1) * 0.22;
  ctx.strokeRect(barX - 2, barY - 2, barW + 4, barH + 4);
  ctx.globalAlpha = 1;

  const pad = 3;
  const gap = 2;
  const cellW = (barW - pad * 2 - gap * (BAR_CELLS - 1)) / BAR_CELLS;
  for (let i = 0; i < BAR_CELLS; i += 1) {
    const f = i / (BAR_CELLS - 1);
    const x = barX + pad + i * (cellW + gap);
    if (i < litCells) {
      ctx.globalAlpha = flashing ? strobe : 1;
      ctx.fillStyle = cellColor(f, flashing ? 1 : 0.4);
      ctx.fillRect(Math.round(x), barY + pad, Math.round(cellW), barH - pad * 2);
    } else if (i === litCells && filling) {
      // The cell being written flickers before it commits — the whole reason
      // a loading bar is watchable.
      ctx.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(t * 14));
      ctx.fillStyle = cellColor(f, 0.2);
      ctx.fillRect(Math.round(x), barY + pad, Math.round(cellW), barH - pad * 2);
    }
  }
  ctx.globalAlpha = 1;

  // Data bits beside the frame, chattering while the bar works and settling
  // once it is done.
  for (const side of [-1, 1] as const) {
    for (let bit = 0; bit < 3; bit += 1) {
      const busy = filling ? scatter(Math.floor(t * 9) * 13 + bit * 5 + (side + 1)) : 0.9;
      ctx.globalAlpha = 0.25 + 0.7 * busy;
      ctx.fillStyle = side < 0 ? "#2f7ff0" : "#f0392f";
      const size = 3 + ((bit + 1) % 2);
      const x = side < 0 ? barX - 10 - bit * 7 : barX + barW + 7 + bit * 7;
      ctx.fillRect(Math.round(x), Math.round(barY + barH / 2 - size / 2), size, size);
    }
  }
  ctx.globalAlpha = 1;
}

/** The tape-damage pass: a horizontal band tears sideways for a frame or two
 *  every several seconds. Reads from the finished frame, so it must run last. */
function drawGlitch(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number) {
  const period = 6.3;
  const local = t % period;
  if (local > 0.18) return;
  const seed = Math.floor(t / period);
  const y = Math.round(scatter(seed * 17 + 3) * BUFFER_H * 0.8);
  const h = 4 + Math.round(scatter(seed * 17 + 4) * 9);
  const shift = (scatter(seed * 17 + 5) < 0.5 ? -1 : 1) * (2 + Math.round(scatter(seed * 17 + 6) * 3));
  ctx.drawImage(canvas, 0, y, BUFFER_W, h, shift, y, BUFFER_W, h);
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillRect(0, y, BUFFER_W, 1);
}

/** Scanlines and corner shading, the CRT the rest of the site pretends to be
 *  behind. */
function drawCrt(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
  for (let y = 0; y < BUFFER_H; y += 2) {
    ctx.fillRect(0, y, BUFFER_W, 1);
  }
  const vignette = ctx.createRadialGradient(
    BUFFER_W / 2, BUFFER_H / 2, BUFFER_H * 0.55,
    BUFFER_W / 2, BUFFER_H / 2, BUFFER_W * 0.62,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.34)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, BUFFER_W, BUFFER_H);
}

export function IntermissionReel({ bellInSeconds = null }: { bellInSeconds?: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The countdown arrives as a prop on the league clock's cadence, but the
  // render loop is started once — so the loop reads it through a ref instead
  // of restarting on every tick.
  const bellRef = useRef(bellInSeconds);

  useEffect(() => {
    bellRef.current = bellInSeconds;
  }, [bellInSeconds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const frame = (t: number) => {
      drawReel(ctx, t, bellRef.current);
      drawGlitch(ctx, canvas, t);
      drawCrt(ctx);
    };

    // Reduced motion gets the same card, held on one honest frame: bar
    // two-thirds in, stars mid-twinkle, nothing moving.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frame(BAR_FILL_S * 0.66);
      return;
    }

    let raf = 0;
    const loop = (now: number) => {
      frame(now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="broadcast__reel"
      width={BUFFER_W}
      height={BUFFER_H}
      aria-hidden="true"
    />
  );
}

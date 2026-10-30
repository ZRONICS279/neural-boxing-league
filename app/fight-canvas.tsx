"use client";

import { useEffect, useRef } from "react";
import {
  BOXING_MODEL,
  formatImpactZone,
  type BoutFighter,
  type BoutState,
  type Corner,
  type Fighter,
  type FighterAction,
  type ImpactZone,
} from "./fight-model";
import {
  crowdLive,
  isMuted,
  keepRing,
  playCue,
  silenceRing,
  startCount,
  startCrowd,
  stopCount,
  stopCrowd,
  type Cue,
} from "./sound";

/** How far ahead of the FIGHT flash the cue starts, in simulation seconds. The
 *  sting has an attack on the front of it, so started dead on the flash it lands
 *  late; this is the lead that makes the hit and the letters coincide. */
const CUE_LEAD_SECONDS = 0.5;

/** The crowd tape opens with three bell rings whose tail dies ~1.5 s in, and
 *  the contract is that the last ring fades exactly as the FIGHT sting fires.
 *  Started this far before the end of the corner break, the sums close: 0.4 s
 *  of break + the 1.6 s round call − the sting's 0.5 s lead = 1.5 s of bell.
 *  Round one has no break to lead with, so it starts on the call instead and
 *  runs a beat tight. */
const CROWD_BREAK_LEAD_SECONDS = 0.4;

/** How long the arena stays up after a stoppage, in real milliseconds. A room
 *  that goes silent the instant a man is counted out leaves the K.O. sting and
 *  the cheering on the end of the count tape standing in an empty building.
 *  Long enough to cover both — the tape's own cheers run out about five and a
 *  half seconds past the ten — and short enough to be gone before the music
 *  between fights comes up. */
const CROWD_STOPPAGE_HOLD_MS = 9000;

/* A broadcast-arcade renderer for the live bout.
 *
 * The whole scene is painted into one low-resolution frame — an arena bowl with
 * a crowd, a real four-rope ring seen in perspective, a referee, and two
 * articulated fighters — and the browser blows it back up with nearest-
 * neighbour scaling (image-rendering: pixelated on .fight-canvas). Every
 * coordinate below is therefore in *buffer pixels* and every shape is snapped to
 * whole pixels, so nothing smears when the camera pans.
 *
 * The renderer invents no contact. Positions, hand travel, aim height, struck
 * zone and energy all come off the BoutState the simulation produces; the job
 * here is only to make them legible. Concretely that means three things:
 *
 *   1. Punches are drawn as real limbs. Each fighter is a skeleton — hips,
 *      chest, shoulders, elbows, gloves, knees, feet — and a punch moves the
 *      glove along a path whose SHAPE is chosen by the punch: a jab spears
 *      straight, a cross turns the hips through it, a hook winds back and
 *      swings a wide bent-arm arc, an uppercut dips to the hip and rips
 *      upward. You can tell what was thrown from the silhouette alone.
 *   2. The glove arrives where the sim aimed it. Forward travel is the sim's
 *      own handExtension in metres and the height is its punchAimHeight, so a
 *      body shot visibly finishes at the ribs and a head shot at the chin —
 *      and if the man slipped, the glove sails through empty air.
 *   3. The landing spot is marked on the body. Every ImpactZone has an
 *      anatomical position on the sprite; a landed punch bursts exactly there,
 *      tags it by name, and leaves a mark that stays on the fighter for the
 *      rest of the night.
 */

const RING_LENGTH_M = BOXING_MODEL.ringLengthMeters;
const RING_DEPTH_M = BOXING_MODEL.ringDepthMeters;

// The frame is sized from the element, but this is the width we aim the integer
// zoom at — it sets how chunky a pixel ends up being.
const FRAME_WIDTH = 340;

// Sprites are drawn side-on and solid, so at a true clinch the two would occupy
// the same pixels. The drawing (never the sim) is spread to this floor, and hand
// travel is spread with it so a punch still finishes on the body it was aimed at.
const MIN_VISUAL_GAP_M = 0.78;

// Sides only swap once the real gap is decisively the other way, remembered
// between frames: the pair circle on a plane, so their raw x-gap crosses zero
// constantly and reading the drawn side straight off its sign teleports both
// sprites across each other on a millimetre of jitter.
const SIDE_SWAP_THRESHOLD_M = 0.3;

const POWER_IMPACT_J = 55;
/* The tier above a power shot: a landing hard enough to drop a man, roughly
 * 700 lbf of peak force through the guard. Measured across twelve full bouts:
 * about 1.3 a fight on average, none at all in a third of fights, and mostly
 * heavyweights — a sound that stays rare enough to mean something. */
const HAYMAKER_IMPACT_J = 65;
const COMBO_WINDOW_MS = 1400;
const OUTLINE = "#07060d";

const HEAD_ZONES = new Set<ImpactZone>([
  "jaw",
  "chin",
  "nose",
  "temple",
  "forehead",
  "cheek",
]);

/* ------------------------------------------------------------- punch catalogue */

type ArcKind = "straight" | "hook" | "uppercut";

interface PunchInfo {
  hand: "lead" | "rear" | "either";
  target: "head" | "body";
  arc: ArcKind;
  label: string;
  // Fraction of the action spent winding up before the hand leaves the guard.
  windup: number;
  // Fraction of the action at which the sim scores contact — PUNCH_SPECS'
  // number, copied here because the renderer deliberately imports no engine
  // code beyond BOXING_MODEL, a formatter and types.
  contactPhase: number;
}

const PUNCH_INFO: Partial<Record<FighterAction, PunchInfo>> = {
  jabHead: { hand: "lead", target: "head", arc: "straight", label: "JAB", windup: 0.14, contactPhase: 0.46 },
  crossHead: { hand: "rear", target: "head", arc: "straight", label: "CROSS", windup: 0.2, contactPhase: 0.5 },
  hookHead: { hand: "either", target: "head", arc: "hook", label: "HOOK", windup: 0.26, contactPhase: 0.48 },
  jabBody: { hand: "lead", target: "body", arc: "straight", label: "BODY JAB", windup: 0.16, contactPhase: 0.48 },
  crossBody: { hand: "rear", target: "body", arc: "straight", label: "BODY CROSS", windup: 0.2, contactPhase: 0.5 },
  hookBody: { hand: "either", target: "body", arc: "hook", label: "BODY HOOK", windup: 0.26, contactPhase: 0.48 },
  uppercut: { hand: "either", target: "head", arc: "uppercut", label: "UPPERCUT", windup: 0.24, contactPhase: 0.52 },
};

/* Which recording a clean landing plays. Body shots share one thud whichever
 * hand threw them, a landing at POWER_IMPACT_J or better plays the power
 * sample no matter what the punch was called, and HAYMAKER_IMPACT_J or better
 * plays the haymaker over everything. */
const PUNCH_CUE: Partial<Record<FighterAction, Cue>> = {
  jabHead: "jab",
  crossHead: "cross",
  hookHead: "hook",
  jabBody: "bodyshot",
  crossBody: "bodyshot",
  hookBody: "bodyshot",
  uppercut: "uppercut",
};

/* Where each struck zone actually sits on a standing fighter.
 *
 * `up` is a fraction of standing height. `front` is how far the spot lies
 * toward the man throwing, as a fraction of the half-width of whatever it sits
 * on — so the liver is forward and low on the near flank, the temple is back and
 * high on the skull, and the burst lands on the right piece of anatomy instead
 * of somewhere in the middle of the sprite. */
// Pinned to the drawn anatomy in buildSkeleton, not to a real body: crown 1.0,
// chin 0.78, shoulder line 0.735, waist 0.48. Move one and these move with it,
// or the bursts and the damage marks start landing off the man.
const ZONE_SITE: Record<ImpactZone, { up: number; front: number }> = {
  guard: { up: 0.82, front: 1.35 },
  forehead: { up: 0.975, front: 0.5 },
  temple: { up: 0.955, front: 0.1 },
  nose: { up: 0.918, front: 1 },
  cheek: { up: 0.905, front: 0.8 },
  jaw: { up: 0.868, front: 0.85 },
  chin: { up: 0.832, front: 1 },
  chest: { up: 0.73, front: 0.75 },
  solarPlexus: { up: 0.67, front: 0.8 },
  ribs: { up: 0.652, front: 0.15 },
  liver: { up: 0.635, front: 0.55 },
  abdomen: { up: 0.585, front: 0.7 },
};

function zoneIsHead(zone: ImpactZone) {
  return HEAD_ZONES.has(zone);
}

/* The drawn anatomy's vertical landmarks, as fractions of standing height, and
 * the single source of truth for them: buildSkeleton lays the rig out on these,
 * drawHead sizes the skull from them, and the damage marks are pinned with
 * them. Kept as named constants because they were previously written out by
 * hand in three places, and the three drifted apart. */
const HIP_UP = 0.52;
const SHOULDER_UP = 0.774;
const NECK_UP = 0.8;
const HEAD_UP = 0.905;
const HEAD_R = 0.096;

// The featherweight rig is the baseline. Add muscle around the same bones,
// with more growth at the shoulders and muscle bellies than at the joints.
function fighterBulk(weightClass: Fighter["weightClass"]) {
  return weightClass === "heavyweight" ? 1 : weightClass === "middleweight" ? 0.5 : 0;
}

/* ------------------------------------------------------------- hoardings */

/* One billboard on the skyline behind the ring — the sellable surface.
 *
 * Boards are assigned to a fixed sequence of mounting points along the city, so
 * a given slot is always the same board on the same rooftop however the camera
 * pans, and a buyer gets a position rather than a lottery ticket. Pass a
 * different array to `FightCanvas` to change what is on sale.
 *
 * A board with no `art` is a plain lit panel with the two strings on it, which
 * is all an unsold slot needs. Naming an `art` key hands the whole face to a
 * painter out of AD_ART, and that painter does the artwork AND the lettering —
 * so selling a slot to a real advertiser is one entry here plus one painter,
 * and taking it back off sale is deleting the `art` line. */
export interface AdFace {
  headline: string;
  sub?: string;
  /** Frame, lettering and the glow it throws. */
  accent?: string;
  /** The lit face behind the lettering. */
  panel?: string;
  /** Which painter fills the face. Plain text panel when omitted. */
  art?: AdArtKey;
  /** Artwork supplied by the buyer, as a URL. Wins over `art` when both are
   *  set, because a sold slot outranks the house board that was holding it. */
  image?: string;
  /** Destination opened when a viewer clicks this board. */
  href?: string;
}

export interface AdBoard extends AdFace {
  /** Optional faces for this physical board. With no options, this board stays
   *  on the face defined above forever. */
  options?: AdFace[];
}

/* The slot a bought banner is hung in.
 *
 * Every image ad gets the same box whatever it was drawn at, so a buyer knows
 * the shape they are buying and two adjacent boards do not come out different
 * sizes. Artwork is fitted inside it on its own aspect and centred, so nothing
 * ever arrives stretched. Roughly 5:2, which is the shape of a real roadside
 * hoarding and of most banner art people turn up with. */
const AD_SLOT = { width: 96, height: 40 };
/** A purchased board stays up for a full skyline pass before the next
 *  advertiser takes the same physical slot. */
const AD_ROTATION_MS = 30_000;

export const DEFAULT_ADS: AdBoard[] = [
  { headline: "DOUBLE KING", sub: "9.99", accent: "#ffd75e", panel: "#1d2f8c", art: "burger", href: "https://www.forgeleague.space/" },
  { headline: "TATBRAT", accent: "#c9a6ff", panel: "#241436", image: "/banners/images.jpeg", href: "https://www.forgeleague.space/" },
  { headline: "TONIGHT", accent: "#ffd75e", panel: "#1a1230", art: "matchup", href: "https://www.forgeleague.space/" },
  { headline: "AD SPACE", sub: "AVAILABLE", accent: "#7cff9b", panel: "#123024", href: "https://www.forgeleague.space/" },
  { headline: "FORGE LEAGUE", sub: "SEASON 01", accent: "#ffd75e", panel: "#2a1206", art: "forge", href: "https://www.forgeleague.space/" },
];

/* Buyer artwork, fetched once and held.
 *
 * A board is painted sixty times a second and the loop cannot wait on a
 * network round trip, so this hands back null until the bitmap is actually
 * decoded and the board shows its plain lit panel in the meantime. A file that
 * never loads therefore degrades to an empty rented board rather than a hole in
 * the skyline. */
const adImages = new Map<string, HTMLImageElement>();

function adImage(src: string) {
  let image = adImages.get(src);
  if (!image) {
    image = new Image();
    image.src = src;
    adImages.set(src, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/* ---------------------------------------------------------------- board art */

export type AdArtKey = "burger" | "forge" | "matchup";

interface AdArt {
  /** The face this painter wants, in frame pixels. It is centred in the slot. */
  width: number;
  height: number;
  /** Paints the whole face, lettering included. Origin is the top-left pixel. */
  paint: (ctx: CanvasRenderingContext2D, x: number, y: number, ad: AdFace, s: Scene) => void;
}

/* Face sizes, cut to the floor the lettering sets.
 *
 * These are as small as the boards go without the copy on them getting harder
 * to read, and the number that decides it is the font: the glyphs are 5×7 with
 * a 6px advance and scale 1 is the smallest they exist at. So the longest run
 * of text on a face is a hard minimum width nothing can shave. "SEASON 01" is
 * 53px, the "9.99" price is 46px at the double size that makes it a price
 * rather than a caption, and a nine-character surname is 53px.
 *
 * Everything that is NOT type came down instead: the target rings, the glove,
 * the burger. Burger and forge each lost about a quarter of their area that
 * way. The matchup board did not move, because it is two nine-character names
 * side by side with the VS between them, and it was already sat on the floor
 * those three set — the only way it gets smaller is by truncating fighters'
 * names further, which is exactly the readability this is protecting. */
const AD_ART: Record<AdArtKey, AdArt> = {
  burger: { width: 88, height: 40, paint: paintBurgerAd },
  forge: { width: 90, height: 38, paint: paintForgeAd },
  matchup: { width: 120, height: 50, paint: paintMatchupAd },
};

/* A filled disc laid down scanline by scanline. Everything in the backdrop is
 * stamped as axis-aligned rects to keep it on the pixel grid, and an arc() here
 * would be the one antialiased edge in the whole city. */
function pixelDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  for (let dy = -r; dy <= r; dy += 1) {
    const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    rect(ctx, cx - half, cy + dy, half * 2 + 1, 1, color);
  }
}

/* Burger joint. Product on the left, price on the right, which is every fast
 * food hoarding ever printed. */
// No `s` parameter: nothing on this face animates, and a painter is free to
// take fewer arguments than the signature offers.
function paintBurgerAd(ctx: CanvasRenderingContext2D, x: number, y: number, ad: AdFace) {
  const accent = ad.accent ?? "#ffd75e";
  // A block of hot colour behind the burger, so the product sits on its own
  // field rather than floating on the panel like a sticker.
  rect(ctx, x + 2, y + 2, 32, 33, "#d8342a");

  const bx = x + 4;
  const by = y + 4;
  const bw = 28;
  const band = (top: number, h: number, inset: number, color: string) =>
    rect(ctx, bx + inset, by + top, bw - inset * 2, h, color);

  // Top bun: a dome stepped in four courses, then sesame.
  band(0, 1, 9, "#e8a852");
  band(1, 1, 6, "#e8a852");
  band(2, 1, 4, "#e8a852");
  band(3, 1, 2, "#e8a852");
  band(4, 3, 1, "#e8a852");
  band(1, 1, 7, "#f7c778");
  band(2, 1, 5, "#f7c778");
  band(3, 2, 4, "#f7c778");
  for (const [sx, sy] of [[7, 3], [12, 2], [18, 3], [10, 5], [15, 5], [21, 4]]) {
    rect(ctx, bx + sx, by + sy, 2, 1, "#fff0cf");
  }
  // Lettuce, with a torn bottom edge — a flat green bar reads as a ruler.
  band(7, 2, 1, "#6fbe4a");
  for (let i = 1; i < bw - 1; i += 3) rect(ctx, bx + i, by + 9, 2, 1, "#8ad961");
  // Cheese over the first patty, with two drips down the side.
  band(10, 2, 1, "#ffc23c");
  rect(ctx, bx + 4, by + 12, 2, 3, "#ffc23c");
  rect(ctx, bx + 20, by + 12, 2, 2, "#ffc23c");
  band(12, 5, 2, "#6b3a22");
  for (const [px, py] of [[5, 13], [11, 15], [18, 13], [22, 15]]) {
    rect(ctx, bx + px, by + py, 2, 1, "#4a2416");
  }
  // The second patty, which is the whole pitch.
  band(17, 2, 1, "#ffc23c");
  band(19, 5, 2, "#6b3a22");
  for (const [px, py] of [[8, 20], [15, 22], [20, 20]]) {
    rect(ctx, bx + px, by + py, 2, 1, "#4a2416");
  }
  // Bottom bun.
  band(24, 5, 2, "#d1913f");
  band(28, 1, 3, "#a86c28");

  // Lettering: the name stacked word per word, then the price big. The price
  // stays at double size — at scale 1 it stops being a price and becomes a
  // caption — so its 46px is what sets the width of this whole face.
  const words = ad.headline.toUpperCase().split(" ").slice(0, 2);
  const tx = x + 38;
  words.forEach((word, i) => {
    drawPixelText(ctx, word, tx, y + 2 + i * 8, 1, "#ffffff", { shadow: "#0b0918" });
  });
  const price = (ad.sub ?? "").toUpperCase();
  if (price) {
    // Double-size glyphs are 14 tall and the drop shadow adds two more, so the
    // rule under them has to clear y+35 or it strikes through the digits.
    drawPixelText(ctx, price, tx, y + 19, 2, accent, { shadow: "#0b0918" });
  }
  rect(ctx, tx, y + 36, 46, 1, accent);
}

/* The league advertising itself: a glove coming off a target of rings, which is
 * the loudest thing you can build out of discs and rects. */
function paintForgeAd(ctx: CanvasRenderingContext2D, x: number, y: number, ad: AdFace, s: Scene) {
  const accent = ad.accent ?? "#ffd75e";
  const cx = x + 71;
  const cy = y + 18;
  // Rings, painted big to small so each one is a band of the last. The outer
  // radius is what the face height affords — any wider and the target is
  // cropped square by the frame instead of ending in sky.
  const rings = ["#ffd75e", "#f0a92e", "#ffd75e", "#f0a92e", "#ffd75e"];
  rings.forEach((color, i) => pixelDisc(ctx, cx, cy, 15 - i * 3, color));

  // The glove: mitt, thumb, cuff. Slow float, so the board is alive without
  // stealing an eye that belongs on the ring.
  const bob = Math.round(Math.sin(s.time / 620));
  const gx = cx - 1;
  const gy = cy + bob;
  pixelDisc(ctx, gx, gy, 9, "#0b0918");
  pixelDisc(ctx, gx, gy, 8, "#d8342a");
  pixelDisc(ctx, gx - 2, gy - 2, 3, "#f5705e");
  pixelDisc(ctx, gx - 7, gy + 4, 4, "#0b0918");
  pixelDisc(ctx, gx - 7, gy + 4, 3, "#c62c22");
  rect(ctx, gx - 5, gy + 8, 11, 6, "#0b0918");
  rect(ctx, gx - 4, gy + 8, 9, 4, "#8a1c16");
  rect(ctx, gx - 4, gy + 9, 9, 1, "#f6d97a");
  // Lacing.
  for (let i = 0; i < 3; i += 1) rect(ctx, gx + 1, gy - 4 + i * 3, 2, 1, "#f6e6c0");

  const words = ad.headline.toUpperCase().split(" ").slice(0, 2);
  words.forEach((word, i) => {
    drawPixelText(ctx, word, x + 4, y + 4 + i * 9, 1, accent, { shadow: "#0b0918" });
  });
  const sub = (ad.sub ?? "").toUpperCase();
  if (sub) drawPixelText(ctx, sub, x + 4, y + 25, 1, "#ffb08a", { shadow: "#0b0918" });
  rect(ctx, x + 4, y + 22, 53, 1, "#ff6b4a");
}

/* Tonight's card, on the skyline: the two men actually in the ring, drawn from
 * the same kits their sprites use, so a viewer who looks up sees the fight they
 * are watching rather than a generic poster. */
function paintMatchupAd(ctx: CanvasRenderingContext2D, x: number, y: number, ad: AdFace, s: Scene) {
  const accent = ad.accent ?? "#ffd75e";
  const panel = ad.panel ?? "#1a1230";

  // Title bar across the top, knocked out of the accent.
  rect(ctx, x, y, 120, 9, accent);
  drawPixelText(ctx, ad.headline.toUpperCase(), x + 60, y + 1, 1, panel, { align: "center" });

  const corners: { corner: Corner; px: number }[] = [
    { corner: "blue", px: x + 22 },
    { corner: "red", px: x + 98 },
  ];
  for (const { corner, px } of corners) {
    const profile = s.profiles[corner];
    const kit = buildKit(corner, profile.seed);
    drawAdPortrait(ctx, px, y + 12, kit, fighterBulk(profile.weightClass));
    drawPixelText(ctx, profile.name.toUpperCase().slice(0, 9), px, y + 41, 1, kit.trim, {
      align: "center",
      shadow: "#0b0918",
    });
  }

  // VS between them, pulsing on the same slow clock as the board lights.
  const hot = Math.sin(s.time / 480) > 0;
  drawPixelText(ctx, "VS", x + 60, y + 20, 2, hot ? "#ffffff" : accent, {
    align: "center",
    outline: "#0b0918",
  });
}

/* A fighter's head straight down the lens, centred on (cx, top). The ring
 * sprite is only ever seen in profile, so this is drawn from scratch rather
 * than lifted off drawHead — but every colour comes out of the same Kit, which
 * is what ties the face on the hoarding to the man throwing punches. */
function drawAdPortrait(ctx: CanvasRenderingContext2D, cx: number, top: number, kit: Kit, bulk = 0) {
  // A cropped boxing torso, with the traps sloping into rounded deltoids.
  // Keep it inside the old portrait slot so the face and name stay put.
  // One extra pixel per shoulder for middleweights, two for heavyweights:
  // this tiny crop has less room than the full fighter, but the same build.
  const muscle = Math.round(bulk * 2);
  const cap = Math.floor(muscle / 2);
  const shoulders = [5, 8, 11, 13, 14, 14, 14, 13];
  shoulders.forEach((base, row) => {
    const half = base + (row === 0 ? cap : muscle);
    const y = top + 20 + row;
    rect(ctx, cx - half - 1, y, half * 2 + 2, 1, "#0b0918");
    rect(ctx, cx - half, y, half * 2, 1, kit.skin);
    if (row < 2) return;
    // Broad light on the near shoulder, a shaded cap on the far one.
    rect(ctx, cx - half, y, 2 + cap, 1, kit.skinLight);
    rect(ctx, cx + half - 3 - cap, y, 3 + cap, 1, kit.skinShade);
  });
  // Two chest planes and the folds where the upper arms leave the ribs.
  rect(ctx, cx - 7 - muscle, top + 23 - cap, 6 + muscle, 2 + cap, kit.skinLight);
  rect(ctx, cx + 1, top + 23, 5 + muscle, 1 + cap, kit.skinLight);
  rect(ctx, cx - 7 - muscle, top + 25, 6 + muscle, 1, kit.skinShade);
  rect(ctx, cx + 1, top + 25, 6 + muscle, 1, kit.skinShade);
  rect(ctx, cx - 10 - muscle, top + 25, 1, 3, kit.skinShade);
  rect(ctx, cx + 9 + muscle, top + 25, 1, 3, kit.skinDark);
  // Only the cropped lower edge carries the corner colour now.
  rect(ctx, cx - 9 - muscle, top + 27, 18 + muscle * 2, 1, kit.trunkLight);
  rect(ctx, cx - 4 - cap, top + 17, 8 + cap * 2, 6, kit.skinShade);

  // Skull: a block with the top corners bitten off, same trick the sprite uses.
  const bite = 3;
  rect(ctx, cx - 9, top + bite - 1, 18, 21 - bite, "#0b0918");
  rect(ctx, cx - 9 + bite, top - 1, 18 - bite * 2, 22, "#0b0918");
  rect(ctx, cx - 8, top + bite, 16, 18 - bite, kit.skin);
  rect(ctx, cx - 8 + bite, top, 16 - bite * 2, 18, kit.skin);
  // Lit from the ring's left, shaded down the far cheek and under the jaw.
  rect(ctx, cx - 8, top + bite, 3, 15, kit.skinLight);
  rect(ctx, cx + 5, top + bite, 3, 15, kit.skinShade);
  rect(ctx, cx - 6, top + 16, 12, 2, kit.skinShade);
  rect(ctx, cx - 5, top + 18, 10, 1, kit.skinDark);

  // The species faces are authored head-on from scratch, same grid as the
  // human one. The skull above already came out in the right ramp — bone,
  // fur or gunmetal — because every colour goes through the Kit.
  switch (kit.species) {
    case "skeleton":
      // Sockets, nasal cavity, and the grin with its seams ticked through.
      rect(ctx, cx - 7, top + 7, 5, 5, kit.skinDark);
      rect(ctx, cx + 2, top + 7, 5, 5, kit.skinDark);
      rect(ctx, cx - 5, top + 9, 1, 1, "#f4f7fb");
      rect(ctx, cx + 4, top + 9, 1, 1, "#f4f7fb");
      rect(ctx, cx - 1, top + 12, 2, 3, kit.skinDark);
      rect(ctx, cx - 5, top + 15, 10, 1, kit.skinDark);
      rect(ctx, cx - 5, top + 16, 10, 3, kit.skinLight);
      for (let tx = -4; tx <= 4; tx += 2) rect(ctx, cx + tx, top + 16, 1, 3, kit.skinShade);
      break;
    case "alien": {
      // The dome takes its three permitted rows; two black almonds take the face.
      rect(ctx, cx - 8, top - 3, 16, 3, "#0b0918");
      rect(ctx, cx - 7, top - 3, 14, 3 + bite, kit.skin);
      rect(ctx, cx - 3, top - 2, 6, 1, kit.skinLight);
      rect(ctx, cx - 8, top + 8, 5, 3, "#10141c");
      rect(ctx, cx - 6, top + 11, 3, 2, "#10141c");
      rect(ctx, cx + 3, top + 8, 5, 3, "#10141c");
      rect(ctx, cx + 3, top + 11, 3, 2, "#10141c");
      rect(ctx, cx - 5, top + 8, 1, 1, "#9fb9c9");
      rect(ctx, cx + 4, top + 8, 1, 1, "#9fb9c9");
      rect(ctx, cx - 1, top + 13, 1, 1, kit.skinDark);
      rect(ctx, cx + 1, top + 13, 1, 1, kit.skinDark);
      rect(ctx, cx - 2, top + 15, 4, 1, kit.skinShade);
      break;
    }
    case "robot":
      // Seam and rivets above the visor, the lens lit in corner colour.
      rect(ctx, cx, top + 1, 1, 6, kit.skinShade);
      rect(ctx, cx - 7, top + 3, 1, 1, kit.skinDark);
      rect(ctx, cx + 6, top + 3, 1, 1, kit.skinDark);
      rect(ctx, cx - 8, top + 7, 16, 5, "#10141c");
      rect(ctx, cx - 6, top + 8, 12, 3, kit.glove);
      rect(ctx, cx - 6, top + 8, 3, 1, kit.gloveLight);
      rect(ctx, cx - 4, top + 15, 8, 2, kit.skinShade);
      rect(ctx, cx - 4, top + 15, 8, 1, kit.skinLight);
      // Side bolts where the ears would sit.
      rect(ctx, cx - 10, top + 8, 2, 4, kit.skinShade);
      rect(ctx, cx + 8, top + 8, 2, 4, kit.skinShade);
      break;
    case "grizzly":
      // Ears on the top corners, then the pale muzzle with its dark nose.
      rect(ctx, cx - 10, top - 3, 6, 6, "#0b0918");
      rect(ctx, cx + 4, top - 3, 6, 6, "#0b0918");
      rect(ctx, cx - 9, top - 2, 4, 4, kit.skin);
      rect(ctx, cx + 5, top - 2, 4, 4, kit.skin);
      rect(ctx, cx - 8, top - 1, 2, 2, kit.skinShade);
      rect(ctx, cx + 6, top - 1, 2, 2, kit.skinShade);
      rect(ctx, cx - 6, top + 7, 2, 2, "#10141c");
      rect(ctx, cx + 4, top + 7, 2, 2, "#10141c");
      rect(ctx, cx - 5, top + 9, 10, 9, kit.skinLight);
      rect(ctx, cx - 2, top + 10, 4, 3, kit.skinDark);
      rect(ctx, cx, top + 13, 1, 2, kit.skinShade);
      rect(ctx, cx - 3, top + 15, 6, 1, kit.skinShade);
      // Eskobear's muzzle comes back dusted white under the nose. The name
      // explains the powder; the powder explains the name.
      if (kit.dusted) {
        rect(ctx, cx - 3, top + 13, 6, 2, "#f4f7fb");
        rect(ctx, cx - 4, top + 12, 1, 1, "#f4f7fb");
        rect(ctx, cx + 3, top + 12, 1, 1, "#f4f7fb");
      }
      break;
    case "gorilla":
      // Crest on the crown, the brow shelf, and the bare dark face under it.
      rect(ctx, cx - 3, top - 3, 6, 3, "#0b0918");
      rect(ctx, cx - 2, top - 3, 4, 3 + bite, kit.skin);
      rect(ctx, cx - 6, top + 9, 12, 9, kit.skinShade);
      rect(ctx, cx - 7, top + 7, 14, 2, kit.skinDark);
      rect(ctx, cx - 5, top + 9, 2, 2, "#10141c");
      rect(ctx, cx + 3, top + 9, 2, 2, "#10141c");
      rect(ctx, cx - 2, top + 14, 1, 2, kit.skinDark);
      rect(ctx, cx + 1, top + 14, 1, 2, kit.skinDark);
      rect(ctx, cx - 3, top + 16, 6, 1, kit.skinDark);
      // Ears.
      rect(ctx, cx - 10, top + 8, 2, 4, kit.skinShade);
      rect(ctx, cx + 8, top + 8, 2, 4, kit.skinShade);
      break;
    default: {
      // Human and cyborg. The cyborg wears the plate where the hair went and
      // one lens in his corner colour; the rest of the face is his own.
      if (kit.species === "cyborg") {
        rect(ctx, cx - 8 + bite, top, 16 - bite * 2, bite, METAL_RAMP.mid);
        rect(ctx, cx - 8, top + bite, 16, 2, METAL_RAMP.mid);
        rect(ctx, cx - 4, top + 1, 7, 1, METAL_RAMP.light);
        rect(ctx, cx - 6, top + 4, 1, 1, METAL_RAMP.dark);
        rect(ctx, cx + 5, top + 4, 1, 1, METAL_RAMP.dark);
      } else {
        drawPortraitHair(ctx, cx, top, bite, kit);
      }

      // Ears.
      rect(ctx, cx - 10, top + 8, 2, 4, kit.skinShade);
      rect(ctx, cx + 8, top + 8, 2, 4, kit.skinShade);
      // Braids hang past the ears, so their strands come back on top of them.
      if (kit.hairStyle === "braids") {
        hairFill(ctx, kit, cx - 8, top + bite, 2, 15);
        hairFill(ctx, kit, cx + 6, top + bite, 2, 15);
      }

      // Brow, eyes, nose, mouth. The brow is the whole expression at this size: a
      // face without one is a mask, a face with one is glaring down a city block.
      rect(ctx, cx - 7, top + 8, 5, 1, kit.skinDark);
      rect(ctx, cx + 2, top + 8, 5, 1, kit.skinDark);
      rect(ctx, cx - 7, top + 9, 4, 2, "#f4f7fb");
      rect(ctx, cx + 3, top + 9, 4, 2, "#f4f7fb");
      rect(ctx, cx - 6, top + 9, 2, 2, "#241a14");
      rect(ctx, cx + 4, top + 9, 2, 2, "#241a14");
      if (kit.species === "cyborg") {
        rect(ctx, cx + 3, top + 9, 4, 2, "#10141c");
        rect(ctx, cx + 4, top + 9, 2, 2, kit.gloveLight);
      }
      rect(ctx, cx - 1, top + 10, 2, 4, kit.skinShade);
      rect(ctx, cx - 2, top + 13, 4, 1, kit.skinDark);
      rect(ctx, cx - 4, top + 16, 8, 1, kit.skinDark);
      break;
    }
  }
}

/** A fighter's broadcast portrait outside the ring.
 *
 * This uses the same authored face, species and hair tables as the live canvas,
 * rendered into its own tiny buffer so CSS can scale it without softening the
 * pixels. The division tint replaces the temporary red/blue corner colour — a
 * champion on the homepage belongs to his weight class, not tonight's corner. */
export function FighterPortrait({ fighter, className }: { fighter: Fighter; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    const kit = buildKit("blue", fighter.seed);
    const division = fighter.weightClass === "featherweight"
      ? { light: "#91efcc", mid: "#55dba7", dark: "#237a5c" }
      : fighter.weightClass === "middleweight"
        ? { light: "#ffe09a", mid: "#ffc247", dark: "#946510" }
        : { light: "#ff8b83", mid: "#f04841", dark: "#8d211d" };

    kit.trunkLight = division.light;
    kit.trunk = division.mid;
    kit.trunkShade = division.dark;
    kit.gloveLight = division.light;
    kit.glove = division.mid;
    kit.gloveShade = division.dark;
    kit.trim = division.light;
    drawAdPortrait(ctx, 18, 4, kit, fighterBulk(fighter.weightClass));
  }, [fighter.seed, fighter.weightClass]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width="36"
      height="34"
      aria-hidden="true"
    />
  );
}

/* Fill a block of hair. Flat colour for everyone except the rainbow head,
 * which cycles its bands one scanline at a time — indexed off the absolute
 * row, so stripes stay aligned across adjacent blocks. */
function hairFill(ctx: CanvasRenderingContext2D, kit: Kit, x: number, y: number, w: number, h: number) {
  if (!kit.hairBands) {
    rect(ctx, x, y, w, h, kit.hair);
    return;
  }
  for (let row = 0; row < h; row++) {
    rect(ctx, x, y + row, w, 1, kit.hairBands[Math.abs(y + row) % kit.hairBands.length]);
  }
}

/* The head-on version of every style. Anything taller than the skull may only
 * climb three rows above `top` — the matchup board's title bar starts there
 * and a flat top poking through six-foot lettering reads as a glitch, not a
 * haircut. */
function drawPortraitHair(ctx: CanvasRenderingContext2D, cx: number, top: number, bite: number, kit: Kit) {
  switch (kit.hairStyle) {
    case "bald":
      // Bare crown: one shine row where the fringe used to sit.
      rect(ctx, cx - 4, top + 1, 8, 1, kit.skinLight);
      return;
    case "buzz":
      // Tight to the scalp — the crown rows only, nothing past the ears.
      hairFill(ctx, kit, cx - 8 + bite, top, 16 - bite * 2, bite);
      hairFill(ctx, kit, cx - 8, top + bite, 16, 1);
      break;
    case "flattop":
      // Square the bitten corners off and carry the box a few rows higher.
      rect(ctx, cx - 9, top - 3, 18, 3 + bite, "#0b0918");
      hairFill(ctx, kit, cx - 8, top - 2, 16, 2 + bite);
      hairFill(ctx, kit, cx - 8, top + bite, 16, 1);
      break;
    case "afro":
      // A mass wider and taller than the skull, corners stepped to read round.
      rect(ctx, cx - 11, top - 1, 22, 8, "#0b0918");
      rect(ctx, cx - 9, top - 3, 18, 10, "#0b0918");
      hairFill(ctx, kit, cx - 10, top, 20, 6);
      hairFill(ctx, kit, cx - 8, top - 2, 16, 8);
      break;
    default: {
      // crop, cornrows and braids share the classic cap; the extras go on top
      // (cornrows here, braid strands after the ears are drawn).
      hairFill(ctx, kit, cx - 8 + bite, top, 16 - bite * 2, bite);
      hairFill(ctx, kit, cx - 8, top + bite, 16, 3);
      hairFill(ctx, kit, cx - 8, top + bite, 2, 7);
      hairFill(ctx, kit, cx + 6, top + bite, 2, 7);
      if (kit.hairStyle === "cornrows") {
        // Rows run front to back, so head-on they are vertical part lines.
        ctx.globalAlpha = 0.45;
        rect(ctx, cx - 3, top, 1, bite + 3, kit.skinDark);
        rect(ctx, cx, top, 1, bite + 3, kit.skinDark);
        rect(ctx, cx + 3, top, 1, bite + 3, kit.skinDark);
        ctx.globalAlpha = 1;
      }
      break;
    }
  }
  rect(ctx, cx - 4, top + 1, 7, 1, kit.skinLight);
}

/* ------------------------------------------------------------------- palette */

/* One fighter's full ramp. Every tone the sprite may use lives here — four steps
 * of skin, three of trunks, three of glove — and shapes pick a step rather than
 * blending, which is what keeps the sprite reading as pixel art. */
interface Kit {
  skinLight: string;
  skin: string;
  skinShade: string;
  skinDark: string;
  trunk: string;
  trunkLight: string;
  trunkShade: string;
  trim: string;
  glove: string;
  gloveLight: string;
  gloveShade: string;
  boot: string;
  bootShade: string;
  sole: string;
  hair: string;
  hairStyle: HairStyle;
  /** Set only on the rainbow head: stripe colours cycled row by row. */
  hairBands: string[] | null;
  species: Species;
  /** Set only on Eskobear: white on the end of the muzzle. */
  dusted: boolean;
}

// Skin ramps are picked off the fighter's seed so the two men in the ring never
// look like the same sprite recoloured.
/* Deliberately wide ramps. Each step is a big jump in value, because the muscle
 * definition on a sprite this size IS the shading — a subtle ramp turns the
 * torso back into one flat slab of skin no matter how carefully the pecs, lats
 * and abs are placed on it. */
const SKINS: { light: string; mid: string; shade: string; dark: string; hair: string }[] = [
  { light: "#ffdfae", mid: "#dda374", shade: "#9c6540", dark: "#4f3020", hair: "#33221a" },
  { light: "#f5c193", mid: "#c9885a", shade: "#8a5433", dark: "#452716", hair: "#1c130e" },
  { light: "#d99a67", mid: "#a86a3e", shade: "#6d4024", dark: "#331d10", hair: "#12100e" },
  { light: "#b0764a", mid: "#814d2c", shade: "#52301b", dark: "#26150c", hair: "#100c0a" },
  { light: "#8f5b35", mid: "#653c21", shade: "#3e2413", dark: "#1c0f08", hair: "#0d0908" },
];

type HairStyle = "bald" | "buzz" | "crop" | "flattop" | "afro" | "cornrows" | "braids";

/* The league is AI athletes, so not everyone in it is a man. Species is pure
 * presentation, same as hair: it lives in the LOOKS table, never in league
 * state, and the archive gets it for free off the seed. The one rule is that
 * species tracks the weight class — skeletons and aliens are featherweights,
 * robots and cyborgs fight at middleweight, and the grizzlies and gorillas
 * are heavyweights — so a division card reads as a roster of its own kind. */
type Species = "human" | "skeleton" | "alien" | "robot" | "cyborg" | "grizzly" | "gorilla";

/* Non-human ramps, same four steps as SKINS and just as wide, for the same
 * reason: at this size the ramp IS the shading. The cyborg has no entry — he
 * keeps his human skin and takes METAL_RAMP on the chrome parts instead. */
const SPECIES_RAMPS: Record<Exclude<Species, "human" | "cyborg">, { light: string; mid: string; shade: string; dark: string }> = {
  skeleton: { light: "#fdf6e1", mid: "#ddd0b2", shade: "#a2937a", dark: "#57503f" },
  alien: { light: "#c9e4c4", mid: "#8fb589", shade: "#587a55", dark: "#2c4230" },
  robot: { light: "#c2cddd", mid: "#8494ab", shade: "#4d5a70", dark: "#252d3c" },
  grizzly: { light: "#c99a63", mid: "#96633a", shade: "#5f3c22", dark: "#2e1c10" },
  gorilla: { light: "#8b8d99", mid: "#565866", shade: "#33343f", dark: "#191a21" },
};

// The cyborg's chrome — the same gunmetal the robots are built from, which is
// the visual claim that the arm came off the same production line.
const METAL_RAMP = SPECIES_RAMPS.robot;

/* One-off coats for the named ones, worn over the species ramp the way a
 * dyed head is worn over the skin table. Same four wide steps as everything
 * else — at this size the ramp IS the shading. */
// Snowflake, the albino gorilla. The face patch (shade) stays a real step
// darker than the coat or the features vanish into the white.
const ALBINO_RAMP = { light: "#fbfaf6", mid: "#ddd8ce", shade: "#a49d90", dark: "#5d574b" };
// Talos, bronze the way the myth cast him.
const BRONZE_RAMP = { light: "#f4d47c", mid: "#c99a3f", shade: "#8a6423", dark: "#453310" };
// Yogan. The stock alien ramp is a polite sage; his is not.
const GREEN_RAMP = { light: "#a7dd6b", mid: "#6cb043", shade: "#3f7527", dark: "#1e3d12" };

/* The roster cards print the species, so the label lives beside the table
 * that defines it rather than being re-derived (and drifting) in the UI. */
const SPECIES_LABELS: Record<Species, string> = {
  human: "Human",
  skeleton: "Skeleton",
  alien: "Alien",
  robot: "Robot",
  cyborg: "Cyborg",
  grizzly: "Grizzly bear",
  gorilla: "Gorilla",
};

export function speciesLabel(seed: number): string {
  return SPECIES_LABELS[LOOKS[Math.abs(seed)]?.species ?? "human"];
}

const HAIR_COLORS = {
  black: "#181210",
  brown: "#5a3a22",
  blond: "#d8ac52",
  ginger: "#b4502a",
  green: "#3fae4f",
  purple: "#8a4fc8",
  rainbow: "#e23d3d",
} as const;

// One fighter in the league wears every colour at once. The bands cycle down
// the hair a scanline at a time, so the stripes survive whatever shape the
// style functions cut them into.
const RAINBOW_BANDS = ["#e23d3d", "#f09a1c", "#f2d43d", "#3fae4f", "#3a7bd5", "#8a4fc8"];

/* Hand-authored looks for the founding roster, keyed by the fighter's seed.
 * Appearance is presentation, so it lives here rather than in league state:
 * the archive replays old bouts from nothing but the seed, and a table in the
 * renderer gives every past fight the same head of hair as tonight's card.
 * The skin index replaces the old `seed % 5` pick, which had no idea where a
 * man was from and handed Malmö the second-darkest ramp on the shelf. Any
 * fighter signed without an entry falls through to the old derivation. */
interface Look {
  skin: number;
  style: HairStyle;
  color: keyof typeof HAIR_COLORS;
  /** Absent means human. Skin/style/color still matter on a cyborg (he keeps
   * his face); on the rest they are ignored and kept only as history. */
  species?: Species;
  /** A one-off coat instead of the species ramp — the albino, the bronze. */
  ramp?: { light: string; mid: string; shade: string; dark: string };
  /** Eskobear only: the muzzle tip comes back white. */
  dusted?: true;
}

const LOOKS: Record<number, Look> = {
  101: { skin: 1, style: "crop", color: "black", species: "skeleton" }, // Kaito Mori, Osaka — "Whisper", of course he's the skeleton
  103: { skin: 2, style: "buzz", color: "black", species: "alien" }, // Emilio Vargas, Guadalajara — Relámpago fell out of the sky
  107: { skin: 4, style: "afro", color: "black" }, // Yusuf Adeyemi, Lagos
  109: { skin: 0, style: "crop", color: "ginger" }, // Danny Boyle, Liverpool
  113: { skin: 1, style: "crop", color: "purple" }, // Tae-hyun Park, Busan — the Scalpel dyes it
  127: { skin: 3, style: "cornrows", color: "black" }, // Marco Feliciano, Havana
  131: { skin: 2, style: "buzz", color: "black", species: "skeleton" }, // Oscar Núñez, Bogotá
  137: { skin: 4, style: "bald", color: "black", species: "alien" }, // Ibrahim Diallo, Dakar
  139: { skin: 1, style: "crop", color: "black", species: "skeleton" }, // Rico Salvatore, Naples
  149: { skin: 1, style: "crop", color: "black", species: "alien", ramp: GREEN_RAMP }, // Jae-won Sohn, Incheon — fights as Yogan, the green one
  229: { skin: 3, style: "afro", color: "black" }, // Rubén Castellanos, Cienfuegos
  233: { skin: 0, style: "crop", color: "blond", species: "skeleton" }, // Otto Lindqvist, Malmö
  17: { skin: 4, style: "cornrows", color: "black" }, // Malik Okoro, Oakland
  29: { skin: 4, style: "braids", color: "black" }, // Jonah Vale, Detroit
  43: { skin: 3, style: "afro", color: "black" }, // Mateo Silva, San Juan
  61: { skin: 3, style: "flattop", color: "black" }, // Darius Cole, Baltimore
  73: { skin: 1, style: "buzz", color: "green", species: "robot" }, // Ren Ito, Seattle — built there, obviously
  89: { skin: 4, style: "buzz", color: "black", species: "cyborg" }, // Andre Bishop, Newark
  151: { skin: 0, style: "crop", color: "brown", species: "robot" }, // Viktor Zeman, Ostrava — steel-town iron
  157: { skin: 2, style: "crop", color: "black", species: "cyborg" }, // Tobias Kane, Toronto
  163: { skin: 2, style: "buzz", color: "black", species: "robot" }, // Samir Haddad, Beirut
  167: { skin: 0, style: "crop", color: "ginger", species: "cyborg" }, // Elias Thorne, Glasgow
  239: { skin: 1, style: "crop", color: "brown", species: "robot", ramp: BRONZE_RAMP }, // Dario Fontana, Trieste — fights as Talos, cast in bronze
  241: { skin: 4, style: "afro", color: "black" }, // Solomon Bright, Memphis
  173: { skin: 3, style: "buzz", color: "black", species: "grizzly" }, // Ivan Brackett, Pittsburgh
  179: { skin: 4, style: "buzz", color: "black" }, // Nnamdi Obi, Port Harcourt
  181: { skin: 0, style: "buzz", color: "blond", species: "grizzly" }, // Grigor Pavlenko, Kharkiv
  191: { skin: 1, style: "crop", color: "brown", species: "gorilla" }, // Wesley Duke, Houston
  193: { skin: 1, style: "buzz", color: "brown", species: "gorilla" }, // Tomáš Kovač, Bratislava
  197: { skin: 2, style: "braids", color: "rainbow" }, // Julian Reyes, Miami — the showman
  199: { skin: 0, style: "crop", color: "blond", species: "grizzly", dusted: true }, // Bo Whitaker, Omaha — fights as Pablo Eskobear
  211: { skin: 4, style: "cornrows", color: "black" }, // Amadi Okonkwo, Accra
  223: { skin: 2, style: "buzz", color: "black", species: "gorilla" }, // Frank Delgado, Fresno
  227: { skin: 0, style: "braids", color: "blond" }, // Kristian Vold, Bergen — full viking
  251: { skin: 1, style: "crop", color: "brown", species: "gorilla", ramp: ALBINO_RAMP }, // Matías Ferreira, Rosario — fights as Snowflake, the albino
  257: { skin: 0, style: "flattop", color: "blond", species: "grizzly" }, // Gunnar Hale, Duluth — north-woods bear
};

function buildKit(corner: Corner, seed: number): Kit {
  const look = LOOKS[Math.abs(seed)];
  const species = look?.species ?? "human";
  // Humans and cyborgs wear their own skin; everyone else wears the species
  // ramp. Hair is a human thing — the cyborg lost his to the cranial plate.
  const human = species === "human" || species === "cyborg";
  const skin = SKINS[(look ? look.skin : Math.abs(seed)) % SKINS.length];
  const ramp = human ? skin : look?.ramp ?? SPECIES_RAMPS[species];
  const blue = corner === "blue";
  return {
    skinLight: ramp.light,
    skin: ramp.mid,
    skinShade: ramp.shade,
    skinDark: ramp.dark,
    hair: look ? HAIR_COLORS[look.color] : skin.hair,
    hairStyle: species === "human" ? (look ? look.style : "crop") : "bald",
    hairBands: species === "human" && look?.color === "rainbow" ? RAINBOW_BANDS : null,
    species,
    dusted: look?.dusted ?? false,
    // Trunks carry the corner, gloves carry it louder still: the glove is the
    // thing the eye has to track across the frame, so it is the most saturated
    // colour in the scene and nothing in the arena competes with it.
    trunk: blue ? "#1f4fa8" : "#b6241f",
    // Satin has a lit face on it. Two tones of trunk read as a rectangle of
    // colour pasted on the hips; the third is what makes it cloth.
    trunkLight: blue ? "#4b87e2" : "#e2593a",
    trunkShade: blue ? "#0f2a60" : "#651010",
    trim: blue ? "#eaf3ff" : "#f6d97a",
    glove: blue ? "#2fb9ec" : "#f0921c",
    gloveLight: blue ? "#9becff" : "#ffd98a",
    gloveShade: blue ? "#145d84" : "#8a4708",
    // Boots stay dark in both corners. A pale high-top is the brightest, biggest
    // block on the sprite and the eye goes to it instead of to the hands; the
    // corner reads off the sole and the laces, which is plenty at this size.
    boot: blue ? "#1d2740" : "#2b1a1a",
    bootShade: blue ? "#0e1425" : "#160d0d",
    sole: blue ? "#3f7fd8" : "#d13a2a",
  };
}

// A kit is chosen from the corner and the fighter's seed, neither of which
// changes while a bout is on screen. Keeping it out of the frame loop saves a
// small allocation twice per frame without changing the authored look.
const kitCache = new Map<string, Kit>();

function cachedKit(corner: Corner, seed: number) {
  const key = `${corner}:${seed}`;
  let kit = kitCache.get(key);
  if (!kit) {
    kit = buildKit(corner, seed);
    kitCache.set(key, kit);
  }
  return kit;
}

/* --------------------------------------------------------------- pixel font */

// A 5x7 bitmap face, one number per scanline, bit 4 = leftmost pixel. Real glyph
// data rather than the browser's rasteriser, so the lettering sits exactly on
// the pixel grid like everything else.
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  // Squeezed into five rows to make room for the tilde. Without it a name like
  // NUÑEZ falls through to the missing-glyph "?" — on the nameplate, and now on
  // the matchup hoarding, where it is six feet tall.
  "Ñ": [0x0a, 0x00, 0x11, 0x19, 0x15, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  "x": [0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x00],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

interface TextOptions {
  align?: "left" | "center" | "right";
  outline?: string;
  shadow?: string;
  alpha?: number;
}

function textWidth(text: string, scale: number) {
  return text.length * 6 * scale - scale;
}

function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  options: TextOptions = {},
) {
  const glyphs = text.split("");
  const w = textWidth(text, scale);
  const align = options.align ?? "left";
  const startX = Math.round(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
  const startY = Math.round(y);

  const stamp = (ox: number, oy: number, fill: string) => {
    ctx.fillStyle = fill;
    glyphs.forEach((char, index) => {
      const rows = GLYPHS[char] ?? GLYPHS[char.toUpperCase()] ?? GLYPHS["?"];
      const gx = startX + index * 6 * scale + ox;
      for (let row = 0; row < 7; row += 1) {
        const bits = rows[row];
        if (!bits) continue;
        for (let col = 0; col < 5; col += 1) {
          if (bits & (1 << (4 - col))) {
            ctx.fillRect(gx + col * scale, startY + row * scale + oy, scale, scale);
          }
        }
      }
    });
  };

  const priorAlpha = ctx.globalAlpha;
  if (options.alpha !== undefined) ctx.globalAlpha = priorAlpha * options.alpha;
  if (options.shadow) stamp(scale, scale, options.shadow);
  if (options.outline) {
    stamp(-scale, 0, options.outline);
    stamp(scale, 0, options.outline);
    stamp(0, -scale, options.outline);
    stamp(0, scale, options.outline);
  }
  stamp(0, 0, color);
  ctx.globalAlpha = priorAlpha;
}

/* ------------------------------------------------------------ small helpers */

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(from: number, to: number, t: number) {
  return from + (to - from) * t;
}

function ease(current: number, target: number, rate: number) {
  return current + (target - current) * clamp(rate, 0, 1);
}

// Stable value noise: the same cell always returns the same number, so a crowd
// built from it holds still while the camera pans across it.
function hash2(a: number, b: number) {
  let n = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = fill;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/* A chunky capsule between two points, stamped square by square rather than
 * stroked: a stroked path would be antialiased into soft grey fringes and the
 * whole scene would stop reading as pixel art. */
function limb(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  half: number,
  fill: string,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  const size = Math.max(1, Math.round(half * 2));
  ctx.fillStyle = fill;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(ax + dx * t - size / 2);
    const y = Math.round(ay + dy * t - size / 2);
    ctx.fillRect(x, y, size, size);
  }
}

// Outline + body + a lit edge, drawn back to front. The lit edge is the same
// capsule pushed one pixel up-and-toward-the-key-light and narrowed, which is
// how hard-shaded sprite art fakes a rim without any blending.
function shadedLimb(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  half: number,
  fill: string,
  light: string,
  face: number,
) {
  limb(ctx, ax, ay, bx, by, half + 1, OUTLINE);
  limb(ctx, ax, ay, bx, by, half, fill);
  if (half >= 1.6) {
    limb(ctx, ax + face * 0.7, ay - 0.9, bx + face * 0.7, by - 0.9, half - 0.9, light);
  }
}

/* A limb that changes thickness along its length, with a muscle belly partway
 * down it. Real arms and legs are not tubes: a bicep swells and the wrist is
 * half its width, a thigh is twice the ankle, and that taper is most of what
 * separates a drawn fighter from a stick figure with a glove on the end.
 *
 * Each shading pass walks the whole limb before the next starts — done per
 * step, the outline of one segment would paint over the fill of the last. */
function taperedLimb(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rootR: number,
  tipR: number,
  bulge: number,
  fill: string,
  light: string,
  face: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  const pass = (grow: number, color: string, ox: number, oy: number) => {
    ctx.fillStyle = color;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const r = lerp(rootR, tipR, t) * (1 + bulge * Math.sin(Math.PI * t)) + grow;
      if (r <= 0.2) continue;
      const size = Math.max(1, Math.round(r * 2));
      ctx.fillRect(
        Math.round(ax + dx * t - size / 2 + ox),
        Math.round(ay + dy * t - size / 2 + oy),
        size,
        size,
      );
    }
  };
  pass(1, OUTLINE, 0, 0);
  pass(0, fill, 0, 0);

  /* The lit edge: a proportionally narrower copy shoved toward the key light,
   * not a uniformly shrunk one. Taking a fixed pixel off the radius leaves the
   * highlight covering more than half of a thin limb — an arm five pixels
   * across ends up four pixels of highlight — and every limb flattens into a
   * pale slab with one dark line down the back of it. Scaled, the band stays a
   * band whatever the limb is, which is what gives a leg its roundness. */
  if (rootR >= 1.5) {
    ctx.fillStyle = light;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const r = lerp(rootR, tipR, t) * (1 + bulge * Math.sin(Math.PI * t));
      const lit = r * 0.5;
      if (lit < 0.5) continue;
      const size = Math.max(1, Math.round(lit * 2));
      ctx.fillRect(
        Math.round(ax + dx * t - size / 2 + face * (r - lit) * 0.9),
        Math.round(ay + dy * t - size / 2 - (r - lit) * 0.5),
        size,
        size,
      );
    }
  }
}

/* An arm has one outline, including the elbow. The two muscle profiles are
 * rasterized into the same small mask before any ink is drawn, so the forearm
 * cannot cut a black seam across the upper arm. Width is measured across the
 * bone, not across the screen: a diagonal punch stays as thick as a guard. */
function drawArm(
  ctx: CanvasRenderingContext2D,
  shoulder: Vec,
  elbow: Vec,
  glove: Vec,
  deltoidR: number,
  upperR: number,
  elbowR: number,
  wristR: number,
  fill: string,
  light: string,
  shade: string,
  face: number,
  shoulderFace = face,
) {
  const pad = Math.ceil(deltoidR + 2);
  const left = Math.floor(Math.min(shoulder.x, elbow.x, glove.x)) - pad;
  const top = Math.floor(Math.min(shoulder.y, elbow.y, glove.y)) - pad;
  const width = Math.ceil(Math.max(shoulder.x, elbow.x, glove.x)) + pad - left;
  const height = Math.ceil(Math.max(shoulder.y, elbow.y, glove.y)) + pad - top;
  const mask = new Uint8Array(width * height);
  const bones = [
    {
      from: shoulder, to: elbow,
      profile: [[0, deltoidR * 0.82], [0.18, deltoidR], [0.36, upperR], [0.56, upperR * 1.06], [0.8, elbowR * 1.16], [1, elbowR]],
    },
    {
      from: elbow, to: glove,
      profile: [[0, elbowR], [0.24, upperR * 0.86], [0.48, upperR * 0.74], [0.78, wristR * 1.12], [1, wristR]],
    },
  ];

  for (let bone = 0; bone < bones.length; bone += 1) {
    const { from, to, profile } = bones[bone];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const ux = length > 0.001 ? dx / length : face;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const lightAcross = nx * face * 0.6 - ny * 0.8;
    const x0 = Math.max(1, Math.floor(Math.min(from.x, to.x) - deltoidR - left));
    const x1 = Math.min(width - 2, Math.ceil(Math.max(from.x, to.x) + deltoidR - left));
    const y0 = Math.max(1, Math.floor(Math.min(from.y, to.y) - deltoidR - top));
    const y1 = Math.min(height - 2, Math.ceil(Math.max(from.y, to.y) + deltoidR - top));

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = left + x + 0.5 - from.x;
        const py = top + y + 0.5 - from.y;
        const along = px * ux + py * uy;
        const across = px * nx + py * ny;
        const t = clamp(along / length, 0, 1);
        let r = profile[0][1];
        for (let i = 1; i < profile.length; i += 1) {
          if (t > profile[i][0]) continue;
          const [start, root] = profile[i - 1];
          const [end, tip] = profile[i];
          r = lerp(root, tip, (t - start) / (end - start));
          break;
        }
        // Round the shoulder and elbow caps, without antialiasing the edge.
        const past = along - clamp(along, 0, length);
        if (across * across + past * past > r * r) continue;

        const plane = across * lightAcross / r;
        let tone = plane < -0.28 ? 1 : 2;
        // Separate pools of light describe the deltoid and biceps. A single
        // stripe from shoulder to wrist turns both muscles back into a pipe.
        const belly = bone === 0
          ? Math.max(1 - Math.abs(t - 0.12) / 0.25, (1 - Math.abs(t - 0.54) / 0.22) * 0.8)
          : 1 - Math.abs(t - 0.36) / 0.42;
        if (belly > 0 && plane > 0.08 && plane < 0.08 + belly * 0.62) tone = 3;
        if (bone === 0 && t > 0.29 && t < 0.38 && plane < 0.12) tone = 1;
        mask[y * width + x] = tone;
      }
    }
  }

  // A one-pixel outline around the union; no separate rings at the joints.
  // Emit runs of equal colour so a shaded arm costs rows, not square stamps
  // for every point along every bone.
  const colors = ["", shade, fill, light, OUTLINE];
  for (let y = 1; y < height - 1; y += 1) {
    let run = 0;
    let prior = 0;
    for (let x = 1; x < width; x += 1) {
      const at = y * width + x;
      let tone = mask[at];
      if (!tone && x < width - 1 && (mask[at - 1] || mask[at + 1] || mask[at - width] || mask[at + width])) {
        tone = 4;
        // The shoulder grows out of the chest. Its inside edge is a muscle
        // shadow, while the exposed silhouette keeps the same black ink.
        const sx = left + x + 0.5 - shoulder.x;
        const sy = top + y + 0.5 - shoulder.y;
        if (sx * shoulderFace < 0 && sx * sx + sy * sy < (deltoidR + 1.5) ** 2) tone = 1;
      }
      if (tone !== prior) {
        if (prior) rect(ctx, left + run, top + y, x - run, 1, colors[prior]);
        run = x;
        prior = tone;
      }
    }
  }
}

/* --------------------------------------------------------------- the skeleton */

interface Vec {
  x: number;
  y: number;
}

/* A fighter's whole pose, in metres, in his own frame: origin between the feet
 * on the canvas, +x the way he is facing, +y up. Drawing maps this through one
 * ground point, one metres-per-pixel and one facing sign, so the entire rig can
 * be reasoned about (and a punch path authored) without any screen maths. */
interface Skeleton {
  hip: Vec;
  chest: Vec;
  neck: Vec;
  head: Vec;
  headTilt: number;
  leadShoulder: Vec;
  leadElbow: Vec;
  leadGlove: Vec;
  rearShoulder: Vec;
  rearElbow: Vec;
  rearGlove: Vec;
  leadHip: Vec;
  leadKnee: Vec;
  leadFoot: Vec;
  rearHip: Vec;
  rearKnee: Vec;
  rearFoot: Vec;
}

/* Eased visual state per corner. The sim ticks far slower than the render
 * loop; these carry the drawing between its ticks and hold the reactions the
 * sim has no opinion about — how
 * far a head has been snapped back, how deep the body is folded, how the sprite
 * is still ringing from the last one. */
interface Visual {
  x: number;
  y: number;
  // Signed and eased rather than snapped: on a side swap this sweeps 1 → -1 and
  // the sprite is drawn squashed through the crossing, so he turns around
  // instead of mirroring inside out on a single frame.
  facing: number;
  ext: number;
  phase: number;
  // The action `phase` was eased against. When the sim starts a new action the
  // drawn phase snaps to the new action's own clock instead of easing across
  // from the old one — eased across, a fresh punch's phase sweeps DOWN through
  // the previous action's recoil region and the extension curve fires a phantom
  // flick of glove before the real windup has begun.
  action: FighterAction;
  crouch: number;
  lean: number;
  headX: number;
  headUp: number;
  guard: number;
  hip: number;
  shoulder: number;
  down: number;
  // Post-fight pose weights. Victory lifts both gloves; lap adds a walking
  // stride while the winner circles the canvas.
  victory: number;
  lap: number;
  // Hit reactions, decayed every frame.
  snapX: number;
  snapY: number;
  fold: number;
  whiteout: number;
  // Permanent damage worn on the sprite: bruises and cuts pinned to the zone
  // that produced them, so a man who has been worked over looks worked over.
  marks: { zone: ImpactZone; weight: number; seed: number }[];
}

/* Where a struck zone sits on a fighter, in his own metres, at the INSTANT of
 * contact. Used to seed the impact burst, the spatter and the callout, all of
 * which are then anchored in the world where the punch landed and left behind
 * as he moves off — which is what a flash of contact should do.
 *
 * Anything that has to STAY on the man uses zoneOnSkeleton below instead. */
function zoneLocal(f: BoutFighter, v: Visual, zone: ImpactZone): Vec {
  const site = ZONE_SITE[zone];
  const h = f.heightM;
  const head = zoneIsHead(zone);
  const halfWidth = head ? h * 0.075 : h * 0.12;
  return {
    x:
      (head ? v.headX * 0.55 + v.snapX : 0) +
      site.front * halfWidth +
      v.lean * 0.06 -
      v.fold * 0.09,
    y:
      h * site.up -
      v.crouch * h * 0.09 -
      v.fold * h * 0.06 +
      (head ? v.headUp + v.snapY : 0),
  };
}

/* Where a struck zone sits on the fighter as he is ACTUALLY DRAWN, in his own
 * metres — read off the same skeleton the sprite was built from rather than
 * recomputed from a parallel formula.
 *
 * That parallel formula is what made blood slide around. zoneLocal() carries a
 * quarter of the lean the real torso does, none of the shoulder rotation and
 * none of the idle bob, so a mark placed with it tracked the sprite roughly and
 * then drifted every time the man moved — reading exactly as if the blood were
 * a separate layer trailing a frame behind his face. Coming off the joints, a
 * cut lands on the cheekbone and stays on the cheekbone through a lean, a slip,
 * a crouch and a knockdown, because it is riding the same numbers the cheekbone
 * is. */
function zoneOnSkeleton(skel: Skeleton, h: number, zone: ImpactZone, bulk = 0): Vec {
  const site = ZONE_SITE[zone];
  if (zoneIsHead(zone)) {
    // Offset from the drawn skull's centre, so head snap and bob come for free.
    return {
      x: skel.head.x + site.front * h * HEAD_R * 0.7,
      y: skel.head.y + (site.up - HEAD_UP) * h,
    };
  }
  // Body zones ride the chest-to-hip axis the torso is actually drawn on, and
  // sit on its silhouette at that height rather than on a nominal half-width.
  const t = clamp((SHOULDER_UP - site.up) / (SHOULDER_UP - HIP_UP), 0, 1);
  return {
    x: lerp(skel.chest.x, skel.hip.x, t) + site.front * torsoHalf(t, bulk) * h,
    y: lerp(skel.chest.y, skel.hip.y, t),
  };
}

function newVisual(f: BoutFighter): Visual {
  return {
    x: f.x,
    y: f.y,
    facing: f.facingDirection,
    ext: 0,
    phase: 0,
    action: f.action,
    crouch: 0,
    lean: 0,
    headX: 0,
    headUp: 0,
    guard: 0.6,
    hip: 0,
    shoulder: 0,
    down: 0,
    victory: 0,
    lap: 0,
    snapX: 0,
    snapY: 0,
    fold: 0,
    whiteout: 0,
    marks: [],
  };
}

/* Two-bone IK. Given a shoulder, a glove and the two segment lengths, put the
 * elbow where a real arm would have to fold it; `bend` picks which side it
 * breaks toward, which is the whole difference between a straight punch (elbow
 * dropped under the line) and a hook (elbow flared high above it). */
function solveElbow(root: Vec, hand: Vec, upper: number, fore: number, bend: number): Vec {
  const dx = hand.x - root.x;
  const dy = hand.y - root.y;
  const d = Math.max(0.0001, Math.hypot(dx, dy));
  const reach = upper + fore;
  if (d >= reach * 0.995) {
    // Arm out straight: sit the elbow on the line at its true share of it.
    const t = upper / reach;
    return { x: root.x + dx * t, y: root.y + dy * t };
  }
  const a = clamp((d * d + upper * upper - fore * fore) / (2 * d * upper), -1, 1);
  const along = upper * a;
  const off = Math.sqrt(Math.max(0, upper * upper - along * along));
  const ux = dx / d;
  const uy = dy / d;
  return {
    x: root.x + ux * along - uy * off * bend,
    y: root.y + uy * along + ux * off * bend,
  };
}

/* The sim's own hand-extension curve (updateHandKinematics), mirrored: nothing
 * through the windup, a straight drive out to the peak at the contact phase, a
 * straight recoil home after it. The renderer runs this itself because contact
 * is scored on a sweep out to the punch's full planned peak, and a fast punch's
 * true top routinely falls between two sim ticks — the sampled handExtension
 * never reaches the reach the hit was measured at. */
function extensionCurve(progress: number, contactPhase: number) {
  const windupEnd = Math.max(0.12, contactPhase - 0.26);
  if (progress <= windupEnd) return 0;
  if (progress <= contactPhase) {
    return (progress - windupEnd) / (contactPhase - windupEnd);
  }
  return clamp(1 - (progress - contactPhase) / (1 - contactPhase), 0, 1);
}

/* The path a glove travels, in the thrower's own frame.
 *
 * `phase` is how far through the action he is (so a windup can be drawn before
 * the hand has left the guard at all) and `reach` is the sim's own hand
 * extension in metres. Everything a viewer uses to name the punch lives here:
 * the hook's wide bent-arm sweep, the uppercut's dip and rip, the cross's long
 * committed spear. */
function gloveTravel(
  arc: ArcKind,
  phase: number,
  reach: number,
  reachMax: number,
  guard: Vec,
  aimHeight: number,
  arm: number,
): { pos: Vec; bend: number; twist: number } {
  const u = clamp(reach / Math.max(0.05, reachMax), 0, 1);
  // Straight-line target: out along the facing axis at the height the sim aimed.
  const tip: Vec = { x: 0.14 + reach, y: aimHeight };

  if (arc === "straight") {
    // A spear. It leaves the guard early, travels flat, and the shoulder rolls
    // through behind it — the give-away is that the whole arm is one line.
    const pos = {
      x: lerp(guard.x, tip.x, Math.min(1, u * 1.08)),
      y: lerp(guard.y, tip.y, Math.min(1, u * 1.25)),
    };
    return { pos, bend: -1, twist: u };
  }

  if (arc === "hook") {
    // Wind back and out, then whip through a wide arc with the elbow flared. The
    // windup is drawn off `phase`, which keeps running while the sim's extension
    // is still zero, so the loaded hand is visible before the punch fires.
    const load = clamp(1 - phase / 0.3, 0, 1);
    const swing = u;
    const bow = Math.sin(Math.PI * swing) * arm * 0.5;
    const high = aimHeight > 1.1;
    const pos = {
      x: lerp(guard.x - arm * 0.42 * load, tip.x, swing),
      // Head hooks come over the top; body hooks dig up under the elbow.
      y: lerp(guard.y + arm * 0.16 * load, tip.y, swing) + (high ? bow : -bow * 0.8),
    };
    return { pos, bend: high ? 1 : -1, twist: swing * 1.25 };
  }

  // Uppercut: drop the hand to the hip, then rip it up the middle. Short in x,
  // enormous in y — nothing else in the fight moves like it.
  const load = clamp(1 - phase / 0.34, 0, 1);
  const dip = arm * 0.46 * load;
  const rise = Math.min(1, u * 1.15);
  const pos = {
    x: lerp(guard.x - arm * 0.1 * load, tip.x * 0.94, rise),
    y: lerp(guard.y - dip, tip.y, rise * rise),
  };
  return { pos, bend: -1, twist: rise };
}

/* Assemble the whole pose for one fighter.
 *
 * `reach` is the hand extension to draw, in metres. It is the sim's own number
 * scaled by however far apart the two sprites had to be pushed to stop them
 * overlapping — without that the drawing and the sim disagree at clinch range
 * and a punch the sim scored lands in the air an inch short of the body. */
function buildSkeleton(
  f: BoutFighter,
  v: Visual,
  arm: number,
  reach: number,
  reachMax: number,
  time: number,
  bulk = 0,
): Skeleton {
  const h = f.heightM;
  const info = PUNCH_INFO[f.action];

  // The standing rig stays standing here. A knockdown has its own authored
  // floor pose below: rotating this pose around one hip stretches the torso,
  // trunks and legs into one long diagonal slab.
  const crouch = v.crouch;
  const fold = v.fold;
  const lean = v.lean;

  // Stance. Boxers stand bladed, so the lead foot is forward and the weight
  // sits between them; a crouch shortens the whole column and widens the base.
  //
  // `chest` is the SHOULDER line, not a point halfway up the ribs: the torso is
  // drawn as one taper from hip to here, and if the two disagree the sprite ends
  // up with a gap between its chest and its arms.
  /* The vertical layout, as fractions of standing height, measured off the
   * side-on sprite fighters this is drawn to match rather than off a person:
   * crown 1.0, chin 0.81, shoulder line 0.774, waist 0.52, trunk hem 0.30,
   * knee 0.185, floor 0.
   *
   * The head is a fifth of the figure — five heads tall against a person's
   * seven and a half — because a realistic head at this size is a dozen pixels
   * with no room for a brow, an eye or a jaw, and nothing for a head shot to
   * land on that anyone can see. The knee is the other deliberate lie: it sits
   * at a fifth of the height, not the anatomical 0.28, giving a long thigh over
   * a short shin. Break a leg at its own midpoint instead and the fighter walks
   * on stilts, however well the rest of him is drawn. */
  const stance = 0.2 + crouch * 0.035;
  const hipY = h * (HIP_UP - crouch * 0.1 - fold * 0.03);
  const chestY = h * (SHOULDER_UP - crouch * 0.09 - fold * 0.05);
  const neckY = h * (NECK_UP - crouch * 0.085 - fold * 0.07);

  // A slow idle bounce keeps him alive on his feet even between exchanges.
  const bob = Math.sin(time / 300 + f.x * 3) * h * 0.006 * (1 - v.down);

  // The hips lead. A cross or a hook turns the pelvis through the shot before
  // the shoulder follows, and drawing that rotation is what separates a punch
  // thrown off the legs from an arm-punch.
  const hip: Vec = { x: lean * 0.05 - fold * 0.06 + v.hip * 0.0015, y: hipY + bob };
  const chest: Vec = {
    x: hip.x + lean * 0.09 + v.shoulder * 0.0022 - fold * 0.1,
    y: chestY + bob,
  };
  const neck: Vec = { x: chest.x + lean * 0.03 - fold * 0.05, y: neckY + bob };
  const head: Vec = {
    x: neck.x + v.headX * 0.55 + v.snapX + lean * 0.05 - fold * 0.09,
    y: neckY + h * (HEAD_UP - NECK_UP) + v.headUp + v.snapY + bob,
  };

  // Open the chest toward the camera. The near, lead shoulder sits on the
  // back edge of the silhouette and the far shoulder faces the opponent, so
  // both arms grow out of separate sides of the chest. A punch narrows that
  // view as the shoulder rolls through, without pulling either joint off it.
  const roll = clamp(v.shoulder / 55, -1, 1);
  const spread = h * (0.086 - Math.abs(roll) * 0.018) * (1 + bulk * 0.28);
  const leadShoulder: Vec = { x: chest.x - spread + roll * h * 0.014, y: chest.y - h * 0.022 };
  const rearShoulder: Vec = { x: chest.x + spread, y: chest.y - h * 0.006 };

  // Guard: hands high and tight against the chin, dropping as he tires, opens
  // up, or gets hurt. Both gloves sit close in front of the face rather than out
  // at arm's length — a guard held away from the head is a stance nobody boxes
  // out of, and it reads from across the room as arms flapping.
  // Staggered, not stacked. Held at the same height and a couple of centimetres
  // apart the two gloves overlap into a single blob the width of the head, the
  // face disappears behind it, and there is no telling which hand is about to
  // go. Each hand stays on its own side of the opened chest: the near hand
  // sits a shade low and the far hand covers the cheek toward the opponent.
  const guardH = lerp(h * 0.62, h * 0.8, v.guard);
  // Anchor the guard to the turned shoulders. The punch still finishes at
  // the same target, but leaves and returns to the correct side of the body.
  const leadGuard: Vec = { x: leadShoulder.x + h * 0.055, y: guardH - h * 0.01 };
  const rearGuard: Vec = { x: rearShoulder.x + h * 0.025, y: guardH + h * 0.045 };

  let leadGlove = { ...leadGuard };
  let rearGlove = { ...rearGuard };
  let leadBend = -1;
  let rearBend = -1;

  if (info && (reach > 0.004 || v.phase < 0.9)) {
    const throwing: "lead" | "rear" = f.punchHand;
    const guard = throwing === "lead" ? leadGuard : rearGuard;
    const travel = gloveTravel(
      info.arc,
      v.phase,
      reach,
      reachMax,
      guard,
      f.punchAimHeight,
      arm,
    );
    if (throwing === "lead") {
      leadGlove = travel.pos;
      leadBend = travel.bend;
      // The other hand comes back to the chin to cover — the tell that this is
      // a trained fighter and not two men swinging.
      rearGlove = { x: rearGuard.x - h * 0.012, y: rearGuard.y + h * 0.012 };
    } else {
      rearGlove = travel.pos;
      rearBend = travel.bend;
      leadGlove = { x: leadGuard.x - h * 0.02, y: leadGuard.y + h * 0.01 };
    }
  }

  // Victory pose: both fists above the crown, spread just enough that the arms
  // read as two raised limbs instead of one column through the head.
  if (v.victory > 0.001) {
    const wave = Math.sin(time / 170) * h * 0.012 * v.victory;
    const leadWin = {
      x: leadShoulder.x + h * 0.13,
      y: h * 1.08 + wave,
    };
    const rearWin = {
      x: rearShoulder.x - h * 0.13,
      y: h * 1.08 - wave,
    };
    leadGlove = {
      x: lerp(leadGlove.x, leadWin.x, v.victory),
      y: lerp(leadGlove.y, leadWin.y, v.victory),
    };
    rearGlove = {
      x: lerp(rearGlove.x, rearWin.x, v.victory),
      y: lerp(rearGlove.y, rearWin.y, v.victory),
    };
    leadBend = 1;
    rearBend = -1;
  }

  const upper = arm * 0.47;
  const fore = arm * 0.53;
  /* Two-bone IK is right for a punch and wrong for a guard. A hand held at the
   * chin leaves the solver almost no span to work with, so it swings the elbow
   * out to wherever the two circles happen to cross — well past the hip — and
   * the arm is drawn as a pair of enormous limbs draped over the whole body.
   * A boxer's guard elbow is not solved, it is placed: dropped just behind
   * the shoulder and tucked against the ribs with the forearm slanting up
   * to the glove. Blend between the placed elbow and the solved one
   * on how far the hand has actually left the body, so the joint stays tucked
   * through the guard and flares out as the punch commits. */
  const armPose = (shoulder: Vec, glove: Vec, bend: number): Vec => {
    const solved = solveElbow(shoulder, glove, upper, fore, bend);
    const span = Math.hypot(glove.x - shoulder.x, glove.y - shoulder.y);
    const out = clamp((span / (upper + fore) - 0.32) / 0.42, 0, 1);
    if (out >= 1) return solved;
    const tuck: Vec = { x: shoulder.x + h * 0.018, y: shoulder.y - upper * 0.88 };
    return { x: lerp(tuck.x, solved.x, out), y: lerp(tuck.y, solved.y, out) };
  };
  const leadElbow = armPose(leadShoulder, leadGlove, leadBend);
  const rearElbow = armPose(rearShoulder, rearGlove, rearBend);

  // Legs. Foot offsets and knee flexion come straight off the articulated body
  // state, so the stance visibly loads before a power shot and buckles when the
  // balance goes.
  const leadHip: Vec = { x: hip.x + h * 0.04, y: hip.y };
  const rearHip: Vec = { x: hip.x - h * 0.04, y: hip.y };
  // Foot offsets are clamped hard. The sim reports a stride, not a drawn stance,
  // and taken raw it splays the sprite into a lunge two metres wide that reads
  // as a fencer rather than a boxer.
  const victoryStride = Math.sin(time / 95) * h * 0.075 * v.lap;
  const leadFoot: Vec = {
    x: stance + clamp(f.body.leadFootOffset, -0.14, 0.16) + victoryStride,
    y: 0,
  };
  const rearFoot: Vec = {
    x: -stance + clamp(f.body.rearFootOffset, -0.16, 0.14) - victoryStride,
    y: 0,
  };
  // A boxer never stands with a straight leg: the knee sits forward of the line
  // from hip to foot, so the leg reads as loaded and springy rather than as a
  // strut holding the torso up.
  //
  // It also sits LOW — at two fifths of the way down from the hip rather than
  // halfway. Break a leg at its own midpoint and you get a long shin under a
  // short thigh, which is the single thing that made these fighters read as
  // stilt-walkers however well the rest of the body was drawn.
  const kneeOf = (hipJoint: Vec, foot: Vec, flex: number): Vec => ({
    x: (hipJoint.x + foot.x) / 2 + h * 0.028 + flex * h * 0.035,
    y: lerp(foot.y, hipJoint.y, 0.49) - flex * h * 0.025,
  });

  return {
    hip,
    chest,
    neck,
    head,
    headTilt: lean * 0.5 + v.snapX * 2.2,
    leadShoulder,
    leadElbow,
    leadGlove,
    rearShoulder,
    rearElbow,
    rearGlove,
    leadHip,
    leadKnee: kneeOf(leadHip, leadFoot, clamp(f.body.leadKneeFlexion, 0, 1) + crouch * 0.4),
    leadFoot,
    rearHip,
    rearKnee: kneeOf(rearHip, rearFoot, clamp(f.body.rearKneeFlexion, 0, 1) + crouch * 0.4),
    rearFoot,
  };
}

/* A knockdown is a pose, not a rotated standing sprite. Every joint lands in a
 * compact side-lying silhouette: the torso is low, the knees fold back toward
 * the hips, and the hands come in around the head. Blending the actual joints
 * keeps all of the anatomy connected through the fall and gives joint-bound
 * kit somewhere truthful to go. */
function downedSkeleton(standing: Skeleton, h: number, amount: number): Skeleton {
  const t = amount * amount * (3 - amount * 2);
  if (t <= 0.001) return standing;

  const origin = standing.hip.x;
  const floor = (x: number, y: number): Vec => ({ x: origin + x * h, y: y * h });
  const down: Skeleton = {
    hip: floor(0, 0.14),
    chest: floor(0.24, 0.22),
    neck: floor(0.34, 0.2),
    head: floor(0.43, 0.17),
    headTilt: 1.2,
    leadShoulder: floor(0.27, 0.24),
    leadElbow: floor(0.35, 0.07),
    leadGlove: floor(0.48, 0.1),
    rearShoulder: floor(0.18, 0.2),
    rearElbow: floor(0.05, 0.08),
    rearGlove: floor(0.28, 0.1),
    leadHip: floor(-0.02, 0.15),
    leadKnee: floor(-0.24, 0.16),
    leadFoot: floor(-0.46, 0.05),
    rearHip: floor(0.02, 0.13),
    rearKnee: floor(-0.12, 0.06),
    rearFoot: floor(-0.34, 0.04),
  };
  const mix = (from: Vec, to: Vec): Vec => ({
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
  });

  return {
    hip: mix(standing.hip, down.hip),
    chest: mix(standing.chest, down.chest),
    neck: mix(standing.neck, down.neck),
    head: mix(standing.head, down.head),
    headTilt: lerp(standing.headTilt, down.headTilt, t),
    leadShoulder: mix(standing.leadShoulder, down.leadShoulder),
    leadElbow: mix(standing.leadElbow, down.leadElbow),
    leadGlove: mix(standing.leadGlove, down.leadGlove),
    rearShoulder: mix(standing.rearShoulder, down.rearShoulder),
    rearElbow: mix(standing.rearElbow, down.rearElbow),
    rearGlove: mix(standing.rearGlove, down.rearGlove),
    leadHip: mix(standing.leadHip, down.leadHip),
    leadKnee: mix(standing.leadKnee, down.leadKnee),
    leadFoot: mix(standing.leadFoot, down.leadFoot),
    rearHip: mix(standing.rearHip, down.rearHip),
    rearKnee: mix(standing.rearKnee, down.rearKnee),
    rearFoot: mix(standing.rearFoot, down.rearFoot),
  };
}

/* --------------------------------------------------------------- the camera */

/* Where the ring sits in the frame.
 *
 * `horizon` is the far rope line and `floorBottom` the near one, both as a share
 * of the frame; a fighter's ring-depth slides him between them. `panY` then
 * lifts the whole ring back toward FEET_FRACTION so the pair stay framed as they
 * work up and down the ring.
 *
 * PAN_FOLLOW deliberately under-corrects. At 1 the boots are pinned to one
 * scanline and the entire city behind slides a third of the frame every time
 * somebody steps forward, which is far more distracting than the drift it was
 * fixing. At 0.6 the men stay comfortably framed and the skyline barely
 * breathes. */
const HORIZON_FRACTION = 0.54;
const FLOOR_BOTTOM_FRACTION = 1.0;
const FEET_FRACTION = 0.82;
const PAN_FOLLOW = 0.6;

// How much of the frame's height a standing fighter fills. This is the single
// number that decides whether a viewer can follow the fight: below about a half
// there are not enough pixels on a man for a guard, a slip or a body shot to be
// distinguishable, and the bout turns into two brown shapes twitching at each
// other in the middle of a very nice arena.
const FIGHTER_FRAME_SHARE = 0.52;

interface Camera {
  center: number;
  ppm: number;
  panY: number;
  shake: number;
  kick: number;
}

// Depth foreshortening. The far rope line is the top of the canvas and the near
// one runs off the bottom of the frame; a fighter's ring-y slides him between
// them and scales him with it, which is what gives the flat side view its floor.
function depthScale(depth: number) {
  return 0.84 + depth * 0.26;
}

/* ------------------------------------------------------------------- effects */

interface Burst {
  x: number;
  y: number;
  depth: number;
  born: number;
  ttl: number;
  power: number;
  head: boolean;
  blocked: boolean;
  dir: number;
  seed: number;
}

interface Tag {
  x: number;
  y: number;
  depth: number;
  born: number;
  ttl: number;
  text: string;
  sub: string;
  color: string;
  scale: number;
  rise: number;
  // Callouts about the same man replace each other instead of piling up. In a
  // fast exchange three of them land inside 200ms and, stacked, they overlap
  // into an unreadable smear right over the thing they are pointing at.
  key: string;
  // Which shelf this one floats on. The two corners get different heights so a
  // simultaneous exchange reads as two separate calls rather than one collision
  // of letters — both men are hit in the same half-second all night.
  lane: number;
}

interface Particle {
  x: number;
  y: number;
  depth: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  blood: boolean;
}

// Blood that has reached the canvas and stays there. The floor of a hard fight
// tells the story of it, exactly as it does on television.
interface Stain {
  x: number;
  depth: number;
  size: number;
  seed: number;
}

interface Ripple {
  x: number;
  y: number;
  depth: number;
  born: number;
  ttl: number;
  power: number;
}

/* --------------------------------------------------------------- the component */

interface Profile {
  name: string;
  seed: number;
  weightClass: Fighter["weightClass"];
}

export type FightVenue = "fight-night" | "gym";
export type FightDrill = "sparring" | "reflex" | "heavy-bag" | "conditioning" | "footwork";

export function FightCanvas({
  bout,
  frames,
  left,
  right,
  ads = DEFAULT_ADS,
  venue = "fight-night",
  drill = "sparring",
  arena = true,
  playbackRate = 1,
  hud = "full",
}: {
  bout: BoutState;
  /** Every frame of the fight, straight from whichever store is playing it.
   *
   * The render loop reads the bout off a ref, so a new frame does not need a
   * render — and at fifty a second, re-rendering the whole broadcast for one is
   * what made a phone stutter. A caller with a stream hands it over and lets
   * the `bout` prop fall back to the rate the numbers around the ring are read
   * at; the gym has no stream and feeds the prop alone. */
  frames?: { current: BoutState | null };
  left: Fighter;
  right: Fighter;
  /** What is on the skyline hoardings. Swap this to change who is paying. */
  ads?: AdBoard[];
  /** The gym keeps the real articulated fighters but drops the fight-night theatre. */
  venue?: FightVenue;
  /** A gym drill authors a pose through the same articulated sprite renderer. */
  drill?: FightDrill;
  /** The room around the fight: the crowd bed, the round call, the stoppage
   *  sting and the referee's ten. The exhibition draws the same ring and lands
   *  the same punches, but nobody is in the building — so it keeps the contact
   *  cues and none of the arena. */
  arena?: boolean;
  /** How fast the caller is stepping the bout relative to real time. A rewatch
   *  runs the sim faster without touching `bout.speed`, and the punch sounds
   *  need to know: above 1x they are a drumroll, so they stay quiet. */
  playbackRate?: number;
  /** What the in-picture HUD carries. "clock" keeps only the round plate — for
   *  a caller whose own scoreboard already shows the names and both bars right
   *  above the picture, where the phone-width nameplates said the same thing
   *  twice in glyphs too small to read. The exhibition has no scoreboard, so
   *  it stays on "full". */
  hud?: "full" | "clock";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boutRef = useRef(bout);
  const framesRef = useRef(frames);
  const profiles = useRef<Record<Corner, Profile>>({
    blue: { name: left.lastName, seed: left.seed, weightClass: left.weightClass },
    red: { name: right.lastName, seed: right.seed, weightClass: right.weightClass },
  });
  const adsRef = useRef(ads);
  const venueRef = useRef(venue);
  const drillRef = useRef(drill);
  const arenaRef = useRef(arena);
  const playbackRateRef = useRef(playbackRate);
  const hudRef = useRef(hud);

  // The animation loop is started once and then reads the live bout off these
  // refs, so a simulation tick never restarts the render loop or resets the
  // eased poses. Written after commit rather than during render: the loop only
  // ever looks at them on the next frame, which is strictly later than this.
  useEffect(() => {
    boutRef.current = bout;
    framesRef.current = frames;
    adsRef.current = ads;
    venueRef.current = venue;
    drillRef.current = drill;
    arenaRef.current = arena;
    playbackRateRef.current = playbackRate;
    hudRef.current = hud;
    profiles.current = {
      blue: { name: left.lastName, seed: left.seed, weightClass: left.weightClass },
      red: { name: right.lastName, seed: right.seed, weightClass: right.weightClass },
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The canvas is a write-only animation surface. Asking the browser for a
    // desynchronised context lets it present completed frames without waiting
    // on unrelated compositor work when the main thread is busy with the HUD.
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) return;

    let raf = 0;
    let width = FRAME_WIDTH;
    let height = 190;
    let lastTime = performance.now();
    let lastFrame: Frame | null = null;
    let lastBillboardTime = 0;
    let lastBillboardBaseY = 0;
    let pointerDown: { x: number; y: number } | null = null;
    let pointerMoved = false;

    const visuals: Record<Corner, Visual> = {
      blue: newVisual(boutRef.current.left),
      red: newVisual(boutRef.current.right),
    };
    const camera: Camera = { center: RING_LENGTH_M / 2, ppm: 52, panY: 0, shake: 0, kick: 0 };
    // The baked city layers live exactly as long as this render loop does.
    const backdrop = createCityBackdrop();
    const bursts: Burst[] = [];
    const tags: Tag[] = [];
    const particles: Particle[] = [];
    const stains: Stain[] = [];
    const ripples: Ripple[] = [];
    const counters: Record<
      Corner,
      {
        landed: number;
        blocked: number;
        down: number;
        thrown: number;
        // A throw the counters have seen but whose outcome has not caught up
        // yet. Held rather than judged on the spot — see the miss inference in
        // syncEvents.
        airborne: { action: FighterAction; landed: number; blocked: number } | null;
      }
    > = {
      blue: { landed: 0, blocked: 0, down: 0, thrown: 0, airborne: null },
      red: { landed: 0, blocked: 0, down: 0, thrown: 0, airborne: null },
    };
    const combo = { corner: "blue" as Corner, count: 0, at: -1e6 };
    // `adopted` is false until the first frame of a fight has been seen. Without
    // it the round call fires for whoever walks in halfway through round two,
    // because round 0 never matches the round actually running.
    //
    /* `at` is the bell, `fightAt` is the moment the round call finishes and the
     * men are released. They are two timestamps rather than one offset because
     * the gap between them is simulation time, not wall time: the bell drops
     * `breakTime` to zero and only THEN does the 1.6s intro start counting, so
     * anything measured as "bell plus n milliseconds" is measuring the wrong
     * clock. Held to one window off the bell, FIGHT was never on screen at all
     * — the intro outlasted the banner and the word was unreachable. */
    const banner = { at: -1e6, round: 0, live: false, adopted: false, fightAt: -1, cued: false };
    /* Which round the crowd tape has been rolled for, and whether the bells on
     * the front of it belong to this viewer. Its own flag rather than a banner
     * field because it is cued off the break clock, before the banner has
     * anything to say about the round.
     *
     * The bells are his if he sat through the corner break before them, or if
     * he arrived at the top of the fight. They are not if he turned the
     * television on inside a round, where a bell out of nowhere is a lie about
     * where the round is — he is dropped into the crowd at the round's own
     * elapsed time instead, which is the join branch below. */
    const crowdCue = { round: -1, armed: false };
    // Whether this viewer has seen the bout unfinished. The stoppage sting is
    // for a stoppage you watched happen, not for the aftermath screen somebody
    // arrived on — the same reasoning as `banner.adopted`, and the same bug if
    // you skip it.
    let sawLive = false;
    // The referee drifts around the far side of the ring, always clear of the
    // action but always in it — the single cheapest thing that makes a drawn
    // ring read as a real one.
    const referee = { x: RING_LENGTH_M / 2, depth: 1.1, step: 0 };
    let hitstopUntil = 0;
    let flash = 0;
    let matThud: number | null = null;
    // Whose count the tape is currently reading, or null when nobody is being
    // counted over. Cleared as soon as the count is no longer the tape's to
    // stop — see the check in the frame.
    let counting: Corner | null = null;
    let sideDir = 1;
    let seedCounter = 1;
    let primed = false;
    let lastBoutId = boutRef.current.id;
    const victory = {
      boutId: -1,
      startedAt: -1,
      winner: null as Corner | null,
      startX: RING_LENGTH_M / 2,
      startY: RING_DEPTH_M / 2,
      startAngle: 0,
    };

    const resize = (entries?: ResizeObserverEntry[]) => {
      // Measure the layout box, not getBoundingClientRect: the latter reports the
      // post-transform size, so any scaling on the canvas would feed a bogus
      // width straight back into the buffer.
      const box = entries?.[0]?.contentRect;
      const bounds = box ?? canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, bounds.width);
      const cssHeight = Math.max(1, bounds.height);
      // The backing store IS the arcade frame, stretched back up by CSS with
      // nearest-neighbour scaling. Size it so that stretch is a WHOLE number of
      // screen pixels per buffer pixel: at a fractional scale some source pixels
      // land on 4 screen pixels and their neighbours on 5, which tears
      // one-pixel detail into shimmering moiré as the camera pans.
      const zoom = Math.max(2, Math.round(cssWidth / FRAME_WIDTH));
      width = Math.round(cssWidth / zoom);
      height = Math.round(cssHeight / zoom);
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = false;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const framePoint = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width,
        y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * height,
      };
    };
    const billboardUnder = (event: PointerEvent) => {
      if (venueRef.current !== "fight-night" || !lastFrame) return null;
      const point = framePoint(event);
      return findBillboard(
        adsRef.current,
        lastFrame,
        lastBillboardBaseY,
        lastBillboardTime,
        point.x,
        point.y,
      );
    };
    const updateBillboardCursor = (event: PointerEvent) => {
      canvas.style.cursor = billboardUnder(event)?.href ? "pointer" : "";
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDown = { x: event.clientX, y: event.clientY };
      pointerMoved = false;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerDown) {
        const movedX = event.clientX - pointerDown.x;
        const movedY = event.clientY - pointerDown.y;
        if (movedX * movedX + movedY * movedY > 36) pointerMoved = true;
      }
      updateBillboardCursor(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasClick = pointerDown && !pointerMoved;
      pointerDown = null;
      pointerMoved = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!wasClick) return;
      const href = billboardUnder(event)?.href;
      if (href) window.open(href, "_blank", "noopener,noreferrer");
      updateBillboardCursor(event);
    };
    const onPointerCancel = (event: PointerEvent) => {
      pointerDown = null;
      pointerMoved = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.style.cursor = "";
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);

    // A phone is told apart by its pointer, the same read the player controls
    // use. The query object tracks the device live, so `.matches` is read
    // fresh each frame rather than latched — a tablet docked to a keyboard
    // mid-fight gets the full theatre back on the next frame.
    const coarse = window.matchMedia("(pointer: coarse)");
    // Phones also spray half the particles. Each one is an update and a draw
    // every frame for up to a second, an exchange spawns a dozen at a time,
    // and a phone GPU is the one place the budget actually shows.
    const spray = (n: number) => (coarse.matches ? Math.ceil(n / 2) : n);

    /* ------------------------------------------------------- event ingestion */

    // Retire any live callout about this man before posting a new one. Not an
    // instant delete: mid-combo the previous label still needs a beat on
    // screen to be read, so it gets bumped upward and a short fade-out while
    // the new one takes the shelf below it.
    const clearTags = (key: string, now: number) => {
      for (const tag of tags) {
        if (tag.key !== key) continue;
        tag.ttl = Math.min(tag.ttl, now - tag.born + 220);
        tag.rise += 6;
      }
    };

    // Whether a landing should be heard as well as seen. Fight night at true
    // speed only: the gym's sparring loop is background footage, not a bout,
    // and above 1x — a fast-forwarded rewatch or a sped-up broadcast — the
    // punches arrive as a drumroll and the cues turn into noise.
    const contactAudible = () =>
      venueRef.current !== "gym" &&
      playbackRateRef.current === 1 &&
      boutRef.current.speed === 1;

    // And whether the room around them should be heard as well: the crowd bed,
    // the round call, the stoppage sting, the referee's ten. Everything a
    // building full of people does, which the exhibition's empty one does not.
    const arenaAudible = () => arenaRef.current && contactAudible();

    const spawnContact = (
      attacker: BoutFighter,
      defender: BoutFighter,
      blocked: boolean,
      now: number,
    ) => {
      const raw = attacker.lastImpactZone;
      // The sim can resolve several impacts between animation frames, so a
      // shared "guard" read may be stale when a clean landing is what actually
      // ticked the counter. Fall back to what the punch was aimed at.
      const zone: ImpactZone = blocked
        ? "guard"
        : raw === "guard"
          ? attacker.punchAimZone
          : raw;
      const power = !blocked && attacker.lastImpactJ >= POWER_IMPACT_J;
      const head = zoneIsHead(zone);
      const dv = visuals[defender.corner];
      const site = zoneLocal(defender, dv, zone);
      const defFace = defender.corner === "blue" ? sideDir : -sideDir;
      const atkDir = attacker.corner === "blue" ? sideDir : -sideDir;

      // World position of the strike: the defender's own anatomy, pushed out to
      // the face he was hit on.
      const wx = dv.x + defFace * site.x;
      const wy = site.y;

      if (blocked) {
        if (contactAudible()) playCue(Math.random() < 0.5 ? "block1" : "block2");
        camera.shake = Math.min(1, camera.shake + 0.14);
        bursts.push({
          x: wx,
          y: wy,
          depth: dv.y,
          born: now,
          ttl: 260,
          power: 0.4,
          head: false,
          blocked: true,
          dir: atkDir,
          seed: seedCounter++,
        });
        clearTags(defender.corner, now);
        tags.push({
          x: wx,
          y: wy,
          depth: dv.y,
          born: now,
          ttl: 700,
          text: "BLOCK",
          sub: "",
          color: "#cfe0f2",
          scale: 1,
          rise: 7,
          key: defender.corner,
          lane: defender.corner === "blue" ? 0 : 1,
        });
        for (let i = 0; i < spray(4); i += 1) {
          particles.push({
            x: wx,
            y: wy,
            depth: dv.y,
            vx: atkDir * (0.4 + Math.random() * 0.9),
            vy: 0.5 + Math.random() * 1.1,
            life: 0,
            max: 240 + Math.random() * 140,
            color: "#e9f4ff",
            blood: false,
          });
        }
        return;
      }

      // The landing, heard.
      if (contactAudible()) {
        const kind = attacker.lastStrikeKind === "none" ? attacker.action : attacker.lastStrikeKind;
        const haymaker = attacker.lastImpactJ >= HAYMAKER_IMPACT_J;
        playCue(haymaker ? "haymaker" : power ? "powershot" : PUNCH_CUE[kind] ?? "jab");
      }

      const linked = combo.corner === attacker.corner && now - combo.at < COMBO_WINDOW_MS;
      combo.corner = attacker.corner;
      combo.count = linked ? combo.count + 1 : 1;
      combo.at = now;

      camera.shake = Math.min(1, camera.shake + (power ? 0.55 : 0.2));
      camera.kick = Math.min(1, camera.kick + (power ? 0.7 : 0.22));
      if (power) {
        hitstopUntil = now + 105;
        flash = Math.max(flash, 0.6);
      }

      // The reaction the DEFENDER wears. A head shot snaps the skull back and
      // rotates it; a body shot folds him over the glove. Both decay.
      const force = clamp(attacker.lastImpactJ / 90, 0.22, 1.35);
      if (head) {
        dv.snapX += -defFace * force * 0.075;
        dv.snapY += force * 0.03;
      } else {
        dv.fold += force * 0.85;
      }
      dv.whiteout = Math.max(dv.whiteout, power ? 1 : 0.6);
      dv.marks.push({ zone, weight: force, seed: seedCounter++ });
      if (dv.marks.length > 26) dv.marks.shift();

      bursts.push({
        x: wx,
        y: wy,
        depth: dv.y,
        born: now,
        ttl: power ? 480 : 340,
        power: power ? 1 : 0.55,
        head,
        blocked: false,
        dir: atkDir,
        seed: seedCounter++,
      });
      ripples.push({ x: wx, y: wy, depth: dv.y, born: now, ttl: power ? 420 : 280, power: power ? 1 : 0.5 });
      clearTags(defender.corner, now);
      // The counter call. The engine's own flag, carried on the frame — the
      // renderer never re-derives it, so the callout and the scoring agree.
      // It takes the sub line over the joule readout because "caught him
      // punching" is the story; the power color and the "!" still mark the big
      // ones.
      const counter = attacker.lastImpactCounter;
      tags.push({
        x: wx,
        y: wy,
        depth: dv.y,
        born: now,
        ttl: counter ? 1500 : power ? 1500 : 1100,
        text: formatImpactZone(zone).toUpperCase() + (power ? "!" : ""),
        sub: counter ? "COUNTER" : power ? `${Math.round(attacker.lastImpactJ)}J` : "",
        color: counter ? "#7bff9e" : power ? "#ffdc4a" : head ? "#ffffff" : "#ffb45e",
        // Always one pixel per glyph pixel. A double-scale callout reads as a
        // billboard dropped over the ring and hides the very thing it is
        // pointing at.
        scale: 1,
        rise: power ? 13 : 9,
        key: defender.corner,
        lane: defender.corner === "blue" ? 0 : 1,
      });

      // Sweat off a clean shot; blood once the head has taken a beating, which
      // then settles onto the canvas and stays.
      const bleeding = head && defender.headTrauma > 26;
      const count = spray(Math.round(4 + force * 9));
      for (let i = 0; i < count; i += 1) {
        const blood = bleeding && Math.random() < 0.65;
        particles.push({
          x: wx,
          y: wy,
          depth: dv.y,
          vx: -atkDir * (0.6 + Math.random() * 2.4) * force,
          vy: 0.3 + Math.random() * 1.4,
          life: 0,
          max: 420 + Math.random() * 420,
          color: blood ? "#b4141b" : "#dff0ff",
          blood,
        });
      }
    };

    const spawnDown = (fighter: BoutFighter, now: number) => {
      camera.shake = 1;
      camera.kick = 1;
      hitstopUntil = now + 150;
      flash = 1;
      // The thud waits for the body: `v.down` eases toward the floor pose at
      // dt/340, so the sprite reaches the canvas around 400 ms after the DOWN
      // tag goes up. playCue re-checks mute at fire time; the handle is kept so
      // that walking off the page in those 400 ms does not drop a body onto the
      // canvas of whatever page you walked onto.
      if (contactAudible()) {
        matThud = window.setTimeout(() => playCue("mat"), 400);
        // The referee only counts over a fight that is still on. A third
        // knockdown ends it on the tick it lands — the frame carrying the drop
        // already carries the TKO — and a man being helped up is not counted
        // over.
        if (arenaAudible() && !boutRef.current.finish) {
          startCount();
          counting = fighter.corner;
        }
      }
      const v = visuals[fighter.corner];
      tags.push({
        x: v.x,
        y: fighter.heightM * 0.95,
        depth: v.y,
        born: now,
        ttl: 1300,
        text: "DOWN",
        sub: "COUNT",
        color: "#ff4b3c",
        scale: 2,
        rise: 16,
        key: `down-${fighter.corner}`,
        lane: 2,
      });
      for (let i = 0; i < spray(22); i += 1) {
        particles.push({
          x: v.x,
          y: fighter.heightM * 0.6,
          depth: v.y,
          vx: (Math.random() - 0.5) * 3.4,
          vy: 1.2 + Math.random() * 3,
          life: 0,
          max: 500 + Math.random() * 500,
          color: Math.random() < 0.4 ? "#b4141b" : "#e6f2ff",
          blood: Math.random() < 0.4,
        });
      }
    };

    // Punches that touched nothing. The sim does not report a miss, so it is
    // inferred: the hand went all the way out and neither the landed nor the
    // blocked counter moved. Worth drawing — a whiffed hook is half the story of
    // a round, and without it the loser looks like he simply stopped throwing.
    const spawnWhiff = (attacker: BoutFighter, action: FighterAction, now: number) => {
      // The action is passed in rather than read off the attacker: by the time
      // a miss is confirmed the man may already be into his next move, and the
      // whiff belongs to the punch that missed.
      const info = PUNCH_INFO[action];
      if (!info) return;
      if (contactAudible()) playCue(Math.random() < 0.5 ? "miss1" : "miss2");
      const v = visuals[attacker.corner];
      const dir = attacker.corner === "blue" ? sideDir : -sideDir;
      clearTags(`miss-${attacker.corner}`, now);
      tags.push({
        x: v.x + dir * 0.55,
        y: attacker.punchAimHeight + 0.12,
        depth: v.y,
        born: now,
        ttl: 650,
        text: "MISS",
        sub: "",
        color: "#8fa4bd",
        scale: 1,
        rise: 6,
        key: `miss-${attacker.corner}`,
        lane: attacker.corner === "blue" ? 1 : 0,
      });
    };

    const syncEvents = (now: number) => {
      const b = boutRef.current;
      for (const side of ["left", "right"] as const) {
        const attacker = b[side];
        const defender = side === "left" ? b.right : b.left;
        const c = counters[attacker.corner];
        if (!primed) {
          c.landed = attacker.landed;
          c.blocked = attacker.blocked;
          c.thrown = attacker.thrown;
          c.airborne = null;
          continue;
        }
        const landedNow = attacker.landed > c.landed;
        const blockedNow = attacker.blocked > c.blocked;
        if (landedNow) {
          c.landed = attacker.landed;
          spawnContact(attacker, defender, false, now);
        }
        if (blockedNow) {
          c.blocked = attacker.blocked;
          spawnContact(attacker, defender, true, now);
        }
        /* A miss is inferred, never reported. At the moment `thrown` ticks the
         * punch is still in the air and may yet land, so the throw is held as
         * airborne and judged later: contact cancels it, and the contact window
         * closing with neither counter moved is what a miss is. This used to
         * key on `punchResolved` instead, which the sim only ever sets ON
         * contact — a clean whiff could never satisfy it, and the MISS call
         * never fired at all. */
        if (c.airborne) {
          if (
            attacker.landed > c.airborne.landed ||
            attacker.blocked > c.airborne.blocked
          ) {
            // It connected — the counter branches above already told the story.
            c.airborne = null;
          } else {
            const info = PUNCH_INFO[c.airborne.action];
            const stillFlying =
              info &&
              attacker.thrown === c.thrown &&
              attacker.action === c.airborne.action &&
              attacker.actionElapsed / Math.max(attacker.actionDuration, 1e-4) <=
                info.contactPhase + 0.09;
            if (!stillFlying) {
              spawnWhiff(attacker, c.airborne.action, now);
              c.airborne = null;
            }
          }
        }
        if (attacker.thrown > c.thrown) {
          c.thrown = attacker.thrown;
          if (!landedNow && !blockedNow) {
            c.airborne = {
              action: attacker.action,
              landed: attacker.landed,
              blocked: attacker.blocked,
            };
          }
        }
      }
      for (const side of ["left", "right"] as const) {
        const fighter = b[side];
        const c = counters[fighter.corner];
        if (primed && fighter.knockdowns > c.down) {
          c.down = fighter.knockdowns;
          spawnDown(fighter, now);
        } else if (!primed) {
          c.down = fighter.knockdowns;
        }
      }
      primed = true;
    };

    /* ------------------------------------------------------------ the frame */

    const render = (time: number) => {
      const dt = Math.min(64, time - lastTime);
      lastTime = time;
      // The newest frame the store has, taken here rather than waiting for a
      // render to bring it: the picture runs at the fight's rate whatever the
      // page around it is doing. Without a stream this is the prop, unchanged.
      const streamed = framesRef.current?.current;
      if (streamed) boutRef.current = streamed;
      const b = boutRef.current;

      /* A new bout gets a clean ring.
       *
       * All of this is per-FIGHT state, and it was only ever built once — when
       * the render loop started. The loop deliberately outlives any single bout
       * so a sim tick cannot reset the eased poses, but that meant the
       * next pair of fighters walked out wearing the last pair's cuts, over the
       * last fight's blood on the canvas. Wipe it on the bout id. */
      if (b.id !== lastBoutId) {
        lastBoutId = b.id;
        visuals.blue = newVisual(b.left);
        visuals.red = newVisual(b.right);
        stains.length = 0;
        particles.length = 0;
        bursts.length = 0;
        ripples.length = 0;
        tags.length = 0;
        for (const corner of ["blue", "red"] as const) {
          const c = counters[corner];
          c.landed = 0;
          c.blocked = 0;
          c.down = 0;
          c.thrown = 0;
          c.airborne = null;
        }
        combo.count = 0;
        combo.at = -1e6;
        banner.at = -1e6;
        banner.round = 0;
        banner.live = false;
        banner.adopted = false;
        banner.fightAt = -1;
        crowdCue.round = -1;
        // Every fight is joined until proven otherwise. The opening frame of a
        // bout the viewer is watching from the top arms it a few lines below.
        crowdCue.armed = false;
        stopCrowd();
        stopCount();
        counting = null;
        sawLive = false;
        camera.shake = 0;
        camera.kick = 0;
        flash = 0;
        hitstopUntil = 0;
        victory.boutId = -1;
        victory.startedAt = -1;
        victory.winner = null;
        // Re-baseline the punch counters off the new fighters on the next sync
        // rather than firing a burst for every punch the previous pair threw.
        primed = false;
      }

      syncEvents(time);

      const winnerCorner: Corner | null =
        b.winnerId && b.winnerId === b.left.fighterId
          ? "blue"
          : b.winnerId && b.winnerId === b.right.fighterId
            ? "red"
            : null;
      if (!b.finish) sawLive = true;
      if (b.finish && winnerCorner && victory.boutId !== b.id) {
        // The stoppage sting, on the frame the fight is called off. Only for a
        // stoppage, only at true speed, and only if this viewer was watching
        // before it happened: arriving on the aftermath screen of a fight that
        // ended two minutes ago should not detonate a knockout in somebody's
        // headphones, and neither should scrubbing to the end at 12×.
        if (sawLive && arenaAudible() && (b.finish === "KO" || b.finish === "TKO")) {
          playCue("ko");
        }
        const winnerVisual = visuals[winnerCorner];
        victory.boutId = b.id;
        victory.startedAt = time;
        victory.winner = winnerCorner;
        victory.startX = winnerVisual.x;
        victory.startY = winnerVisual.y;
        victory.startAngle = Math.atan2(
          (winnerVisual.y - RING_DEPTH_M / 2) / 1.25,
          (winnerVisual.x - RING_LENGTH_M / 2) / 2.15,
        );
        const confetti = winnerCorner === "blue"
          ? ["#2fb9ec", "#9becff", "#ffe45c", "#ffffff"]
          : ["#f0921c", "#ffd98a", "#ff5545", "#ffffff"];
        for (let i = 0; i < 34; i += 1) {
          particles.push({
            x: winnerVisual.x + (Math.random() - 0.5) * 0.5,
            y: 1.45 + Math.random() * 0.45,
            depth: winnerVisual.y + (Math.random() - 0.5) * 0.25,
            vx: (Math.random() - 0.5) * 3.8,
            vy: 2.2 + Math.random() * 3.1,
            life: 0,
            max: 850 + Math.random() * 900,
            color: confetti[i % confetti.length],
            blood: false,
          });
        }
      }
      const victoryAge = victory.startedAt < 0 ? -1 : time - victory.startedAt;

      const holding = time < hitstopUntil;
      const rate = clamp(dt / 110, 0, 1);
      const step = holding ? 0 : rate;

      for (const [corner, f] of [
        ["blue", b.left],
        ["red", b.right],
      ] as const) {
        const v = visuals[corner];
        const info = PUNCH_INFO[f.action];
        const down = f.downCountSeconds > 0;
        const hurt = clamp(f.hurtSeconds / 3, 0, 1);
        const stunned = clamp(f.stunSeconds / 2, 0, 1);

        v.x = ease(v.x, f.x, step * 0.85);
        v.y = ease(v.y, f.y, step * 0.85);
        // The turn keeps running through hitstop; a fighter frozen mid-flip
        // reads as a glitch rather than a pause.
        const wantFacing = corner === "blue" ? sideDir : -sideDir;
        v.facing = ease(v.facing, wantFacing, clamp(dt / 110, 0, 1) * 1.7);

        const rawPhase = info
          ? clamp(f.actionElapsed / Math.max(0.05, f.actionDuration), 0, 1)
          : 1;
        // Eased, phase only ever trails the sim's clock — so the clock reading
        // BEHIND the drawn phase means the action restarted, and that is the
        // cue to snap. Matching on the action name instead misses a jab thrown
        // straight after a jab (the combo library deals plenty), where easing
        // 1 → 0 walks back down through the recoil half of the extension curve
        // and pops a phantom punch between the two real ones.
        if (f.action !== v.action || rawPhase < v.phase - 1e-3) {
          v.action = f.action;
          v.phase = rawPhase;
        } else {
          v.phase = ease(v.phase, rawPhase, holding ? 0 : 0.55);
        }
        // Hands snap out and recoil far faster than the body eases. The reach
        // drawn is NOT the tick-sampled handExtension: the sim scores contact
        // on a sweep out to the punch's full planned peak, and a fast punch's
        // true top lives between two ticks, so drawn off the sample a scored
        // punch kept dying in the air a hand short of the face it had just
        // been counted on. Run the hand along the sim's own curve — which is
        // exactly what handExtension is, sampled at tick rate — and ONLY that
        // curve. Taking the larger of curve and sample instead drew two humps
        // whenever the ticks were fine enough to trace the sample's own peak
        // ahead of the eased phase reaching it, and every jab read as a
        // one-two.
        const swept = info
          ? extensionCurve(v.phase, info.contactPhase) *
            Math.max(0.1, f.punchExtensionTarget)
          : 0;
        v.ext = ease(v.ext, swept, holding ? 0 : 0.62);

        let crouch = (1 - clamp(f.body.centerOfMassHeight, 0.5, 1.1)) * 0.9;
        let lean = 0;
        if (f.action === "duck") crouch += 0.55;
        if (f.action === "weave") {
          crouch += 0.4;
          lean -= 0.5;
        }
        if (f.action === "slip") lean -= 0.55;
        if (f.action === "recover") crouch += 0.12;
        if (f.action === "advance") lean += 0.3;
        if (f.action === "retreat") lean -= 0.28;
        if (info) {
          crouch += info.target === "body" ? 0.42 : 0;
          lean += info.arc === "uppercut" ? 0.15 : 0.3;
        }
        crouch += hurt * 0.25;

        v.crouch = ease(v.crouch, down ? 0.2 : clamp(crouch, 0, 1.1), step);
        v.lean = ease(v.lean, down ? 0 : clamp(lean, -1, 1), step);
        // A slip's travel is lateral — the one axis a side-on camera cannot
        // show. Drawn with its ring-plane sign, half of all slips lunged the
        // head TOWARD the incoming glove, and a punch cleanly dodged in the sim
        // was drawn landing flush. Anything past idle sway is drawn as
        // pull-back off the punch line instead; which ear the head actually
        // went past is the camera's blind spot either way.
        const headOff = f.headOffset;
        const evasive = clamp((Math.abs(headOff) - 0.05) / 0.06, 0, 1);
        v.headX = ease(v.headX, lerp(headOff, -Math.abs(headOff), evasive), step);
        v.headUp = ease(v.headUp, (f.headLevel - 1) * f.heightM * 0.5, step);
        v.hip = ease(v.hip, f.body.hipRotation, step);
        v.shoulder = ease(v.shoulder, f.body.shoulderRotation, step);
        v.down = ease(v.down, down ? 1 : 0, clamp(dt / 340, 0, 1));
        const celebrating = victory.winner === corner && victoryAge >= 0;
        v.victory = ease(v.victory, celebrating ? 1 : 0, clamp(dt / 180, 0, 1));
        v.lap = ease(
          v.lap,
          celebrating && victoryAge > 1200 && victoryAge < 8200 ? 1 : 0,
          clamp(dt / 170, 0, 1),
        );

        // A held block reads as the full high guard even while the feet keep
        // working: `guardHeld` is the exhibition's posture flag and no league
        // fighter ever carries it, so nothing on a broadcast draws differently.
        // Without this the player's block was invisible — the engine was
        // absorbing behind a walking pose with the hands at half mast.
        const guardTarget =
          f.action === "guard" || (f.guardHeld && !info)
            ? 1
            : f.action === "recover" || f.action === "retreat"
              ? 0.82
              : info
                ? 0.3
                : 0.62;
        // A hurt man's hands come down. It is the clearest signal in boxing that
        // somebody is in trouble, so it is drawn plainly rather than implied.
        // The held guard SNAPS up instead of easing — the raise is the player's
        // proof the press landed, and at the normal ease it arrived a beat late.
        const guardStep = f.guardHeld && guardTarget === 1 ? clamp(dt / 60, 0, 1) : step;
        v.guard = ease(v.guard, clamp(guardTarget - hurt * 0.5 - stunned * 0.3, 0, 1), guardStep);

        v.snapX = ease(v.snapX, 0, clamp(dt / 210, 0, 1));
        v.snapY = ease(v.snapY, 0, clamp(dt / 210, 0, 1));
        v.fold = Math.max(0, v.fold - dt / 620);
        v.whiteout = Math.max(0, v.whiteout - dt / 110);
      }

      // Drawn separation is the real one, floored so two solid sprites cannot
      // occupy the same pixels. Hand travel is scaled by the same factor below,
      // so a punch thrown at clinch range still finishes on the body.
      const realGap = Math.hypot(b.right.x - b.left.x, b.right.y - b.left.y);
      const gapX = b.right.x - b.left.x;
      if (gapX > SIDE_SWAP_THRESHOLD_M) sideDir = 1;
      else if (gapX < -SIDE_SWAP_THRESHOLD_M) sideDir = -1;
      // Capped as well as floored: the pair circle on a plane, so a gap that is
      // almost all depth would otherwise fling them to opposite ends of the
      // frame when the drawing already separates them by depth alone.
      const drawnGap = clamp(realGap, MIN_VISUAL_GAP_M, 3.4);
      const spreadScale = drawnGap / Math.max(0.3, realGap);
      const mid = (b.left.x + b.right.x) / 2;
      const blueX = mid - (sideDir * drawnGap) / 2;
      const redX = mid + (sideDir * drawnGap) / 2;
      // Slide the pair as one unit so neither is ever drawn through the ropes.
      // Shifting them together preserves the separation, which is the thing the
      // punches are measured against.
      const edge = 0.5;
      const lo = Math.min(blueX, redX);
      const hi = Math.max(blueX, redX);
      const shift =
        lo < edge
          ? edge - lo
          : hi > RING_LENGTH_M - edge
            ? RING_LENGTH_M - edge - hi
            : 0;
      visuals.blue.x = blueX + shift;
      visuals.red.x = redX + shift;

      // Hold the gloves high, then complete one compact lap around the ring.
      // This only changes the drawn celebration; the completed bout checkpoint
      // remains untouched.
      if (victory.winner && victoryAge >= 0) {
        const winnerVisual = visuals[victory.winner];
        const lapProgress = clamp((victoryAge - 1200) / 7000, 0, 1);
        const angle = victory.startAngle + lapProgress * Math.PI * 2;
        const targetX = lapProgress > 0
          ? RING_LENGTH_M / 2 + Math.cos(angle) * 2.15
          : victory.startX;
        const targetY = lapProgress > 0
          ? RING_DEPTH_M / 2 + Math.sin(angle) * 1.25
          : victory.startY;
        winnerVisual.x = ease(winnerVisual.x, targetX, clamp(dt / 130, 0, 1));
        winnerVisual.y = ease(winnerVisual.y, targetY, clamp(dt / 130, 0, 1));
        if (lapProgress > 0 && lapProgress < 1) {
          const travelX = -Math.sin(angle);
          if (Math.abs(travelX) > 0.08) {
            winnerVisual.facing = ease(
              winnerVisual.facing,
              travelX > 0 ? 1 : -1,
              clamp(dt / 90, 0, 1),
            );
          }
        }
      }

      // Frame the pair. It holds a wide shot on purpose: the ring, both full
      // bodies and the skyline behind them stay in frame at all times, and the
      // lens only creeps in a little when they get into the pocket. A tighter
      // rig reads more dramatic for a second and then spends the round hiding
      // the boots, the ropes and the city.
      const wantPpm = Math.min(
        (width * 0.44) / (drawnGap + 0.85),
        (height * FIGHTER_FRAME_SHARE) / 1.9,
      );
      camera.center = ease(camera.center, mid, step * 0.9);
      camera.ppm = ease(camera.ppm, clamp(wantPpm, 32, 64), step * 0.4);
      if (victory.winner) {
        camera.center = ease(camera.center, RING_LENGTH_M / 2, clamp(dt / 180, 0, 1));
        camera.ppm = ease(camera.ppm, 36, clamp(dt / 220, 0, 1));
      }

      // Track them vertically too, but only part of the way — see PAN_FOLLOW.
      const meanDepth = clamp((visuals.blue.y + visuals.red.y) / 2 / RING_DEPTH_M, 0, 1);
      const restingFeet =
        height * HORIZON_FRACTION +
        height * (FLOOR_BOTTOM_FRACTION - HORIZON_FRACTION) * meanDepth;
      camera.panY = ease(
        camera.panY,
        clamp(
          (height * FEET_FRACTION - restingFeet) * PAN_FOLLOW,
          -height * 0.2,
          height * 0.2,
        ),
        step * 0.5,
      );

      camera.shake = Math.max(0, camera.shake - dt / 240);
      camera.kick = Math.max(0, camera.kick - dt / 260);
      flash = Math.max(0, flash - dt / 130);

      // The referee circles behind the action, always a couple of strides clear.
      // He is placed in the DRAWN frame rather than the sim's: the sprites have
      // been spread apart to stay readable, and an official positioned off the
      // sim's raw coordinates would walk straight through one of them.
      // He stands further back than the fighters, so the same ring-x lands him
      // at a different screen-x. Solving for the ring-x that puts him a fixed
      // distance to the SIDE of the pair on screen is what actually keeps him
      // out of the exchange; offsetting his world position does not.
      const refDepth = clamp(Math.min(b.left.y, b.right.y) - 1.9, 0.4, 2.2);
      const kRef = depthScale(refDepth / RING_DEPTH_M);
      const kMen = depthScale(((visuals.blue.y + visuals.red.y) / 2) / RING_DEPTH_M);
      const clearance = drawnGap / 2 + 1.7;
      const refWant = clamp(
        camera.center + ((mid - camera.center) - sideDir * clearance) * (kMen / kRef),
        0.6,
        RING_LENGTH_M - 0.6,
      );
      referee.x = ease(referee.x, refWant, step * 0.4);
      referee.depth = ease(referee.depth, refDepth, step * 0.2);
      referee.step += Math.abs(refWant - referee.x) * dt * 0.03;

      // The bell: fire the round call whenever the bout goes live again, at the
      // opening or coming back out of the corner.
      const liveRound = b.breakTime <= 0 && !b.finish;
      // The opening of the fight, which every viewer watching normally lands on
      // — the stage only mounts a canvas at the bell — and which nobody joining
      // one already in progress can land on, because the round clock has moved.
      const atTheTop =
        b.round === 1 && liveRound && b.roundLength - b.roundTime < 1;
      // Somebody arriving at a fight already in progress has not missed a bell —
      // he has turned the television on in the middle of a round, and the round
      // call belongs to the bell, not to his arrival. So the first frame of a
      // fight adopts whatever round is already running instead of announcing it,
      // and the top of the fight is the only first frame that is a real start.
      if (!banner.adopted) {
        banner.adopted = true;
        banner.round = b.round;
        // Round two's intro looks exactly like round one's, so the intro alone
        // cannot be the test — read for the top of the fight instead. Anything
        // else on a first frame is an arrival, and it is adopted in silence.
        banner.live = liveRound && !atTheTop;
      }
      if (liveRound && (!banner.live || b.round !== banner.round)) {
        banner.at = time;
        banner.round = b.round;
        banner.fightAt = -1;
        banner.cued = false;
      }
      banner.live = liveRound;

      /* Sound first, word second.
       *
       * The cue goes half a second before the men are released rather than on
       * the same frame as the letters. A sting has an attack on the front of it
       * and lining the file's start up with the flash puts the actual hit half a
       * beat late; started early, the two land together.
       *
       * `banner.at` is still back at -1e6 for anyone who joined mid-round, and
       * that is what keeps both of these quiet for them. They did not miss a
       * bell, they turned the television on. */
      const called = liveRound && banner.at > -1e5;
      if (called && !banner.cued && b.introSeconds <= CUE_LEAD_SECONDS) {
        banner.cued = true;
        // The sting belongs to fight night at true speed, on the same terms as
        // the punches. A gym-cam practice round starting over is routine, not
        // an event — the training page kept barking "FIGHT" at everyone every
        // time the sparring loop reset — and a rewatch at twelve times over
        // gets three round calls inside twenty seconds.
        if (arenaAudible()) playCue("fight");
      }
      if (called && banner.fightAt < 0 && b.introSeconds <= 0) {
        banner.fightAt = time;
      }

      /* The crowd rides the round. Cued off the clock rather than the banner
       * so the bells on the front of the tape land where a real arena's would
       * — see CROWD_BREAK_LEAD_SECONDS. Keyed per round, and how the tape
       * starts depends on when you got here: caught at the bell it rolls from
       * the top, bells first; joined mid-round (or a throttled tab blinked
       * through the window) it drops in mid-crowd at the round's own elapsed
       * time, because a bell out of nowhere is a lie about the round.
       *
       * Mute is checked here rather than left for startCrowd to swallow: a
       * muted viewer must not burn the round's cue, so turning the sound on
       * mid-round drops them into the arena on the next frame. */
      if (b.running && !b.finish && arenaAudible() && !isMuted()) {
        // Sitting in the corner is what earns the bell that ends the corner,
        // and so is arriving before the fight has moved: the first frame of a
        // bout that has not started counting is the walk-out, not a join.
        if (b.breakTime > CROWD_BREAK_LEAD_SECONDS || atTheTop) crowdCue.armed = true;
        const atBell =
          (b.breakTime > 0 && b.breakTime <= CROWD_BREAK_LEAD_SECONDS) ||
          (b.breakTime === 0 && b.introSeconds > 0);
        if (crowdCue.armed && crowdCue.round !== b.round && atBell) {
          crowdCue.round = b.round;
          startCrowd();
        } else if (b.breakTime === 0 && !crowdLive() && b.roundTime > 6) {
          // No bell: they arrived after it, or the sound was off through it.
          // The tape's clock was 2.0s in when the men were released — the break
          // lead plus the round call — so the round's elapsed time lands that
          // far into it. Held off in the last seconds of a round, where the
          // tape has less left than the round does and joining is pointless.
          crowdCue.round = b.round;
          startCrowd(b.roundLength - b.roundTime + 2);
        }
      }
      // And off the air the moment the round is over — the next break, the
      // final bell, or the broadcast leaving true speed. A stoppage is the one
      // ending the arena does not go quiet for: it holds through the sting and
      // the count's own cheering before letting go — see
      // CROWD_STOPPAGE_HOLD_MS.
      const stoppage = b.finish === "KO" || b.finish === "TKO";
      const arenaHolds =
        stoppage && victoryAge >= 0 && victoryAge < CROWD_STOPPAGE_HOLD_MS;
      if (
        (!b.running && !arenaHolds) ||
        b.breakTime > CROWD_BREAK_LEAD_SECONDS ||
        !arenaAudible()
      ) {
        stopCrowd();
      } else {
        // Still ours this frame. The tapes stop themselves if nothing renews
        // this — see keepRing — so a room cannot go on playing over a page that
        // has stopped drawing a fight.
        keepRing();
      }

      /* The count ends where the referee's does.
       *
       * Beating it puts `downCountSeconds` back to zero on the frame the man
       * gets up, and so does the bell for a round that runs out underneath him
       * — a tape that carries on numbering over a fight that has restarted is
       * the whole reason this check exists. A knockout is the one ending left
       * alone: he was counted out, and the cheering on the tail of the tape is
       * what that is for. Read off the verdict rather than off a count that has
       * reached ten, because the count is a quantized channel on the wire and
       * "ten exactly" is not a number a decoded frame owes anybody. */
      if (counting) {
        const counted = counting === "blue" ? b.left : b.right;
        if (b.finish === "KO" && b.winnerId !== counted.fighterId) {
          counting = null;
        } else if (counted.downCountSeconds <= 0 || b.finish || !arenaAudible()) {
          stopCount();
          counting = null;
        }
      }

      // Particles are simulated here rather than in the draw pass so hitstop
      // freezes the blood in the air along with everything else.
      if (!holding) {
        for (let i = particles.length - 1; i >= 0; i -= 1) {
          const p = particles[i];
          const s = dt / 1000;
          p.x += p.vx * s;
          p.y += p.vy * s;
          p.vy -= 9.4 * s;
          p.life += dt;
          if (p.y <= 0.02) {
            if (p.blood) {
              stains.push({
                x: p.x,
                depth: p.depth + (Math.random() - 0.5) * 0.25,
                size: 1 + Math.random() * 1.6,
                seed: seedCounter++,
              });
              // The canvas can only take so much before the frame cost of it
              // starts to show; the oldest marks dry out first.
              if (stains.length > 220) stains.shift();
            }
            particles.splice(i, 1);
            continue;
          }
          if (p.life > p.max) particles.splice(i, 1);
        }
      }

      const drawnFrame = drawScene(context, {
        width,
        height,
        time,
        dt,
        bout: b,
        visuals,
        camera,
        sideDir,
        spreadScale,
        bursts,
        tags,
        particles,
        stains,
        ripples,
        combo,
        banner,
        referee,
        flash,
        profiles: profiles.current,
        ads: adsRef.current,
        venue: venueRef.current,
        drill: drillRef.current,
        mobile: coarse.matches,
        hud: hudRef.current,
        backdrop,
      });
      lastFrame = drawnFrame;
      lastBillboardTime = time;
      lastBillboardBaseY =
        Math.round(drawnFrame.horizon - height * 0.055) + Math.round(camera.panY * 0.3);

      for (let i = bursts.length - 1; i >= 0; i -= 1) {
        if (time - bursts[i].born > bursts[i].ttl) bursts.splice(i, 1);
      }
      for (let i = tags.length - 1; i >= 0; i -= 1) {
        if (time - tags[i].born > tags[i].ttl) tags.splice(i, 1);
      }
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        if (time - ripples[i].born > ripples[i].ttl) ripples.splice(i, 1);
      }

      raf = window.requestAnimationFrame(render);
    };
    raf = window.requestAnimationFrame(render);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.style.cursor = "";
      if (matThud !== null) window.clearTimeout(matThud);
      // Whoever unmounted the ring took the arena with them — cut, not fade.
      // A fade outlives the navigation and follows the viewer onto a page with
      // no fight on it.
      silenceRing();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`fight-canvas fight-canvas--${venue}`}
      role="img"
      aria-label={venue === "gym"
        ? drill === "sparring"
          ? `Illustrative gym sparring: ${left.lastName} versus ${right.lastName}`
          : `Illustrative ${drill.replace("-", " ")} drill featuring ${left.lastName}`
        : `Live bout: ${left.lastName} versus ${right.lastName}`}
    />
  );
}

/* ------------------------------------------------------------------- drawing */

interface Scene {
  width: number;
  height: number;
  time: number;
  dt: number;
  bout: BoutState;
  visuals: Record<Corner, Visual>;
  camera: Camera;
  sideDir: number;
  spreadScale: number;
  bursts: Burst[];
  tags: Tag[];
  particles: Particle[];
  stains: Stain[];
  ripples: Ripple[];
  combo: { corner: Corner; count: number; at: number };
  banner: { at: number; round: number; fightAt: number };
  referee: { x: number; depth: number; step: number };
  flash: number;
  profiles: Record<Corner, Profile>;
  ads: AdBoard[];
  venue: FightVenue;
  drill: FightDrill;
  // On a phone the buffer is half the width and the glyphs do not shrink with
  // it, so the theatre gets turned down there: a dimmer screen flash, smaller
  // impact bursts, and callouts pushed clear of the exchange they are calling.
  mobile: boolean;
  hud: "full" | "clock";
  // The baked city layers, owned by the render loop and threaded through here
  // so drawCity can read and refill them. One per canvas; a resize empties it.
  backdrop: CityBackdrop;
}

interface Frame {
  width: number;
  height: number;
  horizon: number;
  floorBottom: number;
  center: number;
  ppm: number;
  shakeX: number;
  shakeY: number;
}

function projectX(frame: Frame, worldX: number, depth: number) {
  const k = depthScale(depth / RING_DEPTH_M);
  return frame.width / 2 + (worldX - frame.center) * frame.ppm * k + frame.shakeX;
}

function projectY(frame: Frame, depth: number) {
  const t = clamp(depth / RING_DEPTH_M, 0, 1);
  return frame.horizon + (frame.floorBottom - frame.horizon) * t + frame.shakeY;
}

/* The ring is a world object, so its cached projection and the fighters must
 * read the same camera sample. Quantizing the camera to one screen pixel keeps
 * the cache useful while preventing a rope from drifting half a pixel away from
 * the canvas or a fighter as the follow camera eases. */
function quantizeFrame(frame: Frame): Frame {
  const ppm = Math.round(frame.ppm * 16) / 16;
  const centerQuantum = 1 / Math.max(1, ppm);
  return {
    ...frame,
    center: Math.round(frame.center / centerQuantum) * centerQuantum,
    ppm,
    horizon: Math.round(frame.horizon),
    floorBottom: Math.round(frame.floorBottom),
    shakeX: Math.round(frame.shakeX),
    shakeY: Math.round(frame.shakeY),
  };
}

function drawScene(ctx: CanvasRenderingContext2D, s: Scene): Frame {
  const { width, height, time, bout } = s;
  const shakeMag = s.camera.shake * s.camera.shake * 4;
  const rawFrame: Frame = {
    width,
    height,
    horizon: Math.round(height * HORIZON_FRACTION + s.camera.panY),
    floorBottom: Math.round(height * FLOOR_BOTTOM_FRACTION + s.camera.panY),
    center: s.camera.center,
    ppm: s.camera.ppm * (1 + s.camera.kick * 0.045),
    shakeX: Math.round(Math.sin(time / 17) * shakeMag),
    shakeY: Math.round(Math.cos(time / 13) * shakeMag * 0.6),
  };
  const frame = quantizeFrame(rawFrame);

  if (s.venue === "gym") drawGym(ctx, s, frame);
  else drawCity(ctx, s, frame);
  if (s.drill === "sparring") drawRingBackdrop(ctx, s, frame);
  else drawGymFloor(ctx, frame);
  if (s.venue === "fight-night") drawStains(ctx, s, frame);
  if (s.drill !== "sparring") drawGymDrillEquipment(ctx, s, frame);
  if (s.venue === "fight-night") drawReferee(ctx, s, frame);

  // Paint far to near so the man in front genuinely occludes the man behind.
  const order: Corner[] =
    s.visuals.blue.y <= s.visuals.red.y ? ["blue", "red"] : ["red", "blue"];
  for (const corner of order) {
    const f = corner === "blue" ? bout.left : bout.right;
    drawFighter(ctx, s, frame, corner, f);
  }
  if (s.drill === "reflex") drawReflexCall(ctx, s, frame);

  if (s.drill === "sparring") {
    drawNearSideRopes(ctx, s, frame);
    drawRipples(ctx, s, frame);
    if (s.venue === "fight-night") drawParticles(ctx, s, frame);
    drawBursts(ctx, s, frame);
    drawApron(ctx, frame);
    drawTags(ctx, s, frame);
  }

  if (s.flash > 0.01) {
    // Half strength on a phone: the blink fires on every power shot, and at
    // arm's length a full-screen white pop reads as strobing, not impact.
    ctx.globalAlpha = s.flash * (s.mobile ? 0.26 : 0.5);
    rect(ctx, 0, 0, width, height, "#ffffff");
    ctx.globalAlpha = 1;
  }

  if (s.venue === "fight-night") drawHud(ctx, s, frame);

  return frame;
}

/* The gym's key light is the two fluorescent strips overhead and slightly
 * forward of the floor, and every ramp in this room is built against them: a
 * surface turning into the light warms and yellows, a surface turning away
 * cools and goes violet. The same colour at four brightnesses is what makes a
 * fill read as a swatch instead of a lit object, so nothing here is a straight
 * lightness ramp. */
const GYM_TUBES = [0.27, 0.73];

/** The house dither — three rows thinning downward — painted in the UPPER
 *  band's colour over the lower one. Used wherever two flat values meet across
 *  a wide surface: a hard seam across a whole floor reads as a printed line,
 *  and a smooth blend would stop the room reading as pixel art at all. */
function ditherSeam(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  color: string,
) {
  ctx.fillStyle = color;
  for (let row = 0; row < 3; row += 1) {
    for (let px = (row % 2) * 2; px < width; px += 4 - row) {
      ctx.fillRect(Math.round(x + px), Math.round(y + row), 1, 1);
    }
  }
}

/* A one-pixel line stepped by error term rather than by walking a float and
 * rounding it. The float walk is where jaggies come from: the same straight
 * edge comes out in runs of 3, then 1, then 2, and the eye reads the odd run
 * as a kink in a line that is not bent. Stepping keeps the runs even the whole
 * way down, which is the only thing that makes a long diagonal look drawn. */
function pixelRay(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const stepX = x < endX ? 1 : -1;
  const stepY = y < endY ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = color;
  for (let guard = 0; guard < 4096; guard += 1) {
    ctx.fillRect(x, y, 1, 1);
    if (x === endX && y === endY) return;
    const e2 = err * 2;
    if (e2 >= dy) {
      err += dy;
      x += stepX;
    }
    if (e2 <= dx) {
      err += dx;
      y += stepY;
    }
  }
}

/* A basement boxing room rather than a reskinned arena. The same ring and the
 * same articulated bodies sit in front of scuffed blockwork, old plumbing,
 * taped notices and hard fluorescent strips. Nothing here claims to be part of
 * the simulation; it is the camera location wrapped around it. */
function drawGym(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const wallBottom = Math.round(frame.horizon + frame.height * 0.07);
  rect(ctx, 0, 0, frame.width, wallBottom, "#0e1319");
  rect(ctx, 0, wallBottom, frame.width, frame.height - wallBottom, "#171617");

  drawGymWall(ctx, frame, wallBottom);
  drawGymFittings(ctx, s, frame, wallBottom);
}

/* The blockwork's five values, cold and blue in the corners the tubes cannot
 * reach, warm and dry directly under them. */
const BRICK_RAMP = ["#0e1319", "#151a1e", "#1e2325", "#2b2e29", "#3b3a2d"];
/* Selective outlining, applied to a wall: the mortar is a darker version of
 * the brick it borders rather than one black grid laid over everything. A
 * single black grid cuts the lit pool back into squares and throws away the
 * brightness the light was drawn to give it. */
const MORTAR_RAMP = ["#070a0d", "#0a0d10", "#0e1214", "#151711", "#1e1d14"];

/** How lit a point on the wall is, 0 to 1: a tube throws a cone, so a brick
 *  directly beneath one stays lit much further down the wall than a brick off
 *  to the side of it. */
function brickLight(frame: Frame, x: number, y: number, wallBottom: number) {
  let nearest = frame.width;
  for (const tube of GYM_TUBES) {
    nearest = Math.min(nearest, Math.abs(x - frame.width * tube));
  }
  const spread = frame.width * 0.16 + y * 0.62;
  const across = clamp(1 - nearest / spread, 0, 1);
  const down = clamp(1 - (y - 10) / (wallBottom * 0.95), 0, 1);
  return across * down;
}

/* The wall is drawn as lit blockwork, not as a flat fill with a brick grid on
 * top: each brick takes the value its position in the light earns, so squinting
 * at the room leaves two big pale pools and a lot of cold dark, instead of one
 * even grey field with texture in it. The band edges need no dither — they fall
 * on brick boundaries, and the staircase the courses cut through them breaks
 * the contour better than a stipple would. */
function drawGymWall(ctx: CanvasRenderingContext2D, frame: Frame, wallBottom: number) {
  const brickW = 22;
  const brickH = 10;
  const rows = Math.ceil(wallBottom / brickH);
  const top = BRICK_RAMP.length - 1;

  for (let row = 0; row < rows; row += 1) {
    const y = row * brickH;
    const offset = row % 2 ? -brickW / 2 : 0;
    for (let x = offset; x < frame.width; x += brickW) {
      const lit = brickLight(frame, x + brickW / 2, y + brickH / 2, wallBottom);
      // A brick either side of a band edge gets nudged into its neighbour, so
      // the edge scatters into individual bricks rather than drawing a clean
      // contour across a wall that has no such edge in it.
      const jitter = (hash2(row, Math.round(x)) - 0.5) * 0.16;
      const band = clamp(Math.round((lit + jitter) * top), 0, top);
      rect(ctx, x, y, brickW - 1, brickH - 1, BRICK_RAMP[band]);
      rect(ctx, x, y + brickH - 1, brickW, 1, MORTAR_RAMP[band]);
      rect(ctx, x + brickW - 1, y, 1, brickH, MORTAR_RAMP[band]);
      // The top arris of a course catches the tube and the underside does not.
      // One lit pixel along an edge is the whole of what makes a hard-shaded
      // block sit in a room rather than float on it.
      if (band >= 2 && band < top) {
        rect(ctx, x, y, brickW - 1, 1, BRICK_RAMP[band + 1]);
      }
    }
  }

  // Old damp and old scuffing, keyed on index so they hold still while the
  // camera pans. Damp is cold and sits in runs; scuffing is warm, dry and
  // short, and both stay off the darkest band where nothing would read.
  for (let index = 0; index < 46; index += 1) {
    const x = Math.floor(hash2(index, 803) * frame.width);
    const y = Math.floor(hash2(index, 804) * wallBottom);
    const wide = 1 + Math.floor(hash2(index, 805) * 6);
    const damp = hash2(index, 806) > 0.55;
    rect(ctx, x, y, wide, 1, damp ? "#131b21" : "#33352e");
    if (!damp) rect(ctx, x + 1, y + 1, Math.max(1, wide - 2), 1, "#0c0f10");
  }
}

/* Indexed sprite art: one character a pixel, looked up in a palette. Anything
 * this small has to be authored pixel by pixel — a glove assembled out of
 * rectangles comes out a mitten — and a grid of characters is the only form
 * that lets the shape be read in the source rather than run to be seen. */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  art: string[],
  palette: Record<string, string>,
  x: number,
  y: number,
  flip = false,
) {
  const width = art[0].length;
  art.forEach((row, dy) => {
    for (let dx = 0; dx < width; dx += 1) {
      const fill = palette[row[dx]];
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(Math.round(x + (flip ? width - 1 - dx : dx)), Math.round(y + dy), 1, 1);
    }
  });
}

/* A boxing glove, side on, punching to the right: laced cuff on the left, the
 * thumb sitting low and forward of it, the knuckle face rolling away to the
 * right. The silhouette steps 2, 1, 0 into each end — matched runs, or a
 * sixteen-pixel curve comes out an octagon — and the shading is in planes
 * rather than rings: a broad lit top, a mid face, and a hard dark underside.
 * Ramped concentrically it read as a ball with a plug in it. The key light is
 * upper-left, the same one the wall behind it is lit by. */
const GLOVE_ART = [
  ".......oooooo...",
  ".....ohhhllllmo.",
  "....ohhllllmmmmo",
  "okcollllmmmmmmdo",
  "okkolllmmmmmmddo",
  "okcollmmmmmmdddo",
  "okcommmmmmdddddo",
  "okcoommmdddddddo",
  "...olmmoddddddo.",
  "....omoddddddo..",
  "......odddddo...",
  "........oooo....",
];

/* The two corners, in the corner colours the ropes already use, each ramped
 * through four values and hue-shifted the same way the rest of the room is:
 * the light steps toward white-blue and pink, the shadow toward navy and
 * oxblood. The laced cuff is shared — it is the one part of a glove that is
 * the same on both fighters. */
const GLOVE_BLUE = { o: "#0b1832", d: "#1d3f7a", m: "#2f5fb8", l: "#4d86dd", h: "#93bcf4", c: "#7f838c", k: "#d7dae0" };
const GLOVE_RED = { o: "#280a0c", d: "#7a1f1c", m: "#c8342a", l: "#e4695a", h: "#f8aa9d", c: "#7f838c", k: "#d7dae0" };

const GLOVE_WIDTH = GLOVE_ART[0].length;
const EMBLEM_WIDTH = GLOVE_WIDTH * 2 + 3;
const EMBLEM_HEIGHT = GLOVE_ART.length;

/* The hit between them. Four axes and four diagonals at matched run lengths,
 * the same rule the heavy bag's impact follows: a star swept at free angles
 * rounds differently on every arm and comes out lopsided. */
function paintEmblemSpark(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  for (let step = 2; step <= 5; step += 1) {
    const color = step < 4 ? "#ffe9a8" : "#e2951f";
    rect(ctx, cx - step, cy, 1, 1, color);
    rect(ctx, cx + step, cy, 1, 1, color);
    rect(ctx, cx, cy - step, 1, 1, color);
    rect(ctx, cx, cy + step, 1, 1, color);
    if (step <= 3) {
      rect(ctx, cx - step, cy - step, 1, 1, color);
      rect(ctx, cx + step, cy - step, 1, 1, color);
      rect(ctx, cx - step, cy + step, 1, 1, color);
      rect(ctx, cx + step, cy + step, 1, 1, color);
    }
  }
  pixelDisc(ctx, cx, cy, 2, "#ffe9a8");
  pixelDisc(ctx, cx, cy, 1, "#fffdf2");
}

/* The club board: the crest over the name, both measured off what is actually
 * written on them. Every plate on this wall now sizes itself — the old ones
 * were rectangles of a width somebody typed once, with centred text drawn over
 * the top, so the longest line ran clean off the board and out onto the brick.
 * Returns its own edges so the fittings either side can see where it ends. */
function drawGymSign(ctx: CanvasRenderingContext2D, frame: Frame, top: number) {
  // The full name needs a board a third of the frame wide. That is fine on a
  // desktop buffer and absurd on a phone one, so the narrow frame gets the
  // short name and the crest carries the rest.
  const label = frame.width >= 300 ? "FORGE BOXING CLUB" : "FORGE GYM";
  const width = Math.max(textWidth(label, 1), EMBLEM_WIDTH) + 12;
  const height = EMBLEM_HEIGHT + 16;
  const left = Math.round((frame.width - width) / 2);

  rect(ctx, left + 3, top + 3, width, height, "#07090a");
  rect(ctx, left - 2, top - 2, width + 4, height + 4, "#0b0e0f");
  rect(ctx, left, top, width, height, "#4a271c");
  rect(ctx, left, top, width, 1, "#6d3b28");
  rect(ctx, left, top, 1, height, "#6d3b28");
  rect(ctx, left, top + height - 1, width, 1, "#2a140f");
  rect(ctx, left + width - 1, top, 1, height, "#2a140f");

  const emblemX = Math.round(left + (width - EMBLEM_WIDTH) / 2);
  const emblemY = top + 3;
  const spark = emblemX + GLOVE_WIDTH + 1;

  // Rules either side of the crest, stopped short of it. The board is wider
  // than the gloves are and a lone pair of them floating in the middle of it
  // reads as a sign somebody never finished painting.
  for (const side of [-1, 1]) {
    const inner = spark + side * (EMBLEM_WIDTH / 2 + 3);
    const outer = spark + side * (width / 2 - 5);
    const from = Math.round(Math.min(inner, outer));
    const span = Math.round(Math.abs(outer - inner));
    rect(ctx, from, emblemY + 5, span, 1, "#7a4a26");
    rect(ctx, from, emblemY + 6, span, 1, "#33180f");
  }

  drawSprite(ctx, GLOVE_ART, GLOVE_BLUE, emblemX, emblemY);
  drawSprite(ctx, GLOVE_ART, GLOVE_RED, emblemX + GLOVE_WIDTH + 3, emblemY, true);
  paintEmblemSpark(ctx, spark, emblemY + 6);

  drawPixelText(ctx, label, left + width / 2, top + EMBLEM_HEIGHT + 6, 1, "#f0cc78", {
    align: "center",
    shadow: "#5c3a17",
  });

  return { left, right: left + width };
}

/* The card girl, walking the round. She is the one thing every boxing gym wall
 * has a poster of and this one did not — the wall had a printed notice where a
 * poster belonged.
 *
 * Twenty-nine across and forty-four down, which is every row the wall has to
 * give: the pipe run caps it at the top and the skirting at the bottom, and on
 * a short buffer the gym's whole wall is seventy-odd pixels tall. Almost all of
 * that budget goes on proportion rather than detail — the hip line sits at the
 * midpoint of the figure so the legs are half of her and she reads standing
 * rather than squatting, and the head is about a quarter of the body, which is
 * still generous but forced: a realistic head here is five pixels wide and
 * cannot hold two eyes, a nose and a mouth. The raised arms are kept to two
 * pixels of skin each and set a column clear of the hair, because arms that
 * touch the head merge into one blob at this size and the pose stops reading at
 * all. The card carries the round in the same hand-drawn digit the rest of the
 * room is lettered in, painted into the art rather than laid over it as text. */
const RING_GIRL_ART = [
  ".....ooooooooooooooooooo.....",
  ".....owwwwwwwwwwwwwwwwwo.....",
  ".....owwwwwwkwwkwwwwwwwo.....",
  ".....owwwwwwkwwkwwwwwwwo.....",
  ".....owwwwwwkkkkkwwwwwwo.....",
  ".....owwwwwwwwwkwwwwwwwo.....",
  ".....owwwwwwwwwkwwwwwwwo.....",
  ".....ogggggggggggggggggo.....",
  ".....ooooooooooooooooooo.....",
  ".......olso.......osdo.......",
  ".......olso.HHHHH.osdo.......",
  ".......olsohHHHHHJosdo.......",
  ".......olsohllssHJosdo.......",
  ".......olsohlesedJosdo.......",
  ".......olsoHlsdsdJosdo.......",
  ".......olsoHssesdJosdo.......",
  ".......olsoHosssoJosdo.......",
  ".......olsoHHosoJJosdo.......",
  ".......olsoHHdsdJJosdo.......",
  ".......olsoHHdddJJosdo.......",
  ".......olsHsssssJddddo.......",
  "........olHsssssJdddo........",
  "........olttRttttRtdo........",
  "........oltttttttttdo........",
  ".........olssssssdo..........",
  "..........olssssdo...........",
  "..........olssssdo...........",
  ".........olssssssdo..........",
  ".........otttttttto..........",
  "........oRtttttttttto........",
  ".........otttttttto..........",
  ".........olssdossdo..........",
  ".........olssdossdo..........",
  ".........olssdossdo..........",
  ".........olssdossdo..........",
  "..........olsdosdo...........",
  "..........olsdosdo...........",
  "..........olsdosdo...........",
  "..........olsdosdo...........",
  "..........olsdosdo...........",
  "...........osoodo............",
  "...........osoodo............",
  "..........obboobbo...........",
  "..........obboobbo...........",
];

/* Print-shop palette: paper and ink for the card, a four-step skin ramp so the
 * limbs turn instead of reading as flat cutouts, three hair values, and the
 * two-piece in the league's own navy — she is this promotion's card girl, not
 * a stock photograph somebody pinned up. */
const RING_GIRL_PALETTE: Record<string, string> = {
  o: "#0d0a0c",
  w: "#e8e4d8",
  g: "#aca695",
  k: "#1a1618",
  l: "#f7d1a6",
  s: "#d89f6d",
  d: "#a5704a",
  h: "#f0c869",
  H: "#b6873a",
  J: "#7a5620",
  t: "#16203a",
  R: "#4c74ad",
  e: "#4a2a22",
  b: "#1d1518",
};

const POSTER_WIDTH = RING_GIRL_ART[0].length + 6;
const POSTER_HEIGHT = RING_GIRL_ART.length + 6;
/** Directly under the pipe run, which is as high as anything can be taped. */
const POSTER_TOP = 24;

/* The taped poster. Print is the one bright value on this wall that is not a
 * light source, so the sheet gets a lit top-left edge, a cool shadow down the
 * far side, and a dithered pool of stage light behind the subject — the way a
 * fight poster lights the person on it and lets the rest of the sheet go
 * black. No caption: the sheet is as tall as the wall will take, and every row
 * spent on lettering is a row off her legs. */
function drawGymPoster(ctx: CanvasRenderingContext2D, left: number, top: number) {
  rect(ctx, left - 1, top - 1, POSTER_WIDTH + 2, POSTER_HEIGHT + 2, "#08090b");
  rect(ctx, left, top, POSTER_WIDTH, POSTER_HEIGHT, "#161a24");
  rect(ctx, left, top, POSTER_WIDTH, 1, "#333b4e");
  rect(ctx, left, top, 1, POSTER_HEIGHT, "#333b4e");
  rect(ctx, left, top + POSTER_HEIGHT - 1, POSTER_WIDTH, 1, "#0b0d12");
  rect(ctx, left + POSTER_WIDTH - 1, top, 1, POSTER_HEIGHT, "#0b0d12");

  // The pool she stands in, widening down the sheet, dithered along each seam
  // so a printed gradient never appears on a wall drawn a pixel at a time.
  const bands = 6;
  const bandH = Math.ceil((POSTER_HEIGHT - 4) / bands);
  for (let band = 0; band < bands; band += 1) {
    const inset = Math.max(2, 12 - band * 2);
    const y = top + 2 + band * bandH;
    rect(ctx, left + inset, y, POSTER_WIDTH - inset * 2, bandH, band < 3 ? "#1d2230" : "#242a3b");
    ditherSeam(ctx, left + inset, y, POSTER_WIDTH - inset * 2, "#161a24");
  }

  drawSprite(ctx, RING_GIRL_ART, RING_GIRL_PALETTE, left + 3, top + 3);

  rect(ctx, left - 2, top - 2, 6, 3, "#d9d3c0");
  rect(ctx, left + POSTER_WIDTH - 4, top + POSTER_HEIGHT - 1, 6, 3, "#d9d3c0");
}

const CLOCK_WIDTH = textWidth("0:00", 1) + 12;

/* The round clock: a recessed case, so the bevel runs the other way — dark
 * along the top and left where the light cannot get in, lit along the bottom
 * lip that catches it. */
function drawGymClock(ctx: CanvasRenderingContext2D, s: Scene, left: number, top: number) {
  rect(ctx, left, top, CLOCK_WIDTH, 20, "#05070a");
  rect(ctx, left, top + 19, CLOCK_WIDTH, 1, "#39423f");
  rect(ctx, left + 2, top + 2, CLOCK_WIDTH - 4, 16, "#131a1c");
  rect(ctx, left + 2, top + 2, CLOCK_WIDTH - 4, 1, "#0a0e10");
  const clock = 20 - Math.floor((s.time / 1000) % 20);
  drawPixelText(ctx, `0:${String(clock).padStart(2, "0")}`, left + CLOCK_WIDTH / 2, top + 6, 1, "#ef4b37", {
    align: "center",
    shadow: "#3d0f0c",
  });
}

/* Everything bolted to the wall. Each fitting is a form with a lit edge and a
 * shadow edge rather than a flat rectangle: a pipe is a cylinder, a sign has
 * thickness and throws a shadow, and the tubes are the brightest thing in the
 * frame because they are what is lighting it. */
function drawGymFittings(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  frame: Frame,
  wallBottom: number,
) {
  // The pipe run. Four values across four rows turns a bar into a cylinder,
  // and the shadow it casts on the blockwork below is what puts it in front of
  // the wall instead of painted on it.
  rect(ctx, 0, 18, frame.width, 1, "#151b1d");
  rect(ctx, 0, 19, frame.width, 1, "#4e5a58");
  rect(ctx, 0, 20, frame.width, 1, "#313b3c");
  rect(ctx, 0, 21, frame.width, 1, "#1e2628");
  rect(ctx, 0, 22, frame.width, 1, "#0e1416");
  rect(ctx, 0, 23, frame.width, 1, "#0a0d10");
  for (let x = 18; x < frame.width; x += 54) {
    rect(ctx, x, 16, 3, 10, "#080a0b");
    rect(ctx, x, 16, 1, 10, "#2a3234");
  }
  if (Math.floor(s.time / 360) % 11 < 2) {
    rect(ctx, Math.round(frame.width * 0.82), 25 + Math.floor((s.time / 45) % 16), 1, 2, "#7aa1a7");
  }

  // The tubes. There is no soft falloff painted under them — the light is
  // already in the brick values, which is where a hard-shaded room has to keep
  // it. All that goes here is the fitting itself and two rows of warm stipple
  // directly beneath the glass, thinning downward, so the tube reads as the
  // thing emitting rather than a white bar hung on the wall.
  for (const center of GYM_TUBES) {
    const x = Math.round(frame.width * center);
    rect(ctx, x - 35, 4, 70, 5, "#090c0d");
    rect(ctx, x - 34, 4, 68, 1, "#3d4744");
    rect(ctx, x - 32, 6, 64, 2, "#f7f0d6");
    rect(ctx, x - 32, 8, 64, 1, "#c2b183");
    rect(ctx, x - 35, 9, 70, 1, "#0a0d0e");
    ditherSeam(ctx, x - 30, 10, 60, "#4a4636");
    ditherSeam(ctx, x - 22, 13, 44, "#33322a");
  }

  const sign = drawGymSign(ctx, frame, 26);

  // The wall furniture is laid out around the board rather than at fixed
  // coordinates, because the board is now as wide as its own name and the name
  // is longer than the room used to allow for. The notice takes the left
  // corner, the corner bag hangs off the board's shoulder beside it, and the
  // clock keeps the right. On a phone the buffer is half as wide while every
  // plate is still the same number of pixels across, so a plate with nowhere
  // to go simply does not go up — bare brick beats two sheets printed through
  // each other.
  // Width against the board, height against the floor line: the sheet is now
  // most of the wall's height, and on a short buffer it would run out through
  // the boards rather than stop at the skirting.
  const posterFits =
    6 + POSTER_WIDTH + 8 + 18 < sign.left &&
    POSTER_TOP + POSTER_HEIGHT < frame.height * 0.58;
  // Hung just clear of the poster's edge when the poster has the corner: out
  // where it used to sit it swung back and forth across the print all night.
  const bagX = posterFits ? 6 + POSTER_WIDTH + 12 : Math.round(frame.width * 0.12);
  // High on the wall: the ring's top rope crosses this stretch of brick, and a
  // couple of pixels lower it ran straight through the caption.
  if (posterFits) drawGymPoster(ctx, 6, POSTER_TOP);
  if (frame.width - CLOCK_WIDTH - 6 > sign.right + 4) {
    drawGymClock(ctx, s, frame.width - CLOCK_WIDTH - 6, 36);
  }

  // A bag and a bench behind the far ropes, cropped by the ring the way they
  // would be in a tight room. The bag is the same cylinder as the drill bag,
  // drawn small: the values do the work at any size, the detail does not.
  rect(ctx, bagX, 0, 2, wallBottom - 30, "#0a0c0d");
  rect(ctx, bagX, 0, 1, wallBottom - 30, "#232b2c");
  const swing = Math.round(Math.sin(s.time / 620) * 2);
  paintHeavyBag(ctx, bagX + 1 + swing, wallBottom - 52, wallBottom - 19, 8);

  rect(ctx, frame.width - 84, wallBottom - 18, 63, 1, "#3e4644");
  rect(ctx, frame.width - 84, wallBottom - 17, 63, 4, "#171d1f");
  rect(ctx, frame.width - 84, wallBottom - 13, 63, 1, "#080a0b");
  for (const legX of [frame.width - 79, frame.width - 29]) {
    rect(ctx, legX, wallBottom - 12, 3, 12, "#1b2224");
    rect(ctx, legX, wallBottom - 12, 1, 12, "#3a4244");
  }
}

/* The floor recedes in three values, warm and close under the camera, cold and
 * dim at the far wall, with a dithered seam at each change so a room-wide value
 * step never prints as a line. The board joins are a darker version of the
 * board they part — black joins on a dark floor is a grid drawn over a picture,
 * and it flattens the whole surface back into a plane. */
const FLOOR_BANDS = ["#191a1d", "#211e1f", "#292425"];
const FLOOR_JOINS = ["#101115", "#141213", "#1b1718"];

function drawGymFloor(ctx: CanvasRenderingContext2D, frame: Frame) {
  const top = Math.round(frame.height * 0.58);
  const depth = frame.height - top;
  const bandDepth = Math.max(1, Math.ceil(depth / FLOOR_BANDS.length));

  FLOOR_BANDS.forEach((color, index) => {
    const y = top + index * bandDepth;
    rect(ctx, 0, y, frame.width, bandDepth, color);
    if (index > 0) ditherSeam(ctx, 0, y, frame.width, FLOOR_BANDS[index - 1]);
  });

  // Where the floor meets the wall: a dark contact line with a lit lip under
  // it, because the tubes rake along the boards and nothing else in the room
  // catches them at that angle.
  rect(ctx, 0, top - 1, frame.width, 2, "#0a0b0d");
  rect(ctx, 0, top + 1, frame.width, 1, "#3a3733");

  // Boards running away to a vanishing point on the horizon, each drawn in the
  // join colour of the band it is crossing.
  const vanishX = frame.width / 2;
  for (let x = -frame.width; x < frame.width * 2; x += 24) {
    for (let index = 0; index < FLOOR_BANDS.length; index += 1) {
      const from = index / FLOOR_BANDS.length;
      const to = (index + 1) / FLOOR_BANDS.length;
      pixelRay(
        ctx,
        lerp(vanishX, x, from),
        top + depth * from,
        lerp(vanishX, x, to),
        top + depth * to - 1,
        FLOOR_JOINS[index],
      );
    }
  }

  // Cross joins, spaced wider as they come toward the camera. Even spacing is
  // the giveaway that a floor is a flat fill with lines on it.
  for (let index = 1; index < 7; index += 1) {
    const t = (index / 7) ** 1.7;
    const y = Math.round(top + depth * t);
    const band = Math.min(FLOOR_BANDS.length - 1, Math.floor(t * FLOOR_BANDS.length));
    rect(ctx, 0, y, frame.width, 1, FLOOR_JOINS[band]);
  }
}

/* One reflex-ball launch. The equipment drawing, the authored pose and the
 * authored action all read the same clock, so the trajectory, the callout and
 * the answer stay in agreement. Alternating shots: even balls come in on the
 * temple line and get slipped, odd balls ride in high and get ducked under. */
/* One heavy-bag rep. The authored puncher and the bag equipment both read
 * this clock, so the flash lands on the frame the glove does and at the height
 * the combo is actually aiming — the old drawing ran the flash off its own
 * slower sine and one fixed spot, so most punches never flashed at all. */
const HEAVY_BAG_CYCLE_MS = 640;
const HEAVY_BAG_COMBO = ["jabHead", "crossHead", "hookBody", "crossHead"] as const;
function heavyBagStrike(time: number) {
  const local = (time % HEAVY_BAG_CYCLE_MS) / HEAVY_BAG_CYCLE_MS;
  const action =
    HEAVY_BAG_COMBO[Math.floor(time / HEAVY_BAG_CYCLE_MS) % HEAVY_BAG_COMBO.length];
  return {
    local,
    extension: Math.sin(Math.PI * local),
    action,
    body: action === "hookBody",
  };
}

/* Shoulder to fist, which is NOT half the reach. A reach measurement spans
 * fingertip to fingertip across both arms and the whole shoulder girdle, so
 * halving it hands the sprite an arm a full half of its own height and the
 * fighter ends up simian. A boxer's arm is a little over a third of him; the
 * reach the sim carries only slides it a few centimetres either side of that,
 * which is exactly how much longer a rangy fighter should actually look. */
function armLength(f: BoutFighter) {
  return f.heightM * clamp(0.352 + (f.reachM / f.heightM - 1) * 0.34, 0.33, 0.4);
}

/* A drill athlete is placed by the frame, not the ring camera: he stands on
 * 0.84 of its height and is drawn 0.56 of it tall, whoever he is. */
interface SoloStance {
  ppm: number;
  groundY: number;
  originX: number;
}

function soloStance(frame: Frame, drill: FightDrill, h: number, time: number): SoloStance {
  const travel = drill === "footwork" ? Math.sin(time / 460) * frame.width * 0.18 : 0;
  return {
    ppm: (frame.height * 0.56) / h,
    groundY: frame.height * 0.84,
    originX: frame.width * (drill === "conditioning" ? 0.42 : 0.46) + travel,
  };
}

/* The punching glove's leading edge in frame pixels, for this much hand
 * travel. Same rig drawFighter builds and the same box drawGlove paints: a
 * glove travelling mostly sideways is stretched half again along its line,
 * and there is the outline on top. */
function soloGloveFront(
  f: BoutFighter,
  v: Visual,
  bulk: number,
  reach: number,
  reachMax: number,
  time: number,
  stance: SoloStance,
) {
  const skel = buildSkeleton(f, v, armLength(f), reach, reachMax, time, bulk);
  const rear = f.punchHand === "rear";
  const glove = rear ? skel.rearGlove : skel.leadGlove;
  const elbow = rear ? skel.rearElbow : skel.leadElbow;
  const r = Math.max(2, stance.ppm * f.heightM * 0.061) * (rear ? 0.96 : 1);
  const sideways = Math.abs(glove.x - elbow.x) / Math.max(0.001, Math.hypot(glove.x - elbow.x, glove.y - elbow.y)) > 0.6;
  const stretch = sideways ? 1 + clamp(f.handVelocity / 9, 0, 1) * 0.5 : 1;
  const half = Math.round(Math.max(2, Math.round(r)) * stretch) + 1;
  return {
    x: Math.round(stance.originX + glove.x * stance.ppm) + half,
    y: stance.groundY - glove.y * stance.ppm,
  };
}

/* Where the heavy bag's leather has to be for the gloves to meet it.
 *
 * The bag used to stand at a fixed share of the frame's WIDTH while the man
 * punching it is sized off its HEIGHT, so the gap between them changed with
 * the stage's shape: a wide desktop stage left every punch short of the bag,
 * a squarer phone one sent the glove 37 px into it. Instead the face goes
 * where the shortest punch of the combo arrives at full extension. */
function heavyBagFace(s: Scene, frame: Frame) {
  const bulk = fighterBulk(s.profiles.blue.weightClass);
  let face = Infinity;
  for (let index = 0; index < HEAVY_BAG_COMBO.length; index += 1) {
    const peak = (index + 0.5) * HEAVY_BAG_CYCLE_MS;
    const v = authoredDrillVisual(s.visuals.blue, "heavy-bag", peak);
    const f = authoredDrillFighter(s.bout.left, "heavy-bag", peak);
    const stance = soloStance(frame, "heavy-bag", f.heightM, peak);
    const reachMax = Math.max(0.12, f.punchExtensionTarget);
    face = Math.min(face, soloGloveFront(f, v, bulk, v.ext, reachMax, peak, stance).x);
  }
  return face;
}

/* This frame's hand travel, and where it puts the glove.
 *
 * Each punch is scaled so its peak lands exactly on the face. Capping the
 * longer ones at the leather instead left the jab, which arrives seven pixels
 * deep, pinned flat to the bag for a third of every rep; scaled, every punch
 * touches for the same instant and comes away, the arm a touch short of
 * lockout, which is how a bag is actually hit. */
function heavyBagGlove(s: Scene, frame: Frame, face: number) {
  const bulk = fighterBulk(s.profiles.blue.weightClass);
  const peak = (Math.floor(s.time / HEAVY_BAG_CYCLE_MS) + 0.5) * HEAVY_BAG_CYCLE_MS;
  const vPeak = authoredDrillVisual(s.visuals.blue, "heavy-bag", peak);
  const fPeak = authoredDrillFighter(s.bout.left, "heavy-bag", peak);
  const reachMax = Math.max(0.12, fPeak.punchExtensionTarget);
  const stancePeak = soloStance(frame, "heavy-bag", fPeak.heightM, peak);
  let low = 0;
  let high = vPeak.ext * 1.5;
  for (let step = 0; step < 10; step += 1) {
    const mid = (low + high) / 2;
    if (soloGloveFront(fPeak, vPeak, bulk, mid, reachMax, peak, stancePeak).x > face) high = mid;
    else low = mid;
  }
  const f = authoredDrillFighter(s.bout.left, "heavy-bag", s.time);
  const v = authoredDrillVisual(s.visuals.blue, "heavy-bag", s.time);
  const reach = vPeak.ext > 0 ? v.ext * (low / vPeak.ext) : v.ext;
  const stance = soloStance(frame, "heavy-bag", f.heightM, s.time);
  return { reach, front: soloGloveFront(f, v, bulk, reach, reachMax, s.time, stance) };
}

const REFLEX_CYCLE_MS = 575;
function reflexShot(time: number) {
  const index = Math.floor(time / REFLEX_CYCLE_MS);
  const cycle = (time % REFLEX_CYCLE_MS) / REFLEX_CYCLE_MS;
  return {
    cycle,
    duck: index % 2 === 1,
    danger: cycle > 0.56 && cycle < 0.86,
  };
}

/* The SLIP / DUCK call, painted after the athlete and clear above him.
 *
 * It used to go down with the equipment at 0.28 of the frame, which is
 * exactly where the top of his head is (he stands on 0.84 and is drawn 0.56
 * tall), so his head and headgear were painted straight over the word. Now
 * its bottom edge sits a few pixels above the crown, two pixels of scale
 * times seven rows of glyph up from there. */
function drawReflexCall(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const { duck, danger } = reflexShot(s.time);
  if (!danger) return;
  const crown = frame.height * (0.84 - 0.56);
  const y = Math.max(2, Math.round(crown - 6 - 7 * 2));
  drawPixelText(ctx, duck ? "DUCK" : "SLIP", frame.width * 0.44, y, 2, "#ffc247", { align: "center", outline: OUTLINE });
}

/* A hanging bag is a cylinder, and a cylinder is six vertical values: a
 * mid-light left flank, the light band just in from that edge, the mid, the
 * turn, a violet core shadow — and then a thin band of reflected light at the
 * far edge, bounced back off the wall. That last band is the whole difference
 * between a tube and a rectangle. The ramp is hue-shifted through it: the lit
 * leather goes orange, the shadow goes toward plum, neither is the same brown
 * at a different brightness. */
const BAG_BANDS: { at: number; width: number; color: string }[] = [
  { at: 0.0, width: 0.16, color: "#6f3826" },
  { at: 0.16, width: 0.2, color: "#8c4a2e" },
  { at: 0.36, width: 0.26, color: "#5a2b21" },
  { at: 0.62, width: 0.19, color: "#3f1f1d" },
  { at: 0.81, width: 0.13, color: "#2b1219" },
  { at: 0.94, width: 0.06, color: "#4a2622" },
];

/* The silhouette steps in 3, then 2, then 1 at both ends: a rolled top and a
 * weighted bottom, and the same run at each end so the curve reads as a curve.
 * Squaring the caps is what made the old bag read as a door. */
const BAG_CAP = [3, 2, 1];

function paintHeavyBag(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  bottom: number,
  halfW: number,
) {
  const slab = (y: number, h: number, inset: number) => {
    if (h <= 0) return;
    const left = Math.round(cx - halfW + inset);
    const width = Math.round((halfW - inset) * 2);
    if (width <= 2) return;
    // Selective outlining: the rim is a dark plum taken off the leather's own
    // shadow, and it is dropped along the top-left where the light lands — a
    // lit pixel there says "edge" better than a black one, and a black keyline
    // all the way round is what makes a sprite look stamped out of card.
    rect(ctx, left - 1, y, width + 2, h, "#1a0a10");
    for (const band of BAG_BANDS) {
      rect(ctx, left + Math.round(band.at * width), y, Math.max(1, Math.round(band.width * width)), h, band.color);
    }
    rect(ctx, left, y, 1, h, "#a45c33");
  };

  const height = bottom - top;
  BAG_CAP.forEach((inset, index) => {
    slab(top + index, 1, inset);
    slab(bottom - 1 - index, 1, inset);
  });
  slab(top + BAG_CAP.length, height - BAG_CAP.length * 2, 0);
  rect(ctx, Math.round(cx - halfW + BAG_CAP[0]), top, Math.round((halfW - BAG_CAP[0]) * 2), 1, "#a45c33");

  // The seam between the light band and the mid is the only place on the bag
  // where two values meet on a long straight edge, so it is the only place
  // that needs breaking up. Two thinning columns of stipple, not a blend.
  const litEdge = Math.round(cx - halfW + BAG_BANDS[2].at * halfW * 2);
  ctx.fillStyle = BAG_BANDS[1].color;
  for (let y = top + 4; y < bottom - 4; y += 2) ctx.fillRect(litEdge, y, 1, 1);
  for (let y = top + 5; y < bottom - 5; y += 4) ctx.fillRect(litEdge + 1, y, 1, 1);

  // Two retaining straps, top and bottom, each taking the light the same way
  // the leather under it does so they wrap the cylinder instead of lying
  // across it as flat tape. Two and not three: evenly spaced bands down a
  // brown cylinder is a barrel, and the third one was turning this into one.
  for (const at of [0.12, 0.87]) {
    const y = Math.round(lerp(top, bottom, at));
    const left = Math.round(cx - halfW);
    const width = halfW * 2;
    rect(ctx, left, y, width, 1, "#26170a");
    rect(ctx, left, y + 1, Math.round(width * 0.42), 1, "#a67f38");
    rect(ctx, left + Math.round(width * 0.42), y + 1, Math.round(width * 0.32), 1, "#77592a");
    rect(ctx, left + Math.round(width * 0.74), y + 1, Math.round(width * 0.26), 1, "#452f16");
  }

  // The panel seam, a single darker line down the leather a third of the way
  // across. It is the one vertical the bag needs: it says the covering is
  // stitched from sheets, and it breaks the light band without costing the
  // cylinder any of its roundness.
  const seamX = Math.round(cx - halfW + halfW * 0.9);
  for (let y = top + 4; y < bottom - 4; y += 1) {
    rect(ctx, seamX, y, 1, 1, y % 6 === 0 ? "#7a4127" : "#3e1f1a");
  }
}

/* The chain and swivel the bag hangs off. Links alternate lit and shadowed
 * down its length, which is all a chain is at this size — a bar of one colour
 * reads as a rod and takes the weight out of the bag under it. */
function paintBagChain(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  const steps = Math.max(1, Math.round(Math.hypot(toX - fromX, toY - fromY) / 3));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = Math.round(lerp(fromX, toX, t));
    const y = Math.round(lerp(fromY, toY, t));
    rect(ctx, x - 1, y, 3, 2, index % 2 ? "#151b1c" : "#3d4749");
  }
  rect(ctx, Math.round(toX) - 2, Math.round(toY) - 1, 5, 4, "#0d1112");
  rect(ctx, Math.round(toX) - 2, Math.round(toY) - 1, 5, 1, "#4a5457");
}

/* The reflex ball. A ball is a sphere and a sphere is concentric discs offset
 * toward the light, with one hard specular pixel and a rim of reflected light
 * on the shadow side — never a square with a smaller square inside it, which
 * is what was here. The outline is a dark red rather than the scene's black:
 * on an object this small, a black keyline eats a quarter of the sprite. */
function paintReflexBall(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  pixelDisc(ctx, cx, cy, r, "#3d1010");
  pixelDisc(ctx, cx, cy, r - 1, "#b23325");
  pixelDisc(ctx, cx - 1, cy - 1, r - 2, "#e04c37");
  pixelDisc(ctx, cx - 1, cy - 2, Math.max(1, r - 3), "#f4794f");
  rect(ctx, cx - 2, cy - 3, 2, 1, "#ffd8ab");
  rect(ctx, cx - 3, cy - 2, 1, 1, "#ffd8ab");
  rect(ctx, cx + r - 2, cy + 1, 1, 2, "#8f4a3a");
}

/* Traffic cones, drawn as cones. The silhouette widens by exactly one pixel
 * every other row, so every step down the edge is the same length: a cone
 * whose runs jump 3, then 1, then 2 reads as a jagged wedge no matter how it
 * is coloured, and a cone stacked out of three rectangles does not read as a
 * cone at all. */
function paintCone(ctx: CanvasRenderingContext2D, cx: number, baseY: number, height: number) {
  for (let row = 0; row < height; row += 1) {
    const y = baseY - height + row;
    const half = Math.floor(row / 2);
    const reflective = row > height * 0.38 && row < height * 0.62;
    rect(ctx, cx - half - 1, y, half * 2 + 3, 1, "#4d1610");
    rect(ctx, cx - half, y, half * 2 + 1, 1, reflective ? "#ded6c4" : "#d94b35");
    rect(ctx, cx - half, y, 1, 1, reflective ? "#f4efe2" : "#ef873e");
    if (half > 0) rect(ctx, cx + half, y, 1, 1, reflective ? "#a49c8c" : "#8f2a1f");
  }
  const half = Math.floor(height / 2);
  rect(ctx, cx - half - 3, baseY, half * 2 + 7, 1, "#4d1610");
  rect(ctx, cx - half - 2, baseY, half * 2 + 5, 1, "#c04030");
  rect(ctx, cx - half - 2, baseY + 1, half * 2 + 5, 1, "#3a1109");
  // Contact shadow, so the cone sits on the boards instead of hovering over
  // them. Dithered rather than solid: it is a shadow, not a mat.
  ditherSeam(ctx, cx - half - 4, baseY + 2, half * 2 + 9, "#121011");
}

function drawGymDrillEquipment(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const floor = Math.round(frame.height * 0.84);

  if (s.drill === "reflex") {
    const { cycle, duck } = reflexShot(s.time);
    // A duck ball rides in high and flat at the brow; a slip ball wobbles in
    // on the temple line. The height IS the read — the fighter answers what
    // the launcher actually threw.
    const ballY = duck
      ? frame.height * 0.33
      : frame.height * (0.44 + Math.sin(s.time / 240) * 0.03);
    const launcherX = Math.round(frame.width * 0.87);
    const muzzleY = Math.round(ballY);
    const muzzleTipX = launcherX - 13;
    const ballX = Math.round(lerp(muzzleTipX, frame.width * 0.38, cycle));

    // The pitching machine: a floor stand, a body on the pivot, and a barrel
    // that tracks the current shot height — every ball leaves the muzzle
    // instead of materialising mid-air. Every part of it is lit from the top
    // left and rimmed in a dark teal off its own ramp, not in black.
    rect(ctx, launcherX - 3, floor - 3, 15, 4, "#0d1112");
    rect(ctx, launcherX - 3, floor - 3, 15, 1, "#3d4749");
    limb(ctx, launcherX + 4, floor - 2, launcherX + 4, muzzleY + 5, 4, "#141b1c");
    limb(ctx, launcherX + 4, floor - 2, launcherX + 4, muzzleY + 5, 2, "#30393b");
    limb(ctx, launcherX + 3, floor - 2, launcherX + 3, muzzleY + 5, 1, "#4d5a5c");

    rect(ctx, launcherX - 1, muzzleY - 6, 11, 12, "#141b1c");
    rect(ctx, launcherX, muzzleY - 5, 9, 10, "#30393b");
    rect(ctx, launcherX, muzzleY - 5, 9, 1, "#5d6b6d");
    rect(ctx, launcherX, muzzleY - 5, 1, 10, "#4a5658");
    rect(ctx, launcherX, muzzleY + 4, 9, 1, "#1b2223");
    // Anti-aliasing the inside corners only. The background here is the gym
    // floor and we know exactly what colour it is, so an in-between pixel is
    // safe; the same pixel on the outside of a sprite whose background is
    // unknown would print a halo the moment anything else went behind it.
    rect(ctx, launcherX - 1, muzzleY - 6, 1, 1, "#232b2c");
    rect(ctx, launcherX + 9, muzzleY - 6, 1, 1, "#232b2c");

    rect(ctx, muzzleTipX, muzzleY - 3, 14, 6, "#141b1c");
    rect(ctx, muzzleTipX + 1, muzzleY - 2, 12, 4, "#4f5d60");
    rect(ctx, muzzleTipX + 1, muzzleY - 2, 12, 1, "#6c7c7f");
    rect(ctx, muzzleTipX + 1, muzzleY + 1, 12, 1, "#2a3335");
    rect(ctx, muzzleTipX, muzzleY - 2, 2, 4, "#0a0d0e");

    // The hopper, with the next two balls waiting their turn.
    rect(ctx, launcherX - 1, muzzleY - 12, 11, 7, "#141b1c");
    rect(ctx, launcherX, muzzleY - 11, 9, 5, "#28312f");
    rect(ctx, launcherX, muzzleY - 11, 9, 1, "#4f5b58");
    pixelDisc(ctx, launcherX + 2, muzzleY - 9, 2, "#e04c37");
    rect(ctx, launcherX + 1, muzzleY - 10, 1, 1, "#f4794f");
    pixelDisc(ctx, launcherX + 6, muzzleY - 9, 2, "#b23325");

    // The trail is dashes of an even, shortening run in a hue-shifted darker
    // red. Alpha fading it made a grey smear; stepping the length keeps it in
    // the palette and still reads as speed.
    for (let index = 1; index < 4; index += 1) {
      const streak = 5 - index;
      rect(ctx, ballX + 4 + index * 6, Math.round(ballY) + index - 1, streak, 1, index > 2 ? "#5c1c18" : "#8f2a1f");
    }
    paintReflexBall(ctx, ballX, Math.round(ballY), 4);
  }

  if (s.drill === "heavy-bag") {
    const { local } = heavyBagStrike(s.time);
    const face = heavyBagFace(s, frame);
    // Sized off the frame's height like the man hitting it, about 0.6 m
    // across against a 1.8 m fighter, so the pair keep their proportions on
    // any stage.
    const halfW = Math.max(6, Math.round(frame.height * 0.093));
    const rest = face + halfW;
    // The bag moves because it was hit, not before: still while the glove
    // travels, driven off the leather from contact, back by the next punch.
    // Swinging with the punch's own extension had it backing away from the
    // glove the whole way in.
    const swing = local > 0.5 ? Math.round(Math.sin((local - 0.5) * 2 * Math.PI) * halfW * 0.3) : 0;
    const bagX = rest + Math.max(0, swing);
    const bagTop = Math.round(frame.height * 0.28);
    const bagBottom = floor - 3;

    // The pool the bag hangs over, dithered rather than solid: a hard black
    // ellipse under a swinging bag reads as a hole, and without anything down
    // there at all the bag floats a foot off its own floor.
    ditherSeam(ctx, bagX - halfW - 2, bagBottom + 1, halfW * 2 + 4, "#0e0c0d");
    rect(ctx, bagX - halfW + 2, bagBottom, halfW * 2 - 4, 1, "#141112");

    paintBagChain(ctx, rest, 0, bagX, bagTop - 1);
    paintHeavyBag(ctx, bagX, bagTop, bagBottom, halfW);

    // Lit only while the glove is actually on the leather, at the height the
    // glove itself is at, so the flash can never sit in front of a short fist.
    const glove = heavyBagGlove(s, frame, face).front;
    if (glove.x >= face - 1) {
      const impactX = bagX - halfW;
      const impactY = Math.round(glove.y);

      // The leather folds in where the glove is. Three rows stepping 2, 3, 2
      // pixels deep, lit along the fold, which is what sells a hit far better
      // than any amount of spark.
      for (let row = -2; row <= 2; row += 1) {
        const depth = 3 - Math.abs(row);
        rect(ctx, impactX, impactY + row, depth + 2, 1, "#2b1219");
        rect(ctx, impactX + depth, impactY + row, 3, 1, "#a45c33");
      }

      // A stepped starburst instead of eight rays swept at arbitrary angles.
      // Arbitrary angles are a jaggy generator: each ray rounds differently
      // and the star comes out lopsided. Four axes and four diagonals, every
      // run the same length, is both cleaner and more readable.
      pixelDisc(ctx, impactX, impactY, 3, "#fff3cf");
      pixelDisc(ctx, impactX, impactY, 5, "#ffc247");
      pixelDisc(ctx, impactX, impactY, 3, "#ffffff");
      for (let step = 3; step < 11; step += 1) {
        const color = step < 6 ? "#fff3cf" : step < 9 ? "#ffc247" : "#e08a2a";
        rect(ctx, impactX - step, impactY, 1, 1, color);
        rect(ctx, impactX + step, impactY, 1, 1, color);
        rect(ctx, impactX, impactY - step, 1, 1, color);
        rect(ctx, impactX, impactY + step, 1, 1, color);
        const diag = Math.round(step * 0.7);
        rect(ctx, impactX - diag, impactY - diag, 1, 1, color);
        rect(ctx, impactX + diag, impactY - diag, 1, 1, color);
        rect(ctx, impactX - diag, impactY + diag, 1, 1, color);
        rect(ctx, impactX + diag, impactY + diag, 1, 1, color);
      }
    }
  }

  if (s.drill === "conditioning") {
    // The mat has thickness: a top face that recedes through three values, a
    // front edge in a colder blue, a lit near lip, and worn patches dithered
    // into the middle where every set has been done. A flat slab of one blue
    // was reading as a hole cut in the floor, and a three-pixel one was not
    // reading as anything at all.
    const left = Math.round(frame.width * 0.15);
    const width = Math.round(frame.width * 0.7);
    rect(ctx, left - 2, floor - 9, width + 4, 14, "#0b1418");
    rect(ctx, left, floor - 8, width, 3, "#22485a");
    rect(ctx, left, floor - 8, width, 1, "#2e6076");
    rect(ctx, left, floor - 5, width, 3, "#2a5a70");
    rect(ctx, left, floor - 2, width, 2, "#357089");
    rect(ctx, left, floor, width, 1, "#1d4457");
    rect(ctx, left, floor + 1, width, 2, "#15303e");
    rect(ctx, left, floor + 3, width, 1, "#0d1e28");
    ditherSeam(ctx, left, floor - 6, width, "#2e6076");
    ditherSeam(ctx, left + Math.round(width * 0.3), floor - 4, Math.round(width * 0.4), "#3f7d96");

    const reps = Math.floor(s.time / 720) % 12 + 1;
    drawPixelText(ctx, String(reps).padStart(2, "0"), frame.width * 0.82, frame.height * 0.46, 3, "#ffc247", { align: "center", outline: OUTLINE });
    drawPixelText(ctx, "CLEAN REPS", frame.width * 0.82, frame.height * 0.58, 1, "#9dacb8", { align: "center", outline: OUTLINE });
  }

  if (s.drill === "footwork") {
    // The ladder lies on the boards and goes away from the camera, so the
    // rails converge and the rungs both widen and space out as they come
    // forward. Drawn flat and evenly, it read as a fence lying on its side.
    // It runs from behind the athlete up to his own ground line rather than
    // on past it: the lower third covers the last eighth of the frame, and
    // everything drawn down there is art nobody ever sees.
    const nearHalf = Math.round(frame.width * 0.32);
    const farHalf = Math.round(frame.width * 0.19);
    const nearY = floor + 3;
    const farY = Math.round(frame.height * 0.72);
    const centerX = Math.round(frame.width * 0.5);

    pixelRay(ctx, centerX - farHalf, farY, centerX - nearHalf, nearY, "#8a6d24");
    pixelRay(ctx, centerX + farHalf, farY, centerX + nearHalf, nearY, "#8a6d24");
    pixelRay(ctx, centerX - farHalf, farY - 1, centerX - nearHalf, nearY - 1, "#d0a843");
    pixelRay(ctx, centerX + farHalf, farY - 1, centerX + nearHalf, nearY - 1, "#d0a843");

    for (let index = 0; index <= 6; index += 1) {
      const t = (index / 6) ** 1.6;
      const y = Math.round(lerp(farY, nearY, t));
      const half = Math.round(lerp(farHalf, nearHalf, t));
      rect(ctx, centerX - half, y, half * 2, 1, "#d0a843");
      rect(ctx, centerX - half, y + 1, half * 2, 1, "#7a5f1f");
    }

    paintCone(ctx, Math.round(frame.width * 0.12), floor + 2, 14);
    paintCone(ctx, Math.round(frame.width * 0.88), floor + 2, 14);
  }
}

/* -------------------------------------------------------------------- city */

/* Night sky: deep navy overhead, warming to plum where the city glow reaches
 * it. The towers are drawn LIT rather than as silhouettes, so the sky has to be
 * the middle value they sit against — but the whole ramp stays cool and dark,
 * which is what this arena has always looked like. */
const SKY_BANDS = ["#0a0817", "#120f22", "#1a1533", "#241a3f", "#33224c", "#4a2c55"];

/* Everything behind the ring is built from stable value noise keyed on a
 * building's INDEX, never on where it currently sits on screen — so a tower
 * keeps its own shape and its own lit windows as the skyline slides past
 * instead of flickering through a new random silhouette every frame. */

// Each layer scrolls with the camera at its own rate AND creeps sideways on its
// own, so the city is alive even when the fighters hold the centre of the ring.
const CITY_DRIFT = 0.0022;

function cityScroll(frame: Frame, time: number, parallax: number) {
  return -frame.center * frame.ppm * parallax - time * CITY_DRIFT * parallax * 14;
}

/* --------------------------------------------------------- backdrop cache */

/* The city was being repainted from scratch sixty times a second — a couple of
 * thousand single-pixel fills for the sky dither, the tower windows and the
 * crowd, none of which had changed since the frame before. Everything static
 * or animated on a slow shared clock is baked into offscreen canvases here and
 * copied per frame; the genuinely live layers — billboards, blimp, stars,
 * phone flashes, and everything inside the ropes — never come near this.
 *
 * Two ideas carry the whole thing. Horizontally, a strip is painted wider than
 * the frame at an anchor scroll and slid until the viewport nears its padding.
 * Vertically, every layer is painted against the PAN-ZERO street line: the
 * camera pan moves streetY, but every band, tower and head moves with it
 * rigidly, so panning translates the copy instead of invalidating it. */
const STRIP_PAD = 96;
/** The tower warning lights all flip exactly when floor(time / 700) ticks over
 *  — the per-building offset is an integer, so it only sets parity — which
 *  makes this rebake cadence reproduce every blink on time. The slow window
 *  flicker rides the same rebake and lands at worst 0.7 s late on its 33 s
 *  cycle, which nobody has ever watched closely enough to see. */
const RIDGE_BAKE_MS = 700;
/** The crowd's shared sway clock: floor(time / 420 + index / 2) only changes
 *  when time crosses a multiple of 210 ms, so the whole head pattern is
 *  constant between those boundaries and rebaking on them replays the sway
 *  exactly — the people keep jumping, from a strip. */
const CROWD_BAKE_MS = 210;

interface BackdropStrip {
  canvas: HTMLCanvasElement;
  /** The rounded scroll this strip was anchored at; it is drawn offset by the
   *  difference until the viewport drifts within reach of the padding. */
  scroll: number;
  tick: number;
}

interface CityBackdrop {
  /** `${width}x${height}` — a resize drops every layer at once. */
  key: string;
  sky: HTMLCanvasElement | null;
  haze: HTMLCanvasElement | null;
  ridges: (BackdropStrip | null)[];
  heads: BackdropStrip | null;
  /** Stars only change on the slow twinkle clock, so keep their pixels out of
   *  the live city pass between ticks. */
  stars: { canvas: HTMLCanvasElement; tick: number } | null;
  /** The roof deck speckle moves slowly with the city, but the camera can slide
   *  it vertically without requiring another bake. */
  deck: { canvas: HTMLCanvasElement; top: number; tick: number } | null;
  /** The ring is static in world space; rebuild only when the quantized camera
   *  projection changes, then let the fighters move over the finished canvas. */
  ring: { canvas: HTMLCanvasElement; key: string } | null;
  /** One little sprite per cloud index; null records a failed bake so it is
   *  not retried every frame. */
  clouds: Map<number, { canvas: HTMLCanvasElement; originX: number } | null>;
}

function createCityBackdrop(): CityBackdrop {
  return {
    key: "",
    sky: null,
    haze: null,
    ridges: [null, null],
    heads: null,
    stars: null,
    deck: null,
    ring: null,
    clouds: new Map(),
  };
}

function bakeCanvas(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement | null {
  // Guarded rather than assumed: anywhere a 2D context cannot be had, the
  // caller paints live, exactly as this file always did.
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  paint(ctx);
  return canvas;
}

/** The vertical padding every baked layer carries: how far the camera pan can
 *  carry the street line off its rest position (the pan clamps to ±20% of the
 *  height), so a pan slides the copy instead of exposing its edge. */
function bakeMargin(height: number) {
  return Math.ceil(height * 0.22) + 2;
}

/** The street line with the camera pan at zero — the fixed line the bakes are
 *  painted against. Mirrors the live computation in drawCity exactly. */
function referenceStreetY(height: number) {
  return Math.round(Math.round(height * HORIZON_FRACTION) - height * 0.055);
}

function drawCity(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const { width, height } = frame;
  const pan = s.camera.panY;
  // The line the city stands on: the ring's far edge, minus the strip of crowd
  // between the front row and the apron.
  const streetY = Math.round(frame.horizon - height * 0.055);

  const cache = s.backdrop;
  const sizeKey = `${width}x${height}`;
  if (cache.key !== sizeKey) {
    cache.key = sizeKey;
    cache.sky = null;
    cache.haze = null;
    cache.ridges = [null, null];
    cache.heads = null;
    cache.stars = null;
    cache.deck = null;
    cache.ring = null;
    cache.clouds.clear();
  }
  const margin = bakeMargin(height);
  const streetY0 = referenceStreetY(height);

  // Sky in flat bands with a dithered seam between each — the cheapest way to
  // get a gradient that still reads as pixel art. Static per size, so it is
  // painted once and copied; the seam dither alone was over a thousand
  // single-pixel fills a frame. The margins extend the top band and the
  // below-street fill so a panned blit never exposes an edge.
  if (!cache.sky) {
    cache.sky = bakeCanvas(width, height + margin * 2, (sky) => {
      rect(sky, 0, 0, width, margin, SKY_BANDS[0]);
      sky.translate(0, margin);
      paintSky(sky, width, height, streetY0);
      rect(sky, 0, height, width, margin, "#0a0814");
    });
  }
  if (cache.sky) ctx.drawImage(cache.sky, 0, streetY - streetY0 - margin);
  else paintSky(ctx, width, height, streetY);

  const starTick = Math.floor(s.time / CROWD_BAKE_MS);
  if (!cache.stars || cache.stars.tick !== starTick) {
    const baked = bakeCanvas(width, height, (stars) => paintStars(stars, width, streetY, s.time, frame));
    cache.stars = baked ? { canvas: baked, tick: starTick } : null;
  }
  if (cache.stars) ctx.drawImage(cache.stars.canvas, 0, 0);
  else paintStars(ctx, width, streetY, s.time, frame);
  drawClouds(ctx, s, frame, streetY);
  // The moon takes the camera parallax but NOT the drift. It is a single object
  // rather than a tiled layer, so an unbounded drift would walk it off the side
  // of the world and never bring it back.
  drawMoon(
    ctx,
    Math.round(width * 0.78 - frame.center * frame.ppm * 0.03),
    Math.round(streetY * 0.24 + pan * 0.05),
  );
  drawBlimp(ctx, s, frame, streetY);

  // A low warm haze at the very base of the city, where the streets are. Kept
  // shallow now the sky itself carries colour — banked up over the rooftops it
  // would only wash out the tower faces standing in front of it.
  const domeH = Math.max(4, Math.round(height * 0.07));
  if (!cache.haze) {
    cache.haze = bakeCanvas(width, domeH, (haze) => paintHaze(haze, width, domeH));
  }
  if (cache.haze) ctx.drawImage(cache.haze, 0, streetY - domeH);
  else paintHaze(ctx, width, domeH, streetY - domeH);

  /* Two ridges, and they stand TALL — the near one climbing to a third of the
   * frame with crowns and masts over that.
   *
   * The ring is on a mid-rise roof in the middle of a city, not on a lookout
   * above one. Cropping the towers down to a ridge along the parapet put the
   * whole skyline below eye level, which reads as a distant town seen from a
   * mountain; letting them rise past us on both sides is what puts the fight
   * IN the city. The billboards are painted after this, so height here costs
   * the ad inventory nothing. */
  // Each ridge is a baked strip anchored at a scroll and slid until the
  // viewport nears its padding; the rebake cadence is the warning-light clock,
  // so the blinks land on time — see RIDGE_BAKE_MS. The strip is painted
  // against the pan-zero baseline and blitted at the live one.
  const ridgeTick = Math.floor(s.time / RIDGE_BAKE_MS);
  const ridge = (slot: number, band: SkylineBand, liveBaseY: number) => {
    const scroll = Math.round(cityScroll(frame, s.time, band.parallax));
    let strip = cache.ridges[slot];
    if (!strip || strip.tick !== ridgeTick || Math.abs(scroll - strip.scroll) > STRIP_PAD) {
      const baked = bakeCanvas(width + STRIP_PAD * 2, height + margin * 2, (b) => {
        b.translate(0, margin);
        paintSkylineBand(b, s.time, width + STRIP_PAD * 2, scroll - STRIP_PAD, band);
      });
      strip = baked ? { canvas: baked, scroll, tick: ridgeTick } : null;
      cache.ridges[slot] = strip;
    }
    if (strip) {
      ctx.drawImage(strip.canvas, strip.scroll - STRIP_PAD - scroll, liveBaseY - band.baseY - margin);
    } else {
      paintSkylineBand(ctx, s.time, width, scroll, { ...band, baseY: liveBaseY });
    }
  };
  ridge(0, {
    baseY: streetY0 + 2,
    parallax: 0.1,
    pitch: 17,
    minW: 10,
    varW: 9,
    minH: Math.round(height * 0.1),
    varH: Math.round(height * 0.14),
    body: "#4c4585",
    side: "#2b2653",
    bodyAlt: "#3d3770",
    sideAlt: "#221e42",
    edge: "#6d64a8",
    windows: "#8279c4",
    windowChance: 0.2,
    salt: 11,
  }, streetY + 2 + Math.round(pan * 0.16));
  ridge(1, {
    baseY: streetY0 + 4,
    parallax: 0.24,
    pitch: 29,
    minW: 17,
    varW: 18,
    minH: Math.round(height * 0.13),
    varH: Math.round(height * 0.2),
    body: "#37306b",
    side: "#150f2c",
    bodyAlt: "#282253",
    sideAlt: "#0c0819",
    edge: "#544c92",
    windows: "#ffd98a",
    windowChance: 0.3,
    salt: 37,
  }, streetY + 4 + Math.round(pan * 0.3));

  // Boards LAST, so nothing in the city can grow in front of them. Drawn
  // between the ridges they spent half their life behind whichever tower
  // happened to scroll past, which is a strange fate for the ad inventory.
  drawBillboards(ctx, s, frame, streetY + Math.round(pan * 0.3));

  drawStreetCrowd(ctx, s, frame, streetY);
}

/** The gradient bands and the fill below the street line — the static bulk of
 *  the sky, extracted so the bake and the no-canvas fallback paint the exact
 *  same pixels. */
function paintSky(ctx: CanvasRenderingContext2D, width: number, height: number, streetY: number) {
  const bandHeight = Math.max(1, Math.ceil(streetY / SKY_BANDS.length));
  SKY_BANDS.forEach((color, index) => {
    rect(ctx, 0, index * bandHeight, width, bandHeight, color);
    if (index > 0) {
      ctx.fillStyle = SKY_BANDS[index - 1];
      const seamY = index * bandHeight;
      for (let row = 0; row < 3; row += 1) {
        for (let x = (row % 2) * 2; x < width; x += 4 - row) {
          ctx.fillRect(x, seamY + row, 1, 1);
        }
      }
    }
  });
  if (streetY < height) rect(ctx, 0, streetY, width, height - streetY, "#0a0814");
}

/** The warm street-glow band with its dithered upper edge, painted at `atY` —
 *  zero in the bake, the live dome top in the fallback. */
function paintHaze(ctx: CanvasRenderingContext2D, width: number, domeH: number, atY = 0) {
  rect(ctx, 0, atY, width, domeH, "#5b3059");
  ctx.fillStyle = SKY_BANDS[SKY_BANDS.length - 1];
  for (let row = 0; row < 3; row += 1) {
    for (let x = (row % 2) * 2; x < width; x += 4 - row) ctx.fillRect(x, atY + row, 1, 1);
  }
}

function paintStars(
  ctx: CanvasRenderingContext2D,
  width: number,
  streetY: number,
  time: number,
  frame: Frame,
) {
  const scroll = cityScroll(frame, time, 0.02);
  const cell = 9;
  // Carried further down the frame and packed a little tighter now the sky
  // above the skyline is properly dark: on the old washed-out backdrop stars
  // had nothing to show up against and the night looked empty either way.
  const rows = Math.max(1, Math.floor((streetY * 0.72) / cell));
  for (let r = 0; r < rows; r += 1) {
    for (let c = -1; c < Math.ceil(frame.width / cell) + 2; c += 1) {
      const worldCol = Math.floor(c - scroll / cell);
      const n = hash2(worldCol, r * 313);
      if (n < 0.83) continue;
      // Slow twinkle on a per-star phase, so the sky shimmers rather than blinks.
      const phase = Math.sin(time / 900 + n * 40);
      if (phase < -0.3) continue;
      const x = Math.round(c * cell + (scroll % cell));
      const y = r * cell + Math.round(n * 6);
      rect(ctx, x, y, 1, 1, phase > 0.7 ? "#ffffff" : "#b9b2e0");
    }
  }
}

/* Cloud banks over the city: lumpy masses DARKER than the sky, with a moonlit
 * lip along the top. Shape comes from stable per-cloud, per-row noise, so a
 * bank keeps its own outline as the sky drifts instead of boiling.
 *
 * They are what stops the upper frame being an empty wash. A clear sky over a
 * city reads as a title screen; an overcast one reads as a night somebody is
 * fighting through, and it gives the tower crowns something to bite into. */
function drawClouds(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame, streetY: number) {
  const scroll = Math.round(cityScroll(frame, s.time, 0.05));
  const pitch = 62;
  const first = Math.floor(scroll / pitch) - 1;
  const span = Math.ceil(frame.width / pitch) + 3;
  // Kept to the upper sky. Lower down the sky warms toward the city glow and a
  // cloud there has nothing to be a different value from.
  const ceiling = Math.max(6, Math.round(streetY * 0.5));

  for (let n = 0; n < span; n += 1) {
    const index = first + n;
    if (hash2(index, 811) < 0.12) continue;
    const cx = index * pitch - scroll + Math.floor(hash2(index, 812) * 26);
    const w = 40 + Math.floor(hash2(index, 813) * 52);
    const rows = 5 + Math.floor(hash2(index, 814) * 4);
    const base = 3 + Math.floor(hash2(index, 815) * ceiling);
    if (cx + w < -6 || cx - w > frame.width + 6) continue;

    // A bank's shape is fixed by its index, so it is painted once into a
    // little sprite and copied at its drifting position from then on. Only
    // the position reads the ceiling — the shape never did.
    let sprite = s.backdrop.clouds.get(index);
    if (sprite === undefined) {
      // The drift runs one way forever; banks that scrolled off are never
      // coming back, so the shelf is simply emptied when it fills.
      if (s.backdrop.clouds.size > 48) s.backdrop.clouds.clear();
      const originX = (w >> 1) + 2;
      const baked = bakeCanvas(w + 4, rows, (b) => paintCloudRows(b, index, w, rows, originX, 0));
      sprite = baked ? { canvas: baked, originX } : null;
      s.backdrop.clouds.set(index, sprite);
    }
    if (sprite) ctx.drawImage(sprite.canvas, cx - sprite.originX, base);
    else paintCloudRows(ctx, index, w, rows, cx, base);
  }
}

/** The lumpy rows of one cloud bank, drawn about (atX, atY). `atX` must be an
 *  integer for the sprite and the live path to round identically — and it is:
 *  the live cx is built from rounded scroll and floored jitter.
 *
 *  The old per-row clip against the street line is gone rather than moved: the
 *  band tops out around half the street line plus a few rows, so it could
 *  never fire on any frame tall enough to hold a fight. */
function paintCloudRows(
  ctx: CanvasRenderingContext2D,
  index: number,
  w: number,
  rows: number,
  atX: number,
  atY: number,
) {
  for (let r = 0; r < rows; r += 1) {
    const y = atY + rows - 1 - r;
    // Narrowing toward the top, with each edge jittered on its own so the
    // mass comes out lopsided the way weather is.
    const shrink = (r / rows) ** 1.5;
    const half = (w / 2) * (1 - shrink * 0.82);
    const lj = Math.floor(hash2(index * 31 + r, 816) * 8);
    const rj = Math.floor(hash2(index * 31 + r, 817) * 8);
    const left = atX + Math.round(lj - half);
    const wide = Math.round(half * 2 - lj - rj);
    if (wide < 2) continue;
    /* Moonlit, so LIGHTER than the sky rather than darker. Overcast cloud
     * really is the darker mass, but this sky runs black at the top and only
     * warms up at the city glow — a dark cloud in the top half of it is a
     * dark shape on a dark shape, and the whole bank disappeared. */
    rect(ctx, left, y, wide, 1, r === rows - 1 ? "#584f96" : "#2e2758");
  }
}

/* The moon never changes — only where it hangs. Baked once for the whole
 * session, module-wide: every canvas shares the same moon. */
let moonSprite: HTMLCanvasElement | null | undefined;

function drawMoon(ctx: CanvasRenderingContext2D, x: number, y: number) {
  if (moonSprite === undefined) moonSprite = bakeCanvas(22, 11, (b) => paintMoon(b, 11, 5));
  if (moonSprite) ctx.drawImage(moonSprite, x - 11, y - 5);
  else paintMoon(ctx, x, y);
}

function paintMoon(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // Stepped like a hand-drawn pixel circle rather than a hard octagon, so it
  // reads as a moon hanging over the city and not a floating box.
  const rows = [3, 6, 8, 9, 10, 10, 10, 9, 8, 6, 3];
  rows.forEach((half, index) => {
    rect(ctx, x - half, y - 5 + index, half * 2, 1, index < 4 ? "#efe3bb" : "#e4d5a6");
  });
  rect(ctx, x - 5, y - 4, 7, 5, "#f7eecb");
  rect(ctx, x - 1, y + 2, 4, 3, "#d6c599");
}

/* An airship on a slow crossing, hauling a lit banner. It is the one thing on
 * screen that moves independently of the camera, which is what stops the
 * skyline reading as painted scenery. */
function drawBlimp(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame, streetY: number) {
  // Its own crossing IS the movement, so it takes the camera parallax but not
  // the city drift — adding an unbounded offset to a value that has to wrap
  // would sail it out of the world on the first long session.
  const span = frame.width + 120;
  const x = Math.round(((s.time * 0.012) % span) - 60 - frame.center * frame.ppm * 0.05);
  const y = Math.round(streetY * 0.3 + Math.sin(s.time / 2600) * 4 + s.camera.panY * 0.08);
  if (x < -70 || x > frame.width + 70) return;

  const hullW = 17;
  const hullH = 6;
  // Lit from below by the city, so the envelope is PALER than the night behind
  // it. Drawn in near-black it vanished into the sky and left its banner
  // hanging in mid-air, reading as a caption someone forgot to delete.
  for (let i = 0; i < hullH; i += 1) {
    // Taper both ends so the hull reads as a rounded envelope.
    const inset = Math.round(Math.abs(i - (hullH - 1) / 2) * 2.4);
    rect(ctx, x - hullW + inset, y - hullH / 2 + i, hullW * 2 - inset * 2, 1, i < 2 ? "#6f68a4" : "#443c74");
  }
  rect(ctx, x - 3, y + hullH / 2, 7, 2, "#2a2450");
  // Tail fin and a red beacon on the nose.
  rect(ctx, x + hullW - 3, y - 4, 3, 4, "#443c74");
  if (Math.floor(s.time / 620) % 2 === 0) rect(ctx, x - hullW - 1, y, 2, 1, "#ff5545");

  // The banner it tows, on its own lit panel slung under the envelope: the
  // cheapest premium ad slot in the building, and it needs a board behind it
  // or the lettering reads as part of the HUD rather than part of the sky.
  const label = "FORGE LEAGUE";
  const bw = textWidth(label, 1) + 4;
  const by = y + hullH / 2 + 3;
  rect(ctx, x - bw / 2 - 1, by - 1, bw + 2, 9, "#07060d");
  rect(ctx, x - bw / 2, by, bw, 7, "#241a3f");
  rect(ctx, x - bw / 2, by, bw, 1, "#ffd75e");
  drawPixelText(ctx, label, x, by + 1, 1, "#ffd75e", { align: "center" });
}

interface SkylineBand {
  baseY: number;
  parallax: number;
  pitch: number;
  minW: number;
  varW: number;
  minH: number;
  varH: number;
  /** The lit face, turned toward us and the moon. */
  body: string;
  /** The face turned away: one hard step darker, never a blend. */
  side: string;
  /** A second, darker pair. Roughly half the towers take it, so the ridge is a
   *  city of buildings rather than one building repeated at random widths. */
  bodyAlt: string;
  sideAlt: string;
  /** Roof lip and mast — a step lighter again. */
  edge: string;
  windows: string;
  windowChance: number;
  salt: number;
}

/** One ridge of towers at an explicit scroll — no Scene, no Frame, so the
 *  strip bake and the live fallback are the same code with different targets.
 *  `time` still matters: the warning-light blink and the slow window flicker
 *  read it, which is exactly why the strip cache rebakes on the blink clock. */
function paintSkylineBand(
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  scroll: number,
  rawBand: SkylineBand,
) {
  const first = Math.floor(scroll / rawBand.pitch) - 2;
  const span = Math.ceil(width / rawBand.pitch) + 4;

  for (let n = 0; n < span; n += 1) {
    const index = first + n;
    // Half the towers take the darker pair of faces. Keyed on the building's
    // own index like everything else here, so a given tower keeps its colour
    // as the ridge scrolls rather than flickering between the two.
    const dark = hash2(index, rawBand.salt + 9) > 0.5;
    const band = dark
      ? { ...rawBand, body: rawBand.bodyAlt, side: rawBand.sideAlt }
      : rawBand;
    const w = band.minW + Math.floor(hash2(index, band.salt) * band.varW);
    const h = band.minH + Math.floor(hash2(index, band.salt + 1) * band.varH);
    const x = index * band.pitch - scroll;
    if (x > width + 4 || x + w < -4) continue;
    const top = band.baseY - h;

    /* Two faces, never one. A tower painted as a single flat rectangle is a
     * hole in the sky with windows on it; the moment the far face is stepped
     * one shade down the same rectangle becomes a box with a corner, and the
     * whole ridge acquires depth for the cost of one extra fill per building. */
    const sideW = Math.max(2, Math.round(w * 0.3));
    rect(ctx, x, top, w, band.baseY - top + 4, band.body);
    rect(ctx, x + w - sideW, top, sideW, band.baseY - top + 4, band.side);
    // The roof lip, catching the sky.
    rect(ctx, x, top, w, 1, band.edge);

    // Crown: two stepped setbacks and a mast, on the taller towers only. This
    // is the whole difference between a row of boxes and a skyline.
    let crownY = top;
    if (h > band.minH + band.varH * 0.55) {
      const stepA = Math.max(3, Math.round(w * 0.6));
      const stepAH = Math.max(2, Math.round(h * 0.1));
      const ax = x + Math.round((w - stepA) / 2);
      rect(ctx, ax, top - stepAH, stepA, stepAH, band.body);
      rect(ctx, ax + stepA - Math.max(1, Math.round(stepA * 0.3)), top - stepAH, Math.max(1, Math.round(stepA * 0.3)), stepAH, band.side);
      rect(ctx, ax, top - stepAH, stepA, 1, band.edge);
      crownY = top - stepAH;

      const stepB = Math.max(2, Math.round(w * 0.3));
      const stepBH = Math.max(2, Math.round(h * 0.08));
      const bx = x + Math.round((w - stepB) / 2);
      rect(ctx, bx, crownY - stepBH, stepB, stepBH, band.body);
      rect(ctx, bx, crownY - stepBH, stepB, 1, band.edge);
      crownY -= stepBH;

      const mastH = Math.max(3, Math.round(h * 0.15));
      const mx = x + Math.floor(w / 2);
      rect(ctx, mx, crownY - mastH, 1, mastH, band.edge);
      // Aircraft warning lights, each on its own blink phase.
      if (Math.floor(time / 700 + index) % 2 === 0) {
        rect(ctx, mx, crownY - mastH - 1, 1, 1, "#ff4436");
      }
    }

    // Windows on a loose grid, on the lit face. Packed tighter than this every
    // tower turns into the same rectangle of speckle, the silhouettes stop
    // being buildings, and the skyline reads as television static.
    for (let row = 0, wy = top + 4; wy < band.baseY - 3; wy += 6, row += 1) {
      for (let col = 0, wx = x + 3; wx < x + w - sideW - 2; wx += 5, col += 1) {
        const lit = hash2(index * 131 + row * 17 + col, band.salt + 2);
        if (lit > band.windowChance) continue;
        // Offices go dark and come back on a very slow per-window clock, so the
        // city keeps changing without anything strobing.
        if (Math.sin(time / 5200 + lit * 90) < -0.72) continue;
        rect(ctx, wx, wy, 2, 2, band.windows);
      }
      // A couple carried round onto the shadowed face, dimmed. Without them the
      // dark side reads as a painted flat rather than as a wall in shadow.
      const sideLit = hash2(index * 977 + row, band.salt + 5);
      if (sideLit < band.windowChance * 0.55 && sideW >= 3) {
        rect(ctx, x + w - sideW + 1, wy, 2, 2, band.edge);
      }
    }
  }
}

/* The hoardings. Boards are pinned to a fixed pitch along the city, so slot 3
 * is always the same rooftop in the same place. Active ads rotate through each
 * physical slot on a shared clock, so a board keeps one selected option for its
 * whole trip across the frame before the next rotation. */
interface BillboardPlacement {
  ad: AdFace;
  x: number;
  top: number;
  width: number;
  height: number;
}

function billboardPlacement(
  ads: AdBoard[],
  index: number,
  scroll: number,
  frame: Frame,
  baseY: number,
  time: number,
): BillboardPlacement | null {
  const board = ads[((index % ads.length) + ads.length) % ads.length];
  const options = board.options?.length ? board.options : [board];
  const rotation = options.length > 1 ? Math.floor(time / AD_ROTATION_MS) % options.length : 0;
  const ad = options[rotation];
  const boardArt = board.image ? null : board.art ? AD_ART[board.art] : null;
  const boardHeadline = board.headline.toUpperCase();
  const boardSub = (board.sub ?? "").toUpperCase();
  // Geometry belongs to the physical board's primary face, so adding optional
  // faces never makes the gantry resize or vanish during a rotation.
  const width = board.image
    ? AD_SLOT.width
    : boardArt ? boardArt.width : Math.max(textWidth(boardHeadline, 1), textWidth(boardSub, 1)) + 8;
  const x = index * 206 - scroll;
  if (x > frame.width + width || x + width < -4) return null;

  const height = board.image ? AD_SLOT.height : boardArt ? boardArt.height : boardSub ? 20 : 13;
  const lift = Math.round(frame.height * (0.15 + hash2(index, 909) * 0.11));
  const top = clamp(baseY - lift - height, frame.height * 0.14, baseY - height - 3);
  return { ad, x, top, width, height };
}

function findBillboard(
  ads: AdBoard[],
  frame: Frame,
  baseY: number,
  time: number,
  x: number,
  y: number,
) {
  if (!ads.length) return null;
  const pitch = 206;
  const scroll = Math.round(cityScroll(frame, time, 0.28));
  const first = Math.floor(scroll / pitch) - 1;
  const span = Math.ceil(frame.width / pitch) + 3;

  for (let n = 0; n < span; n += 1) {
    const placement = billboardPlacement(ads, first + n, scroll, frame, baseY, time);
    if (!placement?.ad.href) continue;
    if (
      x >= placement.x - 1 &&
      x <= placement.x + placement.width + 1 &&
      y >= placement.top - 1 &&
      y <= placement.top + placement.height + 1
    ) {
      return placement.ad;
    }
  }
  return null;
}

function drawBillboards(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame, baseY: number) {
  const ads = s.ads;
  if (!ads.length) return;
  const parallax = 0.28;
  const scroll = Math.round(cityScroll(frame, s.time, parallax));
  // Spaced well apart. Boards are the loudest thing in the backdrop, and packed
  // any tighter they stop reading as a skyline and start reading as a wall of
  // advertising the fight happens to be in front of. The pitch leaves room for
  // the widest authored face with sky to spare, so two physical boards never touch.
  const pitch = 206;
  const first = Math.floor(scroll / pitch) - 1;
  const span = Math.ceil(frame.width / pitch) + 3;

  for (let n = 0; n < span; n += 1) {
    const index = first + n;
    const placement = billboardPlacement(ads, index, scroll, frame, baseY, s.time);
    if (!placement) continue;
    const { ad, x, top, width: inner, height: boardH } = placement;
    const art = ad.image ? null : ad.art ? AD_ART[ad.art] : null;
    const headline = ad.headline.toUpperCase();
    const sub = (ad.sub ?? "").toUpperCase();
    /* Flown in the clear band of sky between the telemetry strip at the top of
     * frame and the roofline of the city below. These are the only surfaces in
     * the scene anyone is paying for, so they get the one piece of the frame
     * that nothing else is allowed to occupy — hung any higher they go behind
     * the HUD, any lower and the skyline grows over them. A painted board is
     * two and a half times the height of a text one, so the bottom of the band
     * is pinned to the roofline rather than to a fraction of the frame. */
    const accent = ad.accent ?? "#ffd75e";
    const panel = ad.panel ?? "#241a3f";

    // Gantry legs down onto the roof below.
    const legH = Math.max(0, baseY - (top + boardH));
    rect(ctx, x + 3, top + boardH, 2, legH, "#0b0918");
    rect(ctx, x + inner - 5, top + boardH, 2, legH, "#0b0918");

    // Frame, lit face, and a hairline of accent along the top where the
    // floodlights are mounted.
    rect(ctx, x - 1, top - 1, inner + 2, boardH + 2, "#07060d");
    rect(ctx, x, top, inner, boardH, panel);
    rect(ctx, x, top, inner, 1, accent);
    rect(ctx, x, top + boardH - 1, inner, 1, "#07060d");

    const bought = ad.image ? adImage(ad.image) : null;
    if (bought) {
      /* Buyer artwork, fitted inside the slot on its own aspect so it is never
       * stretched, and centred in whatever is left over.
       *
       * Smoothing goes back ON for this one blit. Everything else in the city
       * is stamped on the pixel grid, but a banner arrives at whatever size its
       * owner drew it and is usually several times the slot; dropped through
       * nearest-neighbour at that ratio it comes out as aliased confetti.
       * Artwork authored at slot size stays pixel-crisp either way. */
      const faceW = inner - 2;
      const faceH = boardH - 3;
      const fit = Math.min(faceW / bought.naturalWidth, faceH / bought.naturalHeight);
      const drawW = Math.max(1, Math.round(bought.naturalWidth * fit));
      const drawH = Math.max(1, Math.round(bought.naturalHeight * fit));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        bought,
        x + 1 + Math.round((faceW - drawW) / 2),
        top + 2 + Math.round((faceH - drawH) / 2),
        drawW,
        drawH,
      );
      ctx.imageSmoothingEnabled = false;
    } else if (art) {
      const artX = x + Math.round((inner - art.width) / 2);
      const artY = top + 1 + Math.round((boardH - 2 - art.height) / 2);
      art.paint(ctx, artX, artY, ad, s);
    } else {
      drawPixelText(ctx, headline, x + inner / 2, top + 4, 1, accent, { align: "center" });
      if (sub) {
        drawPixelText(ctx, sub, x + inner / 2, top + 13, 1, "#cfd8ec", { align: "center" });
      }
    }

    // A shine sweeping across the face every few seconds — the tell that the
    // board is a lit panel and not a painted flat.
    const sweep = ((s.time / 34 + index * 260) % (inner + 180)) - 20;
    if (sweep > -6 && sweep < inner) {
      ctx.globalAlpha = 0.16;
      rect(ctx, x + sweep, top + 1, 4, boardH - 2, "#ffffff");
      ctx.globalAlpha = 1;
    }
  }
}

/* The crowd standing between the city and the ring apron: a solid dark mass
 * with heads bumping out of the top, not a row of separate blocks. Gaps a pixel
 * or two wide read as flickering stripes once the frame is blown up. */
function drawStreetCrowd(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame, streetY: number) {
  const { width } = frame;

  /* The parapet: the low wall around the edge of the roof, with a coping course
   * along the top. It is the single element that says the ring is on a BUILDING
   * — the city has to disappear behind something at eye level, or the towers
   * read as a painted backdrop standing on the same floor as the fighters. */
  const wallTop = streetY;
  const wallH = Math.max(5, Math.round(frame.height * 0.05));
  rect(ctx, 0, wallTop, width, wallH, "#1a1730");
  // Coping stones along the top, and a lit edge where the ring lights catch it.
  rect(ctx, 0, wallTop, width, 2, "#3c3760");
  rect(ctx, 0, wallTop, width, 1, "#5b558a");
  const copeScroll = Math.round(cityScroll(frame, s.time, 0.62));
  for (let x = -(copeScroll % 9) - 9; x < width + 9; x += 9) {
    rect(ctx, x, wallTop, 1, 2, "#241f3d");
  }
  // Water-stained render below the coping.
  rect(ctx, 0, wallTop + wallH - 2, width, 2, "#12101f");

  // Spectators standing along the parapet, watching from behind the wall: only
  // heads and shoulders clear the top of it. The band is a baked strip on the
  // sway clock — the pattern only changes every 210 ms, so the strips replay
  // the jumping exactly. See CROWD_BAKE_MS.
  const scroll = Math.round(cityScroll(frame, s.time, 0.68));
  const crowdTick = Math.floor(s.time / CROWD_BAKE_MS);
  let heads = s.backdrop.heads;
  if (!heads || heads.tick !== crowdTick || Math.abs(scroll - heads.scroll) > STRIP_PAD) {
    // The strip is 12 rows tall with the wall top pinned at row 10 — heads
    // reach 9 above it and one below, swaying included.
    const baked = bakeCanvas(width + STRIP_PAD * 2, 12, (b) =>
      paintCrowdHeads(b, s.time, width + STRIP_PAD * 2, scroll - STRIP_PAD, 10),
    );
    heads = baked ? { canvas: baked, scroll, tick: crowdTick } : null;
    s.backdrop.heads = heads;
  }
  if (heads) ctx.drawImage(heads.canvas, heads.scroll - STRIP_PAD - scroll, wallTop - 10);
  else paintCrowdHeads(ctx, s.time, width, scroll, wallTop);

  // Phone flashes popping along the wall.
  const flashSeed = Math.floor(s.time / 130);
  if (hash2(flashSeed, 3301) > 0.72) {
    const fx = Math.round(hash2(flashSeed, 77) * width);
    rect(ctx, fx - 1, wallTop - 6, 3, 1, "#ffffff");
    rect(ctx, fx, wallTop - 7, 1, 3, "#ffffff");
  }

  // The roof deck itself: tar paper with a gravel speckle, running back from the
  // parapet to the ring apron so no strip of the frame is left unpainted. It is
  // slow background motion, so bake it on the same clock as the crowd and move
  // the finished strip with the camera between bakes.
  const deckTop = wallTop + wallH;
  const deckTick = Math.floor(s.time / CROWD_BAKE_MS);
  if (!s.backdrop.deck || s.backdrop.deck.tick !== deckTick) {
    const baked = bakeCanvas(width, frame.height, (deck) => paintRoofDeck(deck, width, frame.height, deckTop, s.time, frame));
    s.backdrop.deck = baked ? { canvas: baked, top: deckTop, tick: deckTick } : null;
  }
  if (s.backdrop.deck) {
    ctx.drawImage(s.backdrop.deck.canvas, 0, deckTop - s.backdrop.deck.top);
  } else {
    paintRoofDeck(ctx, width, frame.height, deckTop, s.time, frame);
  }
}

function paintRoofDeck(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  deckTop: number,
  time: number,
  frame: Frame,
) {
  rect(ctx, 0, deckTop, width, Math.max(0, height - deckTop), "#161226");
  const gravel = Math.round(cityScroll(frame, time, 0.9));
  for (let row = 0; row < 4; row += 1) {
    const y = deckTop + 1 + row * 3;
    if (y > frame.horizon + 2) break;
    for (let c = -1; c < Math.ceil(width / 5) + 2; c += 1) {
      const index = Math.floor(c - gravel / 5);
      const n = hash2(index, 600 + row);
      if (n < 0.6) continue;
      rect(ctx, c * 5 + (gravel % 5), y, 1, 1, n > 0.85 ? "#2e2848" : "#211c37");
    }
  }
}

/** The heads-and-shoulders row itself, at an explicit scroll and wall top —
 *  the strip bake and the no-canvas fallback are the same code. `time` picks
 *  which heads are up: the sway expression is copied verbatim so the baked
 *  pattern and the live one can never drift. */
function paintCrowdHeads(
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  scroll: number,
  wallTop: number,
) {
  const pitch = 8;
  const first = Math.floor(scroll / pitch) - 1;
  const span = Math.ceil(width / pitch) + 3;
  for (let n = 0; n < span; n += 1) {
    const index = first + n;
    if (hash2(index, 5150) < 0.34) continue;
    const x = index * pitch - scroll;
    // Heads sway on a slow shared cel clock, in pairs, so the crowd moves like a
    // crowd instead of buzzing pixel by pixel.
    const sway = Math.floor(time / 420 + index * 0.5) % 4 < 2 ? 0 : -1;
    const tone = hash2(index, 78) > 0.5 ? "#2f3358" : "#242745";
    rect(ctx, x, wallTop - 5 + sway, 5, 6, tone);
    rect(ctx, x + 1, wallTop - 8 + sway, 3, 3, hash2(index, 91) > 0.5 ? "#6b4d38" : "#3f2c20");
  }
}

/* -------------------------------------------------------------- ring & ropes */

function ringCorners(frame: Frame) {
  return {
    farLeft: { x: projectX(frame, 0, 0), y: projectY(frame, 0) },
    farRight: { x: projectX(frame, RING_LENGTH_M, 0), y: projectY(frame, 0) },
    nearLeft: { x: projectX(frame, 0, RING_DEPTH_M), y: projectY(frame, RING_DEPTH_M) },
    nearRight: { x: projectX(frame, RING_LENGTH_M, RING_DEPTH_M), y: projectY(frame, RING_DEPTH_M) },
  };
}

function ringCacheKey(frame: Frame) {
  return [
    frame.width,
    frame.height,
    frame.center.toFixed(3),
    frame.ppm.toFixed(3),
    frame.horizon,
    frame.floorBottom,
    frame.shakeX,
    frame.shakeY,
  ].join(":");
}

function drawRingBackdrop(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const key = ringCacheKey(frame);
  if (!s.backdrop.ring || s.backdrop.ring.key !== key) {
    const baked = bakeCanvas(frame.width, frame.height, (ring) => {
      drawRingFloor(ring, frame);
      drawFarRopes(ring, frame);
      drawSideRopes(ring, frame);
    });
    s.backdrop.ring = baked ? { canvas: baked, key } : null;
  }
  if (s.backdrop.ring) {
    ctx.drawImage(s.backdrop.ring.canvas, 0, 0);
  } else {
    drawRingFloor(ctx, frame);
    drawFarRopes(ctx, frame);
    drawSideRopes(ctx, frame);
  }
}

function drawRingFloor(ctx: CanvasRenderingContext2D, frame: Frame) {
  const c = ringCorners(frame);
  const top = Math.round(c.farLeft.y);
  const bottom = Math.min(frame.height, Math.round(c.nearLeft.y));

  // The apron: the skirted shelf the ring sits on, drawn first so the canvas
  // lands on top of it.
  rect(ctx, 0, top - 3, frame.width, frame.height - top + 3, "#151022");

  // Canvas, scanline by scanline, so the trapezoid edges stay hard.
  //
  // The tone falls steeply from back to front. Under a real rig the far half of
  // the canvas is blown out white and the near half sits in the fighters' own
  // shadow, and that gradient is doing the work of separating two dark sprites
  // from the floor they are standing on.
  for (let y = top; y < bottom; y += 1) {
    const t = clamp((y - c.farLeft.y) / Math.max(1, c.nearLeft.y - c.farLeft.y), 0, 1);
    const xl = lerp(c.farLeft.x, c.nearLeft.x, t);
    const xr = lerp(c.farRight.x, c.nearRight.x, t);
    const shade = Math.round(178 - t * t * 108);
    // Wide banding across the canvas, the way stage light falls off a stretched
    // sheet — stepped, never blended.
    const band = Math.floor(t * 7) % 2 === 0 ? 0 : -9;
    const level = shade + band;
    rect(ctx, xl, y, xr - xl, 1, `rgb(${level},${level + 3},${level + 12})`);
  }

  // Sponsor lettering laid flat on the canvas, foreshortened with it.
  const logoT = 0.3;
  const logoY = Math.round(lerp(c.farLeft.y, c.nearLeft.y, logoT));
  const logoX = projectX(frame, RING_LENGTH_M / 2, logoT * RING_DEPTH_M);
  ctx.globalAlpha = 0.16;
  drawPixelText(ctx, "FORGE LEAGUE", logoX, logoY, 1, "#25456f", { align: "center" });
  ctx.globalAlpha = 1;

  // The painted boundary the fighters work inside.
  ctx.globalAlpha = 0.28;
  for (const t of [0.08, 0.92]) {
    const y = Math.round(lerp(c.farLeft.y, c.nearLeft.y, t));
    const xl = lerp(c.farLeft.x, c.nearLeft.x, t);
    const xr = lerp(c.farRight.x, c.nearRight.x, t);
    rect(ctx, xl + 6, y, xr - xl - 12, 1, "#5d76a0");
  }
  ctx.globalAlpha = 1;
}

function drawStains(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  for (const stain of s.stains) {
    const x = projectX(frame, stain.x, stain.depth);
    const y = projectY(frame, stain.depth);
    if (x < -8 || x > frame.width + 8) continue;
    const size = Math.max(1, Math.round(stain.size));
    rect(ctx, x, y - 1, size, Math.max(1, size - 1), "#8e1219");
    if (stain.seed % 3 === 0) rect(ctx, x + size, y, 1, 1, "#6d0d13");
  }
}

const ROPE_COLORS = ["#c8342a", "#e8edf4", "#2f5fb8", "#e8edf4"];

// Four ropes strung between the posts. Heights are a share of the post so they
// foreshorten with the ring rather than sitting at fixed screen offsets.
const ROPE_HEIGHTS = [0.9, 0.66, 0.43, 0.2];

function drawFarRopes(ctx: CanvasRenderingContext2D, frame: Frame) {
  const c = ringCorners(frame);
  /* Half a real corner post. A ring post is about a metre and a half, and drawn
   * to that once the camera came in tight it stood a third of the frame tall —
   * four coloured cables banded straight across the city, the fighters' heads
   * and the billboards. The broadcast angle looks DOWN into a ring, which
   * foreshortens the posts to roughly this; it also keeps the ropes below the
   * skyline where they belong. */
  const postH = Math.round(frame.ppm * 0.75);
  const y0 = c.farLeft.y;

  // Post shadows and the two far corners.
  drawPost(ctx, c.farLeft.x, y0, postH, "#c8342a", 0.86);
  drawPost(ctx, c.farRight.x, y0, postH, "#2f5fb8", 0.86);

  ROPE_HEIGHTS.forEach((share, index) => {
    const y = Math.round(y0 - postH * share);
    // A little sag in the middle, as a strung rope has.
    const sag = Math.round(frame.ppm * 0.05);
    ctx.fillStyle = ROPE_COLORS[index];
    for (let x = Math.max(-1, Math.round(c.farLeft.x)); x <= Math.min(frame.width, Math.round(c.farRight.x)); x += 1) {
      const t = (x - c.farLeft.x) / Math.max(1, c.farRight.x - c.farLeft.x);
      const dip = Math.sin(Math.PI * t) * sag;
      ctx.fillRect(x, Math.round(y + dip), 1, 2);
    }
  });
}

/* The two side ropes, running from the far posts down out of frame.
 *
 * These are what give the ring depth. The back ropes on their own read as a
 * banner strung across a backdrop, because nothing in the shot travels toward
 * the viewer — the same four cables running down each side put two strong
 * converging lines in the frame and the canvas immediately reads as a floor
 * rather than a wall.
 *
 * Safe to draw where the near ropes are not (see `drawApron`): a fighter is held
 * a good half metre inside the posts, so these never cross a man the way a near
 * rope would cut straight over his body. */
function drawSideRopes(ctx: CanvasRenderingContext2D, frame: Frame, fromDepth = 0) {
  const c = ringCorners(frame);
  const farPostH = Math.round(frame.ppm * 0.75);
  // The near posts stand closer to the camera, so the same metre and a half of
  // post covers more of the frame and the ropes splay as they come forward.
  const nearPostH = Math.round(farPostH * (depthScale(1) / depthScale(0)));

  ROPE_HEIGHTS.forEach((share, index) => {
    const color = ROPE_COLORS[index];
    for (const side of ["left", "right"] as const) {
      const far = side === "left" ? c.farLeft : c.farRight;
      const near = side === "left" ? c.nearLeft : c.nearRight;
      const x0 = far.x;
      const y0 = far.y - farPostH * share;
      const x1 = near.x;
      const y1 = near.y - nearPostH * share;
      const dy = y1 - y0;
      /* Carry the cable on PAST the near post, to the bottom edge of the frame.
       *
       * The near corner sits wherever the camera pan has put it, which is
       * usually well up the frame rather than off the bottom of it. Ending the
       * rope there left four cables stopping in mid-air over the apron with
       * nothing holding them, which reads worse than having no side ropes at
       * all. Run them out of shot instead: the viewer's eye takes them as
       * passing the camera, which is what a ringside seat actually looks
       * like. */
      const endT = dy > 0.5 ? Math.max(1, (frame.height + 4 - y0) / dy) : 1;
      const span = Math.max(1, Math.round(Math.abs(dy) * endT));
      const startStep = Math.floor(span * clamp(fromDepth / RING_DEPTH_M, 0, 1));
      ctx.fillStyle = color;
      for (let step = startStep; step <= span; step += 1) {
        const t = (step / span) * endT;
        const y = Math.round(y0 + dy * t);
        if (y < -2 || y > frame.height + 2) continue;
        // A strung rope sags between its posts, and this one sags away from the
        // camera as well as down — so the dip pushes it toward mid-ring. Past
        // the near post there is no span left to sag, and `sin` is zero there.
        const dip = Math.sin(Math.PI * clamp(t, 0, 1)) * frame.ppm * 0.035;
        const inward = side === "left" ? dip : -dip;
        const x = Math.round(lerp(x0, x1, t) + inward);
        // Thicker as it comes at the viewer, which is most of the perspective.
        const thickness = clamp(Math.round(1 + t * 2), 1, 5);
        ctx.fillRect(x, y, thickness, 1);
      }
    }
  });
}

/* The near part of a side rope is the foreground edge of the ring. Painting
 * this short world-space section after the fighters keeps a man from appearing
 * on top of the cable when he works toward a corner, while the cached far
 * section remains behind him. */
function drawNearSideRopes(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const nearestFighter = Math.min(s.visuals.blue.y, s.visuals.red.y);
  drawSideRopes(ctx, frame, nearestFighter - 0.28);
}

/* The near side of the ring, in front of the fighters.
 *
 * Deliberately NOT the near ropes: the broadcast camera on a fight sits above
 * them, and drawing them puts three coloured cables straight across the men's
 * legs at exactly the height a body shot lands. What the camera does see is the
 * lip of the canvas and the padded edge below it, which frames the shot without
 * covering any of it. */
function drawApron(ctx: CanvasRenderingContext2D, frame: Frame) {
  const c = ringCorners(frame);
  const y0 = Math.round(c.nearLeft.y);
  if (y0 > frame.height + 4) return;

  // The padded edge of the ring, foreshortened with the canvas.
  for (let i = 0; i < 4; i += 1) {
    const y = y0 + i;
    if (y < 0 || y > frame.height) continue;
    const t = 1 + i * 0.02;
    const xl = lerp(c.farLeft.x, c.nearLeft.x, t);
    const xr = lerp(c.farRight.x, c.nearRight.x, t);
    rect(ctx, xl, y, xr - xl, 1, i < 2 ? "#d8dde8" : "#8d94a8");
  }
  rect(ctx, 0, y0 + 4, frame.width, frame.height - y0, "#100c1c");
}

function drawPost(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  h: number,
  color: string,
  alpha: number,
) {
  if (x < -14 || x > 4000) return;
  const w = Math.max(3, Math.round(h * 0.09));
  ctx.globalAlpha = alpha;
  rect(ctx, x - w / 2 - 1, groundY - h - 1, w + 2, h + 2, OUTLINE);
  // Turnbuckle padding: bright, and the thing the eye uses to read the corners.
  rect(ctx, x - w / 2, groundY - h, w, h, color);
  rect(ctx, x - w / 2, groundY - h, Math.max(1, Math.round(w / 3)), h, "#ffffff");
  ctx.globalAlpha = alpha * 0.35;
  rect(ctx, x - w / 2, groundY - h, w, 2, "#ffffff");
  ctx.globalAlpha = 1;
}

/* ---------------------------------------------------------------- the referee */

function drawReferee(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const x = Math.round(projectX(frame, s.referee.x, s.referee.depth));
  const groundY = Math.round(projectY(frame, s.referee.depth));
  const k = depthScale(s.referee.depth / RING_DEPTH_M);
  // Deliberately shorter than the fighters and set well behind them: he is
  // scenery, and the moment he reads as a third man in the exchange he is
  // costing the viewer more than he adds.
  const h = Math.round(1.78 * frame.ppm * k * 0.76);
  if (x < -20 || x > frame.width + 20 || h < 10) return;

  const face = s.referee.x < (s.visuals.blue.x + s.visuals.red.x) / 2 ? 1 : -1;
  const bounce = Math.sin(s.referee.step) * h * 0.012;
  const stride = Math.sin(s.referee.step) * h * 0.06;
  const torsoW = Math.max(2, h * 0.075);
  const legW = Math.max(1, h * 0.05);
  const hipY = groundY - h * 0.47;
  const shoulderY = groundY - h * 0.8 + bounce;

  // Shadow first, so he is planted on the canvas rather than floating over it.
  ctx.globalAlpha = 0.24;
  rect(ctx, x - h * 0.12, groundY - 1, h * 0.24, 2, "#000000");
  ctx.globalAlpha = 1;

  // Dark slacks, one leg swinging with the stride, black shoes on the canvas.
  const shoeH = Math.max(2, h * 0.035);
  shadedLimb(ctx, x - legW, hipY, x - legW + stride, groundY - shoeH, legW, "#20263a", "#2c3450", face);
  shadedLimb(ctx, x + legW, hipY, x + legW - stride, groundY - shoeH, legW, "#181d2d", "#242b42", face);
  rect(ctx, x - legW * 2.1 + stride, groundY - shoeH - 1, legW * 2.6, shoeH + 1, "#0b0d13");
  rect(ctx, x + legW * 0.3 - stride, groundY - shoeH - 1, legW * 2.6, shoeH + 1, "#0b0d13");

  // Light officiating shirt, arms hanging clear.
  shadedLimb(ctx, x + torsoW * 0.9, shoulderY, x + torsoW * 1.1, hipY + h * 0.06, legW * 0.8, "#4f6f92", "#6f92b8", face);
  rect(ctx, x - torsoW - 1, shoulderY - 1, torsoW * 2 + 2, hipY - shoulderY + 2, OUTLINE);
  rect(ctx, x - torsoW, shoulderY, torsoW * 2, hipY - shoulderY, "#6b8fb4");
  rect(ctx, x - torsoW, shoulderY, Math.max(1, torsoW * 0.6), hipY - shoulderY, "#4e6d8f");
  rect(ctx, x + torsoW * 0.3, shoulderY, Math.max(1, torsoW * 0.5), hipY - shoulderY, "#95b6d4");
  // Bow tie, the one detail that says official rather than cornerman.
  rect(ctx, x - torsoW * 0.5, shoulderY + 1, Math.max(2, torsoW), Math.max(1, h * 0.02), "#1a1c28");

  // Head under a shock of grey hair.
  const hr = Math.max(2, Math.round(h * 0.075));
  rect(ctx, x - hr - 1, shoulderY - hr * 2 - 1, hr * 2 + 2, hr * 2 + 2, OUTLINE);
  rect(ctx, x - hr, shoulderY - hr * 2, hr * 2, hr * 2, "#cf9d72");
  rect(ctx, x - hr, shoulderY - hr * 2, hr * 2, Math.max(1, hr * 0.8), "#c9ccd6");
  rect(ctx, x + face * hr * 0.3, shoulderY - hr, Math.max(1, hr * 0.5), 1, "#3c2a1e");
}

/* ---------------------------------------------------------------- the fighter */

function authoredDrillVisual(source: Visual, drill: FightDrill, time: number) {
  if (drill === "sparring") return source;
  const visual = { ...source, down: 0, victory: 0, lap: 0, snapX: 0, snapY: 0, fold: 0, whiteout: 0 };

  if (drill === "reflex") {
    const { duck, danger } = reflexShot(time);
    if (danger && duck) {
      // Under the high ball: sit down into the legs and take the head with —
      // crouch alone folds the body but leaves the skull on the ball's line.
      visual.lean = -0.1;
      visual.crouch = 0.78;
      visual.headX = 0;
      visual.headUp = -0.34;
    } else {
      visual.headUp = 0;
      visual.lean = danger ? -0.82 : Math.sin(time / 620) * 0.06;
      visual.crouch = danger ? 0.34 : 0.08;
      visual.headX = danger ? -0.12 : 0;
    }
    visual.guard = 0.92;
    visual.ext = 0;
    visual.phase = 1;
  }

  if (drill === "heavy-bag") {
    const { local, extension } = heavyBagStrike(time);
    visual.ext = extension * 0.68;
    visual.phase = local;
    visual.lean = extension * 0.28;
    visual.crouch = extension * 0.1;
    visual.hip = extension * 28;
    visual.shoulder = extension * 44;
    visual.guard = extension > 0.1 ? 0.34 : 0.9;
  }

  if (drill === "conditioning") {
    visual.ext = 0;
    visual.phase = 1;
    visual.guard = 0.7;
  }

  if (drill === "footwork") {
    const travel = Math.sin(time / 460);
    visual.lean = travel * 0.18;
    visual.crouch = 0.2 + Math.abs(Math.sin(time / 230)) * 0.09;
    visual.guard = 0.95;
    visual.ext = 0;
    visual.phase = 1;
  }

  return visual;
}

/* The return type is stated rather than inferred, and it has to be.
 *
 * Every branch below spreads `source` and overrides a couple of fields with
 * string literals. Left to infer, TypeScript widens those literals: `punchHand`
 * comes out `string` instead of `"lead" | "rear"` and `action` comes out
 * `string` instead of `FighterAction`, so the result is no longer a
 * `BoutFighter` and `PUNCH_INFO[f.action]` loses its key type. Annotating the
 * return makes the literals contextually typed and the widening never happens. */
function authoredDrillFighter(source: BoutFighter, drill: FightDrill, time: number): BoutFighter {
  if (drill === "sparring") return source;

  if (drill === "heavy-bag") {
    const { local, extension, action, body } = heavyBagStrike(time);
    // The rear hand starts a shoulder's width further from the bag and the
    // body hook travels a diagonal, so both need more extension than the jab
    // to visually arrive on the same leather.
    const target = action === "crossHead" ? 0.8 : body ? 0.74 : 0.68;
    return {
      ...source,
      action,
      actionElapsed: local * 0.64,
      actionDuration: 0.64,
      punchHand: action === "crossHead" ? "rear" : "lead",
      punchAimHeight: body ? source.heightM * 0.62 : source.heightM * 0.86,
      punchExtensionTarget: target,
      handExtension: extension * target,
      handVelocity: extension * 9.4,
    };
  }

  if (drill === "reflex") {
    const { duck, danger } = reflexShot(time);
    return {
      ...source,
      action: danger ? (duck ? "duck" : "slip") : "guard",
      handExtension: 0,
      handVelocity: 0,
    };
  }

  if (drill === "footwork") {
    const travel = Math.sin(time / 460);
    return {
      ...source,
      action: travel > 0 ? "advance" : "retreat",
      handExtension: 0,
      handVelocity: 0,
      body: {
        ...source.body,
        leadFootOffset: travel * 0.13,
        rearFootOffset: -travel * 0.11,
        leadKneeFlexion: 0.28 + Math.max(0, travel) * 0.25,
        rearKneeFlexion: 0.28 + Math.max(0, -travel) * 0.25,
      },
    };
  }

  return { ...source, action: "guard", handExtension: 0, handVelocity: 0 };
}

function pushUpSkeleton(standing: Skeleton, h: number, time: number): Skeleton {
  const rep = (Math.sin(time / 360) + 1) / 2;
  const lift = lerp(0.11, 0.25, rep);
  const origin = standing.hip.x;
  const at = (x: number, y: number): Vec => ({ x: origin + x * h, y: y * h });
  return {
    hip: at(-0.08, lift + 0.1),
    chest: at(0.32, lift + 0.02),
    neck: at(0.46, lift),
    head: at(0.59, lift - 0.01),
    headTilt: 1.25,
    leadShoulder: at(0.35, lift + 0.05),
    leadElbow: at(0.29, 0.09 + rep * 0.04),
    leadGlove: at(0.45, 0.035),
    rearShoulder: at(0.28, lift),
    rearElbow: at(0.2, 0.075 + rep * 0.035),
    rearGlove: at(0.35, 0.025),
    leadHip: at(-0.04, lift + 0.1),
    leadKnee: at(-0.39, lift * 0.58),
    leadFoot: at(-0.7, 0.025),
    rearHip: at(-0.12, lift + 0.08),
    rearKnee: at(-0.46, lift * 0.48),
    rearFoot: at(-0.76, 0.02),
  };
}

function drawFighter(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  frame: Frame,
  corner: Corner,
  source: BoutFighter,
) {
  if (s.drill !== "sparring" && corner === "red") return;
  const v = authoredDrillVisual(s.visuals[corner], s.drill, s.time);
  const f = authoredDrillFighter(source, s.drill, s.time);
  const profile = s.profiles[corner];
  const kit = cachedKit(corner, profile.seed);
  const h = f.heightM;
  const bulk = fighterBulk(profile.weightClass);
  const arm = armLength(f);
  const solo = s.drill !== "sparring";
  const stance = solo ? soloStance(frame, s.drill, h, s.time) : null;
  // The sparring camera stretches hand travel to match the gap it draws the
  // pair at. A drill has no pair, and its spread belongs to the bout running
  // unseen behind the reel, so it would make the gloves fall short of the bag
  // or run past it depending on how that bout happened to be spaced.
  const spread = solo ? 1 : s.spreadScale;
  const reachMax = Math.max(0.12, f.punchExtensionTarget * spread);
  const reach = s.drill === "heavy-bag"
    ? heavyBagGlove(s, frame, heavyBagFace(s, frame)).reach
    : v.ext * spread;
  const standingSkel = buildSkeleton(f, v, arm, reach, reachMax, s.time, bulk);
  const skel = s.drill === "conditioning"
    ? pushUpSkeleton(standingSkel, h, s.time)
    : downedSkeleton(standingSkel, h, v.down);

  const k = depthScale(v.y / RING_DEPTH_M);
  const ppm = stance ? stance.ppm : frame.ppm * k;
  const groundY = stance ? stance.groundY : projectY(frame, v.y);
  const originX = stance ? stance.originX : projectX(frame, v.x, v.y);
  // The eased facing is signed, so a turn squashes the sprite through zero and
  // he pivots on the spot instead of mirroring inside out on one frame.
  const face = s.drill === "footwork"
    ? Math.cos(s.time / 460) >= 0 ? 1 : -1
    : solo ? 1 : v.facing;
  const faceSign = face >= 0 ? 1 : -1;
  const squash = Math.max(0.16, Math.abs(face));

  const downT = v.down;

  const to = (p: Vec): Vec => {
    return {
      x: originX + p.x * ppm * faceSign * squash,
      y: groundY - p.y * ppm,
    };
  };

  const px = (p: Vec) => to(p);
  const w = (n: number) => Math.max(1, n * ppm);

  // Contact ghost: two frames of near-white on the man who just got hit. The
  // oldest tell in the genre and still the clearest.
  const hot = v.whiteout > 0.5;
  const skin = hot ? "#ffffff" : kit.skin;
  const skinLight = hot ? "#ffffff" : kit.skinLight;
  const skinShade = hot ? "#e6eef8" : kit.skinShade;
  const trunk = hot ? "#ffffff" : kit.trunk;
  const trunkLight = hot ? "#ffffff" : kit.trunkLight;
  const trunkShade = hot ? "#dde6f2" : kit.trunkShade;

  // Ground shadow, tightening as he plants.
  // Pulled back this far the sprite is small against a lot of pale canvas, so
  // the shadow does real work anchoring him to the floor.
  // A proper ellipse rather than three tapering lines. Against this much pale
  // canvas the shadow is doing most of the work of saying where the man is
  // standing, and a two-pixel smear under the boots does not say it.
  const shadowW = Math.round(ppm * lerp(0.6, h * 0.5, downT) * squash);
  const shadowH = Math.max(2, Math.round(ppm * lerp(0.1, 0.055, downT)));
  ctx.globalAlpha = 0.34;
  for (let i = 0; i < shadowH; i += 1) {
    const t = (i + 0.5) / shadowH;
    const wide = Math.round(shadowW * Math.sqrt(Math.max(0, 1 - (t * 2 - 1) ** 2)));
    rect(ctx, originX - wide, groundY - shadowH + i, wide * 2, 1, "#000000");
  }
  ctx.globalAlpha = 1;

  const hip = px(skel.hip);
  const chest = px(skel.chest);
  const neck = px(skel.neck);
  const head = px(skel.head);
  const lShoulder = px(skel.leadShoulder);
  const lElbow = px(skel.leadElbow);
  const lGlove = px(skel.leadGlove);
  const rShoulder = px(skel.rearShoulder);
  const rElbow = px(skel.rearElbow);
  const rGlove = px(skel.rearGlove);

  // Division changes muscle mass, not standing height or reach. Keep wrists
  // and knees narrower than the deltoids, biceps, quads and calves they join.
  const deltoidR = w(h * 0.046 * (1 + bulk * 0.4));
  const upperArmR = w(h * 0.04 * (1 + bulk * 0.42));
  const elbowR = w(h * 0.028 * (1 + bulk * 0.16));
  const wristR = w(h * 0.019 * (1 + bulk * 0.12));
  const thighR = w(h * 0.052 * (1 + bulk * 0.32));
  const kneeR = w(h * 0.034 * (1 + bulk * 0.2));
  const ankleR = w(h * 0.023 * (1 + bulk * 0.12));
  const gloveR = Math.max(2, ppm * h * 0.061);

  // The cloth hem and the skin cutoff are the same two projected points. This
  // shared boundary is what keeps a diagonal thigh from revealing a strip of
  // yesterday's skin pixels when the fighter rolls or plants a foot.
  const rearHipPoint = px(skel.rearHip);
  const rearKneePoint = px(skel.rearKnee);
  const leadHipPoint = px(skel.leadHip);
  const leadKneePoint = px(skel.leadKnee);
  const shorts = buildShortsGeometry(skel, px, w, h, bulk);
  const rearShortsEnd = shorts.panels[0].end;
  const leadShortsEnd = shorts.panels[1].end;

  /* --- rear leg behind the torso ---------------------------------------- */
  drawLeg(ctx, rearHipPoint, rearKneePoint, px(skel.rearFoot), thighR, kneeR, ankleR, skin, skinShade, kit, faceSign, true, { end: rearShortsEnd });

  /* --- torso -------------------------------------------------------------- */
  if (s.drill === "conditioning") {
    // Prone. drawTorso scanlines from the chest DOWN to the hip, and in a
    // push-up the hip sits above the chest on screen — the interpolation
    // collapses and the whole midsection vanishes. A horizontal trunk is one
    // thick tapered limb, same as any other angled body part. The tail end is
    // pulled a short way DOWN the thigh line rather than out past the hip:
    // the trunks hang from the hips toward the knees and paint over the torso
    // next, so sinking the tail toward the knee buries it inside the
    // waistband instead of poking bare skin out above it.
    const knee = px(skel.leadKnee);
    const seatX = lerp(hip.x, knee.x, 0.16);
    const seatY = lerp(hip.y, knee.y, 0.16);
    // As wide as the trunks at the seat (their legs are h*0.064), tapering to
    // just over the neck's h*0.042 at the chest — a plank, not a barrel.
    taperedLimb(ctx, seatX, seatY, chest.x, chest.y, w(h * 0.064 * (1 + bulk * 0.12)), w(h * 0.048 * (1 + bulk * 0.3)), 0.05, skin, skinLight, faceSign);
  } else {
    drawTorso(ctx, hip, chest, ppm, h, faceSign, skin, skinLight, skinShade, kit.skinDark, kit, bulk);
  }

  // The far arm is still shaded back, but its guard crosses the visible chest.
  // Painting it under the torso would erase the elbow and leave a loose glove.
  drawArm(ctx, rShoulder, rElbow, rGlove, deltoidR * 0.92, upperArmR * 0.92, elbowR, wristR, skinShade, skin, hot ? skinShade : kit.skinDark, faceSign);

  /* --- lead leg ----------------------------------------------------------- */
  drawLeg(ctx, leadHipPoint, leadKneePoint, px(skel.leadFoot), thighR, kneeR, ankleR, skin, skinShade, kit, faceSign, false, { end: leadShortsEnd });

  /* --- trunks last of the lower body, so they hang over both thighs ------- */
  drawTrunks(ctx, skel, px, w, h, trunk, trunkLight, trunkShade, kit.trim, faceSign, shorts);

  /* --- neck and head ------------------------------------------------------ */
  taperedLimb(ctx, chest.x, chest.y, neck.x, neck.y, w(h * 0.042 * (1 + bulk * 0.22)), w(h * 0.036 * (1 + bulk * 0.16)), 0, skinShade, skin, faceSign);
  drawHead(ctx, head, ppm, h, faceSign, squash, kit, hot, f, s.time, s.venue === "gym");
  if (s.venue === "gym") drawHeadgear(ctx, head, ppm, h, faceSign, corner, hot);

  /* --- lead arm on top ---------------------------------------------------- */
  // The cyborg's chrome arm is the lead one — it is the arm the viewer watches
  // all night, so the augmentation goes where the camera is.
  const leadFill = kit.species === "cyborg" ? (hot ? "#ffffff" : METAL_RAMP.mid) : skin;
  const leadLight = kit.species === "cyborg" ? (hot ? "#ffffff" : METAL_RAMP.light) : skinLight;
  const leadShade = kit.species === "cyborg" ? (hot ? skinShade : METAL_RAMP.shade) : skinShade;
  drawArm(ctx, lShoulder, lElbow, lGlove, deltoidR, upperArmR, elbowR, wristR, leadFill, leadLight, leadShade, faceSign, s.drill === "conditioning" || downT > 0.5 ? faceSign : -faceSign);
  // One seam where chrome meets shoulder, or the arm reads as painted on.
  if (kit.species === "cyborg" && !hot) {
    limb(ctx, lShoulder.x, lShoulder.y - deltoidR, lShoulder.x, lShoulder.y + deltoidR, 1, METAL_RAMP.dark);
  }

  /* --- gloves ------------------------------------------------------------- */
  const info = PUNCH_INFO[f.action];
  const throwing = info ? f.punchHand : null;
  const speed = clamp(f.handVelocity / 9, 0, 1);
  drawGlove(ctx, rGlove, gloveR * 0.96, kit, throwing === "rear" ? speed : 0, rElbow);
  drawGlove(ctx, lGlove, gloveR, kit, throwing === "lead" ? speed : 0, lElbow);

  // Damage worn on the sprite: welts and cuts pinned to the anatomy that took
  // them, so a man who has been battered visibly has been.
  if (s.venue === "fight-night") drawDamage(ctx, skel, h, v, ppm, to, bulk);

  // Stars for a man whose legs have gone. Instantly readable, unlike a number.
  if (f.hurtSeconds > 0.3 && f.downCountSeconds <= 0) {
    const n = 3;
    for (let i = 0; i < n; i += 1) {
      const a = s.time / 260 + (i * Math.PI * 2) / n;
      const sx = Math.round(head.x + Math.cos(a) * ppm * 0.24);
      const sy = Math.round(head.y - ppm * 0.2 + Math.sin(a) * ppm * 0.07);
      rect(ctx, sx - 1, sy, 3, 1, "#ffe45c");
      rect(ctx, sx, sy - 1, 1, 3, "#ffe45c");
    }
  }

  // The punch streak. Drawn from the elbow to the glove along the travel, only
  // while the hand is genuinely moving, so it names the punch rather than
  // smearing the whole sprite.
  if (info && f.handVelocity > 3.2 && v.ext > 0.06) {
    const g = throwing === "lead" ? lGlove : rGlove;
    const e = throwing === "lead" ? lElbow : rElbow;
    const dirX = g.x - e.x;
    const dirY = g.y - e.y;
    const len = Math.max(1, Math.hypot(dirX, dirY));
    // Tapered and short, tucked behind the fist rather than run the length of
    // the arm. Drawn as a fat even bar it stopped being a smear off the glove
    // and became the biggest, palest shape on the sprite — the punch it was
    // supposed to sell was buried underneath it.
    const trailLen = Math.min(ppm * 0.3, speed * ppm * 0.42);
    const tailX = g.x - (dirX / len) * trailLen;
    const tailY = g.y - (dirY / len) * trailLen;
    // In the glove's own colour, not its highlight. Smeared in the near-white
    // top tone the streak outglows the fist it is trailing, and the eye tracks
    // the smear instead of the punch.
    ctx.globalAlpha = 0.4;
    limb(ctx, lerp(tailX, g.x, 0.45), lerp(tailY, g.y, 0.45), g.x, g.y, gloveR * 0.4, kit.glove);
    ctx.globalAlpha = 0.22;
    limb(ctx, tailX, tailY, g.x, g.y, gloveR * 0.18, kit.glove);
    ctx.globalAlpha = 1;
  }

  // The punch name, called the instant it leaves. This is the line between
  // "something happened" and "he ripped a left hook to the liver".
  if (info && v.phase > 0.05 && v.phase < 0.62 && f.handVelocity > 2) {
    const label = info.label;
    ctx.globalAlpha = clamp(1.4 - v.phase * 2, 0, 1);
    drawPixelText(
      ctx,
      label,
      Math.round(originX - faceSign * ppm * 0.5),
      Math.round(groundY - ppm * 2.15),
      1,
      corner === "blue" ? "#7fd8ff" : "#ffb14a",
      { align: "center", outline: OUTLINE },
    );
    ctx.globalAlpha = 1;
  }
}

/* The half-width of the torso at `t`, where 0 is the shoulder line and 1 the
 * hip. Piecewise rather than a single taper: a boxer's silhouette has four
 * distinct events down it — the shoulder shelf, the chest, the waist pinch and
 * the flare back out over the hips — and a smooth interpolation between the top
 * and the bottom flattens every one of them into a wedge. */
function torsoHalf(t: number, bulk = 0) {
  const mass = 1 + bulk * lerp(0.3, 0.12, t);
  if (t < 0.13) return lerp(0.086, 0.114, t / 0.13) * mass;
  if (t < 0.4) return lerp(0.114, 0.1, (t - 0.13) / 0.27) * mass;
  if (t < 0.76) return lerp(0.1, 0.073, (t - 0.4) / 0.36) * mass;
  return lerp(0.073, 0.088, (t - 0.76) / 0.24) * mass;
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  hip: Vec,
  chest: Vec,
  ppm: number,
  h: number,
  face: number,
  fill: string,
  light: string,
  shade: string,
  dark: string,
  kit: Kit,
  bulk = 0,
) {
  // Scanlined rather than stroked: a taper drawn as a path would be antialiased
  // into a soft edge and the sprite would stop looking drawn.
  const top = Math.round(Math.min(chest.y, hip.y));
  const bottom = Math.round(Math.max(chest.y, hip.y));

  for (let y = top; y <= bottom; y += 1) {
    const t = clamp((y - chest.y) / Math.max(1, hip.y - chest.y), 0, 1);
    const cx = lerp(chest.x, hip.x, t);
    const half = Math.max(1, torsoHalf(t, bulk) * h * ppm);
    rect(ctx, cx - half - 1, y, half * 2 + 2, 1, OUTLINE);
    rect(ctx, cx - half, y, half * 2, 1, fill);
    // A narrow flank in shadow leaves the broad chest facing the viewer.
    const backX = face > 0 ? cx - half : cx + half - Math.max(1, half * 0.24);
    rect(ctx, backX, y, Math.max(1, half * 0.24), 1, shade);
    const frontX = face > 0 ? cx + half - Math.max(1, half * 0.18) : cx - half;
    rect(ctx, frontX, y, Math.max(1, half * 0.18), 1, light);
  }

  const at = (t: number) => Math.round(lerp(chest.y, hip.y, t));
  const cxAt = (t: number) => lerp(chest.x, hip.x, t);
  const halfAt = (t: number) => Math.max(1, torsoHalf(t, bulk) * h * ppm);

  // The skeleton and the robot have no muscle to mark. The skeleton carries a
  // ribcage instead — three bars across the top half, plus the sternum seam —
  // and the robot a chest plate: one panel seam, one weld line, and a status
  // lamp in his corner colour. Same budget of three marks as everyone else.
  if (kit.species === "skeleton") {
    for (const t of [0.18, 0.3, 0.42]) {
      const half = halfAt(t);
      rect(ctx, cxAt(t) - half * 0.75, at(t), half * 1.5, 1, shade);
    }
    for (let y = at(0.14); y <= at(0.48); y += 2) {
      rect(ctx, cxAt(0.3) + face * halfAt(0.3) * 0.25, y, 1, 1, dark);
    }
    return;
  }
  if (kit.species === "robot") {
    rect(ctx, cxAt(0.36) - halfAt(0.36), at(0.36), halfAt(0.36) * 2, 1, dark);
    for (let y = at(0.42); y <= at(0.68); y += 1) {
      const t = (y - chest.y) / Math.max(1, hip.y - chest.y);
      rect(ctx, cxAt(t) - face * halfAt(t) * 0.2, y, 1, 1, shade);
    }
    rect(ctx, cxAt(0.2) + face * halfAt(0.2) * 0.35, at(0.2), 2, 2, kit.glove);
    return;
  }

  /* Keep the muscle planes broad.
   *
   * This torso is about twenty pixels tall. It previously carried a trapezius,
   * a pectoral mass, a pec shadow, a lat wedge, an ab ladder, a linea alba and
   * two serratus notches — nine features on twenty scanlines, every one of them
   * a single pixel. At that density anatomy stops adding up to a body and turns
   * into noise: the eye reads scratches, the silhouette goes muddy, and the man
   * is harder to follow than if the whole torso had been left flat. The sprite
   * sheets this is drawn to match are nearly flat by comparison, and they read
   * from across a room. */

  // Two pectoral planes, with the sternum toward the opponent: the near half
  // is broader than the far half. Keep the marks broad at this sprite size.
  const pecTop = at(0.12);
  const pecBot = at(0.32);
  for (let y = pecTop; y <= pecBot; y += 1) {
    const t = (y - chest.y) / Math.max(1, hip.y - chest.y);
    const half = halfAt(t);
    const cx = cxAt(t);
    const bulge = Math.sin(((y - pecTop) / Math.max(1, pecBot - pecTop)) * Math.PI);
    const sternum = cx + face * half * 0.24;
    const nearW = Math.max(1, half * 0.88 * bulge);
    const farW = Math.max(1, half * 0.46 * bulge);
    rect(ctx, face > 0 ? sternum - nearW - 1 : sternum + 1, y, nearW, 1, light);
    rect(ctx, face > 0 ? sternum + 1 : sternum - farW - 1, y, farW, 1, light);
  }
  const pecHalf = halfAt(0.34);
  const sternum = cxAt(0.34) + face * pecHalf * 0.24;
  rect(ctx, face > 0 ? sternum - pecHalf : sternum + 1, at(0.34), pecHalf, 1, shade);
  rect(ctx, face > 0 ? sternum + 1 : sternum - pecHalf * 0.5, at(0.32), pecHalf * 0.5, 1, shade);

  // The larger divisions have room for two broad abdominal planes. Leave the
  // featherweights alone, and avoid a ladder of single-pixel muscle scratches.
  if (bulk > 0) {
    for (const t of [0.48, 0.62]) {
      const half = halfAt(t);
      const seam = cxAt(t) + face * half * 0.18;
      const wide = Math.max(1, half * 0.4);
      rect(ctx, face > 0 ? seam - wide - 1 : seam + 1, at(t), wide, 1, light);
      rect(ctx, face > 0 ? seam - wide - 1 : seam + 1, at(t) + 1, wide, 1, shade);
    }
  }

  // The waist shadow, low on the back flank: one soft block where the ribs run
  // out, so a body shot lands somewhere that visibly exists.
  for (let y = at(0.5); y <= at(0.72); y += 1) {
    const t = (y - chest.y) / Math.max(1, hip.y - chest.y);
    const half = halfAt(t);
    const cx = cxAt(t);
    const wedge = Math.max(1, half * 0.34);
    rect(ctx, face > 0 ? cx - half : cx + half - wedge, y, wedge, 1, dark);
  }
}

interface ShortsPanel {
  root: Vec;
  end: Vec;
  points: Vec[];
  direction: Vec;
  normal: Vec;
  rootHalf: number;
  hemHalf: number;
}

interface ShortsGeometry {
  seat: Vec[];
  waistband: Vec[];
  panels: ShortsPanel[];
}

function direction(from: Vec, to: Vec, fallback: Vec): Vec {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return fallback;
  return { x: dx / length, y: dy / length };
}

function offset(point: Vec, along: Vec, distance: number, across?: Vec, side = 0): Vec {
  return {
    x: point.x + along.x * distance + (across?.x ?? 0) * side,
    y: point.y + along.y * distance + (across?.y ?? 0) * side,
  };
}

function pointInPolygon(point: Vec, polygon: Vec[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/* The shorts are one small polygonal garment, rather than two screen-aligned
 * rectangles laid over the legs. A torso-aligned seat makes the waistband turn
 * with the fall, and each leg panel is a flat trapezoid around its own thigh.
 * The shared geometry is also handed to drawLeg, so the skin starts at the very
 * same hem the cloth ends on. */
function buildShortsGeometry(
  skel: Skeleton,
  px: (p: Vec) => Vec,
  w: (n: number) => number,
  h: number,
  bulk = 0,
): ShortsGeometry {
  const hip = px(skel.hip);
  const chest = px(skel.chest);
  const leadHip = px(skel.leadHip);
  const rearHip = px(skel.rearHip);
  const leadKnee = px(skel.leadKnee);
  const rearKnee = px(skel.rearKnee);
  const bodyUp = direction(hip, chest, { x: 0, y: -1 });
  const bodyDown = { x: -bodyUp.x, y: -bodyUp.y };
  const across = direction(rearHip, leadHip, { x: 1, y: 0 });

  const waistDepth = w(h * 0.026);
  const bandHeight = w(h * 0.018);
  const seatDepth = w(h * 0.062);
  const notchDepth = w(h * 0.048);
  const seatHalf = w(h * 0.104 * (1 + bulk * 0.12));
  const seatBottomHalf = w(h * 0.078 * (1 + bulk * 0.2));
  const notchHalf = w(h * 0.014);
  const waist = offset(hip, bodyUp, waistDepth);
  const seatBottom = offset(hip, bodyDown, seatDepth);
  const notch = offset(hip, bodyDown, notchDepth);

  // The concave lower edge leaves a shallow, deliberate crotch notch between
  // the two openings. It is the small V visible on the front-facing reference,
  // and keeps the lower silhouette from reading as a hanging square flap.
  const seat = [
    offset(waist, across, 0, across, -seatHalf),
    offset(waist, across, 0, across, seatHalf),
    offset(seatBottom, across, 0, across, seatBottomHalf),
    offset(notch, across, 0, across, notchHalf),
    offset(notch, across, 0, across, -notchHalf),
    offset(seatBottom, across, 0, across, -seatBottomHalf),
  ];
  // Keep the band a pixel inside the seat. At a steep knockdown angle a trim
  // row placed exactly on the top edge can become a lone pixel after rounding.
  const bandTop = offset(waist, bodyDown, bandHeight * 0.35);
  const bandBottom = offset(waist, bodyDown, bandHeight * 1.25);
  const waistband = [
    offset(bandTop, across, 0, across, -seatHalf * 0.96),
    offset(bandTop, across, 0, across, seatHalf * 0.96),
    offset(bandBottom, across, 0, across, seatHalf * 0.96),
    offset(bandBottom, across, 0, across, -seatHalf * 0.96),
  ];

  const panel = (root: Vec, knee: Vec): ShortsPanel => {
    const end = {
      x: lerp(root.x, knee.x, 0.68),
      y: lerp(root.y, knee.y, 0.68),
    };
    const fallback = { x: bodyDown.x, y: bodyDown.y };
    const panelDirection = direction(root, end, fallback);
    const normal = { x: -panelDirection.y, y: panelDirection.x };
    const rootHalf = w(h * 0.057 * (1 + bulk * 0.32));
    const hemHalf = w(h * 0.061 * (1 + bulk * 0.32));
    const rootPoint = root;
    return {
      root,
      end,
      direction: panelDirection,
      normal,
      rootHalf,
      hemHalf,
      points: [
        offset(rootPoint, normal, 0, normal, -rootHalf),
        offset(rootPoint, normal, 0, normal, rootHalf),
        offset(end, normal, 0, normal, hemHalf),
        offset(end, normal, 0, normal, -hemHalf),
      ],
    };
  };

  return {
    seat,
    waistband,
    panels: [panel(rearHip, rearKnee), panel(leadHip, leadKnee)],
  };
}

function drawTrunks(
  ctx: CanvasRenderingContext2D,
  skel: Skeleton,
  px: (p: Vec) => Vec,
  w: (n: number) => number,
  h: number,
  trunk: string,
  light: string,
  shade: string,
  trim: string,
  face: number,
  geometry = buildShortsGeometry(skel, px, w, h),
) {
  const shapes = [
    { points: geometry.seat, tone: 2 },
    { points: geometry.panels[0].points, tone: 1 },
    { points: geometry.panels[1].points, tone: 2 },
  ];
  const details = [
    { points: geometry.waistband, tone: 4 },
    ...geometry.panels.map((panel) => {
      const hemDepth = Math.max(1, w(h * 0.012));
      const inner = offset(panel.end, panel.direction, -hemDepth);
      const width = panel.hemHalf * 0.78;
      return {
        points: [
          offset(inner, panel.normal, 0, panel.normal, -width),
          offset(inner, panel.normal, 0, panel.normal, width),
          offset(panel.end, panel.normal, 0, panel.normal, width),
          offset(panel.end, panel.normal, 0, panel.normal, -width),
        ],
        tone: 4,
      };
    }),
  ];
  const points = shapes.flatMap((shape) => shape.points);
  const left = Math.floor(Math.min(...points.map((point) => point.x))) - 2;
  const top = Math.floor(Math.min(...points.map((point) => point.y))) - 2;
  const right = Math.ceil(Math.max(...points.map((point) => point.x))) + 2;
  const bottom = Math.ceil(Math.max(...points.map((point) => point.y))) + 2;
  const width = Math.max(1, right - left + 1);
  const height = Math.max(1, bottom - top + 1);
  const mask = new Uint8Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const point = { x: left + x + 0.5, y: top + y + 0.5 };
      let tone = 0;
      for (const shape of shapes) {
        if (!pointInPolygon(point, shape.points)) continue;
        tone = shape.tone;
      }
      if (!tone) continue;

      // A short satin glint lives on the near panel, while the far panel stays
      // a full shade darker. It follows the panel's local normal, so a downed
      // fighter keeps the same light direction after the garment rotates.
      const panel = geometry.panels[1];
      const dx = panel.end.x - panel.root.x;
      const dy = panel.end.y - panel.root.y;
      const span = Math.max(0.001, Math.hypot(dx, dy));
      const t = clamp(((point.x - panel.root.x) * dx + (point.y - panel.root.y) * dy) / (span * span), 0, 1);
      const lateral = ((point.x - panel.root.x) * panel.normal.x + (point.y - panel.root.y) * panel.normal.y) * face;
      if (pointInPolygon(point, panel.points) && t < 0.34 && lateral > -panel.hemHalf * 0.02 && lateral < panel.hemHalf * 0.12) tone = 3;
      for (const detail of details) {
        if (pointInPolygon(point, detail.points)) tone = detail.tone;
      }
      mask[y * width + x] = tone;
    }
  }

  // A trim corner can land just outside a steeply rotated polygon after the
  // integer snap. Keep the largest connected cloth component so that an
  // isolated one- or two-pixel speck cannot survive as a floating waistband or
  // hem when the fighter is halfway through a fall.
  const labels = new Int32Array(width * height);
  let label = 0;
  let largest = 0;
  let largestSize = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const start = y * width + x;
      if (!mask[start] || labels[start]) continue;
      label += 1;
      const queue = [start];
      labels[start] = label;
      let size = 0;
      for (let i = 0; i < queue.length; i += 1) {
        const at = queue[i];
        size += 1;
        const ax = at % width;
        const ay = Math.floor(at / width);
        for (const next of [at - 1, at + 1, at - width, at + width]) {
          if (next < 0 || next >= mask.length || labels[next] || !mask[next]) continue;
          if (Math.abs((next % width) - ax) + Math.abs(Math.floor(next / width) - ay) !== 1) continue;
          labels[next] = label;
          queue.push(next);
        }
      }
      if (size > largestSize) {
        largest = label;
        largestSize = size;
      }
    }
  }
  for (let at = 0; at < mask.length; at += 1) {
    if (mask[at] && labels[at] !== largest) mask[at] = 0;
  }

  // Read the cloth mask without adding ink to it: an outline pixel must never
  // seed another outline pixel and flood the empty space around the shorts.
  const colors = ["", shade, trunk, light, trim, OUTLINE];
  for (let y = 1; y < height - 1; y += 1) {
    let run = 0;
    let prior = 0;
    for (let x = 1; x < width; x += 1) {
      const at = y * width + x;
      let tone = mask[at];
      if (!tone && x < width - 1 && (mask[at - 1] || mask[at + 1] || mask[at - width] || mask[at + width])) tone = 5;
      if (tone !== prior) {
        if (prior) rect(ctx, left + run, top + y, x - run, 1, colors[prior]);
        run = x;
        prior = tone;
      }
    }
  }

}

/* The old capsule sleeves followed the right points but still left a second
 * stale garment pass underneath diagonal thighs. drawLeg now only begins its
 * skin mask at the shared panel hem; drawTrunks emits the cloth once on top. */

function drawLeg(
  ctx: CanvasRenderingContext2D,
  hip: Vec,
  knee: Vec,
  foot: Vec,
  thighR: number,
  kneeR: number,
  ankleR: number,
  fill: string,
  shade: string,
  kit: Kit,
  face: number,
  back: boolean,
  shorts?: { end: Vec },
) {
  // Both legs use the same skin ramp and muscle highlights. Their outlines
  // and drawing order keep the stance legible where the thighs overlap.
  const light = kit.skinLight;
  const ankle = { x: lerp(knee.x, foot.x, 0.84), y: lerp(knee.y, foot.y, 0.84) };
  const skinHip = shorts?.end ?? hip;

  // Thigh and calf share one raster mask. A separate outlined capsule for each
  // bone makes a black ring at the knee and square stamps at diagonal angles;
  // the union gives the knee a rounded hinge and lets the calf taper into it.
  const bones = [
    {
      from: skinHip,
      to: knee,
      profile: [
        [0, thighR * 1.02],
        [0.18, thighR * 1.12],
        [0.46, thighR * 1.06],
        [0.76, kneeR * 1.3],
        [1, kneeR * 1.1],
      ],
    },
    {
      from: knee,
      to: ankle,
      profile: [
        [0, kneeR * 1.1],
        [0.16, kneeR * 1.25],
        [0.42, kneeR * 1.1],
        [0.72, ankleR * 1.28],
        [1, ankleR],
      ],
    },
  ];
  const maxR = thighR * 1.18;
  const points = bones.flatMap(({ from, to }) => [from, to]);
  const left = Math.floor(Math.min(...points.map((p) => p.x)) - maxR) - 2;
  const top = Math.floor(Math.min(...points.map((p) => p.y)) - maxR) - 2;
  const width = Math.ceil(Math.max(...points.map((p) => p.x)) + maxR) - left + 3;
  const height = Math.ceil(Math.max(...points.map((p) => p.y)) + maxR) - top + 3;
  const mask = new Uint8Array(width * height);
  const profileRadius = (profile: number[][], t: number) => {
    for (let i = 1; i < profile.length; i += 1) {
      if (t > profile[i][0]) continue;
      return lerp(profile[i - 1][1], profile[i][1], (t - profile[i - 1][0]) / (profile[i][0] - profile[i - 1][0]));
    }
    return profile[profile.length - 1][1];
  };

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = { x: left + x + 0.5, y: top + y + 0.5 };
      let tone = 0;
      for (let bone = 0; bone < bones.length; bone += 1) {
        const { from, to, profile } = bones[bone];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const span = Math.max(0.001, Math.hypot(dx, dy));
        const t = clamp(((p.x - from.x) * dx + (p.y - from.y) * dy) / (span * span), 0, 1);
        const nearX = from.x + dx * t;
        const nearY = from.y + dy * t;
        const radius = profileRadius(profile, t);
        if (Math.hypot(p.x - nearX, p.y - nearY) > radius) continue;
        tone = 2;
        const nx = -dy / span;
        const ny = dx / span;
        const front = ((p.x - nearX) * nx + (p.y - nearY) * ny) * face;
        // A broken highlight across the quad and shin keeps the leg round;
        // the dark pocket behind the knee keeps the two bones legible.
        if (front > radius * 0.12) tone = 3;
        if (bone === 0 && t > 0.34 && t < 0.8 && front < -radius * 0.32) tone = 1;
        if (bone === 1 && t < 0.18 && front > -radius * 0.1) tone = 3;
      }
      if (tone) mask[y * width + x] = tone;
    }
  }

  const colors = ["", shade, fill, light, OUTLINE];
  for (let y = 1; y < height - 1; y += 1) {
    let run = 0;
    let prior = 0;
    for (let x = 1; x < width; x += 1) {
      const at = y * width + x;
      let tone = mask[at];
      if (!tone && x < width - 1 && (mask[at - 1] || mask[at + 1] || mask[at - width] || mask[at + width])) tone = 4;
      if (tone !== prior) {
        if (prior) rect(ctx, left + run, top + y, x - run, 1, colors[prior]);
        run = x;
        prior = tone;
      }
    }
  }

  // The boot is two connected bones of its own: an ankle cuff continuing the
  // shin and a short foot continuing from the heel. An axis-aligned rectangle
  // stamped at the foot looks detached the moment the leg bends or falls.
  const bootR = Math.max(2, ankleR * 1.28);
  const shoeR = Math.max(2, ankleR * 1.05);
  const heel = { x: foot.x, y: foot.y - shoeR * 0.72 };
  const toe = { x: heel.x + face * Math.max(4, ankleR * 3.2), y: heel.y };
  const boot = back ? kit.bootShade : kit.boot;
  limb(ctx, ankle.x, ankle.y, heel.x, heel.y, bootR + 1, OUTLINE);
  limb(ctx, ankle.x, ankle.y, heel.x, heel.y, bootR, boot);
  limb(ctx, heel.x, heel.y, toe.x, toe.y, shoeR + 1, OUTLINE);
  limb(ctx, heel.x, heel.y, toe.x, toe.y, shoeR, boot);
  limb(ctx, heel.x - face, heel.y + shoeR, toe.x + face, toe.y + shoeR, 1, kit.sole);
  // A narrow heel shadow and lace panel preserve the high-top read without a
  // second floating block on top of the foot.
  limb(ctx, ankle.x - face * bootR * 0.45, ankle.y, heel.x - face * bootR * 0.45, heel.y, Math.max(1, bootR * 0.3), kit.bootShade);
  if (!back) {
    limb(ctx, ankle.x + face * bootR * 0.35, ankle.y, heel.x + face * bootR * 0.35, heel.y, 0.7, kit.sole);
  }
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  head: Vec,
  ppm: number,
  h: number,
  face: number,
  squash: number,
  kit: Kit,
  hot: boolean,
  f: BoutFighter,
  time: number,
  capped: boolean,
) {
  /* Heads are drawn big — a sixth of standing height, which is caricature
   * rather than anatomy. A realistic head at this scale is nine pixels of
   * undifferentiated skin: no room for a brow, an eye, a nose or a jaw, and
   * nothing for a head shot to land on that the viewer can actually see. Every
   * side-on sprite fighter ever drawn makes the same trade. */
  // A fifth of the figure, which is a head and a half bigger than anatomy
  // allows. It is the trade every side-on sprite fighter ever drawn has made: a
  // realistic head at this size is a dozen pixels of undifferentiated skin with
  // no room for a brow, an eye, a nose or a jaw, and nothing for a head shot to
  // land on that the viewer can actually see.
  const r = Math.max(3, Math.round(ppm * h * HEAD_R));
  // Taller than it is wide. A head as wide as it is tall is a domino; a boxer
  // seen side-on is a deep skull on a narrow one, and the difference is most of
  // what separates a face from a block of skin with an eye painted on it.
  const wide = Math.max(2, Math.round(r * squash * 0.7));
  const x = Math.round(head.x);
  const y = Math.round(head.y);
  const skin = hot ? "#ffffff" : kit.skin;
  const light = hot ? "#ffffff" : kit.skinLight;
  const shade = hot ? "#dfe8f4" : kit.skinShade;
  const dark = hot ? "#c8d4e4" : kit.skinDark;
  const px = (n: number) => Math.max(1, Math.round(n));

  // Cranium, corner-cut at the crown. A skull is round on top and square at the
  // jaw, and biting the two top corners off is the whole of that at this size.
  const bite = Math.max(1, Math.round(wide * 0.45));
  const cranium = (grow: number, color: string) => {
    const gx = wide + grow;
    const gy = r + grow;
    if (gx < 1 || gy < 1) return;
    rect(ctx, x - gx, y - gy + bite, gx * 2, gy * 2 - bite, color);
    rect(ctx, x - gx + bite, y - gy, gx * 2 - bite * 2, gy * 2, color);
  };
  cranium(1, OUTLINE);
  cranium(0, skin);
  // Lit on the front and top where the rig hits, shadowed down the back.
  rect(ctx, face > 0 ? x - wide : x + wide - px(wide * 0.5), y - r + bite, px(wide * 0.5), r * 2 - bite, shade);
  rect(ctx, face > 0 ? x + wide - px(wide * 0.4) : x - wide, y - px(r * 0.5), px(wide * 0.4), px(r * 0.55), light);

  /* Every feature on the face is mirrored by EXTENT as well as by offset.
   * `x + face * offset` with a fixed positive width only mirrors where a
   * feature starts: turn the man around and the feature moves to the correct
   * side of his head and is then drawn backwards across it, which is how the
   * fighter facing left ended up wearing his jaw, his mouth and his eye
   * somewhere behind his own cheekbone. `offset` is the left edge measured
   * from the centre of the skull as the right-facing sprite has always had it,
   * and the mirror reflects the whole span rather than just that edge. */
  const facing = (offset: number, w: number) =>
    face > 0 ? x + offset : x - offset - w + 1;

  // Cheekbone and jawline: the two edges that make a face out of a rectangle.
  const jawY = y + px(r * 0.3);
  const jawW = px(wide * 0.85);
  rect(ctx, facing(px(wide * 0.2), jawW), jawY, jawW, px(r * 0.68), skin);
  rect(ctx, facing(px(wide * 0.2), jawW), jawY + px(r * 0.58), jawW, 1, dark);
  const cheekW = px(wide * 0.6);
  rect(ctx, facing(px(wide * 0.15), cheekW), y + px(r * 0.06), cheekW, 1, shade);
  // Jaw shadow under the chin, which is what lifts the head off the neck.
  const chinW = px(wide * 1.1);
  rect(ctx, facing(-px(wide * 0.4), chinW), y + r - 1, chinW, 1, dark);

  // Hair. Every style keeps the fringe WELL short of the brow at the front:
  // carried any lower it takes the brow and the eye with it, and the head reads
  // as a helmet — which is most of the difference between a fighter with a face
  // and a lump of skin with a dot on it. The big styles grow up and back instead.
  if (kit.species === "human") drawSpriteHair(ctx, kit, x, y, r, wide, bite, face, light, capped, f, time);

  const shut = f.stunSeconds > 0.2 || f.hurtSeconds > 0.4 || f.downCountSeconds > 0;
  const eyeX = Math.round(x + face * px(wide * 0.16));
  const eyeY = Math.round(y - r * 0.16);

  switch (kit.species) {
    case "grizzly": {
      // The round ear on the crown is the silhouette read that says bear from
      // the cheap seats. It folds away under gym headgear like the tall
      // haircuts do.
      if (!capped) {
        const earR = px(r * 0.26);
        const earX = x - face * px(wide * 0.5);
        const earTop = y - r - earR;
        rect(ctx, earX - earR - 1, earTop - earR, earR * 2 + 2, earR * 2, OUTLINE);
        rect(ctx, earX - earR, earTop - earR + 1, earR * 2, earR * 2 - 1, skin);
        rect(ctx, earX - px(earR * 0.4), earTop - px(earR * 0.3) + 1, px(earR * 0.8), px(earR * 0.8), shade);
      }
      // Muzzle out the front, paler than the coat the way a brown bear's snout
      // is, with the nose as a dark block on the end of it. It replaces the
      // human nose entirely — it is doing that job and half the jaw's besides.
      const muzL = px(wide * 0.75);
      const muzH = px(r * 0.5);
      const muzY = y + px(r * 0.02);
      const muzX = face > 0 ? x + wide : x - wide - muzL;
      rect(ctx, muzX - 1, muzY - 1, muzL + 2, muzH + 2, OUTLINE);
      rect(ctx, muzX, muzY, muzL, muzH, light);
      rect(ctx, face > 0 ? muzX + muzL - px(muzL * 0.4) : muzX, muzY, px(muzL * 0.4), px(muzH * 0.5), dark);
      rect(ctx, muzX, muzY + muzH - 1, muzL, 1, shade);
      // Eskobear's tip is dusted white under the nose, in the sprite as in the
      // portrait — the powder is the name.
      if (kit.dusted) {
        const dustW = px(muzL * 0.4);
        rect(ctx, face > 0 ? muzX + muzL - dustW : muzX, muzY + px(muzH * 0.5), dustW, muzH - px(muzH * 0.5), "#f4f7fb");
      }
      // A beady eye above the muzzle; hurt, it closes to a line like anyone's.
      rect(ctx, eyeX, eyeY, px(wide * 0.25), shut ? 1 : px(r * 0.18), dark);
      break;
    }
    case "gorilla": {
      if (!capped) {
        // The sagittal crest: a gorilla's crown peaks instead of rounding.
        rect(ctx, x - px(wide * 0.35) - 1, y - r - px(r * 0.22) - 1, px(wide * 0.7) + 2, px(r * 0.22) + 1, OUTLINE);
        rect(ctx, x - px(wide * 0.35), y - r - px(r * 0.22), px(wide * 0.7), px(r * 0.22) + bite, skin);
        // Small ear, low on the back of the skull.
        rect(ctx, face > 0 ? x - wide - 1 : x + wide - 1, y + px(r * 0.02), 2, px(r * 0.28), shade);
      }
      // The brow shelf: one heavy bar jutting past the front of the skull. At
      // this size it IS the gorilla face; everything else hangs under it.
      rect(ctx, face > 0 ? x - px(wide * 0.3) : x - wide - px(wide * 0.35), y - px(r * 0.34), px(wide * 1.35), px(r * 0.16), dark);
      // Bare muzzle low on the face, a step darker than the coat.
      const gMuzL = px(wide * 0.6);
      const gMuzH = px(r * 0.5);
      const gMuzY = y + px(r * 0.24);
      const gMuzX = face > 0 ? x + wide - px(gMuzL * 0.3) : x - wide - gMuzL + px(gMuzL * 0.3);
      rect(ctx, gMuzX - 1, gMuzY - 1, gMuzL + 2, gMuzH + 2, OUTLINE);
      rect(ctx, gMuzX, gMuzY, gMuzL, gMuzH, shade);
      rect(ctx, face > 0 ? gMuzX + gMuzL - 2 : gMuzX + 1, gMuzY + px(gMuzH * 0.3), 1, 1, dark);
      rect(ctx, gMuzX, gMuzY + gMuzH - 2, gMuzL, 1, dark);
      // The eye sits deep under the shelf.
      rect(ctx, eyeX, eyeY + 1, px(wide * 0.22), shut ? 1 : px(r * 0.16), dark);
      break;
    }
    case "skeleton": {
      // The socket is most of the face: a hole with one point of light in it,
      // the way every arcade skeleton since the genre began has looked.
      const sockX = eyeX - (face > 0 ? 0 : px(wide * 0.5));
      rect(ctx, sockX, eyeY - px(r * 0.12), px(wide * 0.5), shut ? 1 : px(r * 0.34), dark);
      if (!shut) rect(ctx, sockX + px(wide * 0.2), eyeY, 1, 1, "#f4f7fb");
      // Nasal cavity: a notch, not a nose.
      rect(ctx, face > 0 ? x + wide - px(wide * 0.25) : x - wide + px(wide * 0.1), y + px(r * 0.14), px(wide * 0.16), px(r * 0.16), dark);
      // The permanent grin: a band of teeth with the seams ticked through it.
      // He needs no mouthguard tell — the teeth are always showing.
      const teethW = px(wide * 0.8);
      const teethH = px(r * 0.2);
      const teethX = face > 0 ? x + wide - teethW + px(wide * 0.1) : x - wide - px(wide * 0.1);
      const teethY = y + px(r * 0.46);
      rect(ctx, teethX, teethY - 1, teethW, 1, dark);
      rect(ctx, teethX, teethY, teethW, teethH, light);
      for (let tx = 1; tx < teethW; tx += 2) rect(ctx, teethX + tx, teethY, 1, teethH, shade);
      // Cheekbone hollow.
      rect(ctx, x - face * px(wide * 0.15), y + px(r * 0.08), px(wide * 0.3), 1, shade);
      break;
    }
    case "alien": {
      // The dome: the cranium just keeps climbing. Folds away under headgear.
      if (!capped) {
        const domeH = px(r * 0.42);
        rect(ctx, x - wide + bite - 1, y - r - domeH - 1, (wide - bite) * 2 + 2, domeH + 2, OUTLINE);
        rect(ctx, x - wide + bite, y - r - domeH, (wide - bite) * 2, domeH + bite, skin);
        rect(ctx, x - px(wide * 0.3), y - r - domeH + 1, px(wide * 0.7), 1, light);
      }
      // One black almond eye, half the face, swept back and down. The glint is
      // what keeps it a wet eye rather than a hole in the head.
      const aw = px(wide * 0.62);
      const ah = shut ? 1 : px(r * 0.34);
      const ax = face > 0 ? eyeX - px(aw * 0.2) : eyeX - aw + px(aw * 0.2);
      rect(ctx, ax, eyeY - px(r * 0.1), aw, ah, "#10141c");
      if (!shut) {
        rect(ctx, ax - face * px(aw * 0.35), eyeY - px(r * 0.1) + ah - 1, aw, 2, "#10141c");
        rect(ctx, face > 0 ? ax + aw - 2 : ax + 1, eyeY - px(r * 0.06), 1, 1, "#9fb9c9");
      }
      // Nostril slit and a line of a mouth. No nose breaks the profile — the
      // flat face is the tell that this head is not one of ours.
      rect(ctx, face > 0 ? x + wide - 2 : x - wide + 1, y + px(r * 0.22), 1, 1, dark);
      rect(ctx, x + face * px(wide * 0.25), y + px(r * 0.55), px(wide * 0.4), 1, shade);
      break;
    }
    case "robot": {
      // Panel seam and rivets down the back of the skull.
      const seamX = face > 0 ? x - wide + px(wide * 0.3) : x + wide - px(wide * 0.3) - 1;
      rect(ctx, seamX, y - r + bite, 1, r * 2 - bite - 1, shade);
      rect(ctx, seamX - face * 2, y - r + bite + 1, 1, 1, dark);
      rect(ctx, seamX - face * 2, y + r - px(r * 0.3), 1, 1, dark);
      // The visor: a dark slot across the eye line, lens lit in corner colour.
      // The eye the crowd tracks does the corner's work at the same time.
      const visW = px(wide * 1.5);
      const visH = px(r * 0.24);
      const visX = face > 0 ? x - px(wide * 0.2) : x + px(wide * 0.2) - visW;
      rect(ctx, visX, eyeY - 1, visW, visH + 2, "#10141c");
      if (!hot) {
        const lensW = px(visW * 0.35);
        rect(ctx, face > 0 ? visX + visW - lensW - 1 : visX + 1, eyeY, lensW, shut ? 1 : visH, kit.glove);
        if (!shut) rect(ctx, face > 0 ? visX + visW - 2 : visX + 1, eyeY, 1, visH, kit.gloveLight);
      }
      // Chin guard, and a bolt where the ear would be.
      rect(ctx, x + face * px(wide * 0.2), y + px(r * 0.55), px(wide * 0.8), px(r * 0.18), shade);
      rect(ctx, face > 0 ? x - wide + px(wide * 0.15) : x + wide - px(wide * 0.35), y - px(r * 0.02), 2, 2, dark);
      break;
    }
    default: {
      // Human and cyborg share the face. The cyborg first takes the cranial
      // plate where the hair was — the robots' gunmetal, which is the visual
      // claim the chrome arm makes on the same production line.
      if (kit.species === "cyborg") {
        const plateD = Math.max(2, px(r * 0.42));
        const plateMid = hot ? "#ffffff" : METAL_RAMP.mid;
        const plateShade = hot ? "#dfe8f4" : METAL_RAMP.shade;
        rect(ctx, x - wide + bite, y - r, wide * 2 - bite * 2, Math.min(bite, plateD), plateMid);
        if (plateD > bite) rect(ctx, x - wide, y - r + bite, wide * 2, plateD - bite, plateMid);
        rect(ctx, face > 0 ? x - wide : x + wide - px(wide * 0.4), y - r + bite, px(wide * 0.4), px(r * 0.9), plateShade);
        if (!hot) {
          rect(ctx, x - px(wide * 0.3), y - r + 1, px(wide * 0.7), 1, METAL_RAMP.light);
          rect(ctx, x - face * px(wide * 0.4), y - r + plateD - 1, 1, 1, METAL_RAMP.dark);
        }
      }
      // Brow ridge, then the eye under it. A stunned man's eye closes to a
      // line. The cyborg's eye is a lens in his corner colour — lit, it reads
      // across the ring the way the robots' visors do.
      //
      // The sclera is floored at three pixels across, and the pupil is placed
      // one in from its front edge, so white survives on BOTH sides of it.
      // Proportional, it came out two: the pupil took one of them and the eye
      // was a single white pixel, which reads as dirt on the sprite rather
      // than as a face — the three-pixel mouthguard below it was the only
      // feature on the head anybody could find.
      const eyeW = Math.max(3, px(wide * 0.5));
      const eyeH = shut ? 1 : Math.max(2, px(r * 0.26));
      // A third of the way out from the centre rather than a pixel off it: an
      // eye belongs well forward on a side-on skull, and sat in the middle it
      // reads as a smudge on the temple whichever way the man is turned. It
      // stops short of the front so the gym headgear's cheek bar, which is
      // drawn over the top of this, cannot clip it.
      const eyeLeft = facing(px(wide * 0.32), eyeW);
      rect(ctx, face > 0 ? eyeLeft - 1 : eyeLeft, eyeY - px(r * 0.3), eyeW + 1, 1, dark);
      if (!hot) {
        rect(
          ctx,
          eyeLeft,
          eyeY,
          eyeW,
          eyeH,
          shut ? dark : kit.species === "cyborg" ? kit.gloveLight : "#f4f7fb",
        );
        if (!shut && kit.species !== "cyborg") {
          rect(ctx, face > 0 ? eyeLeft + eyeW - 2 : eyeLeft + 1, eyeY, 1, eyeH, "#241a14");
        }
      }
      // Nose, breaking the front silhouette — the profile detail that fixes
      // which way a side-on head is looking without needing two eyes to say it.
      const noseW = px(wide * 0.3);
      rect(ctx, facing(wide, noseW), y - px(r * 0.02), noseW, px(r * 0.34), skin);
      rect(ctx, facing(wide, noseW), y + px(r * 0.28), noseW, 1, dark);
      break;
    }
  }

  // Mouthguard, visible when he opens up — a sucking-wind tell as the stamina
  // drains, which the crowd reads long before any bar does. The skeleton is
  // already all teeth, and the robot has no lungs — he runs a cooling vent
  // instead, glowing as the chassis works.
  const blowing = f.stamina < 42 && Math.sin(time / 180 + f.x) > 0.2;
  if (kit.species === "robot") {
    if (blowing && !hot) {
      rect(ctx, x + face * px(wide * 0.3), y + px(r * 0.28), px(wide * 0.4), 1, kit.glove);
      rect(ctx, x + face * px(wide * 0.3), y + px(r * 0.28) + 2, px(wide * 0.4), 1, kit.glove);
    }
  } else if (kit.species !== "skeleton" && (blowing || shut)) {
    const guardW = px(wide * 0.45);
    rect(ctx, facing(px(wide * 0.3), guardW), y + px(r * 0.45), guardW, px(r * 0.24), "#e8eef6");
  }

  // Beads running off the temple and the jaw once he is genuinely blowing. The
  // open mouth above says he is breathing hard; this says how long he has been
  // doing it, and both land from the back row without anybody hunting for a
  // stamina bar. Each bead runs its own slow cycle off the clock and his
  // position, so two tired men are never dripping in lockstep. Bone and
  // gunmetal do not sweat.
  if (f.stamina < 40 && kit.species !== "skeleton" && kit.species !== "robot") {
    const soak = clamp(1 - f.stamina / 40, 0, 1);
    for (let bead = 0; bead < 3; bead += 1) {
      const phase = ((time / 640 + bead * 0.37 + f.x * 0.11) % 1);
      if (phase > 0.7) continue;
      rect(
        ctx,
        x + face * px(wide * (0.5 - bead * 0.36)),
        y - px(r * 0.42) + px(r * 1.35) * phase,
        1,
        Math.max(1, px(r * 0.15)),
        `rgba(216,238,255,${(0.45 + soak * 0.5).toFixed(2)})`,
      );
    }
  }

  // Ear, on the back side of the head. Only the two human-built faces have
  // one — the rest either drew their own above or never grew any.
  if (kit.species === "human" || kit.species === "cyborg") {
    rect(ctx, face > 0 ? x - wide + px(wide * 0.1) : x + wide - px(wide * 0.4), y - px(r * 0.06), px(wide * 0.3), px(r * 0.46), shade);
  }
}

/* One fighter's hair from the side, in the same corner-cut idiom as the skull.
 * `capped` means gym headgear is coming: the tall styles fold down to a crop so
 * the crown does not poke through the shell, while braids keep hanging below it. */
function drawSpriteHair(
  ctx: CanvasRenderingContext2D,
  kit: Kit,
  x: number,
  y: number,
  r: number,
  wide: number,
  bite: number,
  face: number,
  light: string,
  capped: boolean,
  f: BoutFighter,
  time: number,
) {
  const px = (n: number) => Math.max(1, Math.round(n));
  const style = capped && (kit.hairStyle === "afro" || kit.hairStyle === "flattop") ? "crop" : kit.hairStyle;

  // The classic cap: crown following the corner-cut, dropping down the back of
  // the skull past the ear. Crop wears it as-is; cornrows and braids build on it.
  const cap = (depth: number, nape: boolean) => {
    const hairH = Math.max(2, px(r * depth));
    hairFill(ctx, kit, x - wide + bite, y - r, wide * 2 - bite * 2, Math.min(bite, hairH));
    if (hairH > bite) hairFill(ctx, kit, x - wide, y - r + bite, wide * 2, hairH - bite);
    if (nape) hairFill(ctx, kit, face > 0 ? x - wide : x + wide - px(wide * 0.4), y - r + bite, px(wide * 0.4), px(r * 0.95));
  };

  // Where the hair tops out, for the lit strand after the switch. Bald leaves
  // it on the scalp, which turns the strand into the shine off a shaved crown.
  let crownY = y - r;

  switch (style) {
    case "bald":
      break;
    case "buzz":
      cap(0.3, false);
      break;
    case "flattop": {
      // A squared box carried above the skull, the corner bite filled in.
      const fh = px(r * 0.5);
      rect(ctx, x - wide - 1, y - r - fh - 1, wide * 2 + 2, fh + bite + 1, OUTLINE);
      hairFill(ctx, kit, x - wide, y - r - fh, wide * 2, fh + bite);
      crownY = y - r - fh;
      break;
    }
    case "afro": {
      // A mass wider and taller than the skull, stepped at the top to read
      // round, with trailing volume down the back of the skull to the nape.
      const aw = wide + Math.max(1, px(wide * 0.6));
      const at = y - r - px(r * 0.5);
      const ab = y - r + px(r * 0.55);
      rect(ctx, x - aw - 1, at, aw * 2 + 2, ab - at + 1, OUTLINE);
      rect(ctx, x - aw + 1, at - 1, aw * 2 - 2, 2, OUTLINE);
      hairFill(ctx, kit, x - aw, at + 1, aw * 2, ab - at - 1);
      hairFill(ctx, kit, x - aw + 2, at, aw * 2 - 4, 2);
      hairFill(ctx, kit, face > 0 ? x - aw : x + aw - px(wide * 0.5), ab, px(wide * 0.5), px(r * 0.5));
      crownY = at;
      break;
    }
    case "cornrows":
      cap(0.58, true);
      // Part lines between the rows, running front to back over the crown.
      ctx.globalAlpha = 0.4;
      rect(ctx, x - wide + bite, y - r + 1, wide * 2 - bite * 2, 1, kit.skinShade);
      rect(ctx, x - wide + 1, y - r + bite + 1, wide * 2 - 2, 1, kit.skinShade);
      ctx.globalAlpha = 1;
      break;
    case "braids": {
      cap(0.58, true);
      // Strands off the back of the skull, the lower half swinging a pixel on
      // the same slow clock as the mouthguard tell; corner-trim beads on the
      // tips, which is how a braided man carries his colours into the ring.
      const back = face > 0 ? -1 : 1;
      const swing = Math.round(Math.sin(time / 220 + f.x));
      const strandTop = y - r + bite;
      const outer = back > 0 ? x + wide : x - wide - 1;
      const inner = x + back * (wide - 2);
      const len1 = px(r * 1.5);
      const half1 = px(len1 * 0.55);
      hairFill(ctx, kit, outer, strandTop, 1, half1);
      hairFill(ctx, kit, outer + swing, strandTop + half1, 1, len1 - half1);
      rect(ctx, outer + swing, strandTop + len1, 1, 1, kit.trim);
      const len2 = px(r * 1.1);
      const half2 = px(len2 * 0.55);
      hairFill(ctx, kit, inner, strandTop, 1, half2);
      hairFill(ctx, kit, inner + swing, strandTop + half2, 1, len2 - half2);
      rect(ctx, inner + swing, strandTop + len2, 1, 1, kit.trim);
      break;
    }
    default:
      cap(0.58, true);
      break;
  }

  // One lit strand on the crown, so the hair is a mass with a top on it rather
  // than a flat lid.
  ctx.globalAlpha = 0.32;
  rect(ctx, x - px(wide * 0.3), crownY + 1, px(wide * 0.7), 1, light);
  ctx.globalAlpha = 1;
}

function drawHeadgear(
  ctx: CanvasRenderingContext2D,
  head: Vec,
  ppm: number,
  h: number,
  face: number,
  corner: Corner,
  hot: boolean,
) {
  const r = Math.max(3, Math.round(ppm * h * HEAD_R));
  const wide = Math.max(2, Math.round(r * 0.7));
  const x = Math.round(head.x);
  const y = Math.round(head.y);
  const shell = hot ? "#ffffff" : corner === "blue" ? "#1d7fb7" : "#ae352e";
  const shade = hot ? "#dce6ef" : corner === "blue" ? "#0e4266" : "#66221f";

  // Crown, ear cup and cheek bar leave the face exposed. Filling the whole head
  // would turn the fighter into a coloured helmet with no readable expression.
  rect(ctx, x - wide - 2, y - r - 2, wide * 2 + 4, Math.max(2, r * 0.34), OUTLINE);
  rect(ctx, x - wide, y - r - 1, wide * 2, Math.max(1, r * 0.25), shell);
  const backX = face > 0 ? x - wide - 2 : x + wide - 2;
  rect(ctx, backX, y - r + 1, 5, r + 4, OUTLINE);
  rect(ctx, backX + 1, y - r + 2, 3, r + 2, shade);
  const frontX = face > 0 ? x + wide - 1 : x - wide - 2;
  rect(ctx, frontX, y + 1, 4, Math.max(3, r * 0.7), OUTLINE);
  rect(ctx, frontX + 1, y + 2, 2, Math.max(2, r * 0.55), shell);
  rect(ctx, x - wide + 1, y + r - 1, wide * 2 - 2, 2, shade);
}

function drawGlove(
  ctx: CanvasRenderingContext2D,
  at: Vec,
  r: number,
  kit: Kit,
  speed: number,
  elbow: Vec,
) {
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  const rr = Math.max(2, Math.round(r));
  // A travelling glove stretches along its own line of travel — the classic
  // squash-and-stretch that makes a fast punch read as fast.
  const dx = at.x - elbow.x;
  const dy = at.y - elbow.y;
  const len = Math.max(0.001, Math.hypot(dx, dy));
  const stretch = 1 + speed * 0.5;
  const wx = Math.round(rr * (Math.abs(dx) / len > 0.6 ? stretch : 1));
  const wy = Math.round(rr * (Math.abs(dy) / len > 0.6 ? stretch : 1));

  // Corner-cut rather than square. A glove is the most saturated shape on the
  // sprite and the eye tracks it through every punch — left as a hard rectangle
  // it reads as a coloured box taped to the end of an arm.
  const round = (grow: number, color: string) => {
    const gx = wx + grow;
    const gy = wy + grow;
    if (gx < 1 || gy < 1) return;
    const bite = Math.max(1, Math.round(Math.min(gx, gy) * 0.42));
    rect(ctx, x - gx, y - gy + bite, gx * 2, gy * 2 - bite * 2, color);
    rect(ctx, x - gx + bite, y - gy, gx * 2 - bite * 2, gy * 2, color);
  };
  round(1, OUTLINE);
  round(0, kit.glove);
  // Hard three-step shading, no blending: shadow under the fist, body, hot
  // highlight over the knuckles toward the rig.
  rect(ctx, x - wx + 1, y + wy - Math.max(1, Math.round(wy * 0.5)), wx * 2 - 2, Math.max(1, Math.round(wy * 0.5)), kit.gloveShade);
  // A small hot patch on the knuckles, not a wash over the whole fist. Given
  // half the glove the highlight becomes the glove, and the pair read as two
  // pale blobs held up in front of the face instead of as leather.
  rect(ctx, x - Math.round(wx * 0.1), y - wy + 1, Math.max(1, Math.round(wx * 0.5)), Math.max(1, Math.round(wy * 0.4)), kit.gloveLight);
  // The thumb, tucked on the underside toward the elbow.
  const ux = dx / len;
  const uy = dy / len;
  rect(ctx, Math.round(x - ux * rr * 0.5 - rr * 0.3), Math.round(y - uy * rr * 0.4 + rr * 0.3), Math.max(1, rr * 0.6), Math.max(1, rr * 0.55), kit.gloveShade);
  // Cuff at the wrist, on the elbow side: the dark leather band with a single
  // lace line across it. Filled with the trim colour it became a white square
  // the size of the fist, and the corner's brightest tone ended up on the one
  // part of the glove nobody is looking at.
  const cx = Math.round(x - ux * rr * 1.1);
  const cy = Math.round(y - uy * rr * 1.1);
  const cuff = Math.max(2, Math.round(rr * 0.8));
  rect(ctx, cx - cuff / 2, cy - cuff / 2, cuff, cuff, kit.gloveShade);
  rect(ctx, cx - cuff / 2, cy - cuff / 2 + Math.floor(cuff / 2), cuff, 1, kit.trim);
}

/* Damage pinned to the body. Each landed shot leaves a mark at its own zone,
 * and the marks stack: by the late rounds a man who has been taking body work
 * carries a red flank, and one who has been headhunted is cut over the eye. */
function drawDamage(
  ctx: CanvasRenderingContext2D,
  skel: Skeleton,
  h: number,
  v: Visual,
  ppm: number,
  to: (p: Vec) => Vec,
  bulk = 0,
) {
  if (!v.marks.length) return;
  // Fold the marks down to one blot per zone so the cost stays flat however
  // long the fight runs.
  const byZone = new Map<ImpactZone, number>();
  for (const mark of v.marks) {
    byZone.set(mark.zone, (byZone.get(mark.zone) ?? 0) + mark.weight);
  }
  for (const [zone, weight] of byZone) {
    if (zone === "guard") continue;
    const head = zoneIsHead(zone);
    // Read off the drawn skeleton and then routed through the fighter's own
    // local-to-screen map, so a mark stays welded to its anatomy while he
    // leans, crouches, turns or falls.
    const at = to(zoneOnSkeleton(skel, h, zone, bulk));
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    const size = Math.max(1, Math.round(Math.min(3, weight * 0.9)));
    ctx.globalAlpha = clamp(0.2 + weight * 0.18, 0.2, 0.72);
    rect(ctx, x - size / 2, y - size / 2, size, size, head ? "#a3252a" : "#8f2f2c");
    ctx.globalAlpha = 1;
    // A genuine cut once a head zone has taken real punishment: it opens, and it
    // runs down the face.
    if (head && weight > 2.4) {
      rect(ctx, x, y, 1, Math.max(1, Math.round(ppm * 0.09)), "#c2151b");
    }
  }
}

/* -------------------------------------------------------------------- effects */

function drawBursts(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  for (const burst of s.bursts) {
    const age = (s.time - burst.born) / burst.ttl;
    if (age > 1) continue;
    const x = Math.round(projectX(frame, burst.x, burst.depth));
    const y = Math.round(projectY(frame, burst.depth) - burst.y * frame.ppm * depthScale(burst.depth / RING_DEPTH_M));
    const k = depthScale(burst.depth / RING_DEPTH_M) * frame.ppm;

    if (burst.blocked) {
      // A block is a hard, short spark cone off the guard, not a starburst.
      const r = k * (0.09 + age * 0.1);
      ctx.globalAlpha = 1 - age;
      for (let i = 0; i < 5; i += 1) {
        const a = -0.9 + i * 0.45;
        const dx = Math.cos(a) * r * burst.dir;
        const dy = -Math.sin(a) * r;
        rect(ctx, x + dx, y + dy, 2, 2, i % 2 ? "#9fc7ea" : "#ffffff");
      }
      ctx.globalAlpha = 1;
      continue;
    }

    // Cel-stepped starburst: a hard white core, a coloured corona, and spikes
    // that snap out and die. Stepped in three frames rather than faded, which is
    // what makes it read as drawn animation instead of a particle system.
    const frameIndex = Math.min(2, Math.floor(age * 3.2));
    const grow = [0.55, 1, 0.72][frameIndex];
    // A quarter smaller on a phone, where the full starburst covers the very
    // head it is announcing the hit on.
    const shrink = s.mobile ? 0.75 : 1;
    const core = k * (0.05 + burst.power * 0.07) * grow * shrink;
    const spikes = burst.power > 0.8 ? 8 : 6;
    const reach = k * (0.14 + burst.power * 0.24) * grow * shrink;
    const alpha = 1 - age * 0.75;
    ctx.globalAlpha = alpha;

    const hotColor = burst.power > 0.8 ? "#fff3b0" : "#ffffff";
    const rimColor = burst.head ? "#ffd84a" : "#ff8a3c";

    for (let i = 0; i < spikes; i += 1) {
      const a = (i / spikes) * Math.PI * 2 + burst.seed * 0.7;
      const long = i % 2 === 0 ? reach : reach * 0.62;
      const ex = Math.cos(a) * long;
      const ey = Math.sin(a) * long * 0.85;
      limb(ctx, x, y, x + ex, y + ey, Math.max(1, core * 0.28), rimColor);
    }
    // Core last so it always sits on top of its own spikes.
    rect(ctx, x - core, y - core * 0.85, core * 2, core * 1.7, rimColor);
    rect(ctx, x - core * 0.62, y - core * 0.55, core * 1.24, core * 1.1, hotColor);

    // The line the punch came in on, so the direction of the shot is legible
    // even in a still frame.
    if (frameIndex === 0) {
      limb(ctx, x - burst.dir * reach * 1.3, y, x - burst.dir * reach * 0.5, y, Math.max(1, core * 0.3), hotColor);
    }
    ctx.globalAlpha = 1;
  }
}

function drawRipples(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  for (const r of s.ripples) {
    const age = (s.time - r.born) / r.ttl;
    if (age > 1) continue;
    const k = depthScale(r.depth / RING_DEPTH_M) * frame.ppm;
    const x = Math.round(projectX(frame, r.x, r.depth));
    const y = Math.round(projectY(frame, r.depth) - r.y * k);
    const rad = k * (0.1 + age * (0.5 + r.power * 0.55));
    ctx.globalAlpha = (1 - age) * 0.55 * r.power;
    // Shock ring, drawn as stepped points around an ellipse so it stays pixel
    // art rather than a stroked circle.
    const points = Math.max(10, Math.round(rad * 1.2));
    for (let i = 0; i < points; i += 1) {
      const a = (i / points) * Math.PI * 2;
      rect(ctx, x + Math.cos(a) * rad, y + Math.sin(a) * rad * 0.62, 1, 1, "#ffffff");
    }
    ctx.globalAlpha = 1;
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  for (const p of s.particles) {
    const k = depthScale(p.depth / RING_DEPTH_M) * frame.ppm;
    const x = Math.round(projectX(frame, p.x, p.depth));
    const y = Math.round(projectY(frame, p.depth) - p.y * k);
    const fade = 1 - p.life / p.max;
    ctx.globalAlpha = clamp(fade * 1.4, 0, 1);
    const size = p.blood ? 2 : 1;
    rect(ctx, x, y, size, size, p.color);
    ctx.globalAlpha = 1;
  }
}

function drawTags(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  for (const tag of s.tags) {
    const age = (s.time - tag.born) / tag.ttl;
    if (age > 1) continue;
    const k = depthScale(tag.depth / RING_DEPTH_M) * frame.ppm;
    const x = Math.round(projectX(frame, tag.x, tag.depth));
    const ground = projectY(frame, tag.depth);
    const baseY = Math.round(ground - tag.y * k);
    // The label floats clear above head height and the LEADER does the pointing.
    // Parked just above the impact it sits across both men's faces — hiding the
    // punch it is announcing — which is the opposite of the job.
    const rise = tag.rise * Math.min(1, age * 2.6);
    // Capped in metres, not left to grow with the lane: on the wide shot a
    // third shelf would float the callout up among the billboards, well clear
    // of the man it is about.
    const shelf = Math.min(2.12 + tag.lane * 0.28, 2.45) * k;
    const y = Math.round(Math.min(baseY - 12, ground - shelf) - rise);
    const alpha = age > 0.7 ? clamp((1 - age) / 0.3, 0, 1) : 1;

    // On a phone the buffer is barely two hundred pixels across and the glyphs
    // do not shrink with it, so a callout centred on the impact sits right
    // between the two men — over the very exchange it is calling. Pushed
    // toward the outer half of the frame it hangs in the empty air behind the
    // nearer man instead, and the leader still does the pointing.
    const push = s.mobile ? frame.width * 0.16 : 0;
    const half = textWidth(tag.text, tag.scale) / 2;
    const lx = push === 0
      ? x
      : Math.round(clamp(x + (x < frame.width / 2 ? -push : push), half + 2, frame.width - half - 2));

    // A dotted leader from the label down to the exact spot it is naming, ending
    // in a crosshair on it. This is the whole point of the tag: not "a punch
    // landed" but "it landed HERE". Stepped along the whole run rather than
    // dropped straight, because a pushed-out label makes it travel sideways too.
    ctx.globalAlpha = alpha * 0.8;
    const top = y + 9 * tag.scale;
    const drop = baseY - 3 - top;
    for (let ly = top; ly < baseY - 3; ly += 2) {
      rect(ctx, Math.round(lerp(lx, x, drop > 0 ? (ly - top) / drop : 1)), ly, 1, 1, tag.color);
    }
    rect(ctx, x - 2, baseY, 5, 1, tag.color);
    rect(ctx, x, baseY - 2, 1, 5, tag.color);
    ctx.globalAlpha = 1;

    drawPixelText(ctx, tag.text, lx, y, tag.scale, tag.color, {
      align: "center",
      outline: OUTLINE,
      alpha,
    });
    if (tag.sub) {
      drawPixelText(ctx, tag.sub, lx, y + 8 * tag.scale, 1, "#ffe9a8", {
        align: "center",
        outline: OUTLINE,
        alpha,
      });
    }
  }
}

/* ----------------------------------------------------------------------- HUD */

function drawHud(ctx: CanvasRenderingContext2D, s: Scene, frame: Frame) {
  const { width } = frame;
  const b = s.bout;

  // The clock plate is fixed — "COACHING" needs the full 52 — so the
  // nameplates take what is left of the buffer, not a hard 128. At the
  // desktop width the arithmetic lands on exactly 128; on a phone the buffer
  // is barely half of that and two 128-wide plates put the clock ON the
  // names and their bars.
  const cw = 52;
  if (s.hud === "full") {
    const plateW = Math.min(128, Math.floor((width - cw) / 2) - 5);
    drawNamePlate(ctx, 3, 3, plateW, s.profiles.blue.name, b.left, "blue", false);
    drawNamePlate(ctx, width - 3 - plateW, 3, plateW, s.profiles.red.name, b.right, "red", true);
  }

  // Round and clock, centred, on its own plate.
  const cx = Math.round(width / 2 - cw / 2);
  rect(ctx, cx - 1, 2, cw + 2, 22, OUTLINE);
  rect(ctx, cx, 3, cw, 20, "#0d1120");
  rect(ctx, cx, 3, cw, 1, "#2b3550");
  const betweenRounds = b.breakTime > 0;
  const clock = b.roundTime;
  const mins = Math.floor(Math.max(0, clock) / 60);
  const secs = Math.floor(Math.max(0, clock) % 60);
  drawPixelText(ctx, betweenRounds ? "CORNER" : `ROUND ${b.round}`, cx + cw / 2, 6, 1, "#94a7c4", {
    align: "center",
  });
  drawPixelText(
    ctx,
    betweenRounds ? "COACHING" : `${mins}:${String(secs).padStart(2, "0")}`,
    cx + cw / 2,
    14,
    1,
    clock <= 10 && !betweenRounds ? "#ff5545" : "#ffd75e",
    { align: "center" },
  );

  // Combo counter: rides on the corner that is landing.
  const comboAge = s.time - s.combo.at;
  if (s.combo.count > 1 && comboAge < COMBO_WINDOW_MS) {
    const alpha = clamp(1 - comboAge / COMBO_WINDOW_MS, 0, 1);
    const cornerX = s.combo.corner === "blue" ? 6 : width - 6;
    const align = (s.combo.corner === "blue" ? "left" : "right") as "left" | "right";
    // A brief pop on the frame it ticks over, then it settles — big enough to
    // catch the eye at the edge of frame, small enough to stay out of the ring.
    const pop = comboAge < 130 ? 2 : 1;
    const count = `${s.combo.count}`;
    const countW = textWidth(count, pop);
    drawPixelText(ctx, count, cornerX, 28, pop, "#ffffff", {
      align,
      outline: OUTLINE,
      alpha,
    });
    drawPixelText(
      ctx,
      "HIT COMBO",
      s.combo.corner === "blue" ? cornerX + countW + 4 : cornerX - countW - 4,
      28 + (pop - 1) * 4,
      1,
      "#ffd75e",
      { align, outline: OUTLINE, alpha },
    );
  }

  /* The round call over the stage at the bell, then the result at the end.
   *
   * Two phases on two clocks. ROUND N holds for as long as the men are actually
   * being held, which is simulation time and can be stretched by the broadcast
   * speed; FIGHT then runs on its own wall-clock window from the frame they are
   * released. Driving both off one offset from the bell is what used to make
   * the second phase unreachable. */
  const fightAge = s.banner.fightAt < 0 ? -1 : s.time - s.banner.fightAt;
  if (!b.finish && s.banner.at > -1e5) {
    const held = b.introSeconds > 0;
    const showing = held || (fightAge >= 0 && fightAge < 1100);
    if (showing) {
      const alpha = held || fightAge < 700 ? 1 : clamp((1100 - fightAge) / 400, 0, 1);
      const y = Math.round(frame.height * 0.3);
      drawPixelText(ctx, held ? `ROUND ${s.banner.round}` : "FIGHT", width / 2, y, 2, "#ffe45c", {
        align: "center",
        outline: OUTLINE,
        shadow: "#00000088",
        alpha,
      });
    }
  }

  const countedFighter = b.left.downCountSeconds > 0
    ? b.left
    : b.right.downCountSeconds > 0
      ? b.right
      : null;
  if (countedFighter && !b.finish) {
    const count = Math.min(10, Math.max(1, Math.ceil(countedFighter.downCountSeconds)));
    const beat = countedFighter.downCountSeconds % 1;
    const alpha = beat < 0.18 ? 1 : beat < 0.3 ? 0.42 : 0.94;
    const scale = count === 10 ? 5 : beat < 0.18 ? 7 : 6;
    const y = Math.round(frame.height * 0.28);
    drawPixelText(ctx, "REFEREE COUNT", width / 2, y - 13, 1, "#ffe9c4", {
      align: "center",
      outline: OUTLINE,
      shadow: "#00000088",
      alpha,
    });
    drawPixelText(ctx, String(count), width / 2, y, scale, count >= 8 ? "#ff5545" : "#ffe45c", {
      align: "center",
      outline: OUTLINE,
      shadow: "#00000088",
      alpha,
    });
  }

  /* The result, and the ONLY copy of it. There used to be a second one in the
   * DOM on top of this — a different font, a different size, a different place
   * in the frame — and the two read as one graphic failing to load. */
  if (b.finish) {
    const y = Math.round(frame.height * 0.3);
    drawPixelText(ctx, b.finish === "KO" ? "K.O." : b.finish.toUpperCase(), width / 2, y, 3, "#ff4b3c", {
      align: "center",
      outline: OUTLINE,
      shadow: "#00000088",
    });
    // Winner and finish underneath, in the same face as everything else on the
    // stage. The corner is resolved off the fighter ids rather than assumed.
    const winnerCorner: Corner | null =
      b.winnerId && b.winnerId === b.left.fighterId
        ? "blue"
        : b.winnerId && b.winnerId === b.right.fighterId
          ? "red"
          : null;
    const cause = (b.left.knockout ? b.left : b.right).knockoutCause;
    const line = winnerCorner
      ? `${s.profiles[winnerCorner].name.toUpperCase()} WINS${
          b.finish === "KO" && cause && cause !== "none" ? ` - ${cause.toUpperCase()}` : ""
        }`
      : "DRAW";
    drawPixelText(ctx, line, width / 2, y + 26, 1, "#ffe9c4", {
      align: "center",
      outline: OUTLINE,
      shadow: "#00000088",
    });
  }
}

function drawNamePlate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  name: string,
  f: BoutFighter,
  corner: Corner,
  mirror: boolean,
) {
  const accent = corner === "blue" ? "#2fb9ec" : "#f0921c";
  rect(ctx, x - 1, y - 1, w + 2, 22, OUTLINE);
  rect(ctx, x, y, w, 20, "#0d1120");
  rect(ctx, x, y, w, 1, accent);

  // Clipped to the plate as well as to twelve: a narrow plate keeps whole
  // glyphs inside its border instead of printing across the clock.
  const label = name.toUpperCase().slice(0, Math.min(12, Math.floor((w - 5) / 6)));
  drawPixelText(ctx, label, mirror ? x + w - 3 : x + 3, y + 3, 1, "#e6eef8", {
    align: mirror ? "right" : "left",
  });

  // Two bars: condition over stamina. Damage drains from the far end so the two
  // plates read as a mirrored pair.
  const barX = x + 3;
  const barW = w - 6;
  const bars: { value: number; fill: string; back: string }[] = [
    { value: f.health / 100, fill: accent, back: "#1b2338" },
    { value: f.stamina / 100, fill: "#e8c250", back: "#221d16" },
  ];
  bars.forEach((bar, index) => {
    const by = y + 12 + index * 4;
    rect(ctx, barX, by, barW, 3, bar.back);
    const filled = Math.round(barW * clamp(bar.value, 0, 1));
    rect(ctx, mirror ? barX + barW - filled : barX, by, filled, 3, bar.fill);
    // A lit top line on the bar so it does not read as a flat block.
    rect(ctx, mirror ? barX + barW - filled : barX, by, filled, 1, "#ffffff44");
  });
}

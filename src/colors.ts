/**
 * Deterministic pastel colors.
 *
 * Each Discord user ID is hashed to a hue, and the hash bits are also used
 * to jitter saturation/lightness so the palette doesn't look uniform.
 * The same user always gets the same color, even across bot restarts.
 */

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) =>
    lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Returns a random-looking but stable pastel hex color for a seed (user id). */
export function pastelFor(seed: string): string {
  const h = fnv1a(seed);
  const hue = h % 360;
  const sat = 62 + ((h >>> 9) % 18); // 62 – 79 %
  const light = 74 + ((h >>> 17) % 10); // 74 – 83 %
  return hslToHex(hue, sat, light);
}
/** Minimum HSL lightness (0–100) for colors drawn on the dark story background. */
const MIN_LIGHTNESS = 72;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l * 100]; // grey

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;

  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/**
 * Takes a Discord role color (24-bit integer) and returns a hex color that is
 * readable on a dark background: hue is preserved, lightness is raised to at
 * least MIN_LIGHTNESS, and very washed-out colors get a little saturation back.
 */
export function brightenRoleColor(colorInt: number): string {
  const r = (colorInt >> 16) & 0xff;
  const g = (colorInt >> 8) & 0xff;
  const b = colorInt & 0xff;

  const [h, s, l] = rgbToHsl(r, g, b);
  const lightness = Math.max(l, MIN_LIGHTNESS);
  // Pure greys stay grey; anything else keeps its saturation (min 45%) so
  // brightening doesn't turn it into a flat white.
  const saturation = s === 0 ? 0 : Math.max(s, 45);

  return hslToHex(h, saturation, lightness);
}
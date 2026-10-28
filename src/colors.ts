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
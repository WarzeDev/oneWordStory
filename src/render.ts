import {
  createCanvas,
  loadImage,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";

export interface RenderWord {
  text: string;
  color: string;
  avatarUrl: string;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const avatarCache = new Map<string, Image>();

async function getAvatar(url: string): Promise<Image | null> {
  const cached = avatarCache.get(url);
  if (cached) return cached;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const image = await loadImage(buffer);
    avatarCache.set(url, image);
    return image;
  } catch {
    return null; // callers fall back to a colored disc
  }
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Live story card                                                     */
/* ------------------------------------------------------------------ */

const IMG_W = 900;
const PAD = 40;
const GAP = 10;        // was 18 — tighter horizontal spacing
const AVATAR = 44;
const AVATAR_GAP = 10;
const FONT_SIZE = 30;
const TEXT_H = Math.round(FONT_SIZE * 1.3);
const ROW_H = AVATAR + AVATAR_GAP + TEXT_H;
const ROW_GAP = 18;    // was 22 — tighter row spacing
const FONT = `600 ${FONT_SIZE}px sans-serif`;

/**
 * Renders the story so far: every word sits under a small circular avatar,
 * painted in that user's pastel color.
 */
export async function renderStoryImage(words: RenderWord[]): Promise<Buffer> {
  const measure = createCanvas(1, 1).getContext("2d");
  measure.font = FONT;

  const blocks = words.map((word) => {
    const textWidth = Math.ceil(measure.measureText(word.text).width);
    return { word, width: Math.max(AVATAR, textWidth) + 10 };
  });

  // --- flow blocks into rows ---
  const maxRowWidth = IMG_W - PAD * 2;
  const rows: (typeof blocks)[] = [];
  let row: typeof blocks = [];
  let rowWidth = 0;

  for (const block of blocks) {
    const extra = row.length ? GAP + block.width : block.width;
    if (row.length && rowWidth + extra > maxRowWidth) {
      rows.push(row);
      row = [block];
      rowWidth = block.width;
    } else {
      row.push(block);
      rowWidth += extra;
    }
  }
  if (row.length) rows.push(row);

  const imgH = Math.max(
    200,
    PAD * 2 + rows.length * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP,
  );

  const canvas = createCanvas(IMG_W, imgH);
  const ctx = canvas.getContext("2d");

  // Background card
  ctx.fillStyle = "#15161a";
  roundRect(ctx, 0, 0, IMG_W, imgH, 24);
  ctx.fill();

  // Preload avatars in parallel
  const uniqueUrls = [...new Set(blocks.map((b) => b.word.avatarUrl))];
  const loaded = await Promise.all(uniqueUrls.map((u) => getAvatar(u)));
  const avatars = new Map(uniqueUrls.map((url, i) => [url, loaded[i]]));

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  let y = PAD;

  for (const currentRow of rows) {
    let x = PAD;

    for (const block of currentRow) {
      const { word } = block;
      const cx = x + block.width / 2;
      const cy = y + AVATAR / 2;
      const avatar = avatars.get(word.avatarUrl) ?? null;

      // Circular avatar (clipped) — no colored ring
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, AVATAR / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      if (avatar) {
        ctx.drawImage(avatar, cx - AVATAR / 2, y, AVATAR, AVATAR);
      } else {
        ctx.fillStyle = word.color;
        ctx.fillRect(cx - AVATAR / 2, y, AVATAR, AVATAR);
      }
      ctx.restore();

      // The word itself
      ctx.fillStyle = word.color;
      ctx.font = FONT;
      ctx.fillText(word.text, cx, y + AVATAR + AVATAR_GAP);

      x += block.width + GAP;
    }

    y += ROW_H + ROW_GAP;
  }

  return canvas.toBuffer("image/png");
}

/* ------------------------------------------------------------------ */
/* Finished story — rendered on a flat, simple book                    */
/* ------------------------------------------------------------------ */

const BOOK_IMG_W = 960;
const BOOK_IMG_H = 680;

/**
 * Renders the finished story on a flat, clean book.
 * No avatars, no per-word colors — just plain ink on cream pages,
 * inside a burgundy cover.
 */
export function renderBookImage(words: RenderWord[]): Buffer {
  const canvas = createCanvas(BOOK_IMG_W, BOOK_IMG_H);
  const ctx = canvas.getContext("2d");

  // Backdrop card
  ctx.fillStyle = "#15161a";
  roundRect(ctx, 0, 0, BOOK_IMG_W, BOOK_IMG_H, 24);
  ctx.fill();

  // --- book geometry ---
  const bookW = 800;
  const bookH = 500;
  const bx = (BOOK_IMG_W - bookW) / 2;
  const by = (BOOK_IMG_H - bookH) / 2;
  const coverRadius = 14;

  // --- flat burgundy cover ---
  ctx.fillStyle = "#5a2c2c";
  roundRect(ctx, bx, by, bookW, bookH, coverRadius);
  ctx.fill();

  // Subtle darker edge so the cover reads as a shape, not a blob
  ctx.strokeStyle = "#3b1c1c";
  ctx.lineWidth = 2;
  roundRect(ctx, bx + 1, by + 1, bookW - 2, bookH - 2, coverRadius - 1);
  ctx.stroke();

  // --- cream page area, inset from the cover ---
  const inset = 16;
  const px = bx + inset;
  const py = by + inset;
  const pw = bookW - inset * 2;
  const ph = bookH - inset * 2;
  const pageRadius = 6;

  ctx.fillStyle = "#f7eed9";
  roundRect(ctx, px, py, pw, ph, pageRadius);
  ctx.fill();

  // --- thin spine line down the middle ---
  const spineX = Math.round(px + pw / 2) + 0.5;
  ctx.strokeStyle = "rgba(90, 44, 44, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(spineX, py + 24);
  ctx.lineTo(spineX, py + ph - 24);
  ctx.stroke();

  // --- text layout: two columns, left then right ---
  const padX = 40;
  const padY = 40;
  const gutter = 32;
  const colW = (pw - padX * 2 - gutter) / 2;
  const maxTextH = ph - padY * 2;
  const story = words.map((w) => w.text).join(" ");

  // Shrink the font until the whole story fits across both columns.
  let size = 22;
  let lineHeight = Math.round(size * 1.6);
  ctx.font = `${size}px Georgia, "Times New Roman", serif`;
  let lines = wrapLines(ctx, story, colW);

  while (size > 9) {
    const perPage = Math.max(1, Math.floor(maxTextH / lineHeight));
    if (lines.length <= perPage * 2) break;
    size--;
    lineHeight = Math.round(size * 1.6);
    ctx.font = `${size}px Georgia, "Times New Roman", serif`;
    lines = wrapLines(ctx, story, colW);
  }

  const perPage = Math.max(1, Math.floor(maxTextH / lineHeight));

  ctx.font = `${size}px Georgia, "Times New Roman", serif`;
  ctx.fillStyle = "#3a2e22";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const leftX = px + padX;
  const rightX = px + padX + colW + gutter;

  lines.slice(0, perPage).forEach((line, i) => {
    ctx.fillText(line, leftX, py + padY + i * lineHeight);
  });
  lines.slice(perPage, perPage * 2).forEach((line, i) => {
    ctx.fillText(line, rightX, py + padY + i * lineHeight);
  });

  return canvas.toBuffer("image/png");
}
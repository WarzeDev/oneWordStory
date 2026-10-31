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

export interface RenderTitle {
  /** The whole title as plain text (used on the finished book). */
  text: string;
  /** One entry per title word, each with its own author avatar. */
  words: RenderWord[];
}

export interface RenderContributor {
  color: string;
  avatarUrl: string;
  wordCount: number;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

// Bounded avatar cache: memory leaks are bad, especially on a public bot.
const AVATAR_CACHE_MAX = 500;
const avatarCache = new Map<string, Image>();

async function getAvatar(url: string): Promise<Image | null> {
  const cached = avatarCache.get(url);
  if (cached) {
    // refresh LRU position
    avatarCache.delete(url);
    avatarCache.set(url, cached);
    return cached;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const image = await loadImage(buffer);

    if (avatarCache.size >= AVATAR_CACHE_MAX) {
      const oldest = avatarCache.keys().next().value;
      if (oldest) avatarCache.delete(oldest);
    }
    avatarCache.set(url, image);
    return image;
  } catch {
    return null;
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

function drawAvatar(
  ctx: SKRSContext2D,
  image: Image | null,
  cx: number,
  cy: number,
  radius: number,
  fallbackColor: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (image) {
    ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Live story card                                                     */
/* ------------------------------------------------------------------ */

const IMG_W = 900;
const PAD = 40;
const GAP = 10;
const AVATAR_GAP = 10;
const ROW_GAP = 18;

interface BlockStyle {
  avatar: number;
  font: string;
  textH: number;
  /** Fixed text color; falls back to each word's own color. */
  textColor?: string;
}

const WORD_STYLE: BlockStyle = {
  avatar: 44,
  font: `600 30px sans-serif`,
  textH: Math.round(30 * 1.3),
};

const TITLE_STYLE: BlockStyle = {
  avatar: 44,
  font: `700 40px sans-serif`,
  textH: Math.round(40 * 1.3),
  textColor: "#f4f0e6",
};

const TITLE_GAP = 26;

const rowHeight = (style: BlockStyle) =>
  style.avatar + AVATAR_GAP + style.textH;

interface Block {
  word: RenderWord;
  width: number;
}

/** Flows words (avatar on top, text below) left-to-right into wrapped rows. */
function layoutBlocks(
  measure: SKRSContext2D,
  words: RenderWord[],
  style: BlockStyle,
): Block[][] {
  measure.font = style.font;
  const blocks: Block[] = words.map((word) => {
    const textWidth = Math.ceil(measure.measureText(word.text).width);
    return { word, width: Math.max(style.avatar, textWidth) + 10 };
  });

  const maxRowWidth = IMG_W - PAD * 2;
  const rows: Block[][] = [];
  let row: Block[] = [];
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
  return rows;
}

/** Total height of laid-out rows (no trailing gap). */
function rowsHeight(rows: Block[][], style: BlockStyle): number {
  return rows.length > 0
    ? rows.length * rowHeight(style) + (rows.length - 1) * ROW_GAP
    : 0;
}

/** Draws rows starting at `y`; returns the y after the last row (incl. gap). */
function drawRows(
  ctx: SKRSContext2D,
  rows: Block[][],
  avatars: Map<string, Image | null>,
  startY: number,
  style: BlockStyle,
): number {
  let y = startY;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const currentRow of rows) {
    let x = PAD;
    for (const block of currentRow) {
      const { word } = block;
      const cx = x + block.width / 2;
      const cy = y + style.avatar / 2;

      drawAvatar(
        ctx,
        avatars.get(word.avatarUrl) ?? null,
        cx,
        cy,
        style.avatar / 2,
        word.color,
      );

      ctx.fillStyle = style.textColor ?? word.color;
      ctx.font = style.font;
      ctx.fillText(word.text, cx, y + style.avatar + AVATAR_GAP);

      x += block.width + GAP;
    }
    y += rowHeight(style) + ROW_GAP;
  }
  return y;
}

/**
 * Renders the live story card: an optional title (every title word sits under
 * its author's avatar, in large cream letters), a divider, then the story
 * words, each under a small circular avatar and painted in that user's color.
 */
export async function renderStoryImage(
  title: RenderTitle | null,
  words: RenderWord[],
): Promise<Buffer> {
  const measure = createCanvas(1, 1).getContext("2d");

  const titleRows = title ? layoutBlocks(measure, title.words, TITLE_STYLE) : [];
  const bodyRows = layoutBlocks(measure, words, WORD_STYLE);

  const titleH =
    titleRows.length > 0 ? rowsHeight(titleRows, TITLE_STYLE) + TITLE_GAP : 0;
  const bodyH = rowsHeight(bodyRows, WORD_STYLE);

  const imgH = Math.max(200, PAD * 2 + titleH + bodyH);

  const canvas = createCanvas(IMG_W, imgH);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#15161a";
  roundRect(ctx, 0, 0, IMG_W, imgH, 24);
  ctx.fill();

  // Preload avatars in parallel
  const uniqueUrls = new Set<string>();
  for (const w of words) uniqueUrls.add(w.avatarUrl);
  if (title) for (const w of title.words) uniqueUrls.add(w.avatarUrl);
  const loaded = await Promise.all(
    [...uniqueUrls].map(async (u) => [u, await getAvatar(u)] as const),
  );
  const avatars = new Map<string, Image | null>(loaded);

  let y = PAD;

  // --- title (avatar above every word) ---
  if (titleRows.length > 0) {
    drawRows(ctx, titleRows, avatars, y, TITLE_STYLE);
    y += titleH;

    // Divider
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y - TITLE_GAP / 2 + 1);
    ctx.lineTo(IMG_W - PAD, y - TITLE_GAP / 2 + 1);
    ctx.stroke();
  }

  // --- story words ---
  drawRows(ctx, bodyRows, avatars, y, WORD_STYLE);

  return canvas.toBuffer("image/png");
}

/* ------------------------------------------------------------------ */
/* Finished story — rendered on a flat, simple book                    */
/* ------------------------------------------------------------------ */

const BOOK_IMG_W = 960;
const BOOK_IMG_H = 720;

/**
- Renders the finished story on a flat, clean book.
- Title in large letters at the top of the first page, then plain ink body,
- then a contributor bar at the bottom with avatars + percentages.
 */
export async function renderBookImage(
  title: RenderTitle | null,
  words: RenderWord[],
  contributors: RenderContributor[],
): Promise<Buffer> {
  const canvas = createCanvas(BOOK_IMG_W, BOOK_IMG_H);
  const ctx = canvas.getContext("2d");

  // Preload contributor avatars in parallel
  const loaded = await Promise.all(
    contributors.map(
      async (c) => [c.avatarUrl, await getAvatar(c.avatarUrl)] as const,
    ),
  );
  const avatars = new Map<string, Image | null>(loaded);

  // Backdrop
  ctx.fillStyle = "#15161a";
  roundRect(ctx, 0, 0, BOOK_IMG_W, BOOK_IMG_H, 24);
  ctx.fill();

  // --- book geometry ---
  const bookW = 800;
  const bookH = 500;
  const bx = (BOOK_IMG_W - bookW) / 2;
  const by = 70; // leave room at the top
  const coverRadius = 14;

  // --- flat burgundy cover ---
  ctx.fillStyle = "#5a2c2c";
  roundRect(ctx, bx, by, bookW, bookH, coverRadius);
  ctx.fill();
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

  // --- spine line ---
  const spineX = Math.round(px + pw / 2) + 0.5;
  ctx.strokeStyle = "rgba(90, 44, 44, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(spineX, py + 24);
  ctx.lineTo(spineX, py + ph - 24);
  ctx.stroke();

  const padX = 40;
  const padY = 40;
  const gutter = 32;
  const colW = (pw - padX * 2 - gutter) / 2;

  // --- title at the top of the first page (left side) ---
  let titleH = 0;
  const leftPageCenterX = px + padX + colW / 2;

  if (title?.text) {
    const maxTitleW = colW;
    let titleFont = `700 26px Georgia, "Times New Roman", serif`;
    ctx.font = titleFont;
    let titleLines = wrapLines(ctx, title.text, maxTitleW);
    let size = 26;
    // Shrink if the title wraps to more than 3 lines
    while (titleLines.length > 3 && size > 14) {
      size--;
      titleFont = `700 ${size}px Georgia, "Times New Roman", serif`;
      ctx.font = titleFont;
      titleLines = wrapLines(ctx, title.text, maxTitleW);
    }
    const lineH = Math.round(size * 1.3);
    titleH = titleLines.length * lineH + 24;

    ctx.fillStyle = "#3a2e22";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    titleLines.forEach((line, i) => {
      ctx.fillText(
        line,
        leftPageCenterX,
        py + padY - 4 + i * lineH,
      );
    });

    // underline restricted to the first page width
    const underlineY = py + padY - 4 + titleLines.length * lineH + 6;
    ctx.strokeStyle = "rgba(90, 44, 44, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(leftPageCenterX - 60, underlineY);
    ctx.lineTo(leftPageCenterX + 60, underlineY);
    ctx.stroke();
  }

  // --- body text ---
  const leftBodyTop = py + padY + titleH;
  const rightBodyTop = py + padY;
  const story = words.map((w) => w.text).join(" ");

  let size = 22;
  let lineHeight = Math.round(size * 1.55);
  ctx.font = `${size}px Georgia, "Times New Roman", serif`;
  let lines = wrapLines(ctx, story, colW);

  let leftMaxH = ph - padY * 2 - titleH;
  let rightMaxH = ph - padY * 2;
  let leftPerPage = Math.max(1, Math.floor(leftMaxH / lineHeight));
  let rightPerPage = Math.max(1, Math.floor(rightMaxH / lineHeight));

  while (size > 9) {
    leftMaxH = ph - padY * 2 - titleH;
    rightMaxH = ph - padY * 2;
    leftPerPage = Math.max(1, Math.floor(leftMaxH / lineHeight));
    rightPerPage = Math.max(1, Math.floor(rightMaxH / lineHeight));

    if (lines.length <= leftPerPage + rightPerPage) break;
    size--;
    lineHeight = Math.round(size * 1.55);
    ctx.font = `${size}px Georgia, "Times New Roman", serif`;
    lines = wrapLines(ctx, story, colW);
  }

  leftMaxH = ph - padY * 2 - titleH;
  rightMaxH = ph - padY * 2;
  leftPerPage = Math.max(1, Math.floor(leftMaxH / lineHeight));
  rightPerPage = Math.max(1, Math.floor(rightMaxH / lineHeight));

  ctx.font = `${size}px Georgia, "Times New Roman", serif`;
  ctx.fillStyle = "#3a2e22";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const leftX = px + padX;
  const rightX = px + padX + colW + gutter;

  lines.slice(0, leftPerPage).forEach((line, i) => {
    ctx.fillText(line, leftX, leftBodyTop + i * lineHeight);
  });
  lines.slice(leftPerPage, leftPerPage + rightPerPage).forEach((line, i) => {
    ctx.fillText(line, rightX, rightBodyTop + i * lineHeight);
  });

  // --- contributor bar at the bottom ---
  await drawContributorBar(ctx, contributors, avatars, by + bookH + 20);

  return canvas.toBuffer("image/png");
}

async function drawContributorBar(
  ctx: SKRSContext2D,
  contributors: RenderContributor[],
  avatars: Map<string, Image | null>,
  barTop: number,
): Promise<void> {
  if (contributors.length === 0) return;

  const barH = 64;
  const barX = 40;
  const barW = BOOK_IMG_W - barX * 2;

  // background bar
  ctx.fillStyle = "#1f2026";
  roundRect(ctx, barX, barTop, barW, barH, 16);
  ctx.fill();

  // stacked proportional color bar
  const totalWords = contributors.reduce((a, c) => a + c.wordCount, 0);
  const innerPad = 8;
  const barInnerX = barX + innerPad;
  const barInnerY = barTop + barH - 16;
  const barInnerW = barW - innerPad * 2;
  const barInnerH = 8;

  // track
  ctx.fillStyle = "#2a2b33";
  roundRect(ctx, barInnerX, barInnerY, barInnerW, barInnerH, 4);
  ctx.fill();

  let cursor = barInnerX;
  for (const c of contributors) {
    const w = (c.wordCount / totalWords) * barInnerW;
    if (w <= 0) continue;
    ctx.fillStyle = c.color;
    // Only round the outer edges of the whole stack, keep internal seams flush.
    ctx.fillRect(cursor, barInnerY, w, barInnerH);
    cursor += w;
  }

  // top of the bar: avatars + percentages grouped together
  const topY = barTop + 8;
  const avatarR = 14;
  const avatarDiameter = avatarR * 2;
  const avatarY = topY + avatarR;
  const maxItems = Math.min(contributors.length, 12);

  const percentages = contributors.map((c) =>
    Math.round((c.wordCount / totalWords) * 100),
  );

  ctx.font = `600 13px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  let x = barX + 20;
  const rightLimit = barX + barW - 40;

  for (let i = 0; i < maxItems; i++) {
    const c = contributors[i]!;
    const label = `${percentages[i]}%`;
    const labelW = ctx.measureText(label).width;

    // Total width required for this avatar + percentage pair plus spacing
    const itemWidth = avatarDiameter + 6 + 12 + labelW + 14;
    if (x + itemWidth > rightLimit && i > 0) break;

    // 1. Draw Avatar
    drawAvatar(
      ctx,
      avatars.get(c.avatarUrl) ?? null,
      x + avatarR,
      avatarY,
      avatarR,
      c.color,
    );
    x += avatarDiameter + 6;

    // 2. Draw Percentage & Color Chip
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(x + 4, avatarY, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#d8dae0";
    ctx.fillText(label, x + 12, avatarY);

    // Advance x for the next pair
    x += 12 + labelW + 14;
  }
}
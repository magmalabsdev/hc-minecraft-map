import type { SnakeLayout, StopPosition } from "./routeMapLayout";
import { MAX_TRANSFERS_SHOWN } from "./routeMapLayout";
import { MINECRAFT_ICONS } from "../icons/minecraftIcons";

const MC_FONT = '"Minecraft", ui-monospace, monospace';
const BG_COLOR = "#d8d8d8";

/** Creates a `(text, fontPx) => width` measurer backed by a scratch canvas,
 *  for use by `computeSnakeLayout` before the real canvas is drawn. */
export function createMeasureText(): (text: string, fontPx: number) => number {
  const ctx = document.createElement("canvas").getContext("2d");
  return (text: string, fontPx: number) => {
    if (!ctx) return text.length * fontPx * 0.6; // fallback estimate
    ctx.font = `${fontPx}px ${MC_FONT}`;
    return ctx.measureText(text).width;
  };
}

let minecartIcon: HTMLImageElement | null = null;
function loadMinecartIcon(): Promise<HTMLImageElement | null> {
  if (minecartIcon) return Promise.resolve(minecartIcon);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      minecartIcon = img;
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = MINECRAFT_ICONS.minecart;
  });
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  pos: StopPosition,
  layout: SnakeLayout,
  icon: HTMLImageElement | null,
): void {
  const { stop, x, y, isTerminal } = pos;
  const planned = stop.stop.station.built === false;
  const size = stop.transferLines.length > 0 ? layout.badgeSize : layout.dotSize;
  const half = size / 2;
  const left = Math.round(x - half);
  const top = Math.round(y - half);

  ctx.save();
  if (planned) ctx.globalAlpha = 0.55;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(left, top, size, size);

  ctx.lineWidth = Math.max(1, Math.round(layout.strokeWidth * 0.4));
  ctx.strokeStyle = "#20242b";
  if (planned) ctx.setLineDash([Math.max(2, size * 0.15), Math.max(2, size * 0.15)]);
  ctx.strokeRect(left + 0.5, top + 0.5, size - 1, size - 1);
  if (isTerminal && stop.transferLines.length > 0) {
    // Double outline distinguishes a terminal transfer stop from an
    // intermediate one, without printing extra role-label text.
    const inset = Math.max(2, Math.round(size * 0.15));
    ctx.strokeRect(left + inset, top + inset, size - inset * 2, size - inset * 2);
  }
  ctx.setLineDash([]);

  if (stop.transferLines.length > 0) {
    const iconH = Math.round(size * 0.55);
    if (icon) {
      const prevSmoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(icon, left + 2, top + 2, size - 4, iconH - 2);
      ctx.imageSmoothingEnabled = prevSmoothing;
    }
    const swatchTop = top + iconH + 2;
    const swatchH = Math.max(2, top + size - swatchTop - 2);
    const shown = stop.transferLines.slice(0, MAX_TRANSFERS_SHOWN);
    const swatchW = (size - 4) / Math.max(1, shown.length);
    shown.forEach((line, i) => {
      ctx.fillStyle = line.color ?? "#888888";
      ctx.fillRect(Math.round(left + 2 + i * swatchW), swatchTop, Math.ceil(swatchW), swatchH);
    });
  }

  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, pos: StopPosition, layout: SnakeLayout): void {
  const { stop, x, y } = pos;
  const size = stop.transferLines.length > 0 ? layout.badgeSize : layout.dotSize;
  let ly = Math.round(y + size / 2 + layout.labelGap + layout.lineHeightPx * 0.8);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.font = `bold ${layout.fontPx}px ${MC_FONT}`;
  ctx.fillStyle = "#1a1a1a";
  ctx.fillText(stop.stop.station.name, Math.round(x), ly);
  ly += layout.lineHeightPx;

  const shown = stop.transferLines.slice(0, MAX_TRANSFERS_SHOWN);
  if (shown.length > 0) {
    ctx.font = `${layout.fontPx}px ${MC_FONT}`;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText("Transfer to", Math.round(x), ly);
    ly += layout.lineHeightPx;
    for (const line of shown) {
      ctx.fillStyle = line.color ?? "#333333";
      ctx.fillText(line.name, Math.round(x), ly);
      ly += layout.lineHeightPx;
    }
  }
}

/** Route name + termini, centered at the top of the canvas. `isLoop` reflects
 *  the route's actual shape (first and last node coincide) — the displayed
 *  first/last *stops* are normally two different stations even for a loop
 *  (the duplicate closing node is dropped), so that can't be inferred from
 *  the stop list itself. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  layout: SnakeLayout,
  routeName: string,
  routeColor: string,
  isLoop: boolean,
): void {
  const positions = layout.stopPositions;
  if (positions.length === 0) return;
  const first = positions[0].stop.stop.station.name;
  const last = positions[positions.length - 1].stop.stop.station.name;
  const termini = isLoop ? "⟳ Loop line" : `${first} ↔ ${last}`;

  const cx = Math.round(canvasWidth / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.font = `bold ${layout.titleFontPx}px ${MC_FONT}`;
  ctx.fillStyle = routeColor;
  ctx.fillText(routeName, cx, Math.round(layout.labelGap + layout.titleLineHeight * 0.8));

  ctx.font = `${layout.fontPx}px ${MC_FONT}`;
  ctx.fillStyle = "#3a3a3a";
  ctx.fillText(termini, cx, Math.round(layout.labelGap + layout.titleLineHeight + layout.lineHeightPx * 0.8));
}

/** Draws a full route-map diagram onto `canvas`, sized exactly to
 *  `layout`'s footprint (the caller sets canvas.width/height beforehand). */
export async function renderRouteMapCanvas(
  canvas: HTMLCanvasElement,
  layout: SnakeLayout,
  opts: { routeColor: string; routeName: string; isLoop: boolean },
): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Make sure the bitmap font is actually ready before any text metrics or
  // fillText calls, even though the app already loads it globally.
  const fontSpec = `${layout.fontPx}px ${MC_FONT}`;
  try {
    await document.fonts.load(fontSpec);
    await document.fonts.ready;
  } catch {
    // best-effort; fall back to whatever font is available
  }
  const icon = await loadMinecartIcon();

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (layout.stopPositions.length === 0) return;

  // The connected line: straight within a row, U-turn arcs between rows.
  ctx.beginPath();
  layout.stopPositions.forEach((p, i) => {
    if (i === 0) {
      ctx.moveTo(p.x, p.y);
      return;
    }
    const prev = layout.stopPositions[i - 1];
    if (p.row === prev.row) {
      ctx.lineTo(p.x, p.y);
    } else {
      const turn = layout.turns[prev.row];
      if (turn) {
        ctx.arc(turn.cx, turn.cy, turn.r, turn.fromAngle, turn.toAngle, turn.anticlockwise);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
  });
  ctx.strokeStyle = opts.routeColor;
  ctx.lineWidth = layout.strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  for (const pos of layout.stopPositions) drawBadge(ctx, pos, layout, icon);
  for (const pos of layout.stopPositions) drawLabel(ctx, pos, layout);
  drawTitle(ctx, canvas.width, layout, opts.routeName, opts.routeColor, opts.isLoop);
}

export function slugifyRouteName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "route";
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

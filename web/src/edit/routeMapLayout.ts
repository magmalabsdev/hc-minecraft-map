import type { Route, RouteStop } from "@hcmap/shared";

/** A route stop plus the other lines it transfers to (already filtered by
 *  whether planned-only transfers should be included). */
export interface LabeledStop {
  stop: RouteStop;
  transferLines: Route[];
}

export interface StopPosition {
  stop: LabeledStop;
  x: number;
  y: number;
  row: number;
  isTerminal: boolean;
}

/** A semicircular U-turn connecting the last stop of one row to the first
 *  stop of the next. Angles are in the same coordinate space as `x`/`y`
 *  (canvas 2D: +y is down), consumed directly by `ctx.arc(cx, cy, r,
 *  fromAngle, toAngle, anticlockwise)`. */
export interface TurnArc {
  cx: number;
  cy: number;
  r: number;
  fromAngle: number;
  toAngle: number;
  anticlockwise: boolean;
}

export interface SnakeLayout {
  stopPositions: StopPosition[];
  turns: TurnArc[];
  fontPx: number;
  dotSize: number;
  badgeSize: number;
  strokeWidth: number;
  lineHeightPx: number;
  labelGap: number;
  /** Font size and line height for the title (route name) drawn at the top. */
  titleFontPx: number;
  titleLineHeight: number;
  /** Total vertical space reserved at the top for the title + termini. */
  titleHeight: number;
  warnings: string[];
}

export interface Footprint {
  width: number;
  height: number;
}

export const MAX_TRANSFERS_SHOWN = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Lay out an ordered list of route stops as a "snake" (boustrophedon): rows
 * of stops alternating left-to-right / right-to-left, connected by U-turn
 * arcs, sized to fit within `footprint` (pixels = blocks, 1:1). More rows
 * means shorter rows, which is how this "covers more stations over less
 * space" than a single straight line would.
 */
export function computeSnakeLayout(
  stops: LabeledStop[],
  footprint: Footprint,
  measureText: (text: string, fontPx: number) => number,
): SnakeLayout {
  const { width, height } = footprint;
  const warnings: string[] = [];

  const fontPx = clamp(Math.round(Math.min(width, height) / 20), 6, 16);
  const lineHeightPx = Math.round(fontPx * 1.4);
  const dotSize = Math.max(4, Math.round(fontPx * 0.8));
  const badgeSize = Math.max(dotSize + 6, Math.round(fontPx * 2.2));
  const strokeWidth = Math.max(2, Math.round(fontPx * 0.5));
  const labelGap = Math.round(fontPx * 0.6);
  // Title (route name + termini) sits above the diagram in a slightly larger
  // font, so it reads as a heading rather than another station label.
  const titleFontPx = clamp(Math.round(fontPx * 1.3), 7, 20);
  const titleLineHeight = Math.round(titleFontPx * 1.3);
  const titleHeight = titleLineHeight + lineHeightPx + labelGap;

  const base: Omit<SnakeLayout, "stopPositions" | "turns" | "warnings"> = {
    fontPx,
    dotSize,
    badgeSize,
    strokeWidth,
    lineHeightPx,
    labelGap,
    titleFontPx,
    titleLineHeight,
    titleHeight,
  };

  if (stops.length === 0) {
    return { ...base, stopPositions: [], turns: [], warnings: ["No stations to lay out."] };
  }

  // Row height: sized for the stop with the most label lines (name, plus one
  // "Transfer to" header and one line per shown transfer — the header is
  // written once, not once per transfer), so every row has enough vertical
  // room regardless of which stop lands in it.
  const labelLinesFor = (s: LabeledStop) => {
    const shown = Math.min(s.transferLines.length, MAX_TRANSFERS_SHOWN);
    return 1 + (shown > 0 ? 1 + shown : 0);
  };
  const maxLabelLines = Math.max(...stops.map(labelLinesFor));
  const rowHeight = badgeSize + labelGap + maxLabelLines * lineHeightPx;

  const longestLabelPx = Math.max(
    0,
    ...stops.map((s) => measureText(s.stop.station.name, fontPx)),
    ...stops.flatMap((s) =>
      s.transferLines.slice(0, MAX_TRANSFERS_SHOWN).map((r) => measureText(r.name, fontPx)),
    ),
  );
  const minStepX = Math.max(dotSize * 3, longestLabelPx + fontPx * 2);

  // Labels are centered under each dot, so the outermost stop in a row needs
  // half the widest label's width as clearance, or its text overflows the
  // canvas edge.
  const marginX = Math.max(6, Math.round(width * 0.04), Math.ceil(longestLabelPx / 2) + 4);
  const marginY = Math.max(6, Math.round(height * 0.06));
  // The title (route name + termini) reserves extra space at the top only.
  const marginTop = marginY + titleHeight;
  const drawWidth = Math.max(1, width - 2 * marginX);
  const drawHeight = Math.max(1, height - marginTop - marginY);

  const n = stops.length;
  const maxRowsByHeight = Math.max(1, Math.floor(drawHeight / rowHeight));
  // Directly compute the row count that keeps stations comfortably spaced
  // given the available width, then cap it by how many rows the height can
  // actually fit. This scales smoothly with both dimensions — unlike a
  // declining search from "most rows" down to 1, which can spuriously bottom
  // out at a single row whenever no candidate above 1 happens to satisfy the
  // spacing check, regardless of how much vertical space is available.
  const maxPerRow = Math.max(1, Math.floor(drawWidth / minStepX) + 1);
  const neededRows = Math.max(1, Math.ceil(n / maxPerRow));
  const rows = Math.min(neededRows, maxRowsByHeight);
  if (neededRows > maxRowsByHeight) {
    warnings.push("Diagram is cramped at this footprint — try a larger width or height.");
  }

  const stopsPerRow = Math.ceil(n / rows);
  const stepX = stopsPerRow > 1 ? drawWidth / (stopsPerRow - 1) : drawWidth;
  const rowsOfStops: LabeledStop[][] = [];
  for (let i = 0; i < n; i += stopsPerRow) rowsOfStops.push(stops.slice(i, i + stopsPerRow));
  const numRows = rowsOfStops.length;
  const extraY = Math.max(0, (drawHeight - rowHeight * numRows) / 2);

  interface RowMeta {
    dir: 1 | -1;
    y: number;
    startX: number;
    endX: number;
  }
  const rowsMeta: RowMeta[] = [];
  for (let r = 0; r < numRows; r++) {
    const dir: 1 | -1 = r % 2 === 0 ? 1 : -1;
    const y = marginTop + extraY + rowHeight * r + rowHeight / 2;
    const startX = r === 0 ? marginX : rowsMeta[r - 1].endX;
    const span = rowsOfStops[r].length > 1 ? stepX * (rowsOfStops[r].length - 1) : 0;
    rowsMeta.push({ dir, y, startX, endX: startX + dir * span });
  }

  const stopPositions: StopPosition[] = [];
  rowsOfStops.forEach((rowStops, r) => {
    const { dir, y, startX } = rowsMeta[r];
    rowStops.forEach((stop, j) => {
      stopPositions.push({ stop, x: startX + dir * stepX * j, y, row: r, isTerminal: false });
    });
  });
  if (stopPositions.length > 0) {
    stopPositions[0].isTerminal = true;
    stopPositions[stopPositions.length - 1].isTerminal = true;
  }

  const turns: TurnArc[] = [];
  for (let r = 0; r + 1 < numRows; r++) {
    const a = rowsMeta[r];
    const b = rowsMeta[r + 1];
    const r0 = rowHeight / 2;
    const cx = a.endX; // === b.startX by construction
    const cy = (a.y + b.y) / 2;
    // A sits "above" the arc's center (toward row a), B sits "below" (toward
    // row b); bulge outward in the direction row `a` was travelling.
    turns.push({
      cx,
      cy,
      r: r0,
      fromAngle: -Math.PI / 2,
      toAngle: Math.PI / 2,
      anticlockwise: a.dir === -1,
    });
  }

  return { ...base, stopPositions, turns, warnings };
}

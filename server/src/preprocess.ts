import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { contours as d3contours } from "d3-contour";
import {
  blockToLowresTileIndex,
  decodeHeight,
  LOWRES_TILE_SIZE,
  type Dimension,
} from "@hcmap/shared";
import {
  CONTOUR_DOWNSAMPLE,
  CONTOUR_INTERVAL,
  SNAPSHOT_DIR,
  UPSTREAM,
} from "./config";

export interface Region {
  dimension: Dimension;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface MirrorResult {
  dimension: Dimension;
  tilesRequested: number;
  tilesWritten: number;
  tilesEmpty: number;
  heightRange: [number, number] | null;
  contourFeatures: number;
  bbox: Region;
}

const SEA_LEVEL = 63;
const PAPER: [number, number, number] = [216, 211, 198];

function tileUrl(dim: Dimension, lod: number, tx: number, tz: number): string {
  return `${UPSTREAM}/maps/${dim}/tiles/${lod}/x${tx}/z${tz}.png`;
}

/** Fetch and decode a lowres tile PNG. Returns null for empty (204/404) tiles. */
async function fetchTilePng(
  dim: Dimension,
  tx: number,
  tz: number,
): Promise<PNG | null> {
  const res = await fetch(tileUrl(dim, 1, tx, tz));
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`tile ${tx},${tz}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;
  return PNG.sync.read(buf);
}

/** Index into an RGBA buffer for pixel (x, y) in a `width`-wide image. */
function idx(x: number, y: number, width: number): number {
  return (y * width + x) * 4;
}

/** Run an async worker over items with bounded concurrency. */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Mirror a rectangular block region from the upstream BlueMap, writing derived
 * terrain + minimal tiles and a contour GeoJSON into the committed snapshot so
 * the static site works without the backend.
 */
export async function mirrorRegion(region: Region): Promise<MirrorResult> {
  const { dimension: dim } = region;
  const txMin = blockToLowresTileIndex(region.minX, 1);
  const txMax = blockToLowresTileIndex(region.maxX, 1);
  const tzMin = blockToLowresTileIndex(region.minZ, 1);
  const tzMax = blockToLowresTileIndex(region.maxZ, 1);

  const tilesX = txMax - txMin + 1;
  const tilesZ = tzMax - tzMin + 1;
  const S = LOWRES_TILE_SIZE;

  // Downsampled height grid spanning the whole tile region, row-major (z*W+x).
  const d = CONTOUR_DOWNSAMPLE;
  const gridW = Math.ceil((tilesX * S) / d);
  const gridH = Math.ceil((tilesZ * S) / d);
  const height = new Float32Array(gridW * gridH).fill(SEA_LEVEL);
  let hMin = Infinity;
  let hMax = -Infinity;

  const dimDir = path.join(SNAPSHOT_DIR, dim);
  await fs.mkdir(path.join(dimDir, "terrain"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "minimal"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "derived"), { recursive: true });

  const tileCoords: { tx: number; tz: number }[] = [];
  for (let tz = tzMin; tz <= tzMax; tz++)
    for (let tx = txMin; tx <= txMax; tx++) tileCoords.push({ tx, tz });

  let written = 0;
  let empty = 0;

  await pool(tileCoords, 6, async ({ tx, tz }) => {
    const png = await fetchTilePng(dim, tx, tz);
    if (!png) {
      empty++;
      return;
    }
    // BlueMap stores tiles with inclusive edges: a 500-block tile is 501x1002,
    // with 501 color rows then 501 meta rows (metaOffset = png.height/2). We
    // crop to a clean S x S output so tiles abut seamlessly at tileSize=S; the
    // dropped overlap row/col conveniently supplies the edge hillshade sample.
    const srcW = png.width;
    const metaOffset = png.height >> 1;
    const data = png.data;

    const colorPng = new PNG({ width: S, height: S });
    const minimal = new PNG({ width: S, height: S });

    for (let pz = 0; pz < S; pz++) {
      for (let px = 0; px < S; px++) {
        const ci = idx(px, pz, srcW);
        const oi = idx(px, pz, S);
        const h = decodeHeight(
          data[idx(px, pz + metaOffset, srcW) + 1],
          data[idx(px, pz + metaOffset, srcW) + 2],
        );

        // color output
        colorPng.data[oi] = data[ci];
        colorPng.data[oi + 1] = data[ci + 1];
        colorPng.data[oi + 2] = data[ci + 2];
        colorPng.data[oi + 3] = data[ci + 3];

        // hillshade from the +x / +z neighbours (overlap row/col covers edges)
        const hx = decodeHeight(
          data[idx(px + 1, pz + metaOffset, srcW) + 1],
          data[idx(px + 1, pz + metaOffset, srcW) + 2],
        );
        const hz = decodeHeight(
          data[idx(px, pz + 1 + metaOffset, srcW) + 1],
          data[idx(px, pz + 1 + metaOffset, srcW) + 2],
        );
        const shade = Math.max(-0.25, Math.min(0.06, (2 * h - hx - hz) * 0.06));
        for (let k = 0; k < 3; k++) {
          const base = data[ci + k] * 0.45 + PAPER[k] * 0.55;
          minimal.data[oi + k] = Math.max(0, Math.min(255, base + shade * 255));
        }
        minimal.data[oi + 3] = data[ci + 3];

        // region height grid (sampled every d-th block)
        if (px % d === 0 && pz % d === 0) {
          const gx = Math.floor(((tx - txMin) * S + px) / d);
          const gz = Math.floor(((tz - tzMin) * S + pz) / d);
          if (gx < gridW && gz < gridH) {
            height[gz * gridW + gx] = h;
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
          }
        }
      }
    }
    await writeTile(dimDir, "terrain", 0, tx, tz, colorPng);
    await writeTile(dimDir, "minimal", 0, tx, tz, minimal);
    written++;
  });

  // --- overview pyramid (so zoomed-out views load few, pre-shrunk tiles) ---
  const spanX = txMax - txMin + 1;
  const spanZ = tzMax - tzMin + 1;
  const maxLevel = Math.min(6, Math.ceil(Math.log2(Math.max(1, spanX, spanZ))));
  const bounds = { xMin: txMin, xMax: txMax, yMin: tzMin, yMax: tzMax };
  await generateOverviews(dimDir, "terrain", bounds, maxLevel);
  const minNativeZoom = await generateOverviews(dimDir, "minimal", bounds, maxLevel);

  // --- contours ---
  const contourFeatures = await writeContours(
    dimDir,
    height,
    gridW,
    gridH,
    d,
    txMin * S,
    tzMin * S,
    hMin,
    hMax,
  );

  // --- height field (for terrain-aware route finding) ---
  await writeHeightField(dimDir, height, gridW, gridH, d, txMin * S, tzMin * S);

  // --- live markers snapshot (best effort) ---
  await snapshotMarkers(dim, dimDir);

  const manifest = {
    dimension: dim,
    generatedAt: new Date().toISOString(),
    tileSize: S,
    tiles: { txMin, txMax, tzMin, tzMax },
    bbox: region,
    heightRange: Number.isFinite(hMin) ? [hMin, hMax] : null,
    contourInterval: CONTOUR_INTERVAL,
    minNativeZoom,
  };
  await fs.writeFile(
    path.join(dimDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return {
    dimension: dim,
    tilesRequested: tileCoords.length,
    tilesWritten: written,
    tilesEmpty: empty,
    heightRange: Number.isFinite(hMin) ? [hMin, hMax] : null,
    contourFeatures,
    bbox: region,
  };
}

type TileKind = "terrain" | "minimal";

async function writeTile(
  dimDir: string,
  kind: TileKind,
  z: number,
  tx: number,
  tz: number,
  png: PNG,
): Promise<void> {
  const dir = path.join(dimDir, kind, String(z), String(tx));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${tz}.png`), PNG.sync.write(png));
}

async function readTile(
  dimDir: string,
  kind: TileKind,
  z: number,
  tx: number,
  tz: number,
): Promise<PNG | null> {
  try {
    return PNG.sync.read(
      await fs.readFile(path.join(dimDir, kind, String(z), String(tx), `${tz}.png`)),
    );
  } catch {
    return null;
  }
}

/** Average a tile down by 2× (S×S -> S/2×S/2), alpha-weighted. */
function downsampleHalf(src: PNG): PNG {
  const w = src.width;
  const ow = w >> 1;
  const oh = src.height >> 1;
  const out = new PNG({ width: ow, height: oh });
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const si = ((y * 2 + j) * w + (x * 2 + i)) * 4;
          const af = src.data[si + 3];
          r += src.data[si] * af;
          g += src.data[si + 1] * af;
          b += src.data[si + 2] * af;
          a += af;
        }
      }
      const oi = (y * ow + x) * 4;
      if (a > 0) {
        out.data[oi] = r / a;
        out.data[oi + 1] = g / a;
        out.data[oi + 2] = b / a;
        out.data[oi + 3] = a / 4;
      }
    }
  }
  return out;
}

function blit(dst: PNG, src: PNG, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = ((oy + y) * dst.width + (ox + x)) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/**
 * Build a downsampled tile pyramid so zoomed-out views load a handful of
 * pre-shrunk tiles instead of every full-resolution tile. Overview level -L
 * (Leaflet zoom -L) has each tile aggregating a 2×2 block of level -(L-1) tiles.
 * Returns the deepest (most negative) zoom level produced.
 */
async function generateOverviews(
  dimDir: string,
  kind: TileKind,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  maxLevel: number,
): Promise<number> {
  const S = LOWRES_TILE_SIZE;
  let { xMin, xMax, yMin, yMax } = bounds;
  let deepest = 0;
  for (let L = 1; L <= maxLevel; L++) {
    const prevZ = -(L - 1);
    const curZ = -L;
    const pXmin = Math.floor(xMin / 2);
    const pXmax = Math.floor(xMax / 2);
    const pYmin = Math.floor(yMin / 2);
    const pYmax = Math.floor(yMax / 2);
    for (let X = pXmin; X <= pXmax; X++) {
      for (let Y = pYmin; Y <= pYmax; Y++) {
        const parent = new PNG({ width: S, height: S });
        let any = false;
        for (let dx = 0; dx < 2; dx++) {
          for (let dy = 0; dy < 2; dy++) {
            const child = await readTile(dimDir, kind, prevZ, X * 2 + dx, Y * 2 + dy);
            if (!child) continue;
            any = true;
            blit(parent, downsampleHalf(child), dx * (S >> 1), dy * (S >> 1));
          }
        }
        if (any) await writeTile(dimDir, kind, curZ, X, Y, parent);
      }
    }
    deepest = curZ;
    xMin = pXmin;
    xMax = pXmax;
    yMin = pYmin;
    yMax = pYmax;
  }
  return deepest;
}

async function writeContours(
  dimDir: string,
  height: Float32Array,
  gridW: number,
  gridH: number,
  downsample: number,
  originX: number,
  originZ: number,
  hMin: number,
  hMax: number,
): Promise<number> {
  if (!Number.isFinite(hMin) || !Number.isFinite(hMax) || hMax - hMin < 1) {
    await fs.writeFile(
      path.join(dimDir, "derived", "contours.geojson"),
      JSON.stringify({ type: "FeatureCollection", features: [] }),
    );
    return 0;
  }

  const thresholds: number[] = [];
  const start = Math.ceil(hMin / CONTOUR_INTERVAL) * CONTOUR_INTERVAL;
  for (let t = start; t <= hMax; t += CONTOUR_INTERVAL) thresholds.push(t);

  const gen = d3contours().size([gridW, gridH]).thresholds(thresholds);
  const bands = gen(Array.from(height));

  // Convert grid-space coordinates to block coordinates in place.
  const toBlock = (coord: number[]): number[] => [
    originX + coord[0] * downsample,
    originZ + coord[1] * downsample,
  ];
  const features = bands.map((band) => ({
    type: "Feature" as const,
    properties: { value: band.value },
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: band.coordinates.map((poly) =>
        poly.map((ring) => ring.map(toBlock)),
      ),
    },
  }));

  await fs.writeFile(
    path.join(dimDir, "derived", "contours.geojson"),
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  return features.length;
}

/**
 * Write the downsampled height grid as a PNG the browser can sample. Height is
 * encoded per pixel as (h + 2048) into R (high byte) and G (low byte); the JSON
 * sidecar describes how grid cells map back to block coordinates.
 */
const HEIGHT_BIAS = 2048;
async function writeHeightField(
  dimDir: string,
  height: Float32Array,
  gridW: number,
  gridH: number,
  cellSize: number,
  originX: number,
  originZ: number,
): Promise<void> {
  const png = new PNG({ width: gridW, height: gridH });
  for (let i = 0; i < gridW * gridH; i++) {
    const v = Math.max(0, Math.min(65535, Math.round(height[i]) + HEIGHT_BIAS));
    const o = i * 4;
    png.data[o] = v >> 8;
    png.data[o + 1] = v & 255;
    png.data[o + 2] = 0;
    png.data[o + 3] = 255;
  }
  await fs.writeFile(path.join(dimDir, "derived", "height.png"), PNG.sync.write(png));
  await fs.writeFile(
    path.join(dimDir, "derived", "height.json"),
    JSON.stringify({ originX, originZ, cellSize, width: gridW, height: gridH, bias: HEIGHT_BIAS }),
  );
}

/** Copy the upstream live markers into the snapshot for offline landmark seed. */
async function snapshotMarkers(dim: Dimension, dimDir: string): Promise<void> {
  try {
    const res = await fetch(`${UPSTREAM}/maps/${dim}/live/markers.json`);
    if (res.ok) {
      await fs.writeFile(path.join(dimDir, "markers.json"), await res.text());
    }
  } catch {
    /* best effort — snapshot still valid without live markers */
  }
}

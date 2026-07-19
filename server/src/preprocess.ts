import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { contours as d3contours } from "d3-contour";
import type { Climate } from "deepslate";
import {
  blockToLowresTileIndex,
  decodeHeight,
  digitBands,
  LOWRES_TILE_SIZE,
  RESISTOR_COLORS,
  type Dimension,
} from "@hcmap/shared";
import {
  BANDS_SUPERSAMPLE,
  BIOME_CELL_SIZE,
  CONTOUR_DOWNSAMPLE,
  CONTOUR_INTERVAL,
  DIFFERENCE_COARSE_CELL,
  DIFFERENCE_FINE_RADIUS,
  SNAPSHOT_DIR,
  UPSTREAM,
  WORLD_SEED,
} from "./config";
import { classifyBiome, climateSampler, sampleClimate, URBAN_COLOR } from "./biome";
import { originalHeight, resetOriginalHeightCaches } from "./originalHeight";
import { absoluteDiff, filterNaturalArtifacts } from "./differenceFilter";

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

/**
 * The resistor color palette (see @hcmap/shared), pre-blended into light/dark
 * variants so the "true" Terrain 2D background can read a block's elevation
 * the way a resistor's bands read a two-digit number: the tens digit of Y
 * picks the hue, the ones digit picks light (0-4) vs dark (5-9).
 */
function mix(
  c: [number, number, number],
  target: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(c[0] + (target[0] - c[0]) * t),
    Math.round(c[1] + (target[1] - c[1]) * t),
    Math.round(c[2] + (target[2] - c[2]) * t),
  ];
}

const RESISTOR_LIGHT = RESISTOR_COLORS.map((c) => mix(c, [255, 255, 255], 0.4));
const RESISTOR_DARK = RESISTOR_COLORS.map((c) => mix(c, [0, 0, 0], 0.35));

/** Elevation -> resistor-band color. Continuous across negative Y via floored digits. */
function bandColor(h: number): [number, number, number] {
  const { tens, ones } = digitBands(h);
  return ones < 5 ? RESISTOR_LIGHT[tens] : RESISTOR_DARK[tens];
}

/**
 * Render one block's resistor-code cell into a supersampled tile plus its
 * coarse tinted overview-seed twin — shared by the "bands" (absolute elevation)
 * and "difference" (current-minus-original height) tiles. The N x N cell is the
 * tens-digit hue, with a smaller bottom-right corner dot in the ones-digit hue
 * so every exact value reads off up close; the tint pixel encodes the same
 * value as bandColor's light/dark shading for the zoomed-out pyramid.
 */
function writeResistorCell(
  superPng: PNG,
  tintPng: PNG,
  px: number,
  pz: number,
  value: number,
  alpha: number,
  N: number,
  bandsSize: number,
  innerLo: number,
  innerHi: number,
): void {
  const { tens, ones } = digitBands(value);
  const [br, bg, bb] = RESISTOR_COLORS[tens];
  const [dr, dg, db] = RESISTOR_COLORS[ones];
  for (let sz = 0; sz < N; sz++) {
    for (let sx = 0; sx < N; sx++) {
      const inner = sx >= innerLo && sx < innerHi && sz >= innerLo && sz < innerHi;
      const oi2 = idx(px * N + sx, pz * N + sz, bandsSize);
      superPng.data[oi2] = inner ? dr : br;
      superPng.data[oi2 + 1] = inner ? dg : bg;
      superPng.data[oi2 + 2] = inner ? db : bb;
      superPng.data[oi2 + 3] = alpha;
    }
  }
  const oi = idx(px, pz, tintPng.width);
  const [tr, tg, tb] = bandColor(value);
  tintPng.data[oi] = tr;
  tintPng.data[oi + 1] = tg;
  tintPng.data[oi + 2] = tb;
  tintPng.data[oi + 3] = alpha;
}

function tileUrl(dim: Dimension, lod: number, tx: number, tz: number): string {
  return `${UPSTREAM}/maps/${dim}/tiles/${lod}/x${tx}/z${tz}.png`;
}

/**
 * Fetch and decode a lowres tile PNG. Returns null for empty (204/404) tiles.
 * Retries transient network failures for several minutes with exponential
 * backoff — a full-map mirror runs for hours, and a DNS/network outage
 * (observed twice: `ENOTFOUND mc.hackclub.com` mid-run) must not kill it.
 * If retries are exhausted the error still propagates; callers in the tile
 * pool additionally catch-and-skip so one dead tile can't sink a whole bake.
 */
const FETCH_BACKOFF_S = [1, 2, 4, 8, 16, 30, 60, 60, 60];

async function fetchTilePng(
  dim: Dimension,
  tx: number,
  tz: number,
  attempt = 0,
): Promise<PNG | null> {
  try {
    const res = await fetch(tileUrl(dim, 1, tx, tz));
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`tile ${tx},${tz}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return PNG.sync.read(buf);
  } catch (err) {
    if (attempt >= FETCH_BACKOFF_S.length) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000 * FETCH_BACKOFF_S[attempt]));
    return fetchTilePng(dim, tx, tz, attempt + 1);
  }
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
  await fs.mkdir(path.join(dimDir, "bands"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "biome"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "difference"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "difference-filtered"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "water"), { recursive: true });
  await fs.mkdir(path.join(dimDir, "derived"), { recursive: true });

  const tileCoords: { tx: number; tz: number }[] = [];
  for (let tz = tzMin; tz <= tzMax; tz++)
    for (let tx = txMin; tx <= txMax; tx++) tileCoords.push({ tx, tz });

  let written = 0;
  let empty = 0;
  const sampler = climateSampler(WORLD_SEED);
  // Coarse tinted "bands"/"difference" tiles keyed by "tx,tz" — fed into
  // generateOverviews as an in-memory substitute for the actual (dotted,
  // supersampled) native tile so the zoomed-out pyramid keeps the light/dark
  // ones-digit shading instead of inheriting the corner dot.
  const bandsTintSeed = new Map<string, PNG>();
  const differenceTintSeed = new Map<string, PNG>();
  const differenceFilteredTintSeed = new Map<string, PNG>();
  const failed: string[] = [];

  await pool(tileCoords, 6, async ({ tx, tz }) => {
    let png: PNG | null;
    try {
      png = await fetchTilePng(dim, tx, tz);
    } catch (err) {
      // Retries exhausted (minutes of outage) — skip this tile rather than
      // killing an hours-long bake; the summary below lists what to re-run.
      failed.push(`${tx},${tz}`);
      console.warn(`[mirror] tile ${tx},${tz} failed after retries:`, (err as Error).message);
      return;
    }
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
    const N = BANDS_SUPERSAMPLE;
    const bandsSize = S * N;
    // "bands" (Terrain 2D) and "difference" share the exact same resistor-code
    // rendering — an N x N supersampled cell (tens-digit hue + ones-digit corner
    // dot) plus a coarse single-resolution tinted twin (bandColor's light/dark
    // shading) that seeds the zoomed-out overview pyramid, so the ones digit
    // survives as shading once the corner dot is too small to see. They differ
    // only in the value encoded: absolute elevation for bands, current-minus-
    // original height for difference.
    const bands = new PNG({ width: bandsSize, height: bandsSize });
    const bandsTint = new PNG({ width: S, height: S });
    const difference = new PNG({ width: bandsSize, height: bandsSize });
    const differenceTint = new PNG({ width: S, height: S });
    const differenceFiltered = new PNG({ width: bandsSize, height: bandsSize });
    const differenceFilteredTint = new PNG({ width: S, height: S });
    // Sub-pixel rows/cols making up the smaller inner dot (the bottom-right
    // corner of each block's N x N cell), e.g. N=2 -> just index 1.
    const innerLo = Math.floor(N / 2);
    const innerHi = N;

    // Bound deepslate's unbounded interpolation-corner caches to one tile's
    // worth. Safe under pool() concurrency: the loops below have no await,
    // so one tile's height computations never interleave with another's.
    resetOriginalHeightCaches();

    // Whole-tile current + freshly-generated height grids, computed up front:
    // the "Remove natural features" filter is morphological (it looks at a
    // block's neighborhood), so it needs full grids rather than per-pixel
    // streaming. The main loop below reuses curHeights instead of re-decoding.
    const curHeights = new Int16Array(S * S);
    const simHeights = new Int16Array(S * S);
    for (let pz = 0; pz < S; pz++) {
      for (let px = 0; px < S; px++) {
        curHeights[pz * S + px] = decodeHeight(
          data[idx(px, pz + metaOffset, srcW) + 1],
          data[idx(px, pz + metaOffset, srcW) + 2],
        );
      }
    }
    // Fresh-world heights: full per-block resolution near spawn
    // (DIFFERENCE_FINE_RADIUS), one sample per DIFFERENCE_COARSE_CELL square
    // beyond it (cells straddling the boundary run per-block).
    const C = DIFFERENCE_COARSE_CELL;
    const R = DIFFERENCE_FINE_RADIUS;
    for (let cz = 0; cz < S; cz += C) {
      for (let cx = 0; cx < S; cx += C) {
        const wx0 = tx * S + cx;
        const wz0 = tz * S + cz;
        const fine = wx0 <= R && wx0 + C - 1 >= -R && wz0 <= R && wz0 + C - 1 >= -R;
        if (fine) {
          for (let dz = 0; dz < C; dz++)
            for (let dx = 0; dx < C; dx++)
              simHeights[(cz + dz) * S + cx + dx] = originalHeight(WORLD_SEED, wx0 + dx, wz0 + dz);
        } else {
          const v = originalHeight(WORLD_SEED, wx0 + (C >> 1), wz0 + (C >> 1));
          for (let dz = 0; dz < C; dz++)
            for (let dx = 0; dx < C; dx++) simHeights[(cz + dz) * S + cx + dx] = v;
        }
      }
    }
    const rawDiff = absoluteDiff(curHeights, simHeights, S);
    const filteredDiff = filterNaturalArtifacts(curHeights, simHeights, S);

    for (let pz = 0; pz < S; pz++) {
      for (let px = 0; px < S; px++) {
        const ci = idx(px, pz, srcW);
        const oi = idx(px, pz, S);
        const gi = pz * S + px;
        const h = curHeights[gi];

        // color output
        colorPng.data[oi] = data[ci];
        colorPng.data[oi + 1] = data[ci + 1];
        colorPng.data[oi + 2] = data[ci + 2];
        colorPng.data[oi + 3] = data[ci + 3];

        // Resistor-code cells (see the bands/difference declarations above):
        // absolute elevation for Terrain 2D, and |current − freshly-generated|
        // height for the Difference view — identical tens-hue + ones-corner-dot
        // scheme. Absolute value: raised and dug ground read the same. The
        // filtered variant backs the "Remove natural features" toggle.
        const alpha = data[ci + 3];
        writeResistorCell(bands, bandsTint, px, pz, h, alpha, N, bandsSize, innerLo, innerHi);
        writeResistorCell(
          difference,
          differenceTint,
          px,
          pz,
          rawDiff[gi],
          alpha,
          N,
          bandsSize,
          innerLo,
          innerHi,
        );
        writeResistorCell(
          differenceFiltered,
          differenceFilteredTint,
          px,
          pz,
          filteredDiff[gi],
          alpha,
          N,
          bandsSize,
          innerLo,
          innerHi,
        );

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
    const biome = buildBiomeTile(colorPng, sampler, tx * S, tz * S);

    await writeTile(dimDir, "terrain", 0, tx, tz, colorPng);
    await writeTile(dimDir, "minimal", 0, tx, tz, minimal);
    await writeTile(dimDir, "bands", 0, tx, tz, bands);
    await writeTile(dimDir, "biome", 0, tx, tz, biome);
    await writeTile(dimDir, "difference", 0, tx, tz, difference);
    await writeTile(dimDir, "difference-filtered", 0, tx, tz, differenceFiltered);
    await writeTile(dimDir, "water", 0, tx, tz, buildWaterTile(data, srcW, S));
    bandsTintSeed.set(`${tx},${tz}`, bandsTint);
    differenceTintSeed.set(`${tx},${tz}`, differenceTint);
    differenceFilteredTintSeed.set(`${tx},${tz}`, differenceFilteredTint);
    written++;
    if (written % 20 === 0) {
      console.log(`[mirror] progress: ${written}/${tileCoords.length} tiles`);
    }
  });
  if (failed.length) {
    console.warn(
      `[mirror] ${failed.length} tile(s) failed and were skipped (re-run a scoped mirror to fill): ${failed.join(" ")}`,
    );
  }

  // --- overview pyramid (so zoomed-out views load few, pre-shrunk tiles) ---
  const spanX = txMax - txMin + 1;
  const spanZ = tzMax - tzMin + 1;
  const maxLevel = Math.min(6, Math.ceil(Math.log2(Math.max(1, spanX, spanZ))));
  const bounds = { xMin: txMin, xMax: txMax, yMin: tzMin, yMax: tzMax };
  await generateOverviews(dimDir, "terrain", bounds, maxLevel);
  await generateOverviews(dimDir, "bands", bounds, maxLevel, bandsTintSeed);
  await generateOverviews(dimDir, "biome", bounds, maxLevel);
  await generateOverviews(dimDir, "difference", bounds, maxLevel, differenceTintSeed);
  await generateOverviews(dimDir, "difference-filtered", bounds, maxLevel, differenceFilteredTintSeed);
  await generateOverviews(dimDir, "water", bounds, maxLevel);
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

type TileKind =
  | "terrain"
  | "minimal"
  | "bands"
  | "biome"
  | "difference"
  | "difference-filtered"
  | "water";

/**
 * Whether a BlueMap surface color reads as water (blue-dominant). BlueMap has
 * no material channel in lowres tiles, so color is the only signal; the same
 * threshold classified water bottoms correctly in the ravine investigation.
 * Ice and blue builds also match — acceptable for a readability mask.
 */
function isWaterColor(r: number, g: number, b: number): boolean {
  return b > r + 20 && b > g + 10;
}

/**
 * Build the "water" mask tile for one fetched BlueMap tile: opaque black over
 * water, fully transparent elsewhere. Overlaid on Terrain 2D by the frontend
 * ("Black out water"), since resistor elevation bands alone can't tell water
 * from land at the same height.
 */
function buildWaterTile(data: Buffer, srcW: number, S: number): PNG {
  const water = new PNG({ width: S, height: S });
  for (let pz = 0; pz < S; pz++) {
    for (let px = 0; px < S; px++) {
      const ci = idx(px, pz, srcW);
      const oi = idx(px, pz, S);
      if (data[ci + 3] > 0 && isWaterColor(data[ci], data[ci + 1], data[ci + 2])) {
        water.data[oi] = 0;
        water.data[oi + 1] = 0;
        water.data[oi + 2] = 0;
        water.data[oi + 3] = 255;
      }
    }
  }
  return water;
}

/**
 * Water-mask-only pass over a region: fetches the BlueMap tiles and (re)writes
 * just the "water" tile kind + its overview pyramid. No simulation, no
 * manifest writes — safe to run alongside (or much faster than) a full mirror.
 */
export async function mirrorWaterMasks(region: Region): Promise<{ written: number; empty: number }> {
  const { dimension: dim } = region;
  const txMin = blockToLowresTileIndex(region.minX, 1);
  const txMax = blockToLowresTileIndex(region.maxX, 1);
  const tzMin = blockToLowresTileIndex(region.minZ, 1);
  const tzMax = blockToLowresTileIndex(region.maxZ, 1);
  const S = LOWRES_TILE_SIZE;
  const dimDir = path.join(SNAPSHOT_DIR, dim);
  await fs.mkdir(path.join(dimDir, "water"), { recursive: true });

  const tileCoords: { tx: number; tz: number }[] = [];
  for (let tz = tzMin; tz <= tzMax; tz++)
    for (let tx = txMin; tx <= txMax; tx++) tileCoords.push({ tx, tz });

  let written = 0;
  let empty = 0;
  const failed: string[] = [];
  await pool(tileCoords, 6, async ({ tx, tz }) => {
    let png: PNG | null;
    try {
      png = await fetchTilePng(dim, tx, tz);
    } catch (err) {
      failed.push(`${tx},${tz}`);
      console.warn(`[water] tile ${tx},${tz} failed after retries:`, (err as Error).message);
      return;
    }
    if (!png) {
      empty++;
      return;
    }
    await writeTile(dimDir, "water", 0, tx, tz, buildWaterTile(png.data, png.width, S));
    written++;
    if (written % 100 === 0) console.log(`[water] progress: ${written}/${tileCoords.length}`);
  });
  if (failed.length) console.warn(`[water] ${failed.length} tile(s) failed: ${failed.join(" ")}`);

  const spanX = txMax - txMin + 1;
  const spanZ = tzMax - tzMin + 1;
  const maxLevel = Math.min(6, Math.ceil(Math.log2(Math.max(1, spanX, spanZ))));
  await generateOverviews(dimDir, "water", { xMin: txMin, xMax: txMax, yMin: tzMin, yMax: tzMax }, maxLevel);
  return { written, empty };
}

const BIOME_CELLS_PER_TILE = LOWRES_TILE_SIZE / BIOME_CELL_SIZE;

// Heuristic thresholds for flagging a cell as "Urban": a concentration of
// blocks whose color doesn't fit natural terrain's smooth, few-color palette
// (sharp edges + many distinct materials, the way built structures read
// against BlueMap's surface render). Untuned against ground truth — adjust if
// real villages/bases end up under- or over-flagged.
// Calibrated against the mirrored snapshot: sampled distinct-color/edge-density
// values for every 50-block cell across ~1900 native tiles (spawn's known
// builds vs. the rest of the explored map). distinct>42 & edge>0.35 isolated
// spawn's built-up cells (11 flagged in its tile) while flagging only ~0.07%
// of cells elsewhere — see conversation history for the calibration data.
const URBAN_COLOR_THRESHOLD = 42; // distinct quantized colors within a cell
const URBAN_EDGE_FRACTION = 0.35; // fraction of hard color-edges within a cell
const URBAN_NEIGHBOR_FRACTION = 0.4; // fraction of a cell's 3x3 neighborhood also flagged

/**
 * Render a tile's biome background: real vanilla climate noise (from the
 * seed) picks each cell's natural biome color, unless the cell — together
 * with a concentrated neighborhood around it — looks unnatural by color
 * (villages, player builds), in which case it's painted grey ("Urban").
 */
function buildBiomeTile(
  colorPng: PNG,
  sampler: Climate.Sampler,
  originX: number,
  originZ: number,
): PNG {
  const S = colorPng.width;
  const n = BIOME_CELLS_PER_TILE;
  const distinct: Set<number>[] = Array.from({ length: n * n }, () => new Set());
  const edges = new Int32Array(n * n);
  const totals = new Int32Array(n * n);

  for (let pz = 0; pz < S; pz++) {
    for (let px = 0; px < S; px++) {
      const oi = idx(px, pz, S);
      const cellIdx = Math.floor(pz / BIOME_CELL_SIZE) * n + Math.floor(px / BIOME_CELL_SIZE);
      const r = colorPng.data[oi];
      const g = colorPng.data[oi + 1];
      const b = colorPng.data[oi + 2];
      totals[cellIdx]++;
      distinct[cellIdx].add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      if (px > 0) {
        const li = oi - 4;
        const delta =
          Math.abs(r - colorPng.data[li]) +
          Math.abs(g - colorPng.data[li + 1]) +
          Math.abs(b - colorPng.data[li + 2]);
        if (delta > 40) edges[cellIdx]++;
      }
      if (pz > 0) {
        const ti = oi - S * 4;
        const delta =
          Math.abs(r - colorPng.data[ti]) +
          Math.abs(g - colorPng.data[ti + 1]) +
          Math.abs(b - colorPng.data[ti + 2]);
        if (delta > 40) edges[cellIdx]++;
      }
    }
  }

  const flagged = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    flagged[i] =
      distinct[i].size > URBAN_COLOR_THRESHOLD && edges[i] > totals[i] * URBAN_EDGE_FRACTION ? 1 : 0;
  }

  const urban = new Uint8Array(n * n);
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= n || nz < 0 || nz >= n) continue;
          sum += flagged[nz * n + nx];
          count++;
        }
      }
      urban[cz * n + cx] = sum / count >= URBAN_NEIGHBOR_FRACTION ? 1 : 0;
    }
  }

  const out = new PNG({ width: S, height: S });
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const color = urban[cz * n + cx]
        ? URBAN_COLOR
        : classifyBiome(
            sampleClimate(
              sampler,
              originX + cx * BIOME_CELL_SIZE + BIOME_CELL_SIZE / 2,
              originZ + cz * BIOME_CELL_SIZE + BIOME_CELL_SIZE / 2,
            ),
          ).color;
      for (let pz = cz * BIOME_CELL_SIZE; pz < cz * BIOME_CELL_SIZE + BIOME_CELL_SIZE; pz++) {
        for (let px = cx * BIOME_CELL_SIZE; px < cx * BIOME_CELL_SIZE + BIOME_CELL_SIZE; px++) {
          const oi = idx(px, pz, S);
          out.data[oi] = color[0];
          out.data[oi + 1] = color[1];
          out.data[oi + 2] = color[2];
          out.data[oi + 3] = colorPng.data[oi + 3];
        }
      }
    }
  }
  return out;
}

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

/** Repeatedly halve until reaching `target` — normalizes an oversized tile
 *  (e.g. the supersampled "bands" native tile) back to the standard S x S
 *  before it enters the regular overview-halving pipeline below. */
function downsampleToSize(src: PNG, target: number): PNG {
  let cur = src;
  while (cur.width > target) cur = downsampleHalf(cur);
  return cur;
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
  /**
   * In-memory zoom-0 substitute, keyed by "tx,tz" — used instead of reading
   * the real native tile from disk for the very first level (L=1). "bands"
   * uses this to build its overview pyramid from the coarse tinted color
   * (bandsTint) rather than the dotted, untinted native tile, so the
   * light/dark ones-digit shading survives at zoomed-out levels even though
   * the native tile itself no longer carries it.
   */
  seedTiles?: Map<string, PNG>,
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
            const cx = X * 2 + dx;
            const cy = Y * 2 + dy;
            const child =
              L === 1 && seedTiles
                ? (seedTiles.get(`${cx},${cy}`) ?? null)
                : await readTile(dimDir, kind, prevZ, cx, cy);
            if (!child) continue;
            any = true;
            // The "bands" native tile is supersampled (bigger than S x S) for
            // its close-range inner dots; normalize before the standard halving.
            const normalized = child.width === S ? child : downsampleToSize(child, S);
            blit(parent, downsampleHalf(normalized), dx * (S >> 1), dy * (S >> 1));
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

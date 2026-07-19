/**
 * Standalone validation render for the Difference algorithm (no snapshot writes).
 *
 *   npx tsx scripts/render-diff-test.mts <outDir> [radius=512]
 *
 * Fetches the live BlueMap heights for the ±radius region around (0,0),
 * simulates the freshly-generated top-block height per column via
 * src/originalHeight (the exact module the mirror bake uses), and renders
 * |current − original| in the production resistor scheme (2× supersample,
 * tens-digit cell + ones-digit corner dot). Writes diff-test.png + prints
 * histograms so the algorithm can be judged before a full bake.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { LOWRES_TILE_SIZE, RESISTOR_COLORS, decodeHeight, digitBands } from "@hcmap/shared";
import { UPSTREAM, WORLD_SEED } from "../src/config";
import { originalHeight, resetOriginalHeightCaches } from "../src/originalHeight";

const outDir = process.argv[2] ?? ".";
const RADIUS = Number(process.argv[3] ?? 512);
const S = LOWRES_TILE_SIZE;
const SIZE = RADIUS * 2; // blocks per side
const N = 2; // supersample (matches BANDS_SUPERSAMPLE)

// --- fetch current heights from the live BlueMap (same source as the mirror) ---
const tMin = Math.floor(-RADIUS / S);
const tMax = Math.floor((RADIUS - 1) / S);
const current = new Int16Array(SIZE * SIZE).fill(-4096);

for (let tz = tMin; tz <= tMax; tz++) {
  for (let tx = tMin; tx <= tMax; tx++) {
    const res = await fetch(`${UPSTREAM}/maps/world/tiles/1/x${tx}/z${tz}.png`);
    if (res.status === 204 || res.status === 404) continue;
    if (!res.ok) throw new Error(`tile ${tx},${tz}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) continue;
    const png = PNG.sync.read(buf);
    const srcW = png.width;
    const metaOffset = png.height >> 1;
    for (let pz = 0; pz < S; pz++) {
      const wz = tz * S + pz;
      if (wz < -RADIUS || wz >= RADIUS) continue;
      for (let px = 0; px < S; px++) {
        const wx = tx * S + px;
        if (wx < -RADIUS || wx >= RADIUS) continue;
        const mi = ((pz + metaOffset) * srcW + px) * 4;
        current[(wz + RADIUS) * SIZE + (wx + RADIUS)] = decodeHeight(
          png.data[mi + 1],
          png.data[mi + 2],
        ) as number;
      }
    }
    process.stdout.write(`fetched tile ${tx},${tz}\n`);
  }
}

// --- simulate + render ---
const out = new PNG({ width: SIZE * N, height: SIZE * N });
const hist: Record<string, number> = { "0": 0, "1-3": 0, "4-9": 0, "10-29": 0, ">=30": 0 };
let n = 0;
let sumAbs = 0;
const t0 = Date.now();
resetOriginalHeightCaches();

for (let wz = -RADIUS; wz < RADIUS; wz++) {
  for (let wx = -RADIUS; wx < RADIUS; wx++) {
    const c = current[(wz + RADIUS) * SIZE + (wx + RADIUS)];
    if (c === -4096) continue; // no data
    const d = Math.abs(c - originalHeight(WORLD_SEED, wx, wz));
    n++;
    sumAbs += d;
    hist[d === 0 ? "0" : d <= 3 ? "1-3" : d <= 9 ? "4-9" : d <= 29 ? "10-29" : ">=30"]++;

    const { tens, ones } = digitBands(d);
    const [br, bg, bb] = RESISTOR_COLORS[tens];
    const [dr, dg, db] = RESISTOR_COLORS[ones];
    const bx = (wx + RADIUS) * N;
    const bz = (wz + RADIUS) * N;
    for (let sz = 0; sz < N; sz++) {
      for (let sx = 0; sx < N; sx++) {
        const inner = sx >= 1 && sz >= 1;
        const oi = ((bz + sz) * SIZE * N + bx + sx) * 4;
        out.data[oi] = inner ? dr : br;
        out.data[oi + 1] = inner ? dg : bg;
        out.data[oi + 2] = inner ? db : bb;
        out.data[oi + 3] = 255;
      }
    }
  }
  if ((wz + RADIUS) % 128 === 0 && wz + RADIUS > 0) {
    const done = (wz + RADIUS) / SIZE;
    process.stdout.write(`sim ${(done * 100).toFixed(0)}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
}

await fs.writeFile(path.join(outDir, "diff-test.png"), PNG.sync.write(out));
const ms = Date.now() - t0;
console.log(`\ndone: ${n} columns in ${(ms / 1000).toFixed(0)}s (${((ms / n) * 1000).toFixed(0)}us/col)`);
console.log(`mean |diff| = ${(sumAbs / n).toFixed(2)}`);
for (const [k, v] of Object.entries(hist)) console.log(`  |diff| ${k.padEnd(6)}: ${((100 * v) / n).toFixed(1)}%`);
console.log(`wrote ${path.join(outDir, "diff-test.png")}`);

import fs from "node:fs";
import path from "node:path";
import { DensityFunction, NoiseGeneratorSettings, RandomState } from "deepslate";
import { loadWorldgenData, VENDOR_DIR } from "./biome";

/**
 * The original (seed-generated, pre-player) surface height at a block column,
 * used by the "Difference" map view to measure how far the live world has been
 * terraformed from the vanilla terrain the seed would have produced.
 *
 * We deliberately do NOT use deepslate's `NoiseChunkGenerator.getBaseHeight()`:
 * with this vendored worldgen data + deepslate 0.26.0 the full terrain-solidity
 * function (`final_density`/`sloped_cheese`) is broken and puts the surface
 * ~110 blocks too low. Instead we read the `depth` density function, which
 * computes correctly and, by construction, crosses zero right at the intended
 * surface elevation (`depth = y_clamped_gradient(y) + offset(x,z)`). Because
 * `depth` is *linear in y* (offset is y-independent), the surface is the
 * analytic zero-crossing of two samples — no per-block column iteration, so
 * this is also ~750x faster than getBaseHeight.
 *
 * This yields the *smooth generated* surface: it omits the fine 3D-noise wiggle
 * (jaggedness, small hills/ravines) and all decoration (trees), so rugged
 * natural terrain and tree cover show a small nonzero difference even with no
 * player edits. Same category of approximation as classifyBiome (see biome.ts).
 */

interface DepthState {
  seed: bigint;
  depth: DensityFunction;
  seaLevel: number;
}

let cached: DepthState | null = null;
let callsSinceReset = 0;

/**
 * deepslate memoizes every density-function interpolation "corner" it evaluates,
 * per RandomState, with no eviction (DensityFunction.js `Interpolated.values`).
 * Over a full-map run that unbounded Map eventually overflows JS's max Map size
 * ("RangeError: Map maximum size exceeded"). Rebuilding a fresh RandomState
 * periodically resets those caches; the result is identical either way since
 * RandomState is a pure function of (settings, seed) — a memory-management
 * detail, not a behaviour change. The depth path is light, so a large interval
 * keeps the (few-ms) rebuild cost negligible while staying well under the limit.
 */
const RESET_INTERVAL = 500_000;

/** Two y samples inside the y_clamped_gradient's linear range (-64..320). */
const Y0 = 0;
const Y1 = 128;

function freshState(seed: bigint): DepthState {
  const overworldSettings = JSON.parse(
    fs.readFileSync(path.join(VENDOR_DIR, "noise_settings/overworld.json"), "utf8"),
  );
  const settings = NoiseGeneratorSettings.fromJson(overworldSettings);
  const randomState = new RandomState(settings, seed);
  return { seed, depth: randomState.router.depth, seaLevel: settings.seaLevel };
}

function stateFor(seed: bigint): DepthState {
  loadWorldgenData();
  if (cached && cached.seed === seed && callsSinceReset < RESET_INTERVAL) return cached;
  cached = freshState(seed);
  callsSinceReset = 0;
  return cached;
}

export function originalHeight(seed: bigint, x: number, z: number): number {
  const { depth, seaLevel } = stateFor(seed);
  callsSinceReset++;
  const d0 = depth.compute(DensityFunction.context(x, Y0, z));
  const d1 = depth.compute(DensityFunction.context(x, Y1, z));
  const slope = (d1 - d0) / (Y1 - Y0); // depth decreases with y, so slope < 0
  const surface = Y0 - d0 / slope; // zero-crossing of the line through the two samples
  // A fresh world fills anything below sea level with water, and BlueMap reports
  // that water surface as the "current" height — so clamp the bare terrain floor
  // up to the water surface, otherwise every ocean reads as a large false diff.
  return Math.max(Math.round(surface), seaLevel - 1);
}

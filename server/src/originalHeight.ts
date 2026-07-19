import { DensityFunction, RandomState } from "deepslate";
import { loadOverworldSettings, loadWorldgenData } from "./biome";

/**
 * The topmost block Y a freshly-generated world (same seed, no players) would
 * have at a column — the baseline the "Difference" map view compares the live
 * world against.
 *
 * This runs the REAL vanilla terrain pipeline: the noise router's
 * `final_density` graph (3D noise, jaggedness, cave carvers — everything),
 * made to parse correctly by the `interval_select` compatibility rewrite in
 * biome.ts. The surface is the topmost y where final_density > 0 (solid),
 * scanned downward from just above the router's own preliminary surface
 * estimate. Direct `.compute()` calls go through deepslate's `Interpolated`
 * wrappers, which lerp cell corners exactly like in-game chunk generation —
 * so results are block-accurate (verified matching the live map exactly in
 * un-terraformed terrain).
 *
 * The one remaining approximation: feature decoration (trees, etc.) is not
 * simulated, so natural tree canopy reads as a small difference vs BlueMap's
 * top rendered block.
 */

const WORLD_TOP = 320;
const WORLD_BOTTOM = -64;
/** Blocks above the preliminary-surface estimate where the scan starts.
 *  Jaggedness peaks reach ~+16 over it; 40 is a generous safety margin. */
const SCAN_MARGIN = 40;

interface HeightState {
  seed: bigint;
  finalDensity: DensityFunction;
  preliminarySurface: DensityFunction;
  seaLevel: number;
}

let cached: HeightState | null = null;
let callsSinceReset = 0;

/**
 * deepslate memoizes every `Interpolated` cell corner it evaluates, per
 * RandomState, in unbounded Maps — over a long run those overflow JS's max
 * Map size ("RangeError: Map maximum size exceeded"). Rebuilding the
 * RandomState resets them; results are identical either way (it's a pure
 * function of settings + seed). preprocess.ts calls resetOriginalHeightCaches
 * per tile; the call counter is a backstop for other callers.
 */
const RESET_INTERVAL = 300_000;

export function resetOriginalHeightCaches(): void {
  cached = null;
  callsSinceReset = 0;
}

function stateFor(seed: bigint): HeightState {
  loadWorldgenData();
  if (cached && cached.seed === seed && callsSinceReset < RESET_INTERVAL) return cached;
  const settings = loadOverworldSettings();
  const randomState = new RandomState(settings, seed);
  cached = {
    seed,
    finalDensity: randomState.router.finalDensity,
    preliminarySurface: randomState.router.preliminarySurfaceLevel,
    seaLevel: settings.seaLevel,
  };
  callsSinceReset = 0;
  return cached;
}

export function originalHeight(seed: bigint, x: number, z: number): number {
  const { finalDensity, preliminarySurface, seaLevel } = stateFor(seed);
  callsSinceReset++;
  const ctx = DensityFunction.context;

  const guess = Math.floor(preliminarySurface.compute(ctx(x, 0, z)));
  let top = Math.min(WORLD_TOP, guess + SCAN_MARGIN);
  // Never start inside solid ground: if the margin above the estimate is
  // still solid (a freak spike), walk up until we reach air.
  while (top < WORLD_TOP && finalDensity.compute(ctx(x, top, z)) > 0) top++;

  for (let y = top; y >= WORLD_BOTTOM; y--) {
    if (finalDensity.compute(ctx(x, y, z)) > 0) {
      // Topmost solid block. A fresh world floods everything below sea level
      // with water, and BlueMap reports the water surface as the top block.
      return Math.max(y, seaLevel - 1);
    }
  }
  return seaLevel - 1; // no solid found (deep ocean column) -> water surface
}

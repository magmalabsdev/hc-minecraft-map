import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Climate,
  DensityFunction,
  Identifier,
  NoiseGeneratorSettings,
  NoiseParameters,
  RandomState,
  WorldgenRegistries,
} from "deepslate";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/server/src
export const VENDOR_DIR = path.resolve(here, "../vendor/worldgen");

/**
 * Vanilla's real overworld biome placement (`OverworldBiomeBuilder`) is a
 * ~700-point Voronoi lookup baked into the client, not exposed anywhere as
 * data — so it can't be reproduced exactly without decompiling the game.
 * What *is* public and data-driven is the climate noise itself (temperature,
 * humidity, continentalness, erosion, weirdness, depth): six density-function
 * graphs from the actual vanilla worldgen data, evaluated here with deepslate
 * for the server's real seed. `classifyBiome` below maps that real climate
 * onto biome names with a hand-built approximation of vanilla's bands, so the
 * regions are seed-accurate in shape/placement even though the exact biome
 * chosen at a boundary may differ from the live server.
 */

let dataLoaded = false;

export function loadWorldgenData(): void {
  if (dataLoaded) return;
  dataLoaded = true;
  walk(path.join(VENDOR_DIR, "noise"), (id, json) => {
    WorldgenRegistries.NOISE.register(Identifier.parse(id), NoiseParameters.fromJson(json));
  });
  walk(path.join(VENDOR_DIR, "density_function"), (id, json) => {
    WorldgenRegistries.DENSITY_FUNCTION.register(
      Identifier.parse(id),
      DensityFunction.fromJson(rewriteUnsupportedDensityFunctions(json)),
    );
  });
}

/**
 * The vendored worldgen data comes from a newer Minecraft version than the
 * deepslate release we use understands. Deepslate silently parses any unknown
 * density-function type as constant 0 — and `minecraft:interval_select`
 * (used by the overworld cave functions) landing as 0 inside final_density's
 * `min(...)` chain flattens the ENTIRE world to air. This rewrites every
 * `interval_select` node into an exactly-equivalent chain of nested
 * `range_choice` nodes (which deepslate does support) before parsing:
 * pick functions[i] when input ∈ [thresholds[i-1], thresholds[i]), the last
 * function for input ≥ the last threshold. The selector is wrapped in
 * `cache_once` so the chain doesn't recompute it at every link. Boundary
 * inclusivity is a measure-zero concern on continuous noise inputs.
 */
export function rewriteUnsupportedDensityFunctions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteUnsupportedDensityFunctions);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "minecraft:interval_select") {
      const input = {
        type: "minecraft:cache_once",
        argument: rewriteUnsupportedDensityFunctions(obj.input),
      };
      const fns = (obj.functions as unknown[]).map(rewriteUnsupportedDensityFunctions);
      const ts = obj.thresholds as number[];
      let out = fns[fns.length - 1];
      for (let i = ts.length - 1; i >= 0; i--) {
        out = {
          type: "minecraft:range_choice",
          input,
          min_inclusive: i === 0 ? -1e9 : ts[i - 1],
          max_exclusive: ts[i],
          when_in_range: fns[i],
          when_out_of_range: out,
        };
      }
      return out;
    }
    const rewritten: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) rewritten[k] = rewriteUnsupportedDensityFunctions(v);
    return rewritten;
  }
  return node;
}

function walk(dir: string, cb: (id: string, json: unknown) => void, base = dir): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb, base);
    else if (entry.name.endsWith(".json")) {
      const rel = path.relative(base, full).replace(/\.json$/, "").split(path.sep).join("/");
      cb(`minecraft:${rel}`, JSON.parse(fs.readFileSync(full, "utf8")));
    }
  }
}

let cached: { seed: bigint; sampler: Climate.Sampler } | null = null;

/** Real vanilla overworld climate sampler for the given world seed. */
export function climateSampler(seed: bigint): Climate.Sampler {
  loadWorldgenData();
  if (cached && cached.seed === seed) return cached.sampler;
  const settings = loadOverworldSettings();
  const randomState = new RandomState(settings, seed);
  cached = { seed, sampler: randomState.sampler };
  return randomState.sampler;
}

/** Parse the vendored overworld noise settings (with the compatibility rewrite). */
export function loadOverworldSettings(): NoiseGeneratorSettings {
  const overworldSettings = JSON.parse(
    fs.readFileSync(path.join(VENDOR_DIR, "noise_settings/overworld.json"), "utf8"),
  );
  return NoiseGeneratorSettings.fromJson(rewriteUnsupportedDensityFunctions(overworldSettings));
}

export interface ClimatePoint {
  temperature: number;
  humidity: number;
  continentalness: number;
  erosion: number;
  depth: number;
  weirdness: number;
}

/** Sample real vanilla overworld climate noise at a block (x, z) position. */
export function sampleClimate(sampler: Climate.Sampler, x: number, z: number): ClimatePoint {
  const t = sampler.sample(x >> 2, 0, z >> 2);
  return {
    temperature: t.temperature,
    humidity: t.humidity,
    continentalness: t.continentalness,
    erosion: t.erosion,
    depth: t.depth,
    weirdness: t.weirdness,
  };
}

// --- climate band thresholds (from Mojang's publicly documented overworld ranges) ---
const OCEAN_DEEP = -0.455;
const OCEAN = -0.19;
const COAST = -0.11;

const EROSION_MOUNTAINS = -0.78;
const EROSION_HILLS = -0.375;
const EROSION_MID = 0.05;
const EROSION_PLAINS = 0.45;

const TEMP_FROZEN = -0.45;
const TEMP_COLD = -0.15;
const TEMP_TEMPERATE = 0.2;
const TEMP_WARM = 0.55;

const HUM_ARID = -0.35;
const HUM_LOW = -0.1;
const HUM_MED = 0.1;
const HUM_HIGH = 0.3;

type Tier = "mountains" | "hills" | "midlands" | "plains" | "lowlands";

function tempBand(t: number): number {
  if (t < TEMP_FROZEN) return 0;
  if (t < TEMP_COLD) return 1;
  if (t < TEMP_TEMPERATE) return 2;
  if (t < TEMP_WARM) return 3;
  return 4;
}

function humidBand(h: number): number {
  if (h < HUM_ARID) return 0;
  if (h < HUM_LOW) return 1;
  if (h < HUM_MED) return 2;
  if (h < HUM_HIGH) return 3;
  return 4;
}

function erosionTier(e: number): Tier {
  if (e < EROSION_MOUNTAINS) return "mountains";
  if (e < EROSION_HILLS) return "hills";
  if (e < EROSION_MID) return "midlands";
  if (e < EROSION_PLAINS) return "plains";
  return "lowlands";
}

const OCEAN_BY_TEMP = ["frozen_ocean", "cold_ocean", "ocean", "lukewarm_ocean", "warm_ocean"];
const DEEP_OCEAN_BY_TEMP = [
  "deep_frozen_ocean",
  "deep_cold_ocean",
  "deep_ocean",
  "deep_lukewarm_ocean",
  "deep_lukewarm_ocean",
];

function classifyBeach(temp5: number, erosion: number): string {
  if (temp5 === 0) return "snowy_beach";
  if (erosion < EROSION_HILLS) return "stony_shore";
  return "beach";
}

function classifyLand(temp5: number, humid5: number, tier: Tier, weird: number): string {
  const weirdAbs = Math.abs(weird);

  if (tier === "mountains") {
    if (temp5 === 0) return weirdAbs > 0.3 ? "frozen_peaks" : "snowy_slopes";
    if (temp5 === 1) return weirdAbs > 0.3 ? "jagged_peaks" : humid5 >= 3 ? "grove" : "stony_peaks";
    if (humid5 <= 1) return weirdAbs > 0.5 ? "windswept_gravelly_hills" : "windswept_hills";
    return "windswept_forest";
  }

  if (tier === "hills") {
    if (temp5 === 0) return "snowy_taiga";
    if (temp5 === 1) return humid5 >= 3 ? "old_growth_pine_taiga" : "taiga";
    if (temp5 <= 2) return humid5 <= 1 ? "windswept_hills" : "windswept_forest";
    return humid5 <= 1 ? "savanna_plateau" : "windswept_forest";
  }

  // badlands: hot + dry, on the flatter tiers
  if (temp5 === 4 && humid5 === 0 && (tier === "midlands" || tier === "plains")) {
    if (weirdAbs > 0.5) return "eroded_badlands";
    return weird > 0.15 ? "wooded_badlands" : "badlands";
  }

  if (temp5 === 4 && humid5 <= 1) return "desert";

  // swamp: flat, warm-hot, humid
  if (tier === "lowlands" && humid5 >= 3 && temp5 >= 2) {
    return temp5 === 4 ? "mangrove_swamp" : "swamp";
  }

  if (temp5 >= 3 && humid5 >= 3) {
    if (weird > 0.4) return "bamboo_jungle";
    return humid5 === 3 ? "sparse_jungle" : "jungle";
  }

  if (temp5 >= 3 && humid5 <= 2) {
    return tier === "midlands" ? "savanna_plateau" : "savanna";
  }

  if (temp5 === 0) {
    if (weird > 0.6 && humid5 <= 1) return "ice_spikes";
    return humid5 >= 3 ? "snowy_taiga" : "snowy_plains";
  }

  if (temp5 === 1 && humid5 >= 2) return "taiga";

  if (humid5 >= 4) return "dark_forest";
  if (humid5 === 3) {
    if (temp5 >= 2) return "birch_forest";
    return weird > 0.3 ? "flower_forest" : "forest";
  }
  if (humid5 === 2) return "forest";

  return weird > 0.5 ? "sunflower_plains" : "plains";
}

/** Approximate biome id + display color for a sampled climate point. */
export function classifyBiome(c: ClimatePoint): { id: string; color: [number, number, number] } {
  const temp5 = tempBand(c.temperature);
  let id: string;
  if (c.continentalness < OCEAN) {
    id = c.continentalness < OCEAN_DEEP ? DEEP_OCEAN_BY_TEMP[temp5] : OCEAN_BY_TEMP[temp5];
  } else if (c.continentalness < COAST) {
    id = classifyBeach(temp5, c.erosion);
  } else {
    const humid5 = humidBand(c.humidity);
    const tier = erosionTier(c.erosion);
    id = classifyLand(temp5, humid5, tier, c.weirdness);
  }
  return { id, color: BIOME_COLORS[id] ?? [120, 120, 120] };
}

/** Grey used for "Urban" cells (see preprocess.ts's block-deviation heuristic). */
export const URBAN_COLOR: [number, number, number] = [128, 128, 128];

// Colors sourced from the vanilla map-item biome color convention (as
// catalogued by misode/deepslate's demo palette); mangrove_swamp is filled in
// by hand since that reference predates its addition.
const BIOME_COLORS: Record<string, [number, number, number]> = {
  frozen_ocean: [112, 112, 214],
  deep_frozen_ocean: [64, 64, 144],
  cold_ocean: [32, 32, 112],
  deep_cold_ocean: [32, 32, 56],
  ocean: [0, 0, 112],
  deep_ocean: [0, 0, 48],
  lukewarm_ocean: [0, 0, 144],
  deep_lukewarm_ocean: [0, 0, 64],
  warm_ocean: [0, 0, 172],
  snowy_beach: [250, 240, 192],
  beach: [250, 222, 85],
  stony_shore: [162, 162, 132],
  frozen_peaks: [200, 198, 200],
  jagged_peaks: [196, 168, 193],
  stony_peaks: [82, 92, 103],
  snowy_slopes: [140, 195, 222],
  grove: [150, 150, 189],
  windswept_hills: [96, 96, 96],
  windswept_gravelly_hills: [136, 136, 136],
  windswept_forest: [80, 112, 80],
  old_growth_pine_taiga: [89, 102, 81],
  old_growth_spruce_taiga: [129, 142, 121],
  taiga: [11, 102, 89],
  savanna_plateau: [167, 157, 100],
  badlands: [217, 69, 21],
  eroded_badlands: [255, 109, 61],
  wooded_badlands: [176, 151, 101],
  desert: [250, 148, 24],
  savanna: [189, 178, 95],
  plains: [141, 179, 96],
  sunflower_plains: [181, 219, 136],
  forest: [5, 102, 33],
  flower_forest: [45, 142, 73],
  birch_forest: [48, 116, 68],
  dark_forest: [64, 81, 26],
  jungle: [83, 123, 9],
  sparse_jungle: [98, 139, 23],
  bamboo_jungle: [118, 142, 20],
  swamp: [7, 249, 178],
  mangrove_swamp: [91, 116, 58],
  snowy_plains: [255, 255, 255],
  ice_spikes: [180, 220, 220],
  snowy_taiga: [49, 85, 74],
};

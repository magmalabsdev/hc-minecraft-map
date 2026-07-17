import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/server/src
export const REPO_ROOT = path.resolve(here, "../..");
export const SNAPSHOT_DIR = path.join(REPO_ROOT, "snapshot");
export const DATA_DIR = path.join(REPO_ROOT, "data");

/** Upstream BlueMap deployment we mirror from. */
export const UPSTREAM = process.env.BLUEMAP_UPSTREAM ?? "https://mc.hackclub.com";

export const PORT = Number(process.env.PORT ?? 8787);

/**
 * Default region to mirror when none is given, in block coordinates. Chosen to
 * bracket the SMP spawn point (-182, 27) reported by the live markers.json.
 */
export const DEFAULT_REGION = {
  dimension: "world" as const,
  minX: -2000,
  minZ: -2000,
  maxX: 2000,
  maxZ: 2000,
};

/**
 * Contour spacing (blocks of elevation between lines) for generated GeoJSON.
 */
export const CONTOUR_INTERVAL = 8;

/**
 * Downsample factor applied to the height grid before contouring. 1 = full
 * resolution (1 sample/block); higher trades detail for speed & file size.
 */
export const CONTOUR_DOWNSAMPLE = 4;

/** The SMP's world seed, used to reverse-engineer biome placement (see biome.ts). */
export const WORLD_SEED = -4475792576490886961n;

/** Block span of one solid-color cell in the biome map. */
export const BIOME_CELL_SIZE = 50;

/**
 * Sub-pixels per block rendered into the "bands" (Terrain 2D) tile, so a
 * smaller inner dot showing the exact ones-digit can be nested inside each
 * block's resistor-band color. Must be a power of 2 (the overview pyramid
 * normalizes it back down via repeated halving). Kept small (2 = a single
 * corner sub-pixel) since the fine per-block texture this creates compresses
 * far worse than the original smooth solid-color bands tiles.
 */
export const BANDS_SUPERSAMPLE = 2;

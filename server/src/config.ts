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

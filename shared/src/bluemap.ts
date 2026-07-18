/**
 * Constants and pure helpers for interpreting BlueMap's on-disk tile data.
 *
 * All values are verified against the live deployment at mc.hackclub.com
 * (BlueMap 5.15) — see `maps/<id>/settings.json`:
 *
 *   hires:  tileSize [32,32], scale [1,1], translate [2,2]
 *   lowres: tileSize [500,500], lodFactor 5, lodCount 3
 *
 * Tile URL layout (relative to the map data root `maps/<id>/`):
 *   hires  (3D geometry): tiles/0/x<x>/z<z>.prbm   (gzip; HTTP 204 when empty)
 *   lowres (2D raster):   tiles/<lod>/x<x>/z<z>.png  for lod in 1..lodCount
 *
 * The lowres PNG is `tileSize.x` wide by `2 * tileSize.y` tall. The encoding is
 * taken directly from BlueMap's LowresFragmentShader:
 *   - top half   (rows 0 .. tileSize.y-1)          = surface COLOR (RGBA)
 *   - bottom half (rows tileSize.y .. 2*tileSize.y-1) = META, where per texel:
 *       height (blocks, signed) = decodeHeight(G, B)
 *       block-light (0..255)    = R
 *
 * At lod 1 each texel represents exactly one block column, so a lod-1 tile
 * covers `tileSize` blocks and doubles as a full-resolution heightmap.
 */

export const LOWRES_TILE_SIZE = 500;
export const HIRES_TILE_SIZE = 32;
export const LOD_FACTOR = 5;
export const LOD_COUNT = 3;

export type Dimension = "world" | "world_nether" | "world_the_end";

// Only the Overworld is surfaced in the UI — the Nether and End are never
// mirrored, so they'd be empty map options. The type keeps the other two so
// the backend/tile plumbing stays dimension-generic.
export const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: "world", label: "Overworld" },
];

/** How many blocks a single lod texel spans. lod 1 -> 1 block, lod 2 -> 5, ... */
export function lodBlockScale(lod: number): number {
  return LOD_FACTOR ** (lod - 1);
}

/** Block span of one lowres tile at the given lod. */
export function lodTileBlocks(lod: number): number {
  return LOWRES_TILE_SIZE * lodBlockScale(lod);
}

/** Block (x or z) -> lowres tile index (x or z) at the given lod. */
export function blockToLowresTileIndex(block: number, lod: number): number {
  return Math.floor(block / lodTileBlocks(lod));
}

/** Block (x or z) -> hires tile index. */
export function blockToHiresTileIndex(block: number): number {
  return Math.floor(block / HIRES_TILE_SIZE);
}

/**
 * Decode a signed block height from the green/blue channels of a meta texel.
 * Mirrors `metaToHeight` in LowresFragmentShader: 16-bit value G<<8 | B, where
 * values >= 32768 are negative.
 */
export function decodeHeight(g: number, b: number): number {
  const unsigned = g * 256 + b;
  return unsigned >= 32768 ? -(65535 - unsigned) : unsigned;
}

/** Decode block-light level (0..255) from the red channel of a meta texel. */
export function decodeLight(r: number): number {
  return r;
}

import { DEFAULT_REGION } from "./config";
import { mirrorRegion, type Region } from "./preprocess";
import type { Dimension } from "@hcmap/shared";

/**
 * CLI: mirror + preprocess a block region into the committed snapshot.
 *
 *   npm run mirror -- --dim world --minX -1000 --minZ -1000 --maxX 1000 --maxZ 1000
 *
 * With no flags it uses DEFAULT_REGION (a box around spawn).
 */
function parseArgs(argv: string[]): Region {
  const region: Region = { ...DEFAULT_REGION };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const val = argv[i + 1];
    if (!key || val === undefined) continue;
    if (key === "dim") region.dimension = val as Dimension;
    else if (key === "minX") region.minX = Number(val);
    else if (key === "minZ") region.minZ = Number(val);
    else if (key === "maxX") region.maxX = Number(val);
    else if (key === "maxZ") region.maxZ = Number(val);
  }
  return region;
}

const region = parseArgs(process.argv.slice(2));
console.log("[mirror] region:", region);
const result = await mirrorRegion(region);
console.log("[mirror] done:", result);

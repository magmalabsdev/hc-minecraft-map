import { DEFAULT_REGION } from "./config";
import { mirrorWaterMasks, type Region } from "./preprocess";
import type { Dimension } from "@hcmap/shared";

/**
 * CLI: (re)generate ONLY the "water" mask tiles for a region — no terrain
 * simulation, no manifest writes, so it's fast and safe to run any time
 * (including alongside a full mirror).
 *
 *   npm run water -w server -- --dim world --minX -15000 --minZ -15000 --maxX 15000 --maxZ 15000
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
console.log("[water] region:", region);
const result = await mirrorWaterMasks(region);
console.log("[water] done:", result);

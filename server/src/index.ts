import express from "express";
import type { Request, Response, NextFunction } from "express";
import { PORT, SNAPSHOT_DIR, DATA_DIR, DEFAULT_REGION } from "./config";
import { proxyUpstream } from "./mirror";
import { mirrorRegion, type Region } from "./preprocess";
import { isDataKind, readData, writeData } from "./data";
import type { Dimension } from "@hcmap/shared";

const app = express();
app.use(express.json({ limit: "16mb" }));

// Permissive read CORS so the built site can talk to a locally-run backend.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  next();
});
app.options(/.*/, (_req, res) => res.status(204).end());

/** Guards write/mirror endpoints so they only work when running locally. */
function localOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.socket.remoteAddress ?? "";
  const local =
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
  if (!local) {
    res.status(403).json({ error: "edit endpoints are available on localhost only" });
    return;
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, editable: true });
});

// --- terrain snapshot (works with no upstream) ---
app.use("/snapshot", express.static(SNAPSHOT_DIR, { fallthrough: true }));

// --- overlay data as static files (read path, no backend needed to view) ---
app.use("/data", express.static(DATA_DIR, { fallthrough: true }));

// --- upstream mirror proxy (fresh tiles + live data) ---
app.get(/^\/api\/mirror\/(.*)$/, proxyUpstream);

// --- manual mirror: pull + preprocess a region into the snapshot ---
app.post("/api/mirror/run", localOnly, async (req, res) => {
  const region: Region = { ...DEFAULT_REGION, ...(req.body ?? {}) };
  if (!["world", "world_nether", "world_the_end"].includes(region.dimension)) {
    res.status(400).json({ error: "invalid dimension" });
    return;
  }
  region.dimension = region.dimension as Dimension;
  try {
    const result = await mirrorRegion(region);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- editable overlay data ---
app.get("/api/data/:kind", async (req, res) => {
  if (!isDataKind(req.params.kind)) {
    res.status(404).json({ error: "unknown data kind" });
    return;
  }
  res.json(await readData(req.params.kind));
});

app.put("/api/data/:kind", localOnly, async (req, res) => {
  if (!isDataKind(req.params.kind)) {
    res.status(404).json({ error: "unknown data kind" });
    return;
  }
  try {
    await writeData(req.params.kind, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[hcmap] server on http://localhost:${PORT}`);
  console.log(`[hcmap] snapshot dir: ${SNAPSHOT_DIR}`);
});

import type { Request, Response } from "express";
import { UPSTREAM } from "./config";

/**
 * Transparent same-origin proxy to the upstream BlueMap. Solves the CORS gap:
 * the browser can read pixels / fetch live data through us. Used as the "fresh"
 * tile source in dev and as a fallback when the snapshot lacks a tile.
 *
 * Mounted at /api/mirror, so /api/mirror/maps/world/tiles/1/x0/z0.png proxies
 * https://mc.hackclub.com/maps/world/tiles/1/x0/z0.png.
 */
export async function proxyUpstream(req: Request, res: Response): Promise<void> {
  // req.params[0] is the wildcard tail after /api/mirror/
  const tail = (req.params as Record<string, string>)[0] ?? "";
  if (tail.includes("..")) {
    res.status(400).end("bad path");
    return;
  }
  const url = `${UPSTREAM}/${tail}`;
  try {
    const upstream = await fetch(url);
    res.status(upstream.status);
    const type = upstream.headers.get("content-type");
    if (type) res.setHeader("content-type", type);
    // Cache tiles for a day; live/* data must stay fresh.
    res.setHeader(
      "cache-control",
      tail.includes("/live/") ? "no-store" : "public, max-age=86400",
    );
    if (upstream.status === 204 || !upstream.body) {
      res.end();
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.status(502).end(`upstream error: ${(err as Error).message}`);
  }
}

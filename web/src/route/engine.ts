import {
  type HighwayNetwork,
  type Id,
  type Landmark,
  type RailwayNetwork,
  type Vec2,
  nodeDistance,
  resolveSegment,
} from "@hcmap/shared";
import type { Network } from "../edit/model";
import type { HeightField } from "./heightField";

export type RouteMode = "walk" | "rail" | "horse";

/** Blocks per second. Minecart top speed on powered rails ≈ 8; player walk ≈
 *  4.317; average horse ≈ 9.7 (horses vary 4.8–14.5). */
const SPEED: Record<RouteMode, number> = { walk: 4.317, rail: 8.0, horse: 9.7 };

/** Deviation gate: a straight shortcut is allowed only below this slope. Horse
 *  only deviates on near-flat ground ("flat biomes"); walking tolerates more. */
const MAX_SLOPE: Record<RouteMode, number> = { walk: 0.5, rail: 0, horse: 0.2 };
const MAX_SHORTCUT = 500; // blocks — cap shortcut length for performance

export interface RouteResult {
  ok: boolean;
  mode: RouteMode;
  points: Vec2[];
  distanceBlocks: number;
  timeSeconds: number;
  message?: string;
  deviated: boolean;
}

function landmarkPos(lm: Landmark): Vec2 | null {
  if (lm.point) return lm.point;
  if (lm.polygon && lm.polygon.length) {
    const n = lm.polygon.length;
    return {
      x: lm.polygon.reduce((s, p) => s + p.x, 0) / n,
      z: lm.polygon.reduce((s, p) => s + p.z, 0) / n,
    };
  }
  return null;
}

/** Nodes touching at least one segment that isn't width-0 (not built yet /
 *  nonfunctional) — the only nodes route-finding may use as an anchor. */
function functionalNodeIds(net: Network): Set<Id> {
  const ids = new Set<Id>();
  for (const seg of Object.values(net.segments)) {
    if (resolveSegment(seg).props.width <= 0) continue;
    ids.add(seg.a);
    ids.add(seg.b);
  }
  return ids;
}

function nearestNode(net: Network, p: Vec2, allowed: Set<Id>): Id | null {
  let best: Id | null = null;
  let bestD = Infinity;
  for (const [id, n] of Object.entries(net.nodes)) {
    if (!allowed.has(id)) continue;
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** Dijkstra shortest path over the shared segment graph (edge weight = length).
 *  Width-0 segments (not built yet / nonfunctional) are excluded entirely. */
function shortestPath(net: Network, start: Id, goal: Id): Id[] | null {
  const adj = new Map<Id, { to: Id; w: number }[]>();
  const link = (from: Id, to: Id, w: number) => {
    let list = adj.get(from);
    if (!list) adj.set(from, (list = []));
    list.push({ to, w });
  };
  for (const seg of Object.values(net.segments)) {
    if (resolveSegment(seg).props.width <= 0) continue;
    const a = net.nodes[seg.a];
    const b = net.nodes[seg.b];
    if (!a || !b) continue;
    const w = nodeDistance(a, b);
    link(seg.a, seg.b, w);
    link(seg.b, seg.a, w);
  }

  const dist = new Map<Id, number>();
  const prev = new Map<Id, Id>();
  const visited = new Set<Id>();
  dist.set(start, 0);
  // Simple array-based priority queue (networks are small).
  const queue = new Set<Id>([start]);
  while (queue.size) {
    let u: Id | null = null;
    let ud = Infinity;
    for (const q of queue) {
      const d = dist.get(q) ?? Infinity;
      if (d < ud) {
        ud = d;
        u = q;
      }
    }
    if (u === null) break;
    queue.delete(u);
    if (u === goal) break;
    visited.add(u);
    for (const { to, w } of adj.get(u) ?? []) {
      if (visited.has(to)) continue;
      const nd = ud + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
        queue.add(to);
      }
    }
  }

  if (!dist.has(goal)) return null;
  const path: Id[] = [];
  let cur: Id | undefined = goal;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return path[0] === start ? path : null;
}

/**
 * Terrain-aware deviation: greedily replace stretches of the road path with a
 * straight shortcut whenever the terrain along it stays smooth enough. Rough
 * terrain forces the route to stay on the roadway.
 */
function applyDeviation(points: Vec2[], hf: HeightField, maxSlope: number): {
  points: Vec2[];
  deviated: boolean;
} {
  if (points.length < 3) return { points, deviated: false };
  const out: Vec2[] = [points[0]];
  let i = 0;
  let deviated = false;
  while (i < points.length - 1) {
    let chosen = i + 1;
    for (let k = points.length - 1; k > i + 1; k--) {
      const a = points[i];
      const b = points[k];
      if (Math.hypot(b.x - a.x, b.z - a.z) > MAX_SHORTCUT) continue;
      if (hf.maxSlopeAlong(a.x, a.z, b.x, b.z) <= maxSlope) {
        chosen = k;
        if (k > i + 1) deviated = true;
        break;
      }
    }
    out.push(points[chosen]);
    i = chosen;
  }
  return { points: out, deviated };
}

function totalDistance(points: Vec2[]): number {
  let d = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    d += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return d;
}

export interface RouteContext {
  highways: HighwayNetwork;
  railways: RailwayNetwork;
  heightField: HeightField | null;
}

export function computeRoute(
  mode: RouteMode,
  from: Landmark,
  to: Landmark,
  ctx: RouteContext,
): RouteResult {
  const base = (v: Partial<RouteResult> = {}): RouteResult => ({
    ok: false,
    mode,
    points: [],
    distanceBlocks: 0,
    timeSeconds: 0,
    deviated: false,
    ...v,
  });

  const a = landmarkPos(from);
  const b = landmarkPos(to);
  if (!a || !b) return base({ message: "Landmarks need a position." });

  const net: Network = mode === "rail" ? ctx.railways : ctx.highways;
  const functional = functionalNodeIds(net);
  if (functional.size === 0) {
    return base({
      message: `No ${mode === "rail" ? "railway" : "highway"} network drawn yet.`,
    });
  }

  const startNode = nearestNode(net, a, functional);
  const endNode = nearestNode(net, b, functional);
  if (!startNode || !endNode) return base({ message: "No reachable network node." });

  let points: Vec2[];
  let deviated = false;

  if (startNode === endNode) {
    points = [a, net.nodes[startNode], b];
  } else {
    const path = shortestPath(net, startNode, endNode);
    if (!path) {
      return base({ message: "Landmarks are on disconnected parts of the network." });
    }
    const nodePts = path.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
    points = [a, ...nodePts, b];
  }

  // Walking / horse may deviate off the roadway across smooth terrain.
  if (mode !== "rail" && ctx.heightField) {
    const dev = applyDeviation(points, ctx.heightField, MAX_SLOPE[mode]);
    points = dev.points;
    deviated = dev.deviated;
  }

  const distance = totalDistance(points);
  return base({
    ok: true,
    points,
    distanceBlocks: Math.round(distance),
    timeSeconds: distance / SPEED[mode],
    deviated,
  });
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

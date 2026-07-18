import {
  type HighwayNetwork,
  type Id,
  type Landmark,
  type RailwayNetwork,
  type Route,
  type Segment,
  type Station,
  type StationAccess,
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

/** How far you'll walk to reach a railway station, and how many nearby stations
 *  to try on each end (so a slightly-farther station with a better connection
 *  can win). Seconds added per line change, to prefer fewer transfers. */
const MAX_STATION_WALK = 700;
const MAX_STATION_CANDIDATES = 5;
const TRANSFER_PENALTY_S = 45;

/** One contiguous stretch of a journey travelled by a single mode. */
export interface RouteLeg {
  mode: RouteMode;
  points: Vec2[];
}

/** An addressable endpoint for route-finding — resolved from anything clickable
 *  on the map (a landmark, station, district) or a bare map coordinate. */
export interface RoutePlace {
  kind: "landmark" | "station" | "district" | "point";
  id?: Id;
  name: string;
  pos: Vec2;
}

export interface RouteResult {
  ok: boolean;
  mode: RouteMode;
  points: Vec2[];
  /** Per-mode breakdown of the path (rail journeys walk to/from stations). */
  legs: RouteLeg[];
  distanceBlocks: number;
  timeSeconds: number;
  message?: string;
  deviated: boolean;
  // Rail-only journey detail (walking legs to/from the chosen stations).
  boardStation?: string;
  alightStation?: string;
  transfers?: number;
  walkToStationSeconds?: number;
  railSeconds?: number;
  walkFromStationSeconds?: number;
}

export function centroidOf(poly: Vec2[]): Vec2 {
  const n = poly.length || 1;
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / n,
    z: poly.reduce((s, p) => s + p.z, 0) / n,
  };
}

/** Resolve a landmark to a routable position (its point, or polygon centroid). */
export function landmarkPos(lm: Landmark): Vec2 | null {
  if (lm.point) return lm.point;
  if (lm.polygon && lm.polygon.length) return centroidOf(lm.polygon);
  return null;
}

/** A segment is usable for route-finding unless it's width-0 (not built yet /
 *  nonfunctional) or explicitly marked unbuilt (planned rail track). */
function isUsable(seg: Segment): boolean {
  const props = resolveSegment(seg).props;
  return props.width > 0 && props.built !== false;
}

/** Nodes touching at least one usable segment — the only nodes route-finding
 *  may use as an anchor. */
function functionalNodeIds(net: Network): Set<Id> {
  const ids = new Set<Id>();
  for (const seg of Object.values(net.segments)) {
    if (!isUsable(seg)) continue;
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
 *  Unusable segments (width-0, or unbuilt/planned track) are excluded entirely. */
function shortestPath(net: Network, start: Id, goal: Id): Id[] | null {
  const adj = new Map<Id, { to: Id; w: number }[]>();
  const link = (from: Id, to: Id, w: number) => {
    let list = adj.get(from);
    if (!list) adj.set(from, (list = []));
    list.push({ to, w });
  };
  for (const seg of Object.values(net.segments)) {
    if (!isUsable(seg)) continue;
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

function base(mode: RouteMode, v: Partial<RouteResult> = {}): RouteResult {
  return {
    ok: false,
    mode,
    points: [],
    legs: [],
    distanceBlocks: 0,
    timeSeconds: 0,
    deviated: false,
    ...v,
  };
}

export function computeRoute(
  mode: RouteMode,
  from: RoutePlace,
  to: RoutePlace,
  ctx: RouteContext,
): RouteResult {
  if (mode === "rail") return railRoute(from, to, ctx);
  return roadRoute(mode, from, to, ctx);
}

/** Walking / horse routing over the highway graph, with terrain deviation. */
function roadRoute(
  mode: RouteMode,
  from: RoutePlace,
  to: RoutePlace,
  ctx: RouteContext,
): RouteResult {
  const a = from.pos;
  const b = to.pos;
  const net: Network = ctx.highways;
  const functional = functionalNodeIds(net);
  if (functional.size === 0) {
    return base(mode, { message: "No highway network drawn yet." });
  }

  const startNode = nearestNode(net, a, functional);
  const endNode = nearestNode(net, b, functional);
  if (!startNode || !endNode) return base(mode, { message: "No reachable network node." });

  let points: Vec2[];
  let deviated = false;

  if (startNode === endNode) {
    points = [a, net.nodes[startNode], b];
  } else {
    const path = shortestPath(net, startNode, endNode);
    if (!path) {
      return base(mode, { message: "Endpoints are on disconnected parts of the network." });
    }
    const nodePts = path.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
    points = [a, ...nodePts, b];
  }

  if (ctx.heightField) {
    const dev = applyDeviation(points, ctx.heightField, MAX_SLOPE[mode]);
    points = dev.points;
    deviated = dev.deviated;
  }

  const distance = totalDistance(points);
  return base(mode, {
    ok: true,
    points,
    legs: [{ mode, points }],
    distanceBlocks: Math.round(distance),
    timeSeconds: distance / SPEED[mode],
    deviated,
  });
}

interface StationCand {
  station: Station;
  /** Where the rider enters/leaves the station on foot. */
  access: Vec2;
  /** Nearest functional rail node — where the train is boarded. */
  boardNode: Id;
  boardPos: Vec2;
  /** Straight-line walk distance from the endpoint to the access point. */
  walk: number;
}

/** A station's access point nearest to `pos`, preferring entrance/exit by role. */
function stationAccess(st: Station, pos: Vec2, role: "board" | "alight"): Vec2 {
  const usable = (a: StationAccess) =>
    a.kind === "both" || (role === "board" ? a.kind === "entrance" : a.kind === "exit");
  const entrances = (st.entrances ?? []).filter(usable);
  const pool = entrances.length ? entrances : (st.entrances ?? []);
  if (!pool.length) return centroidOf(st.polygon);
  let best = pool[0].point;
  let bestD = Infinity;
  for (const e of pool) {
    const d = Math.hypot(e.point.x - pos.x, e.point.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = e.point;
    }
  }
  return best;
}

/** Nearby, boardable stations for one endpoint, nearest first. Falls back to the
 *  single closest station if none sit within comfortable walking distance. */
function candidateStations(
  net: RailwayNetwork,
  pos: Vec2,
  functional: Set<Id>,
  role: "board" | "alight",
): StationCand[] {
  const cands: StationCand[] = [];
  for (const station of net.stations) {
    if (station.built === false || station.polygon.length < 3) continue;
    const boardNode = nearestNode(net, centroidOf(station.polygon), functional);
    if (!boardNode) continue;
    const access = stationAccess(station, pos, role);
    const boardPos = { x: net.nodes[boardNode].x, z: net.nodes[boardNode].z };
    const walk = Math.hypot(access.x - pos.x, access.z - pos.z);
    cands.push({ station, access, boardNode, boardPos, walk });
  }
  cands.sort((a, b) => a.walk - b.walk);
  const within = cands.filter((c) => c.walk <= MAX_STATION_WALK);
  const chosen = within.length ? within : cands.slice(0, 1);
  return chosen.slice(0, MAX_STATION_CANDIDATES);
}

/** Line changes needed to ride a node path, greedily staying on one line as far
 *  as possible. A segment "belongs to" every route whose ordered nodeIds contain
 *  its consecutive node pair. */
function countTransfers(path: Id[], routes: Route[]): number {
  const linesFor = (a: Id, b: Id): Set<Id> => {
    const s = new Set<Id>();
    for (const r of routes) {
      for (let i = 0; i + 1 < r.nodeIds.length; i++) {
        if (
          (r.nodeIds[i] === a && r.nodeIds[i + 1] === b) ||
          (r.nodeIds[i] === b && r.nodeIds[i + 1] === a)
        ) {
          s.add(r.id);
          break;
        }
      }
    }
    return s;
  };
  let transfers = 0;
  let current: Set<Id> | null = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const lines = linesFor(path[i], path[i + 1]);
    if (current === null) {
      current = lines;
      continue;
    }
    const prev: Set<Id> = current;
    const inter: Set<Id> = new Set<Id>([...prev].filter((x) => lines.has(x)));
    if (inter.size === 0) {
      transfers++;
      current = lines;
    } else {
      current = inter;
    }
  }
  return transfers;
}

/**
 * Rail routing: walk to a nearby station, ride the rail network, walk from the
 * arrival station to the destination. Every nearby station on each end is tried
 * and the combination with the lowest total time (walk + ride + a per-transfer
 * penalty) wins — so it's worth walking a bit further to a better-connected
 * station.
 */
function railRoute(from: RoutePlace, to: RoutePlace, ctx: RouteContext): RouteResult {
  const net = ctx.railways;
  const functional = functionalNodeIds(net);
  if (functional.size === 0) return base("rail", { message: "No railway network drawn yet." });
  if (!net.stations.some((s) => s.built !== false && s.polygon.length >= 3)) {
    return base("rail", { message: "No railway stations to travel between." });
  }

  const origins = candidateStations(net, from.pos, functional, "board");
  const dests = candidateStations(net, to.pos, functional, "alight");
  if (!origins.length || !dests.length) {
    return base("rail", { message: "No railway station within walking distance." });
  }

  let best: {
    o: StationCand;
    d: StationCand;
    path: Id[];
    railDist: number;
    transfers: number;
    cost: number;
  } | null = null;

  for (const o of origins) {
    for (const d of dests) {
      if (o.boardNode === d.boardNode) continue; // same platform — rail adds nothing
      const path = shortestPath(net, o.boardNode, d.boardNode);
      if (!path) continue;
      const nodePts = path.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
      const railDist = totalDistance(nodePts);
      const transfers = countTransfers(path, net.routes);
      const cost =
        o.walk / SPEED.walk +
        railDist / SPEED.rail +
        transfers * TRANSFER_PENALTY_S +
        d.walk / SPEED.walk;
      if (!best || cost < best.cost) best = { o, d, path, railDist, transfers, cost };
    }
  }

  if (!best) {
    return base("rail", {
      message: "Nearby stations aren't connected by rail — try walking or horse.",
    });
  }

  const { o, d, path, railDist, transfers } = best;
  const railPts = path.map((id) => ({ x: net.nodes[id].x, z: net.nodes[id].z }));
  const walkTo: Vec2[] = [from.pos, o.access, o.boardPos];
  const walkFrom: Vec2[] = [d.boardPos, d.access, to.pos];
  const legs: RouteLeg[] = [
    { mode: "walk", points: walkTo },
    { mode: "rail", points: railPts },
    { mode: "walk", points: walkFrom },
  ];
  const points = [from.pos, o.access, ...railPts, d.access, to.pos];

  const walkToSec = totalDistance(walkTo) / SPEED.walk;
  const walkFromSec = totalDistance(walkFrom) / SPEED.walk;
  const railSec = railDist / SPEED.rail;

  return base("rail", {
    ok: true,
    points,
    legs,
    distanceBlocks: Math.round(totalDistance(points)),
    timeSeconds: walkToSec + railSec + walkFromSec + transfers * TRANSFER_PENALTY_S,
    boardStation: o.station.name,
    alightStation: d.station.name,
    transfers,
    walkToStationSeconds: walkToSec,
    railSeconds: railSec,
    walkFromStationSeconds: walkFromSec,
  });
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

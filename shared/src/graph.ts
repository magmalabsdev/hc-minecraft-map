import type {
  DisruptionType,
  District,
  HighwayNetwork,
  Id,
  Node,
  RailwayNetwork,
  Route,
  Segment,
  SegmentProps,
  Station,
  Vec2,
} from "./types";

export type Network = HighwayNetwork | RailwayNetwork;

/** Canonical, order-independent key for the segment between two nodes. */
export function pairKey(a: Id, b: Id): Id {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** Consecutive node pairs of a route as canonical segment keys. */
export function routeSegmentKeys(route: Route): Id[] {
  const keys: Id[] = [];
  for (let i = 0; i + 1 < route.nodeIds.length; i++) {
    keys.push(pairKey(route.nodeIds[i], route.nodeIds[i + 1]));
  }
  return keys;
}

/** Resolve the segments a route traverses, in order (skips any missing). */
export function getRouteSegments(route: Route, network: Network): Segment[] {
  const out: Segment[] = [];
  for (const key of routeSegmentKeys(route)) {
    const seg = network.segments[key];
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * Effective properties of a segment, applying its disruption when active.
 * `disrupted` is true when an active disruption changes at least one value.
 */
export function resolveSegment(seg: Segment): {
  props: SegmentProps;
  disrupted: boolean;
  type?: DisruptionType;
  note?: string;
} {
  // Legacy data may lack `paved`/`built`; treat missing as paved/built.
  const paved = seg.paved ?? true;
  const built = seg.built ?? true;
  const d = seg.disruption;
  if (!d || !d.active) {
    return {
      props: { width: seg.width, flat: seg.flat, lit: seg.lit, paved, built, tunnelY: seg.tunnelY },
      disrupted: false,
    };
  }
  // An active disruption always marks the segment; any provided fields override
  // the standard values (undefined fields keep the standard). `built` and
  // `tunnelY` are fixed/planning attributes, not transient conditions, so
  // disruptions never touch them.
  const props: SegmentProps = {
    width: d.width ?? seg.width,
    flat: d.flat ?? seg.flat,
    lit: d.lit ?? seg.lit,
    paved: d.paved ?? paved,
    built,
    tunnelY: seg.tunnelY,
  };
  return { props, disrupted: true, type: d.type ?? "other", note: d.note };
}

/** Adjacency map: node id -> set of neighbouring node ids (whole network). */
export function buildAdjacency(network: Network): Map<Id, Set<Id>> {
  const adj = new Map<Id, Set<Id>>();
  const ensure = (id: Id) => {
    let s = adj.get(id);
    if (!s) adj.set(id, (s = new Set()));
    return s;
  };
  for (const id of Object.keys(network.nodes)) ensure(id);
  for (const seg of Object.values(network.segments)) {
    ensure(seg.a).add(seg.b);
    ensure(seg.b).add(seg.a);
  }
  return adj;
}

export interface RouteValidation {
  ok: boolean;
  isLoop: boolean;
  /** Human-readable reasons the route is invalid. */
  errors: string[];
}

/**
 * A route must be a simple path or a simple loop — never a loop-plus-spur.
 * Because a route is an ordered node list, that reduces to: no node repeats,
 * except that the first and last node may be equal (which marks a loop).
 */
export function validateRoute(route: Route): RouteValidation {
  const errors: string[] = [];
  const ids = route.nodeIds;
  if (ids.length < 2) {
    errors.push("A route needs at least two points.");
    return { ok: false, isLoop: false, errors };
  }

  const isLoop = ids[0] === ids[ids.length - 1];
  // Interior nodes that may not repeat: drop the closing node when it's a loop.
  const body = isLoop ? ids.slice(0, -1) : ids;
  const seen = new Set<Id>();
  for (const id of body) {
    if (seen.has(id)) {
      errors.push("A route cannot revisit a point (loops may not have spurs).");
      break;
    }
    seen.add(id);
  }

  return { ok: errors.length === 0, isLoop, errors };
}

/** Create or fetch the shared segment for a node pair, seeding from defaults. */
export function ensureSegment(
  network: Network,
  a: Id,
  b: Id,
  defaults: SegmentProps,
): Segment {
  const id = pairKey(a, b);
  let seg = network.segments[id];
  if (!seg) {
    seg = { id, a, b, ...defaults };
    network.segments[id] = seg;
  }
  return seg;
}

/** Euclidean distance between two nodes in the XZ plane (blocks). */
export function nodeDistance(a: Node, b: Node): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Remove segments no longer referenced by any route. Call after edits so the
 * shared segment table doesn't accumulate orphans.
 */
export function pruneSegments(network: Network): void {
  const used = new Set<Id>();
  for (const route of network.routes) {
    for (const key of routeSegmentKeys(route)) used.add(key);
  }
  for (const key of Object.keys(network.segments)) {
    if (!used.has(key)) delete network.segments[key];
  }
}

// --- stations ---

/** Ray-casting point-in-polygon test (block coords). */
export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    const intersect =
      zi > pt.z !== zj > pt.z && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** The first district (by list order) whose polygon contains this point, if any. */
export function districtAt(districts: District[], pt: Vec2): District | null {
  for (const d of districts) {
    if (d.polygon.length >= 3 && pointInPolygon(pt, d.polygon)) return d;
  }
  return null;
}

function polyCentroid(poly: Vec2[]): Vec2 {
  const n = poly.length || 1;
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / n,
    z: poly.reduce((s, p) => s + p.z, 0) / n,
  };
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.z, b.z) <= p.z &&
    p.z <= Math.max(a.z, b.z)
  );
}

/** Whether segments (p1,p2) and (p3,p4) intersect or touch (block coords). */
function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Whether the segment (a,b) reaches a station's footprint at all — either
 * endpoint sits inside it, or the track simply passes through it without a
 * node placed there. A station doesn't need a vertex inside it to count as
 * served; a straight run of track crossing its polygon is enough.
 */
export function segmentIntersectsPolygon(a: Vec2, b: Vec2, poly: Vec2[]): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
  }
  return false;
}

/** Whether a *built* segment of `route` reaches the station's footprint —
 *  i.e. track for this line actually passes through it, as opposed to the
 *  station merely being assigned to a still-planned line. A vertex doesn't
 *  need to sit inside the station; the track just needs to cross it. */
export function lineBuiltThroughStation(
  route: Route,
  station: Station,
  net: RailwayNetwork,
): boolean {
  for (let i = 0; i + 1 < route.nodeIds.length; i++) {
    const a = route.nodeIds[i];
    const b = route.nodeIds[i + 1];
    const key = pairKey(a, b);
    const seg = net.segments[key];
    if (!seg || resolveSegment(seg).props.built === false) continue;
    const na = net.nodes[a];
    const nb = net.nodes[b];
    if (na && nb && segmentIntersectsPolygon(na, nb, station.polygon)) return true;
  }
  return false;
}

export interface RouteStop {
  station: Station;
  /** The route node inside the station's footprint, if any — a station
   *  crossed by a segment without a vertex placed inside it has none. */
  nodeId: Id | null;
  nodeIndex: number;
}

/**
 * Ordered, deduped list of stations a route stops at, walking `route.nodeIds`
 * in travel order. A stop is any station (assigned to this route via
 * `lineIds`) whose footprint the route's track reaches — either a route node
 * sits inside it, or a segment between two nodes simply crosses through it.
 * Not filtered by `built` status — a route's own planned/future stops still
 * appear (this is meant for edit-mode planning tools).
 */
export function orderedRouteStops(route: Route, net: RailwayNetwork): RouteStop[] {
  const ids = route.nodeIds;
  const isLoop = ids.length >= 2 && ids[0] === ids[ids.length - 1];
  const body = isLoop ? ids.slice(0, -1) : ids;
  if (body.length === 0) return [];

  const eligible = net.stations.filter((s) => s.lineIds.includes(route.id));
  const out: RouteStop[] = [];
  const pushIfNew = (station: Station, nodeId: Id | null, nodeIndex: number) => {
    const prev = out[out.length - 1];
    if (prev && prev.station.id === station.id) return;
    out.push({ station, nodeId, nodeIndex });
  };

  const firstNode = net.nodes[body[0]];
  if (firstNode) {
    const st = eligible.find((s) => pointInPolygon(firstNode, s.polygon));
    if (st) pushIfNew(st, body[0], 0);
  }

  for (let i = 0; i + 1 < body.length; i++) {
    const a = net.nodes[body[i]];
    const b = net.nodes[body[i + 1]];
    if (!a || !b) continue;
    const hits = eligible
      .filter((s) => segmentIntersectsPolygon(a, b, s.polygon))
      .sort((s1, s2) => {
        const c1 = polyCentroid(s1.polygon);
        const c2 = polyCentroid(s2.polygon);
        return Math.hypot(a.x - c1.x, a.z - c1.z) - Math.hypot(a.x - c2.x, a.z - c2.z);
      });
    for (const s of hits) {
      const nodeId = pointInPolygon(b, s.polygon) ? body[i + 1] : pointInPolygon(a, s.polygon) ? body[i] : null;
      pushIfNew(s, nodeId, i + 1);
    }
  }
  return out;
}

/**
 * Other lines serving this station, excluding the route itself. When
 * `includePlanned` is false, only lines with a built path through the
 * station (see `lineBuiltThroughStation`) are included — matching the same
 * "only show a real transfer" rule the live map uses for station badges.
 */
export function stationTransferLines(
  station: Station,
  ownRouteId: Id,
  net: RailwayNetwork,
  includePlanned: boolean,
): Route[] {
  const others = net.routes.filter((r) => r.id !== ownRouteId && station.lineIds.includes(r.id));
  return includePlanned ? others : others.filter((r) => lineBuiltThroughStation(r, station, net));
}

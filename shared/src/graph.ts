import type {
  HighwayNetwork,
  Id,
  Node,
  RailwayNetwork,
  Route,
  Segment,
  SegmentProps,
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
  note?: string;
} {
  const d = seg.disruption;
  if (!d || !d.active) {
    return { props: { width: seg.width, flat: seg.flat, lit: seg.lit }, disrupted: false };
  }
  // An active disruption always marks the segment; any provided fields override
  // the standard values (undefined fields keep the standard).
  const props: SegmentProps = {
    width: d.width ?? seg.width,
    flat: d.flat ?? seg.flat,
    lit: d.lit ?? seg.lit,
  };
  return { props, disrupted: true, note: d.note };
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

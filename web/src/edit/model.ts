import {
  type District,
  type DistrictCollection,
  type HighwayNetwork,
  type Id,
  type Landmark,
  type LandmarkCollection,
  type RailwayNetwork,
  type Route,
  type Segment,
  type SegmentProps,
  type Station,
  type Vec2,
  ensureSegment,
  nodeDistance,
  pruneSegments,
  routeSegmentKeys,
} from "@hcmap/shared";
import type { LineKind } from "../data/useOverlays";

export type Network = HighwayNetwork | RailwayNetwork;

export type Tool =
  | "select"
  | "line"
  | "station"
  | "landmark-point"
  | "landmark-area"
  | "district-area";
export type ActiveLayer = LineKind | "landmark" | "district";

/** A polygon we can edit vertices on (landmark area, railway station, or district). */
export type PolyTarget = { kind: "landmark" | "station" | "district"; id: Id };

export type Selection =
  | { type: "node"; net: LineKind; id: Id }
  | { type: "segment"; net: LineKind; id: Id }
  | { type: "route"; net: LineKind; id: Id }
  | { type: "station"; id: Id }
  | { type: "landmark"; id: Id }
  | { type: "district"; id: Id }
  | { type: "vertex"; target: PolyTarget; index: number }
  | null;

export interface EditState {
  enabled: boolean;
  layer: ActiveLayer;
  tool: Tool;
  /** Route currently being drawn / extended (line tools). */
  activeRouteId: Id | null;
  /** In-progress landmark-area polygon vertices. */
  draftPolygon: Vec2[];
  selection: Selection;
}

export const DEFAULT_SEGMENT: SegmentProps = {
  width: 3,
  flat: false,
  lit: false,
  paved: true,
  built: true,
};

/**
 * Migrate a loaded network in place: existing roads/tracks default to paved
 * and built (the `paved` and `built` fields were added later). Preserves all
 * other data.
 */
export function migrateNetworkPaved(net: Network): void {
  for (const seg of Object.values(net.segments)) {
    if (seg.paved === undefined) seg.paved = true;
    if (seg.built === undefined) seg.built = true;
  }
  if (net.kind === "railway") {
    for (const st of net.stations) {
      if (st.built === undefined) st.built = true;
    }
  }
}

const ROUTE_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080",
];

let counter = 0;
export function newId(prefix: string): Id {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Nearest existing node within `tol` blocks (excluding `excludeId`), or null. */
export function findNodeNear(
  net: Network,
  x: number,
  z: number,
  tol: number,
  excludeId?: Id,
): Id | null {
  let best: Id | null = null;
  let bestD = tol;
  for (const [id, n] of Object.entries(net.nodes)) {
    if (id === excludeId) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d <= bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export function addNodeAt(net: Network, x: number, z: number): Id {
  const id = newId("n");
  net.nodes[id] = { id, x: Math.round(x), z: Math.round(z) };
  return id;
}

export function createRoute(net: Network, firstNodeId: Id, id: Id = newId("r")): Id {
  const route: Route = {
    id,
    name: `${net.kind === "highway" ? "Highway" : "Line"} ${net.routes.length + 1}`,
    nodeIds: [firstNodeId],
    color: ROUTE_COLORS[net.routes.length % ROUTE_COLORS.length],
    defaults: { ...DEFAULT_SEGMENT },
  };
  net.routes.push(route);
  return id;
}

/** Append a node to a route, creating the shared segment from the previous node. */
export function appendToRoute(net: Network, routeId: Id, nodeId: Id): void {
  const route = net.routes.find((r) => r.id === routeId);
  if (!route) return;
  const prev = route.nodeIds[route.nodeIds.length - 1];
  if (prev === nodeId) return; // ignore double-click on same node
  route.nodeIds.push(nodeId);
  if (prev) ensureSegment(net, prev, nodeId, route.defaults);
}

export function moveNode(net: Network, nodeId: Id, x: number, z: number): void {
  const n = net.nodes[nodeId];
  if (n) {
    n.x = Math.round(x);
    n.z = Math.round(z);
  }
}

/**
 * Split a segment by inserting a new node in its middle, updating every route
 * that traverses it so the whole network stays connected. New sub-segments
 * inherit the original's width/flat/lit/paved/tunnelY/disruption.
 */
export function insertNodeInSegment(
  net: Network,
  segId: Id,
  x: number,
  z: number,
): Id {
  const seg = net.segments[segId];
  if (!seg) return "";
  const { a, b } = seg;
  const nid = addNodeAt(net, x, z);
  for (const route of net.routes) {
    const ids = route.nodeIds;
    for (let i = 0; i + 1 < ids.length; i++) {
      const p = ids[i];
      const q = ids[i + 1];
      if ((p === a && q === b) || (p === b && q === a)) {
        ids.splice(i + 1, 0, nid);
        i++;
      }
    }
  }
  const props: SegmentProps = {
    width: seg.width,
    flat: seg.flat,
    lit: seg.lit,
    paved: seg.paved ?? true,
    tunnelY: seg.tunnelY,
  };
  const s1 = ensureSegment(net, a, nid, props);
  const s2 = ensureSegment(net, nid, b, props);
  if (seg.disruption) {
    s1.disruption = { ...seg.disruption };
    s2.disruption = { ...seg.disruption };
  }
  pruneSegments(net);
  return nid;
}

/**
 * Delete a node: remove it from every route (reconnecting its neighbours),
 * drop routes that become too short, then prune dangling segments/nodes.
 */
export function deleteNodeFromNetwork(net: Network, nodeId: Id): void {
  for (const route of net.routes) {
    route.nodeIds = route.nodeIds.filter((id) => id !== nodeId);
  }
  net.routes = net.routes.filter((r) => r.nodeIds.length >= 2);
  for (const route of net.routes) {
    for (let i = 0; i + 1 < route.nodeIds.length; i++) {
      ensureSegment(net, route.nodeIds[i], route.nodeIds[i + 1], route.defaults);
    }
  }
  pruneSegments(net);
  delete net.nodes[nodeId];
  removeOrphanNodes(net);
}

/**
 * Merge `fromId` into `toId`: every route that visited `fromId` now visits
 * `toId` instead (collapsing any resulting consecutive duplicates), segments
 * are rebuilt to match, and `fromId` is dropped. Used when a dragged node is
 * released on top of another node, forming an intersection.
 */
export function mergeNodes(net: Network, fromId: Id, toId: Id): void {
  if (fromId === toId || !net.nodes[fromId] || !net.nodes[toId]) return;
  for (const route of net.routes) {
    const merged = route.nodeIds.map((id) => (id === fromId ? toId : id));
    route.nodeIds = merged.filter((id, i) => i === 0 || id !== merged[i - 1]);
  }
  net.routes = net.routes.filter((r) => r.nodeIds.length >= 2);
  for (const route of net.routes) {
    for (let i = 0; i + 1 < route.nodeIds.length; i++) {
      ensureSegment(net, route.nodeIds[i], route.nodeIds[i + 1], route.defaults);
    }
  }
  pruneSegments(net);
  delete net.nodes[fromId];
  removeOrphanNodes(net);
}

// --- polygon vertex editing (landmark areas & stations) ---

export function movePolyVertex(poly: Vec2[], i: number, x: number, z: number): void {
  if (poly[i]) poly[i] = { x: Math.round(x), z: Math.round(z) };
}

/** Insert a vertex just after `edgeIndex` (i.e. on the edge edgeIndex→edgeIndex+1). */
export function insertPolyVertex(
  poly: Vec2[],
  edgeIndex: number,
  x: number,
  z: number,
): void {
  poly.splice(edgeIndex + 1, 0, { x: Math.round(x), z: Math.round(z) });
}

export function deletePolyVertex(poly: Vec2[], i: number): void {
  if (poly.length > 3) poly.splice(i, 1);
}

export function deleteRoute(net: Network, routeId: Id): void {
  net.routes = net.routes.filter((r) => r.id !== routeId);
  pruneSegments(net);
  removeOrphanNodes(net);
}

/**
 * Remove a single physical segment from the network — cutting every route
 * that traverses it, rather than deleting the whole line. A route cut in the
 * middle splits into two (the far side becomes a new route with its own id);
 * cut at either end just trims that route by one segment.
 */
export function deleteSegment(net: Network, segId: Id): void {
  const seg = net.segments[segId];
  if (!seg) return;
  const { a, b } = seg;
  const nextRoutes: Route[] = [];
  for (const route of net.routes) {
    const ids = route.nodeIds;
    let cut = -1;
    for (let i = 0; i + 1 < ids.length; i++) {
      if ((ids[i] === a && ids[i + 1] === b) || (ids[i] === b && ids[i + 1] === a)) {
        cut = i;
        break;
      }
    }
    if (cut === -1) {
      nextRoutes.push(route);
      continue;
    }
    const before = ids.slice(0, cut + 1);
    const after = ids.slice(cut + 1);
    if (before.length >= 2) nextRoutes.push({ ...route, nodeIds: before });
    if (after.length >= 2) {
      const keepOriginalId = before.length < 2; // only one surviving piece -> it keeps the route's identity
      nextRoutes.push({
        ...route,
        id: keepOriginalId ? route.id : newId("r"),
        name: keepOriginalId ? route.name : `${route.name} (2)`,
        nodeIds: after,
      });
    }
  }
  net.routes = nextRoutes;
  for (const route of net.routes) {
    for (let i = 0; i + 1 < route.nodeIds.length; i++) {
      ensureSegment(net, route.nodeIds[i], route.nodeIds[i + 1], route.defaults);
    }
  }
  pruneSegments(net);
  removeOrphanNodes(net);
}

/** Drop nodes not referenced by any route (keeps the graph tidy). */
export function removeOrphanNodes(net: Network): void {
  const used = new Set<Id>();
  for (const r of net.routes) for (const id of r.nodeIds) used.add(id);
  for (const id of Object.keys(net.nodes)) if (!used.has(id)) delete net.nodes[id];
}

export function totalRouteLength(net: Network, route: Route): number {
  let len = 0;
  for (let i = 0; i + 1 < route.nodeIds.length; i++) {
    const a = net.nodes[route.nodeIds[i]];
    const b = net.nodes[route.nodeIds[i + 1]];
    if (a && b) len += nodeDistance(a, b);
  }
  return len;
}

/** Which routes traverse a given shared segment (by canonical key). */
export function routesUsingSegment(net: Network, segId: Id): Route[] {
  return net.routes.filter((r) => routeSegmentKeys(r).includes(segId));
}

/** Apply an edit to every segment a route traverses (batch edit a whole route). */
export function applyToRouteSegments(
  net: Network,
  route: Route,
  fn: (seg: Segment) => void,
): void {
  for (const key of routeSegmentKeys(route)) {
    const seg = net.segments[key];
    if (seg) fn(seg);
  }
}

/**
 * The value shared by every segment of a route, or undefined when the segments
 * disagree (a "mixed" batch field) or the route has no segments.
 */
export function routeSegmentsUniform<T>(
  net: Network,
  route: Route,
  get: (seg: Segment) => T,
): T | undefined {
  let value: T | undefined;
  let seen = false;
  for (const key of routeSegmentKeys(route)) {
    const seg = net.segments[key];
    if (!seg) continue;
    const v = get(seg);
    if (!seen) {
      value = v;
      seen = true;
    } else if (v !== value) {
      return undefined;
    }
  }
  return value;
}

/** Number of segments a route currently traverses. */
export function routeSegmentCount(net: Network, route: Route): number {
  let n = 0;
  for (const key of routeSegmentKeys(route)) if (net.segments[key]) n++;
  return n;
}

// --- landmarks ---

export function addPointLandmark(doc: LandmarkCollection, x: number, z: number): Id {
  const id = newId("l");
  const lm: Landmark = {
    id,
    name: `Landmark ${doc.landmarks.length + 1}`,
    point: { x: Math.round(x), z: Math.round(z) },
    color: "#e8c14a",
    shape: "marker",
    icon: "map",
  };
  doc.landmarks.push(lm);
  return id;
}

export function addAreaLandmark(doc: LandmarkCollection, polygon: Vec2[]): Id {
  const id = newId("l");
  const lm: Landmark = {
    id,
    name: `Area ${doc.landmarks.length + 1}`,
    polygon: polygon.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) })),
    color: "#4a90d9",
    shape: "polygon",
    icon: "map",
  };
  doc.landmarks.push(lm);
  return id;
}

export function deleteLandmark(doc: LandmarkCollection, id: Id): void {
  doc.landmarks = doc.landmarks.filter((l) => l.id !== id);
}

// --- districts ---

export function addDistrict(doc: DistrictCollection, polygon: Vec2[]): Id {
  const id = newId("d");
  const district: District = {
    id,
    name: `District ${doc.districts.length + 1}`,
    polygon: polygon.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) })),
    color: ROUTE_COLORS[doc.districts.length % ROUTE_COLORS.length],
  };
  doc.districts.push(district);
  return id;
}

export function deleteDistrict(doc: DistrictCollection, id: Id): void {
  doc.districts = doc.districts.filter((d) => d.id !== id);
}

// --- railway stations ---

export function addStation(net: RailwayNetwork, polygon: Vec2[]): Id {
  const id = newId("st");
  const station: Station = {
    id,
    name: `Station ${net.stations.length + 1}`,
    polygon: polygon.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) })),
    lineIds: [],
  };
  net.stations.push(station);
  return id;
}

export function deleteStation(net: RailwayNetwork, id: Id): void {
  net.stations = net.stations.filter((s) => s.id !== id);
}

/** The station's polygon centroid — the default drop point for a new entrance. */
export function stationCentroid(station: Station): Vec2 {
  const n = station.polygon.length || 1;
  return {
    x: station.polygon.reduce((s, p) => s + p.x, 0) / n,
    z: station.polygon.reduce((s, p) => s + p.z, 0) / n,
  };
}

export function addStationEntrance(station: Station, x: number, z: number): Id {
  const id = newId("se");
  const entrances = station.entrances ?? (station.entrances = []);
  entrances.push({
    id,
    name: `Entrance ${entrances.length + 1}`,
    point: { x: Math.round(x), z: Math.round(z) },
    kind: "both",
  });
  return id;
}

export function deleteStationEntrance(station: Station, id: Id): void {
  if (!station.entrances) return;
  station.entrances = station.entrances.filter((e) => e.id !== id);
}

export function moveStationEntrance(station: Station, id: Id, x: number, z: number): void {
  const en = station.entrances?.find((e) => e.id === id);
  if (en) en.point = { x: Math.round(x), z: Math.round(z) };
}

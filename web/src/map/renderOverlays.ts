import L from "leaflet";
import {
  type HighwayNetwork,
  type Id,
  type Landmark,
  type LandmarkCollection,
  type RailwayNetwork,
  type Route,
  type Station,
  type StationAccessKind,
  type Vec2,
  digitBands,
  disruptionTypeLabel,
  lineBuiltThroughStation,
  resistorColorHex,
  resolveSegment,
} from "@hcmap/shared";
import type { LineKind } from "../data/useOverlays";
import type { EditState, Network, PolyTarget, Selection } from "../edit/model";
import { routesUsingSegment } from "../edit/model";
import { MINECRAFT_ICONS } from "../icons/minecraftIcons";
import { blockToLatLng } from "./crs";

function iconUri(id: string): string {
  return MINECRAFT_ICONS[id] ?? MINECRAFT_ICONS.map;
}

/** Snap a marker to the nearest whole block while it is being dragged. */
function snapMarkerToBlock(e: L.LeafletEvent): void {
  const m = e.target as L.Marker;
  const ll = m.getLatLng();
  const s = L.latLng(Math.round(ll.lat), Math.round(ll.lng));
  if (s.lat !== ll.lat || s.lng !== ll.lng) m.setLatLng(s);
}

function nodeDivIcon(selected: boolean, activeEnd = false): L.DivIcon {
  return L.divIcon({
    className: "node-marker",
    html: `<div class="node-dot${selected ? " sel" : ""}${
      activeEnd ? " active-end" : ""
    }"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function midDivIcon(): L.DivIcon {
  return L.divIcon({
    className: "mid-marker",
    html: '<div class="mid-handle"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

const SELECT_COLOR = "#ffffff";

/**
 * Automatic road colour by width (blocks): 0 crimson, 1 red, 2 orange, 3 yellow,
 * 4–5 green, 6+ blue.
 */
function widthColor(w: number): string {
  if (w <= 0) return "#dc143c"; // crimson
  if (w === 1) return "#ff2d2d"; // red
  if (w === 2) return "#ff7f0e"; // orange
  if (w === 3) return "#ffd21e"; // yellow
  if (w <= 5) return "#3ec46d"; // green
  return "#3b82f6"; // blue
}

export interface OverlayToggles {
  highway: boolean;
  railway: boolean;
  landmark: boolean;
}

export interface OverlayHandlers {
  onSelect: (sel: Selection) => void;
  onMoveNode: (net: LineKind, nodeId: Id, x: number, z: number) => void;
  onInsertNode: (net: LineKind, segId: Id, x: number, z: number) => void;
  onMovePolyVertex: (target: PolyTarget, index: number, x: number, z: number) => void;
  onInsertPolyVertex: (target: PolyTarget, edgeIndex: number, x: number, z: number) => void;
}

export interface OverlayRenderOpts {
  highways: HighwayNetwork;
  railways: RailwayNetwork;
  landmarks: LandmarkCollection;
  toggles: OverlayToggles;
  edit: EditState;
  handlers: OverlayHandlers;
  /** Screen pixels per block at the current zoom (2^zoom). */
  pixelsPerBlock: number;
  /** Register an SVG stripe pattern (for transfer-station bodies). */
  onPattern?: (id: string, colors: string[]) => void;
  /**
   * "Tunnel view": recolor every path by its tunnel Y depth instead of its
   * normal route/width color — tens digit picks the main line color (resistor
   * code), ones digit picks a dashed overlay color. Paths with no tunnel Y set
   * render neutral grey.
   */
  showTunnelDepths?: boolean;
}

/** Deterministic id for a stripe pattern of the given colours. */
export function stripePatternId(colors: string[]): string {
  return "hcmap-stripe-" + colors.map((c) => c.replace("#", "")).join("-");
}

/** CSS conic-gradient of equal slices — a pie chart from the given colours. */
function conicGradient(colors: string[]): string {
  if (colors.length <= 1) return colors[0] ?? "#d0d0d0";
  const step = 100 / colors.length;
  const stops = colors
    .map((c, i) => `${c} ${(i * step).toFixed(3)}% ${((i + 1) * step).toFixed(3)}%`)
    .join(", ");
  return `conic-gradient(from -90deg, ${stops})`;
}

/** Minimum on-screen line weight so thin roads stay visible when zoomed out. */
const MIN_LINE_PX = 2.5;

/**
 * A line's on-screen weight is its TRUE width in blocks (width * pixelsPerBlock),
 * so a 5-block road really looks 5 blocks wide — except when zoomed far out, where
 * that would be sub-pixel, so it clamps to a visible minimum.
 */
function widthToWeight(width: number, pixelsPerBlock: number): number {
  return Math.max(MIN_LINE_PX, width * pixelsPerBlock);
}

function isSelected(sel: Selection, type: string, id: Id): boolean {
  return !!sel && sel.type === type && (sel as { id: Id }).id === id;
}

/** Build all overlay layers for the current data + edit state. */
export function buildOverlays(opts: OverlayRenderOpts): L.Layer[] {
  const layers: L.Layer[] = [];
  if (opts.toggles.highway) {
    pushNetwork(layers, "highway", opts.highways, opts);
  }
  if (opts.toggles.railway) {
    pushNetwork(layers, "railway", opts.railways, opts);
    pushStations(layers, opts.railways, opts);
  }
  if (opts.toggles.landmark) {
    pushLandmarks(layers, opts.landmarks, opts);
  }
  if (opts.showTunnelDepths) {
    pushTunnelCrossings(layers, opts);
  }
  pushDraft(layers, opts.edit);
  return layers;
}

// --- tunnel view: mark every place two paths cross on the 2D map ---

interface PathEdge {
  kind: LineKind;
  segId: Id;
  aId: Id;
  bId: Id;
  a: Vec2;
  b: Vec2;
  tunnelY: number;
}

function collectEdges(edges: PathEdge[], kind: LineKind, net: Network): void {
  for (const seg of Object.values(net.segments)) {
    const a = net.nodes[seg.a];
    const b = net.nodes[seg.b];
    if (!a || !b) continue;
    const { props } = resolveSegment(seg);
    if (kind === "railway" && props.built === false) continue; // planned track never crosses "for real"
    edges.push({
      kind,
      segId: seg.id,
      aId: seg.a,
      bId: seg.b,
      a: { x: a.x, z: a.z },
      b: { x: b.x, z: b.z },
      tunnelY: props.tunnelY ?? 0,
    });
  }
}

/** The node id these two edges share, if any (they touch at an endpoint). */
function sharedNodeId(e1: PathEdge, e2: PathEdge): Id | null {
  if (e1.aId === e2.aId || e1.aId === e2.bId) return e1.aId;
  if (e1.bId === e2.aId || e1.bId === e2.bId) return e1.bId;
  return null;
}

/** Whether some single route treats both edges as part of its own path (a bend, not a crossing). */
function sameRoutePath(e1: PathEdge, e2: PathEdge, highways: HighwayNetwork, railways: RailwayNetwork): boolean {
  if (e1.kind !== e2.kind) return false;
  const net = e1.kind === "highway" ? highways : railways;
  const routesA = routesUsingSegment(net, e1.segId);
  const routesB = routesUsingSegment(net, e2.segId);
  return routesA.some((ra) => routesB.some((rb) => ra.id === rb.id));
}

/** Interior intersection point of two segments, or null if parallel / not crossing within both. */
function segmentCrossPoint(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d1x = p2.x - p1.x;
  const d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x;
  const d2z = p4.z - p3.z;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const dx = p3.x - p1.x;
  const dz = p3.z - p1.z;
  const t = (dx * d2z - dz * d2x) / denom;
  const u = (dx * d1z - dz * d1x) / denom;
  const eps = 1e-6;
  if (t < eps || t > 1 - eps || u < eps || u > 1 - eps) return null;
  return { x: p1.x + t * d1x, z: p1.z + t * d1z };
}

/**
 * "Tunnel view" crossing markers: every place two paths cross on the 2D map,
 * regardless of whether they're actually connected — filled where they share
 * a node (a real junction), hollow with a Y-depth difference where they just
 * pass over/under each other (a grade-separated crossing).
 */
function pushTunnelCrossings(layers: L.Layer[], opts: OverlayRenderOpts): void {
  const edges: PathEdge[] = [];
  if (opts.toggles.highway) collectEdges(edges, "highway", opts.highways);
  if (opts.toggles.railway) collectEdges(edges, "railway", opts.railways);

  const junctions = new Map<string, Vec2>();
  const crossings = new Map<string, { point: Vec2; diff: number }>();

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      const shared = sharedNodeId(e1, e2);
      if (shared) {
        if (!sameRoutePath(e1, e2, opts.highways, opts.railways)) {
          const pos = e1.aId === shared ? e1.a : e1.b;
          junctions.set(`${e1.kind}:${shared}`, pos);
        }
        continue;
      }
      const pt = segmentCrossPoint(e1.a, e1.b, e2.a, e2.b);
      if (!pt) continue;
      const key = `${Math.round(pt.x)},${Math.round(pt.z)}`;
      if (!crossings.has(key)) {
        crossings.set(key, { point: pt, diff: Math.round(Math.abs(e1.tunnelY - e2.tunnelY)) });
      }
    }
  }

  for (const pos of junctions.values()) {
    const marker = L.circleMarker(blockToLatLng(pos.x, pos.z), {
      radius: 6,
      color: "#14161a",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    });
    marker.bindTooltip("Junction — paths meet here");
    layers.push(marker);
  }

  for (const { point, diff } of crossings.values()) {
    const marker = L.marker(blockToLatLng(point.x, point.z), {
      icon: L.divIcon({
        className: "crossing-marker",
        html: `<div class="crossing-badge">${diff}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    });
    marker.bindTooltip(`Grade-separated crossing — Δ${diff} blocks`);
    layers.push(marker);
  }
}

/** In-progress landmark-area polygon while drawing. */
function pushDraft(layers: L.Layer[], edit: EditState): void {
  const drawingArea = edit.tool === "landmark-area" || edit.tool === "station";
  if (!edit.enabled || !drawingArea || edit.draftPolygon.length === 0) {
    return;
  }
  const pts = edit.draftPolygon.map((p) => blockToLatLng(p.x, p.z));
  if (pts.length >= 2) {
    layers.push(
      L.polyline(pts, { color: "#4a90d9", weight: 2, dashArray: "4 4", interactive: false }),
    );
  }
  for (const ll of pts) {
    layers.push(
      L.circleMarker(ll, {
        radius: 4,
        color: "#fff",
        weight: 1.5,
        fillColor: "#4a90d9",
        fillOpacity: 1,
        interactive: false,
      }),
    );
  }
}

function nodeLatLng(net: Network, id: Id): L.LatLng | null {
  const n = net.nodes[id];
  return n ? blockToLatLng(n.x, n.z) : null;
}

function polyCentroid(poly: Vec2[]): { x: number; z: number } {
  const n = poly.length || 1;
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / n,
    z: poly.reduce((s, p) => s + p.z, 0) / n,
  };
}

/** Nearest station serving `lineId` to a point, by polygon centroid distance. */
function nearestServingStation(
  net: Network,
  lineId: Id,
  at: { x: number; z: number },
): Station | null {
  if (net.kind !== "railway") return null;
  let best: Station | null = null;
  let bestD = Infinity;
  for (const st of net.stations) {
    if (!st.lineIds.includes(lineId) || st.polygon.length < 1) continue;
    const c = polyCentroid(st.polygon);
    const d = Math.hypot(c.x - at.x, c.z - at.z);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

/** "Terminus A ↔ Terminus B" for a rail line — end stations, coords, or loop. */
function railTermini(route: Route, net: Network): string {
  const ids = route.nodeIds;
  if (!ids.length) return "";
  if (ids.length >= 2 && ids[0] === ids[ids.length - 1]) return "⟳ loop line";
  const label = (nid: Id): string => {
    const node = net.nodes[nid];
    if (!node) return "?";
    const st = nearestServingStation(net, route.id, node);
    return st ? escape(st.name) : `${Math.round(node.x)}, ${Math.round(node.z)}`;
  };
  return `${label(ids[0])} ↔ ${label(ids[ids.length - 1])}`;
}

function pushNetwork(
  layers: L.Layer[],
  kind: LineKind,
  net: Network,
  opts: OverlayRenderOpts,
): void {
  const { edit, handlers } = opts;
  const isActiveEditLayer = edit.enabled && edit.layer === kind;
  const rail = kind === "railway";

  // Which routes traverse each segment (first one drives its colour).
  const segColor = new Map<Id, string>();
  const segRoutes = new Map<Id, Route[]>();
  for (const route of net.routes) {
    for (let i = 0; i + 1 < route.nodeIds.length; i++) {
      const a = route.nodeIds[i];
      const b = route.nodeIds[i + 1];
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      if (!segColor.has(key)) segColor.set(key, route.color ?? "#4a90d9");
      let list = segRoutes.get(key);
      if (!list) segRoutes.set(key, (list = []));
      if (!list.includes(route)) list.push(route);
    }
  }

  // Segments (base geometry, styled by resolved props).
  for (const seg of Object.values(net.segments)) {
    const a = nodeLatLng(net, seg.a);
    const b = nodeLatLng(net, seg.b);
    if (!a || !b) continue;
    const { props, disrupted, type, note } = resolveSegment(seg);
    // Planned rail track that hasn't been built yet only shows while editing.
    const planned = rail && props.built === false;
    if (planned && !edit.enabled) continue;
    const selected = isSelected(edit.selection, "segment", seg.id);
    const paved = props.paved;

    // "Tunnel view" recolors every path by its tunnel Y depth (resistor code)
    // instead of its normal route/width color.
    const tunnelColor =
      opts.showTunnelDepths && !selected
        ? props.tunnelY !== undefined
          ? resistorColorHex(digitBands(props.tunnelY).tens)
          : "#555555"
        : null;

    // Roads keep their width-based colour (rail keeps its line colour) even when
    // disrupted; the disruption shows as black stripes laid over the road.
    const color =
      tunnelColor ??
      (selected
        ? SELECT_COLOR
        : rail
          ? (segColor.get(seg.id) ?? "#888")
          : widthColor(props.width));

    const weight = widthToWeight(props.width, opts.pixelsPerBlock) + (selected ? 2 : 0);
    // Unpaved roads render dashed (dirt track); paved solid. Rail always ties.
    // Planned (unbuilt) rail track gets its own sparser dash so it reads as
    // distinct from a real, already-laid track while editing.
    const dashArray = planned ? "2 8" : rail ? "3 7" : !paved ? "6 7" : undefined;
    // Width 0 means "not built yet / nonfunctional" — fade it out instead of
    // drawing it like a real road/track.
    const ghost = props.width <= 0;

    const line = L.polyline([a, b], {
      color,
      weight,
      opacity: ghost ? 0.15 : planned ? 0.4 : props.lit ? 1 : 0.9,
      dashArray,
      lineCap: paved || rail ? "round" : "butt",
    });
    const usingRoutes = segRoutes.get(seg.id) ?? [];
    const disrupt = disrupted
      ? `⚠ ${disruptionTypeLabel(type)}${note ? `: ${escape(note)}` : ""}`
      : "";
    const tunnelNote = props.tunnelY !== undefined ? `<br>⛏ Tunnel Y ${props.tunnelY}` : "";
    let tip: string;
    if (rail) {
      // Rail: line name(s) + termini (the physical width/paving is irrelevant).
      const body = usingRoutes.length
        ? usingRoutes
            .map((r) => `<b>${escape(r.name)}</b><br>${railTermini(r, net)}`)
            .join("<br><br>")
        : "<b>Railway</b>";
      tip = body + tunnelNote + (disrupt ? `<br>${disrupt}` : "") + (planned ? "<br>🚧 Planned — not yet built" : "");
    } else {
      // Highway: line 1 route name, line 2 path info, line 3 disruption (if any).
      const name = usingRoutes.length
        ? usingRoutes.map((r) => escape(r.name)).join(", ")
        : "Highway";
      const path = `${props.width} wide · ${paved ? "paved" : "unpaved"} · ${
        props.flat ? "flat" : "sloped"
      } · ${props.lit ? "lit" : "unlit"}`;
      tip = `<b>${name}</b><br>${path}${tunnelNote}${disrupt ? `<br>${disrupt}` : ""}`;
    }
    line.bindTooltip(tip, { sticky: true });
    line.on("click", (e) => {
      L.DomEvent.stop(e);
      handlers.onSelect({ type: "segment", net: kind, id: seg.id });
    });
    layers.push(line);

    // "Tunnel view" ones-digit overlay: small dashes in a second resistor color.
    if (opts.showTunnelDepths && !selected && props.tunnelY !== undefined) {
      layers.push(
        L.polyline([a, b], {
          color: resistorColorHex(digitBands(props.tunnelY).ones),
          weight: Math.max(1.5, weight * 0.4),
          opacity: 0.95,
          dashArray: "4 10",
          lineCap: "butt",
          interactive: false,
        }),
      );
    }

    // Disruption marker: black stripes over the full road width.
    if (disrupted && !ghost && !planned) {
      layers.push(
        L.polyline([a, b], {
          color: "#000000",
          weight,
          opacity: 0.9,
          dashArray: "8 12",
          lineCap: "butt",
          interactive: false,
        }),
      );
    }

    // lit centre line accent
    if (props.lit && !disrupted && !ghost && !planned) {
      layers.push(
        L.polyline([a, b], {
          color: "#ffe27a",
          weight: 1.5,
          opacity: 0.9,
          interactive: false,
          dashArray: "1 5",
        }),
      );
    }
  }

  // Route endpoints highlight (start/end) so lines vs loops read clearly.
  for (const route of net.routes) {
    const selectedRoute = isSelected(edit.selection, "route", route.id);
    if (!selectedRoute) continue;
    const lls = route.nodeIds
      .map((id) => nodeLatLng(net, id))
      .filter((x): x is L.LatLng => !!x);
    if (lls.length > 1) {
      layers.push(
        L.polyline(lls, {
          color: SELECT_COLOR,
          weight: 2,
          opacity: 0.9,
          dashArray: "2 6",
          interactive: false,
        }),
      );
    }
  }

  // Edit handles — only for the active edit layer.
  if (isActiveEditLayer) {
    // Midpoint handles: drag to insert a new node splitting the segment.
    for (const seg of Object.values(net.segments)) {
      const a = net.nodes[seg.a];
      const b = net.nodes[seg.b];
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const segId = seg.id;
      const mid = L.marker(blockToLatLng(mx, mz), {
        draggable: true,
        icon: midDivIcon(),
        zIndexOffset: -50,
        opacity: 0.85,
      });
      // A plain click (no drag) inserts a new node right at the midpoint.
      mid.on("click", (e) => {
        L.DomEvent.stop(e);
        handlers.onInsertNode(kind, segId, mx, mz);
      });
      mid.on("drag", snapMarkerToBlock);
      mid.on("dragend", (e) => {
        const ll = (e.target as L.Marker).getLatLng();
        handlers.onInsertNode(kind, segId, ll.lng, ll.lat);
      });
      layers.push(mid);
    }

    // Draggable nodes.
    for (const node of Object.values(net.nodes)) {
      const selected = isSelected(edit.selection, "node", node.id);
      const isActiveEnd =
        !!edit.activeRouteId &&
        net.routes.find((r) => r.id === edit.activeRouteId)?.nodeIds.at(-1) === node.id;
      const marker = L.marker(blockToLatLng(node.x, node.z), {
        draggable: true,
        icon: nodeDivIcon(selected, isActiveEnd),
      });
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        handlers.onSelect({ type: "node", net: kind, id: node.id });
      });
      marker.on("drag", snapMarkerToBlock);
      marker.on("dragend", (e) => {
        const ll = (e.target as L.Marker).getLatLng();
        handlers.onMoveNode(kind, node.id, ll.lng, ll.lat);
      });
      layers.push(marker);
    }
  }
}

/** Draggable vertices + midpoint insert handles for an editable polygon. */
function pushPolygonEditor(
  layers: L.Layer[],
  target: PolyTarget,
  poly: Vec2[],
  opts: OverlayRenderOpts,
): void {
  const sel = opts.edit.selection;
  poly.forEach((p, i) => {
    const selected =
      !!sel &&
      sel.type === "vertex" &&
      sel.target.kind === target.kind &&
      sel.target.id === target.id &&
      sel.index === i;
    const m = L.marker(blockToLatLng(p.x, p.z), {
      draggable: true,
      icon: nodeDivIcon(selected),
    });
    m.on("click", (e) => {
      L.DomEvent.stop(e);
      opts.handlers.onSelect({ type: "vertex", target, index: i });
    });
    m.on("drag", snapMarkerToBlock);
    m.on("dragend", (e) => {
      const ll = (e.target as L.Marker).getLatLng();
      opts.handlers.onMovePolyVertex(target, i, ll.lng, ll.lat);
    });
    layers.push(m);
  });
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const mid = L.marker(blockToLatLng(mx, mz), {
      draggable: true,
      icon: midDivIcon(),
      zIndexOffset: -50,
      opacity: 0.85,
    });
    const edge = i;
    // A plain click (no drag) inserts a new vertex right at the midpoint.
    mid.on("click", (e) => {
      L.DomEvent.stop(e);
      opts.handlers.onInsertPolyVertex(target, edge, mx, mz);
    });
    mid.on("drag", snapMarkerToBlock);
    mid.on("dragend", (e) => {
      const ll = (e.target as L.Marker).getLatLng();
      opts.handlers.onInsertPolyVertex(target, edge, ll.lng, ll.lat);
    });
    layers.push(mid);
  }
}

/** Whether this landmark/station polygon is the current edit target. */
function isPolyEditing(
  sel: Selection,
  edit: EditState,
  kind: "landmark" | "station",
  id: Id,
): boolean {
  if (!edit.enabled || !sel) return false;
  if ((sel.type === "landmark" || sel.type === "station") && sel.id === id) return true;
  return sel.type === "vertex" && sel.target.kind === kind && sel.target.id === id;
}

function pushStations(
  layers: L.Layer[],
  net: RailwayNetwork,
  opts: OverlayRenderOpts,
): void {
  for (const st of net.stations) {
    pushStationLike(layers, st, net, opts);
  }
}

function pushStationLike(
  layers: L.Layer[],
  st: Station,
  net: RailwayNetwork,
  opts: OverlayRenderOpts,
): void {
  if (st.polygon.length < 3) return;
  // A planned (unbuilt) station footprint only shows while editing.
  const planned = st.built === false;
  if (planned && !opts.edit.enabled) return;
  // Lines this station is assigned to. Outside edit mode, a line only counts
  // as an actual transfer here once a built path of that line reaches the
  // station's footprint — merely being assigned to a planned line doesn't
  // show up as one until it's actually built through.
  const assignedLines = net.routes.filter((r) => st.lineIds.includes(r.id));
  const lines = opts.edit.enabled
    ? assignedLines
    : assignedLines.filter((r) => lineBuiltThroughStation(r, st, net));
  const colors = lines.length ? lines.map((l) => l.color ?? "#888") : ["#d0d0d0"];
  const ring = st.polygon.map((p) => blockToLatLng(p.x, p.z));

  // Body: striped with every served line's colour (SVG pattern), or solid for one.
  let fillColor = colors[0];
  if (colors.length > 1) {
    const id = stripePatternId(colors);
    opts.onPattern?.(id, colors);
    fillColor = `url(#${id})`;
  }
  const poly = L.polygon(ring, {
    color: "#20242b",
    weight: 2,
    fillColor,
    fillOpacity: planned ? 0.15 : colors.length > 1 ? 0.65 : 0.3,
    opacity: planned ? 0.45 : 1,
    dashArray: planned ? "4 4" : undefined,
  });
  poly.bindTooltip(stationTooltip(st, lines, planned));
  poly.on("click", (e) => {
    L.DomEvent.stop(e);
    opts.handlers.onSelect({ type: "station", id: st.id });
  });
  layers.push(poly);

  // Icon: a larger pie-chart badge of the served lines with a minecart on top.
  const n = st.polygon.length;
  const cx = st.polygon.reduce((s, p) => s + p.x, 0) / n;
  const cz = st.polygon.reduce((s, p) => s + p.z, 0) / n;
  const selected = isSelected(opts.edit.selection, "station", st.id);
  const marker = L.marker(blockToLatLng(cx, cz), {
    opacity: planned ? 0.45 : 1,
    icon: L.divIcon({
      className: "landmark-marker",
      html: `<div class="lm-badge station-pie${selected ? " sel" : ""}" style="background:${conicGradient(
        colors,
      )}"><span class="station-inner"><img src="${iconUri("minecart")}" alt="" draggable="false"></span></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    }),
  });
  marker.bindTooltip(stationTooltip(st, lines, planned));
  marker.on("click", (e) => {
    L.DomEvent.stop(e);
    opts.handlers.onSelect({ type: "station", id: st.id });
  });
  layers.push(marker);

  if (isPolyEditing(opts.edit.selection, opts.edit, "station", st.id)) {
    pushPolygonEditor(layers, { kind: "station", id: st.id }, st.polygon, opts);
  }

  for (const en of st.entrances ?? []) {
    const enMarker = L.marker(blockToLatLng(en.point.x, en.point.z), {
      opacity: planned ? 0.45 : 1,
      icon: L.divIcon({
        className: "access-marker",
        html: `<div class="access-badge ${en.kind}">${accessGlyph(en.kind)}</div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    });
    enMarker.bindTooltip(`<b>${escape(en.name)}</b><br>${accessKindLabel(en.kind)}`);
    enMarker.on("click", (e) => {
      L.DomEvent.stop(e);
      opts.handlers.onSelect({ type: "station", id: st.id });
    });
    layers.push(enMarker);
  }
}

function accessGlyph(kind: StationAccessKind): string {
  return kind === "entrance" ? "→" : kind === "exit" ? "←" : "↔";
}

function accessKindLabel(kind: StationAccessKind): string {
  return kind === "entrance" ? "Entrance" : kind === "exit" ? "Exit" : "Entrance / Exit";
}

function pushLandmarks(
  layers: L.Layer[],
  doc: LandmarkCollection,
  opts: OverlayRenderOpts,
): void {
  for (const lm of doc.landmarks) {
    if (lm.polygon && lm.polygon.length >= 3) {
      const ring = lm.polygon.map((p) => blockToLatLng(p.x, p.z));
      const poly = L.polygon(ring, {
        color: lm.color,
        weight: 2,
        fillColor: lm.color,
        fillOpacity: 0.2,
      });
      bindLandmark(poly, lm, opts);
      layers.push(poly);
      layers.push(landmarkIconMarker(centroid(lm), lm, opts));
      if (lm.polygon && isPolyEditing(opts.edit.selection, opts.edit, "landmark", lm.id)) {
        pushPolygonEditor(layers, { kind: "landmark", id: lm.id }, lm.polygon, opts);
      }
    } else if (lm.point) {
      layers.push(landmarkIconMarker(blockToLatLng(lm.point.x, lm.point.z), lm, opts));
    }
  }
}

function landmarkIconMarker(
  at: L.LatLng,
  lm: Landmark,
  opts: OverlayRenderOpts,
): L.Marker {
  const selected = isSelected(opts.edit.selection, "landmark", lm.id);
  const marker = L.marker(at, {
    icon: L.divIcon({
      className: "landmark-marker",
      html: `<div class="lm-badge ${lm.shape}${selected ? " sel" : ""}" style="--c:${
        lm.color
      }"><img src="${iconUri(lm.icon)}" alt="" draggable="false"></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
  });
  bindLandmark(marker, lm, opts);
  return marker;
}

function bindLandmark(
  layer: L.Path | L.Marker,
  lm: Landmark,
  opts: OverlayRenderOpts,
): void {
  layer.bindTooltip(`<b>${escape(lm.name)}</b>`);
  layer.on("click", (e) => {
    L.DomEvent.stop(e);
    opts.handlers.onSelect({ type: "landmark", id: lm.id });
  });
}

function centroid(lm: Landmark): L.LatLng {
  const pts = lm.polygon ?? [];
  const sx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const sz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  return blockToLatLng(sx, sz);
}

function stationTooltip(st: Station, lines: Route[], planned = false): string {
  const list = lines.length
    ? "<br>" +
      lines
        .map((l) => `<span style="color:${l.color ?? "#ccc"}">■</span> ${escape(l.name)}`)
        .join("<br>")
    : "";
  const plannedNote = planned ? "<br>🚧 Planned — not yet built" : "";
  return `<b>🚆 ${escape(st.name)}</b>${list}${plannedNote}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

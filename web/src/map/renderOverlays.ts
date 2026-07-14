import L from "leaflet";
import {
  type HighwayNetwork,
  type Id,
  type Landmark,
  type LandmarkCollection,
  type RailwayNetwork,
  type Route,
  type Station,
  type Vec2,
  disruptionTypeLabel,
  resolveSegment,
} from "@hcmap/shared";
import type { LineKind } from "../data/useOverlays";
import type { EditState, Network, PolyTarget, Selection } from "../edit/model";
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
  pushDraft(layers, opts.edit);
  return layers;
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

function pushNetwork(
  layers: L.Layer[],
  kind: LineKind,
  net: Network,
  opts: OverlayRenderOpts,
): void {
  const { edit, handlers } = opts;
  const isActiveEditLayer = edit.enabled && edit.layer === kind;
  const rail = kind === "railway";

  // Primary route color per segment (first route that uses it).
  const segColor = new Map<Id, string>();
  for (const route of net.routes) {
    for (let i = 0; i + 1 < route.nodeIds.length; i++) {
      const a = route.nodeIds[i];
      const b = route.nodeIds[i + 1];
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      if (!segColor.has(key)) segColor.set(key, route.color ?? "#4a90d9");
    }
  }

  // Segments (base geometry, styled by resolved props).
  for (const seg of Object.values(net.segments)) {
    const a = nodeLatLng(net, seg.a);
    const b = nodeLatLng(net, seg.b);
    if (!a || !b) continue;
    const { props, disrupted, type, note } = resolveSegment(seg);
    const selected = isSelected(edit.selection, "segment", seg.id);
    const paved = props.paved;

    // Roads keep their width-based colour (rail keeps its line colour) even when
    // disrupted; the disruption shows as black stripes laid over the road.
    const color = selected
      ? SELECT_COLOR
      : rail
        ? (segColor.get(seg.id) ?? "#888")
        : widthColor(props.width);

    const weight = widthToWeight(props.width, opts.pixelsPerBlock) + (selected ? 2 : 0);
    // Unpaved roads render dashed (dirt track); paved solid. Rail always ties.
    const dashArray = rail ? "3 7" : !paved ? "6 7" : undefined;

    const line = L.polyline([a, b], {
      color,
      weight,
      opacity: props.lit ? 1 : 0.9,
      dashArray,
      lineCap: paved || rail ? "round" : "butt",
    });
    const parts = [
      `${props.width} wide`,
      paved ? "paved" : "unpaved",
      props.flat ? "flat" : "sloped",
      props.lit ? "lit" : "unlit",
    ];
    if (disrupted) parts.push(`⚠ ${disruptionTypeLabel(type)}${note ? `: ${note}` : ""}`);
    line.bindTooltip(parts.join(" · "), { sticky: true });
    line.on("click", (e) => {
      L.DomEvent.stop(e);
      handlers.onSelect({ type: "segment", net: kind, id: seg.id });
    });
    layers.push(line);

    // Disruption marker: black stripes over the full road width.
    if (disrupted) {
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
    if (props.lit && !disrupted) {
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
      mid.on("click", (e) => {
        L.DomEvent.stop(e);
        handlers.onSelect({ type: "segment", net: kind, id: segId });
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
    const mid = L.marker(blockToLatLng((a.x + b.x) / 2, (a.z + b.z) / 2), {
      draggable: true,
      icon: midDivIcon(),
      zIndexOffset: -50,
      opacity: 0.85,
    });
    const edge = i;
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
    pushStationLike(layers, st, net.routes, opts);
  }
}

function pushStationLike(
  layers: L.Layer[],
  st: Station,
  routes: Route[],
  opts: OverlayRenderOpts,
): void {
  if (st.polygon.length < 3) return;
  const color = routes.find((r) => st.lineIds.includes(r.id))?.color ?? "#d0d0d0";
  const ring = st.polygon.map((p) => blockToLatLng(p.x, p.z));
  const poly = L.polygon(ring, {
    color,
    weight: 2,
    fillColor: color,
    fillOpacity: 0.25,
  });
  poly.bindTooltip(`<b>${escape(st.name)}</b>`);
  poly.on("click", (e) => {
    L.DomEvent.stop(e);
    opts.handlers.onSelect({ type: "station", id: st.id });
  });
  layers.push(poly);

  // Station icon (minecart) in the line colour at the polygon centroid.
  const n = st.polygon.length;
  const cx = st.polygon.reduce((s, p) => s + p.x, 0) / n;
  const cz = st.polygon.reduce((s, p) => s + p.z, 0) / n;
  const selected = isSelected(opts.edit.selection, "station", st.id);
  const marker = L.marker(blockToLatLng(cx, cz), {
    icon: L.divIcon({
      className: "landmark-marker",
      html: `<div class="lm-badge circle${selected ? " sel" : ""}" style="--c:${color}"><img src="${iconUri(
        "minecart",
      )}" alt="" draggable="false"></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
  });
  marker.bindTooltip(`<b>${escape(st.name)}</b>`);
  marker.on("click", (e) => {
    L.DomEvent.stop(e);
    opts.handlers.onSelect({ type: "station", id: st.id });
  });
  layers.push(marker);

  if (isPolyEditing(opts.edit.selection, opts.edit, "station", st.id)) {
    pushPolygonEditor(layers, { kind: "station", id: st.id }, st.polygon, opts);
  }
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

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

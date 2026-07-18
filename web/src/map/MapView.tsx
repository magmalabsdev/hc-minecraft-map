import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type {
  Dimension,
  DistrictCollection,
  HighwayNetwork,
  LandmarkCollection,
  RailwayNetwork,
} from "@hcmap/shared";
import {
  MinecraftCRS,
  NATIVE_ZOOM,
  TILE_SIZE,
  blockToLatLng,
  latLngToBlock,
  xzToLatLng,
} from "./crs";
import { buildOverlays, type OverlayHandlers, type OverlayToggles } from "./renderOverlays";
import type { EditState } from "../edit/model";
import type { RouteResult } from "../route/engine";
import { MINECRAFT_ICONS } from "../icons/minecraftIcons";
import {
  type BackendStatus,
  type BaseVariant,
  type BlueMapMarkers,
  type LivePlayer,
  contoursUrl,
  fetchJSON,
  liveMarkersUrl,
  livePlayersUrl,
  manifestUrl,
  snapshotMarkersUrl,
  snapshotTileUrlTemplate,
} from "../api";

export type BaseMode = "landscape2d" | "contour2d" | "minimal2d" | "biome" | "difference";

export interface MapViewProps {
  dimension: Dimension;
  baseMode: BaseMode;
  showContours: boolean;
  showLive: boolean;
  showTunnelDepths: boolean;
  backend: BackendStatus;
  overlays: {
    highways: HighwayNetwork;
    railways: RailwayNetwork;
    landmarks: LandmarkCollection;
    districts: DistrictCollection;
  };
  toggles: OverlayToggles;
  edit: EditState;
  overlayHandlers: OverlayHandlers;
  route: RouteResult | null;
  /** Route-finder is waiting for the user to click an endpoint. */
  routePicking?: boolean;
  onCursor: (block: { x: number; z: number } | null) => void;
  onMapClick: (block: { x: number; z: number }) => void;
  onMapDblClick: () => void;
}

const SPAWN = { x: -182, z: 27 };

function baseVariant(mode: BaseMode): BaseVariant {
  if (mode === "minimal2d") return "minimal";
  if (mode === "contour2d") return "bands";
  if (mode === "biome") return "biome";
  if (mode === "difference") return "difference";
  return "terrain";
}

export function MapView(props: MapViewProps) {
  const {
    dimension,
    baseMode,
    showContours,
    showLive,
    showTunnelDepths,
    backend,
    overlays,
    toggles,
    edit,
    overlayHandlers,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseRef = useRef<L.TileLayer | null>(null);
  const contourRef = useRef<L.GeoJSON | null>(null);
  const liveRef = useRef<L.LayerGroup | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const routeRef = useRef<L.LayerGroup | null>(null);
  const [zoom, setZoom] = useState(0);

  // Latest event callbacks, so the map can be initialised once (empty deps)
  // while always invoking current handlers.
  const cb = useRef({
    onCursor: props.onCursor,
    onMapClick: props.onMapClick,
    onMapDblClick: props.onMapDblClick,
  });
  cb.current = {
    onCursor: props.onCursor,
    onMapClick: props.onMapClick,
    onMapDblClick: props.onMapDblClick,
  };

  // --- init map once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      crs: MinecraftCRS,
      center: blockToLatLng(SPAWN.x, SPAWN.z),
      zoom: -1,
      minZoom: -5,
      maxZoom: 5,
      zoomControl: true,
      attributionControl: false,
      doubleClickZoom: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __hcmap?: L.Map }).__hcmap = map;
    liveRef.current = L.layerGroup().addTo(map);
    overlayRef.current = L.layerGroup().addTo(map);
    routeRef.current = L.layerGroup().addTo(map);
    setZoom(map.getZoom());
    map.on("zoomend", () => setZoom(map.getZoom()));

    map.on("mousemove", (e: L.LeafletMouseEvent) =>
      cb.current.onCursor(latLngToBlock(e.latlng)),
    );
    map.on("mouseout", () => cb.current.onCursor(null));
    map.on("click", (e: L.LeafletMouseEvent) =>
      cb.current.onMapClick(latLngToBlock(e.latlng)),
    );
    map.on("dblclick", () => cb.current.onMapDblClick());

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // --- base tile layer (dimension + mode) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    // The manifest tells us how deep the overview pyramid goes for this
    // dimension, so zoomed-out views load a few pre-shrunk tiles, not hundreds.
    void fetchJSON<{ minNativeZoom?: number }>(manifestUrl(dimension)).then((m) => {
      if (cancelled || !mapRef.current) return;
      const minNative = m?.minNativeZoom ?? -4;
      if (baseRef.current) baseRef.current.remove();
      const layer = L.tileLayer(snapshotTileUrlTemplate(dimension, baseVariant(baseMode)), {
        tileSize: TILE_SIZE,
        minZoom: minNative - 1,
        maxZoom: 6,
        minNativeZoom: minNative,
        maxNativeZoom: NATIVE_ZOOM,
        noWrap: true,
        keepBuffer: 2,
        updateWhenZooming: false,
        errorTileUrl:
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        className:
          baseMode === "minimal2d"
            ? "base-minimal"
            : baseMode === "contour2d"
              ? "base-bands"
              : baseMode === "biome"
                ? "base-biome"
                : baseMode === "difference"
                  ? "base-difference"
                  : "base-terrain",
      });
      layer.addTo(map);
      layer.bringToBack();
      baseRef.current = layer;
      map.setMinZoom(minNative - 1);
      map.setMaxZoom(6);
    });
    return () => {
      cancelled = true;
    };
  }, [dimension, baseMode]);

  // --- contour overlay ---
  // "contour2d" is the true Terrain 2D mode: its whole background is derived
  // from elevation (resistor-color bands), so contour lines are intrinsic to
  // it and only the major lines (every 5th, matching the bold weight below)
  // are drawn — the minor lines would just clutter a background that already
  // encodes elevation via color.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (contourRef.current) {
      contourRef.current.remove();
      contourRef.current = null;
    }
    const majorOnly = baseMode === "contour2d";
    if (!showContours && !majorOnly) return;
    let cancelled = false;
    void fetchJSON<GeoJSON.FeatureCollection>(contoursUrl(dimension)).then((geo) => {
      if (cancelled || !geo || !mapRef.current) return;
      const layer = L.geoJSON(geo, {
        coordsToLatLng: xzToLatLng,
        filter: (f) => !majorOnly || (f?.properties?.value ?? 0) % 40 === 0,
        style: (f) => ({
          color: majorOnly ? "#241b12" : "#5a4632",
          weight: (f?.properties?.value ?? 0) % 40 === 0 ? 1.1 : 0.5,
          opacity: majorOnly ? 0.75 : 0.5,
          fill: false,
          interactive: false,
        }),
      });
      layer.addTo(mapRef.current);
      layer.bringToBack();
      baseRef.current?.bringToBack();
      contourRef.current = layer;
    });
    return () => {
      cancelled = true;
    };
  }, [dimension, showContours, baseMode]);

  // --- overlays (highways / railways / landmarks + edit handles) ---
  useEffect(() => {
    const group = overlayRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();
    const patterns: { id: string; colors: string[] }[] = [];
    for (const layer of buildOverlays({
      highways: overlays.highways,
      railways: overlays.railways,
      landmarks: overlays.landmarks,
      districts: overlays.districts,
      toggles,
      edit,
      handlers: overlayHandlers,
      pixelsPerBlock: Math.pow(2, zoom),
      onPattern: (id, colors) => patterns.push({ id, colors }),
      showTunnelDepths,
    })) {
      group.addLayer(layer);
    }
    ensureStripePatterns(map, patterns);
  }, [overlays, toggles, edit, overlayHandlers, zoom, showTunnelDepths]);

  // --- computed route highlight ---
  useEffect(() => {
    const group = routeRef.current;
    if (!group) return;
    group.clearLayers();
    const route = props.route;
    if (!route || !route.ok || route.points.length < 2) return;

    const legs = route.legs.length
      ? route.legs
      : [{ mode: route.mode, points: route.points }];

    // Dark casing under the whole journey for contrast.
    const fullLL = route.points.map((p) => blockToLatLng(p.x, p.z));
    group.addLayer(
      L.polyline(fullLL, { color: "#0b0d10", weight: 8, opacity: 0.5, interactive: false }),
    );

    // Each leg in its own style: rail dashed, walking solid.
    for (const leg of legs) {
      if (leg.points.length < 2) continue;
      const lls = leg.points.map((p) => blockToLatLng(p.x, p.z));
      group.addLayer(
        L.polyline(lls, {
          color: leg.mode === "rail" ? "#33d6ff" : "#8ce27a",
          weight: 4,
          opacity: 0.95,
          dashArray: leg.mode === "rail" ? "10 6" : undefined,
          interactive: false,
        }),
      );
    }

    // Station board/alight junctions (where walking meets rail).
    for (let i = 0; i + 1 < legs.length; i++) {
      if (legs[i].mode === legs[i + 1].mode) continue;
      const pts = legs[i].points;
      const junction = pts[pts.length - 1];
      group.addLayer(
        L.circleMarker(blockToLatLng(junction.x, junction.z), {
          radius: 5,
          color: "#0b0d10",
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
          interactive: false,
        }),
      );
    }

    // Overall start / end.
    for (const end of [fullLL[0], fullLL[fullLL.length - 1]]) {
      group.addLayer(
        L.circleMarker(end, {
          radius: 6,
          color: "#fff",
          weight: 2,
          fillColor: "#33d6ff",
          fillOpacity: 1,
          interactive: false,
        }),
      );
    }
  }, [props.route]);

  // --- live players + markers overlay ---
  useEffect(() => {
    const group = liveRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showLive) return;
    let cancelled = false;
    let timer: number | undefined;

    async function renderMarkers() {
      const url = backend.available
        ? liveMarkersUrl(dimension)
        : snapshotMarkersUrl(dimension);
      const sets = await fetchJSON<BlueMapMarkers>(url);
      if (cancelled || !sets || !group) return;
      for (const set of Object.values(sets)) {
        for (const m of Object.values(set.markers ?? {})) {
          if (!m.position) continue;
          const marker = L.marker(blockToLatLng(m.position.x, m.position.z), {
            icon: poiIcon(),
          });
          marker.bindTooltip(
            `<b>${escapeHtml(m.label ?? "marker")}</b>${
              m.detail ? `<br>${escapeHtml(m.detail)}` : ""
            }`,
          );
          group.addLayer(marker);
        }
      }
    }

    async function renderPlayers() {
      if (!backend.available) return;
      const data = await fetchJSON<{ players: LivePlayer[] }>(livePlayersUrl(dimension));
      if (cancelled || !group) return;
      group.eachLayer((l) => {
        if ((l as L.Layer & { _isPlayer?: boolean })._isPlayer) group.removeLayer(l);
      });
      for (const p of data?.players ?? []) {
        const dot = L.circleMarker(blockToLatLng(p.position.x, p.position.z), {
          radius: 5,
          color: "#fff",
          weight: 2,
          fillColor: "#2ecc71",
          fillOpacity: 1,
        }) as L.CircleMarker & { _isPlayer?: boolean };
        dot._isPlayer = true;
        dot.bindTooltip(escapeHtml(p.name ?? "player"));
        group.addLayer(dot);
      }
    }

    void renderMarkers();
    void renderPlayers();
    timer = window.setInterval(renderPlayers, 5000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [dimension, showLive, backend.available]);

  return (
    <div ref={containerRef} className={`map-canvas${props.routePicking ? " route-picking" : ""}`} />
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Inject diagonal-stripe `<pattern>` defs (used by transfer-station bodies) into
 * the Leaflet overlay SVG, so polygons filled with `url(#id)` resolve. Rebuilt
 * each overlay pass; only our own `data-hcmap` patterns are touched.
 */
function ensureStripePatterns(
  map: L.Map,
  patterns: { id: string; colors: string[] }[],
): void {
  const svg = map.getPanes().overlayPane.querySelector("svg");
  if (!svg) return;
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  defs.querySelectorAll("pattern[data-hcmap]").forEach((el) => el.remove());
  const seen = new Set<string>();
  for (const { id, colors } of patterns) {
    if (seen.has(id) || colors.length < 2) continue;
    seen.add(id);
    const sw = 9;
    const size = colors.length * sw;
    const pat = document.createElementNS(SVG_NS, "pattern");
    pat.setAttribute("id", id);
    pat.setAttribute("data-hcmap", "1");
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    pat.setAttribute("width", String(size));
    pat.setAttribute("height", String(size));
    pat.setAttribute("patternTransform", "rotate(45)");
    colors.forEach((c, i) => {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(i * sw));
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(sw));
      rect.setAttribute("height", String(size));
      rect.setAttribute("fill", c);
      pat.appendChild(rect);
    });
    defs.appendChild(pat);
  }
}

function poiIcon(): L.DivIcon {
  return L.divIcon({
    className: "landmark-marker",
    html: `<div class="lm-badge circle" style="--c:#c9a54a"><img src="${MINECRAFT_ICONS.compass}" alt="" draggable="false"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { DIMENSIONS, type Dimension } from "@hcmap/shared";
import { MapView, type BaseMode } from "./map/MapView";
import type { OverlayToggles, OverlayHandlers } from "./map/renderOverlays";
import { type BackendStatus, checkBackend } from "./api";
import { useOverlays } from "./data/useOverlays";
import { Inspector } from "./edit/Inspector";
import { RoutePanel } from "./route/RoutePanel";
import type { RouteResult } from "./route/engine";
import {
  type ActiveLayer,
  type EditState,
  type PolyTarget,
  type Selection,
  type Tool,
  addAreaLandmark,
  addNodeAt,
  addPointLandmark,
  addStation,
  appendToRoute,
  createRoute,
  deleteNodeFromNetwork,
  deletePolyVertex,
  deleteRoute,
  findNodeNear,
  insertNodeInSegment,
  insertPolyVertex,
  mergeNodes,
  moveNode,
  movePolyVertex,
  newId,
  routesUsingSegment,
} from "./edit/model";

const SNAP_TOL = 6; // blocks — click within this of a point to connect to it

export default function App() {
  const overlays = useOverlays();

  const [dimension, setDimension] = useState<Dimension>("world");
  const [mode, setMode] = useState<BaseMode>("landscape2d");
  const [showContours, setShowContours] = useState(false);
  const [showLive, setShowLive] = useState(true);
  const [toggles, setToggles] = useState<OverlayToggles>({
    highway: true,
    railway: true,
    landmark: true,
  });
  const [backend, setBackend] = useState<BackendStatus>({
    available: false,
    editable: false,
  });
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [edit, setEdit] = useState<EditState>({
    enabled: false,
    layer: "highway",
    tool: "select",
    activeRouteId: null,
    draftPolygon: [],
    selection: null,
  });

  useEffect(() => {
    void checkBackend().then(setBackend);
  }, []);

  // --- map interaction ---
  const onMapClick = useCallback(
    (block: { x: number; z: number }) => {
      if (!edit.enabled) return;
      const { x, z } = block;
      if (edit.layer === "landmark") {
        if (edit.tool === "landmark-point") {
          let id = "";
          overlays.updateLandmarks((d) => {
            id = addPointLandmark(d, x, z);
          });
          setEdit((e) => ({ ...e, selection: { type: "landmark", id } }));
        } else if (edit.tool === "landmark-area") {
          setEdit((e) => ({ ...e, draftPolygon: [...e.draftPolygon, { x, z }] }));
        }
        return;
      }
      // railway station polygon
      if (edit.tool === "station") {
        setEdit((e) => ({ ...e, draftPolygon: [...e.draftPolygon, { x, z }] }));
        return;
      }
      // line layers (highway / railway)
      if (edit.tool !== "line") return;
      const kind = edit.layer;
      const startingNew = !edit.activeRouteId;
      const routeId = edit.activeRouteId ?? newId("r");
      overlays.updateNetwork(kind, (net) => {
        const near = findNodeNear(net, x, z, SNAP_TOL);
        const nodeId = near ?? addNodeAt(net, x, z);
        if (startingNew) createRoute(net, nodeId, routeId);
        else appendToRoute(net, routeId, nodeId);
      });
      setEdit((e) => ({
        ...e,
        activeRouteId: routeId,
        selection: { type: "route", net: kind, id: routeId },
      }));
    },
    [edit, overlays],
  );

  const onMapDblClick = useCallback(() => {
    if (!edit.enabled) return;
    if (edit.tool === "line" && edit.activeRouteId) {
      setEdit((e) => ({ ...e, activeRouteId: null }));
    } else if (edit.tool === "landmark-area" && edit.draftPolygon.length >= 3) {
      let id = "";
      const poly = edit.draftPolygon;
      overlays.updateLandmarks((d) => {
        id = addAreaLandmark(d, poly);
      });
      setEdit((e) => ({ ...e, draftPolygon: [], selection: { type: "landmark", id } }));
    } else if (edit.tool === "station" && edit.draftPolygon.length >= 3) {
      let id = "";
      const poly = edit.draftPolygon;
      overlays.updateNetwork("railway", (net) => {
        if (net.kind === "railway") id = addStation(net, poly);
      });
      setEdit((e) => ({ ...e, draftPolygon: [], selection: { type: "station", id } }));
    }
  }, [edit, overlays]);

  const applyPolyTarget = useCallback(
    (target: PolyTarget, fn: (poly: { x: number; z: number }[]) => void) => {
      if (target.kind === "landmark") {
        overlays.updateLandmarks((doc) => {
          const l = doc.landmarks.find((x) => x.id === target.id);
          if (l?.polygon) fn(l.polygon);
        });
      } else {
        overlays.updateNetwork("railway", (n) => {
          if (n.kind !== "railway") return;
          const s = n.stations.find((x) => x.id === target.id);
          if (s) fn(s.polygon);
        });
      }
    },
    [overlays],
  );

  const overlayHandlers: OverlayHandlers = useMemo(
    () => ({
      onSelect: (sel: Selection) => {
        // Clicking an existing point while drawing a line connects to it.
        if (
          sel &&
          sel.type === "node" &&
          edit.enabled &&
          edit.tool === "line" &&
          edit.layer === sel.net &&
          edit.activeRouteId
        ) {
          const rid = edit.activeRouteId;
          overlays.updateNetwork(sel.net, (net) => appendToRoute(net, rid, sel.id));
          setEdit((e) => ({ ...e, selection: sel }));
          return;
        }
        setEdit((e) => ({ ...e, selection: sel }));
      },
      onMoveNode: (net, nodeId, x, z) => {
        let landedOn: string | null = null;
        overlays.updateNetwork(net, (n) => {
          const near = findNodeNear(n, x, z, SNAP_TOL, nodeId);
          if (near) {
            mergeNodes(n, nodeId, near);
            landedOn = near;
          } else {
            moveNode(n, nodeId, x, z);
          }
        });
        // Dragging onto another node merges the two into one intersection —
        // keep the surviving node selected instead of the one that vanished.
        if (landedOn) setEdit((e) => ({ ...e, selection: { type: "node", net, id: landedOn! } }));
      },
      onInsertNode: (net, segId, x, z) => {
        // No snap-to-existing-node here: the new node sits halfway along the
        // segment it splits, so on any segment shorter than 2*SNAP_TOL it would
        // always land within range of the endpoint it just split off from and
        // immediately merge back into it, silently undoing the insert.
        let nid = "";
        overlays.updateNetwork(net, (n) => {
          nid = insertNodeInSegment(n, segId, x, z);
        });
        if (nid) setEdit((e) => ({ ...e, selection: { type: "node", net, id: nid } }));
      },
      onMovePolyVertex: (target, i, x, z) =>
        applyPolyTarget(target, (poly) => movePolyVertex(poly, i, x, z)),
      onInsertPolyVertex: (target, edgeIndex, x, z) => {
        applyPolyTarget(target, (poly) => insertPolyVertex(poly, edgeIndex, x, z));
        setEdit((e) => ({ ...e, selection: { type: "vertex", target, index: edgeIndex + 1 } }));
      },
    }),
    [edit, overlays, applyPolyTarget],
  );

  // Delete key removes the selected point, polygon vertex, or whole route.
  useEffect(() => {
    if (!edit.enabled) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const sel = edit.selection;
      if (!sel) return;
      if (sel.type === "node") {
        ev.preventDefault();
        overlays.updateNetwork(sel.net, (n) => deleteNodeFromNetwork(n, sel.id));
        setEdit((e) => ({ ...e, selection: null }));
      } else if (sel.type === "vertex") {
        ev.preventDefault();
        applyPolyTarget(sel.target, (poly) => deletePolyVertex(poly, sel.index));
        setEdit((e) => ({ ...e, selection: null }));
      } else if (sel.type === "route") {
        ev.preventDefault();
        overlays.updateNetwork(sel.net, (n) => deleteRoute(n, sel.id));
        setEdit((e) => ({ ...e, selection: null }));
      } else if (sel.type === "segment") {
        // Finishing a route often leaves its last segment selected rather than
        // the route itself (the closing click lands on the segment, not the
        // route). Delete only when the segment belongs to a single route —
        // with multiple routes sharing it, which one to delete is ambiguous,
        // so leave that to the Inspector's per-route Delete button instead.
        const routes = routesUsingSegment(overlays.network(sel.net), sel.id);
        if (routes.length === 1) {
          ev.preventDefault();
          overlays.updateNetwork(sel.net, (n) => deleteRoute(n, routes[0].id));
          setEdit((e) => ({ ...e, selection: null }));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit.enabled, edit.selection, overlays, applyPolyTarget]);

  const setEditState = useCallback(
    (fn: (e: EditState) => EditState) => setEdit(fn),
    [],
  );

  function pickLayer(layer: ActiveLayer) {
    setEdit((e) => ({
      ...e,
      layer,
      tool: "select",
      activeRouteId: null,
      draftPolygon: [],
    }));
  }

  function pickTool(tool: Tool) {
    setEdit((e) => ({ ...e, tool, activeRouteId: null, draftPolygon: [] }));
  }

  const canEdit = backend.editable;
  const anyDirty = overlays.dirty.highways || overlays.dirty.railways || overlays.dirty.landmarks;

  return (
    <div className="app">
      <MapView
        dimension={dimension}
        baseMode={mode}
        showContours={showContours}
        showLive={showLive}
        backend={backend}
        overlays={overlays}
        toggles={toggles}
        edit={edit}
        overlayHandlers={overlayHandlers}
        route={route}
        onCursor={setCursor}
        onMapClick={onMapClick}
        onMapDblClick={onMapDblClick}
      />

      <div className="panel">
        <div className="panel-title">
          HC SMP Map
          <button
            className={`route-toggle ${showRoute ? "active" : ""}`}
            title="Route finder"
            onClick={() => setShowRoute((v) => !v)}
          >
            🧭
          </button>
        </div>

        <section>
          <label className="section-label">Dimension</label>
          <div className="btn-row">
            {DIMENSIONS.map((d) => (
              <button
                key={d.id}
                className={dimension === d.id ? "active" : ""}
                onClick={() => setDimension(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label className="section-label">Map type</label>
          <div className="btn-col">
            <button className={mode === "landscape2d" ? "active" : ""} onClick={() => setMode("landscape2d")}>
              Landscape 2D
            </button>
            <button className={mode === "contour2d" ? "active" : ""} onClick={() => setMode("contour2d")}>
              Terrain 2D
            </button>
            <button className={mode === "minimal2d" ? "active" : ""} onClick={() => setMode("minimal2d")}>
              Minimal 2D
            </button>
            <button className={mode === "biome" ? "active" : ""} onClick={() => setMode("biome")}>
              Biome
            </button>
          </div>
        </section>

        <section>
          <label className="section-label">Overlays</label>
          <label className="check">
            <input type="checkbox" checked={toggles.highway} onChange={(e) => setToggles((t) => ({ ...t, highway: e.target.checked }))} />
            Highways
          </label>
          <label className="check">
            <input type="checkbox" checked={toggles.railway} onChange={(e) => setToggles((t) => ({ ...t, railway: e.target.checked }))} />
            Railways
          </label>
          <label className="check">
            <input type="checkbox" checked={toggles.landmark} onChange={(e) => setToggles((t) => ({ ...t, landmark: e.target.checked }))} />
            Landmarks
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showContours || mode === "contour2d"}
              disabled={mode === "contour2d"}
              onChange={(e) => setShowContours(e.target.checked)}
            />
            Contour lines
          </label>
          <label className="check">
            <input type="checkbox" checked={showLive} onChange={(e) => setShowLive(e.target.checked)} />
            Live players &amp; markers
          </label>
        </section>

        {canEdit && (
          <section>
            <label className="section-label">Edit</label>
            <label className="check">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) =>
                  setEdit((s) => ({
                    ...s,
                    enabled: e.target.checked,
                    tool: "select",
                    activeRouteId: null,
                    draftPolygon: [],
                    selection: null,
                  }))
                }
              />
              Edit mode
            </label>
            {edit.enabled && (
              <EditTools
                edit={edit}
                pickLayer={pickLayer}
                pickTool={pickTool}
                onFinish={onMapDblClick}
                onSave={() => void overlays.saveAll()}
                dirty={anyDirty}
              />
            )}
          </section>
        )}

        <div className="status">
          <span className={backend.available ? "dot ok" : "dot off"} />
          {backend.available
            ? backend.editable
              ? "Backend connected · editing enabled"
              : "Backend connected"
            : "Static snapshot (no backend)"}
        </div>
      </div>

      {(edit.enabled || edit.selection) && (
        <div className="side">
          <Inspector overlays={overlays} edit={edit} setEdit={setEditState} editable={edit.enabled} />
        </div>
      )}

      {showRoute && (
        <RoutePanel
          dimension={dimension}
          highways={overlays.highways}
          railways={overlays.railways}
          landmarks={overlays.landmarks}
          onRoute={setRoute}
        />
      )}

      <div className="coords">
        {cursor ? `X ${Math.round(cursor.x)}  Z ${Math.round(cursor.z)}` : "— move over the map —"}
      </div>
    </div>
  );
}

function EditTools(props: {
  edit: EditState;
  pickLayer: (l: ActiveLayer) => void;
  pickTool: (t: Tool) => void;
  onFinish: () => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const { edit, pickLayer, pickTool, onFinish, onSave, dirty } = props;
  const isLine = edit.layer === "highway" || edit.layer === "railway";
  return (
    <div className="edit-tools">
      <div className="btn-row">
        {(["highway", "railway", "landmark"] as ActiveLayer[]).map((l) => (
          <button key={l} className={edit.layer === l ? "active" : ""} onClick={() => pickLayer(l)}>
            {l === "highway" ? "Hwy" : l === "railway" ? "Rail" : "Mark"}
          </button>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 4 }}>
        <button className={edit.tool === "select" ? "active" : ""} onClick={() => pickTool("select")}>
          Select
        </button>
        {isLine && (
          <button className={edit.tool === "line" ? "active" : ""} onClick={() => pickTool("line")}>
            Draw
          </button>
        )}
        {edit.layer === "railway" && (
          <button className={edit.tool === "station" ? "active" : ""} onClick={() => pickTool("station")}>
            Station
          </button>
        )}
        {edit.layer === "landmark" && (
          <>
            <button className={edit.tool === "landmark-point" ? "active" : ""} onClick={() => pickTool("landmark-point")}>
              Pin
            </button>
            <button className={edit.tool === "landmark-area" ? "active" : ""} onClick={() => pickTool("landmark-area")}>
              Area
            </button>
          </>
        )}
      </div>
      {(edit.tool === "line" ||
        edit.tool === "landmark-area" ||
        edit.tool === "station") && (
        <p className="hint">
          Click the map to add points.{" "}
          {edit.tool === "line"
            ? "Click an existing point to connect. Double-click to finish."
            : "Double-click to close the area."}
        </p>
      )}
      {(edit.activeRouteId || edit.draftPolygon.length > 0) && (
        <button style={{ width: "100%", marginTop: 4 }} onClick={onFinish}>
          Finish shape
        </button>
      )}
      <button className={dirty ? "save dirty" : "save"} style={{ width: "100%", marginTop: 8 }} onClick={onSave}>
        {dirty ? "Save changes ●" : "Saved"}
      </button>
    </div>
  );
}

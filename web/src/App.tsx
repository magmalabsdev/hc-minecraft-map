import { useCallback, useEffect, useMemo, useState } from "react";
import { DIMENSIONS, type Dimension, type Id } from "@hcmap/shared";
import { MapView, type BaseMode } from "./map/MapView";
import { ResistorKey } from "./map/ResistorKey";
import type { OverlayToggles, OverlayHandlers } from "./map/renderOverlays";
import { type BackendStatus, checkBackend } from "./api";
import { type LineKind, type Overlays, useOverlays } from "./data/useOverlays";
import { Inspector } from "./edit/Inspector";
import { RoutePanel, type PickWhich } from "./route/RoutePanel";
import { type RoutePlace, type RouteResult, centroidOf, landmarkPos } from "./route/engine";
import {
  type ActiveLayer,
  type EditState,
  type Network,
  type PolyTarget,
  type Selection,
  type Tool,
  addAreaLandmark,
  addDistrict,
  addNodeAt,
  addPointLandmark,
  addStation,
  appendToRoute,
  createRoute,
  deleteNodeFromNetwork,
  deletePolyVertex,
  deleteRoute,
  deleteSegment,
  findNodeNear,
  insertNodeInSegment,
  insertPolyVertex,
  mergeNodes,
  mergeRoutes,
  moveNode,
  movePolyVertex,
  moveStationEntrance,
  newId,
  routeSegmentCount,
} from "./edit/model";

const SNAP_TOL = 6; // blocks — click within this of a point to connect to it

const DEFAULT_OPERATOR = "Magma Labs";
const UNASSIGNED_OPERATOR = "(no operator)";

/** Normalized operator grouping key — trims whitespace, buckets untagged routes. */
function operatorKey(operator: string | undefined): string {
  const trimmed = operator?.trim();
  return trimmed || UNASSIGNED_OPERATOR;
}

export default function App() {
  const overlays = useOverlays();

  const [dimension, setDimension] = useState<Dimension>("world");
  const [mode, setMode] = useState<BaseMode>("landscape2d");
  const [showContours, setShowContours] = useState(false);
  const [showLive, setShowLive] = useState(true);
  const [showTunnelDepths, setShowTunnelDepths] = useState(false);
  // Difference mode: hide natural canopy/ravine differences (filtered tile
  // variant). Toggleable because the filter can misread small player builds.
  const [hideNaturalDiffs, setHideNaturalDiffs] = useState(true);
  // Terrain 2D: overlay the baked water mask, since elevation bands alone
  // can't tell water from land at the same height.
  const [blackoutWater, setBlackoutWater] = useState(false);
  const [toggles, setToggles] = useState<OverlayToggles>({
    highway: true,
    railway: true,
    landmark: true,
    district: true,
  });
  // Railway operator subsetting — which operators' lines currently render.
  // Keyed by trimmed operator name (data has inconsistent trailing whitespace),
  // with untagged routes grouped under UNASSIGNED_OPERATOR. Newly-seen
  // operators default to hidden except DEFAULT_OPERATOR; once a user flips a
  // switch, that choice is preserved as more operators are discovered.
  const [operatorVisible, setOperatorVisible] = useState<Record<string, boolean>>({});
  const [backend, setBackend] = useState<BackendStatus>({
    available: false,
    editable: false,
  });
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeFrom, setRouteFrom] = useState<RoutePlace | null>(null);
  const [routeTo, setRouteTo] = useState<RoutePlace | null>(null);
  const [routePick, setRoutePick] = useState<PickWhich>(null);
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

  // Seed newly-discovered railway operators with a default (only Magma Labs
  // visible at first), without disturbing operators the user already toggled.
  useEffect(() => {
    const seen = new Set(overlays.railways.routes.map((r) => operatorKey(r.operator)));
    setOperatorVisible((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const op of seen) {
        if (!(op in next)) {
          next[op] = op === DEFAULT_OPERATOR;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [overlays.railways.routes]);

  const railwayOperators = useMemo(
    () => [...new Set(overlays.railways.routes.map((r) => operatorKey(r.operator)))].sort(),
    [overlays.railways.routes],
  );
  const railwayOperatorVisible = useCallback(
    (operator: string | undefined) => operatorVisible[operatorKey(operator)] ?? true,
    [operatorVisible],
  );

  // --- route endpoint picking (click anything on the map) ---
  const placeFromSelection = useCallback(
    (sel: Selection): RoutePlace | null => {
      if (!sel) return null;
      if (sel.type === "landmark") {
        const lm = overlays.landmarks.landmarks.find((l) => l.id === sel.id);
        const pos = lm ? landmarkPos(lm) : null;
        return lm && pos ? { kind: "landmark", id: lm.id, name: lm.name, pos } : null;
      }
      if (sel.type === "station") {
        const st = overlays.railways.stations.find((s) => s.id === sel.id);
        return st ? { kind: "station", id: st.id, name: st.name, pos: centroidOf(st.polygon) } : null;
      }
      if (sel.type === "district") {
        const d = overlays.districts.districts.find((x) => x.id === sel.id);
        return d
          ? { kind: "district", id: d.id, name: d.name, pos: d.labelPos ?? centroidOf(d.polygon) }
          : null;
      }
      return null;
    },
    [overlays],
  );

  const applyRoutePick = useCallback(
    (place: RoutePlace) => {
      if (routePick === "to") {
        setRouteTo(place);
        setRoutePick(null);
      } else {
        setRouteFrom(place);
        // Auto-advance to picking the destination if it isn't chosen yet.
        setRoutePick(routeTo ? null : "to");
      }
    },
    [routePick, routeTo],
  );

  // --- map interaction ---
  const onMapClick = useCallback(
    (block: { x: number; z: number }) => {
      const { x, z } = block;
      // Route picking intercepts empty-ground clicks (feature clicks come through
      // onSelect) so a bare coordinate can be a start/destination too.
      if (showRoute && routePick) {
        applyRoutePick({ kind: "point", name: `${Math.round(x)}, ${Math.round(z)}`, pos: { x, z } });
        return;
      }
      if (!edit.enabled) return;
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
      if (edit.layer === "district") {
        if (edit.tool === "district-area") {
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
    [edit, overlays, showRoute, routePick, applyRoutePick],
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
    } else if (edit.tool === "district-area" && edit.draftPolygon.length >= 3) {
      let id = "";
      const poly = edit.draftPolygon;
      overlays.updateDistricts((d) => {
        id = addDistrict(d, poly);
      });
      setEdit((e) => ({ ...e, draftPolygon: [], selection: { type: "district", id } }));
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
      } else if (target.kind === "district") {
        overlays.updateDistricts((doc) => {
          const d = doc.districts.find((x) => x.id === target.id);
          if (d) fn(d.polygon);
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
        // While picking a route endpoint, clicking a landmark / station /
        // district sets that endpoint instead of opening its inspector.
        if (showRoute && routePick) {
          const place = placeFromSelection(sel);
          if (place) {
            applyRoutePick(place);
            return;
          }
        }
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
      onMoveStationEntrance: (stationId, entranceId, x, z) => {
        overlays.updateNetwork("railway", (n) => {
          if (n.kind !== "railway") return;
          const s = n.stations.find((x) => x.id === stationId);
          if (s) moveStationEntrance(s, entranceId, x, z);
        });
      },
      onMoveLandmark: (id, x, z) => {
        overlays.updateLandmarks((doc) => {
          const lm = doc.landmarks.find((l) => l.id === id);
          if (!lm) return;
          if (lm.point) {
            lm.point = { x: Math.round(x), z: Math.round(z) };
          } else if (lm.polygon) {
            lm.labelPos = { x: Math.round(x), z: Math.round(z) };
          }
        });
      },
      onMoveDistrict: (id, x, z) => {
        overlays.updateDistricts((doc) => {
          const d = doc.districts.find((x2) => x2.id === id);
          if (!d) return;
          d.labelPos = { x: Math.round(x), z: Math.round(z) };
        });
      },
    }),
    [edit, overlays, applyPolyTarget, showRoute, routePick, placeFromSelection, applyRoutePick],
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
        // Cuts just this segment (trimming or splitting whichever route(s) use
        // it) rather than deleting a whole line — see the Inspector's separate
        // "Delete line" (whole route) vs "Delete segment" (this piece) buttons.
        ev.preventDefault();
        overlays.updateNetwork(sel.net, (n) => deleteSegment(n, sel.id));
        setEdit((e) => ({ ...e, selection: null }));
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
  const anyDirty =
    overlays.dirty.highways ||
    overlays.dirty.railways ||
    overlays.dirty.landmarks ||
    overlays.dirty.districts;

  return (
    <div className="app">
      <MapView
        dimension={dimension}
        baseMode={mode}
        showContours={showContours}
        showLive={showLive}
        showTunnelDepths={showTunnelDepths}
        backend={backend}
        overlays={overlays}
        toggles={toggles}
        edit={edit}
        overlayHandlers={overlayHandlers}
        route={route}
        routePicking={showRoute && routePick !== null}
        railwayOperatorVisible={railwayOperatorVisible}
        hideNaturalDiffs={hideNaturalDiffs}
        blackoutWater={blackoutWater}
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
            onClick={() =>
              setShowRoute((v) => {
                if (v) setRoutePick(null); // leaving the panel ends any pending pick
                return !v;
              })
            }
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
            {mode === "contour2d" && (
              <label className="check mode-sub-check">
                <input
                  type="checkbox"
                  checked={blackoutWater}
                  onChange={(e) => setBlackoutWater(e.target.checked)}
                />
                Black out water
              </label>
            )}
            <button className={mode === "minimal2d" ? "active" : ""} onClick={() => setMode("minimal2d")}>
              Minimal 2D
            </button>
            <button className={mode === "biome" ? "active" : ""} onClick={() => setMode("biome")}>
              Biome
            </button>
            <button className={mode === "difference" ? "active" : ""} onClick={() => setMode("difference")}>
              Difference
            </button>
            {mode === "difference" && (
              <label className="check mode-sub-check">
                <input
                  type="checkbox"
                  checked={hideNaturalDiffs}
                  onChange={(e) => setHideNaturalDiffs(e.target.checked)}
                />
                Remove natural features
              </label>
            )}
            <button className={mode === "blank" ? "active" : ""} onClick={() => setMode("blank")}>
              Solid Color
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
          {toggles.railway && railwayOperators.length > 0 && (
            <div className="operator-filter">
              {railwayOperators.map((op) => (
                <label className="check operator-check" key={op}>
                  <input
                    type="checkbox"
                    checked={operatorVisible[op] ?? true}
                    onChange={(e) =>
                      setOperatorVisible((prev) => ({ ...prev, [op]: e.target.checked }))
                    }
                  />
                  {op}
                </label>
              ))}
              <p className="hint">Transfer stations always show, regardless of this filter.</p>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={toggles.landmark} onChange={(e) => setToggles((t) => ({ ...t, landmark: e.target.checked }))} />
            Landmarks
          </label>
          <label className="check">
            <input type="checkbox" checked={toggles.district} onChange={(e) => setToggles((t) => ({ ...t, district: e.target.checked }))} />
            Districts
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
          <label className="check">
            <input
              type="checkbox"
              checked={showTunnelDepths}
              onChange={(e) => setShowTunnelDepths(e.target.checked)}
            />
            Tunnel view
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
                overlays={overlays}
                setEdit={setEdit}
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
          from={routeFrom}
          to={routeTo}
          pick={routePick}
          onPick={setRoutePick}
          onClearEndpoint={(which) => (which === "from" ? setRouteFrom(null) : setRouteTo(null))}
          onSwap={() => {
            setRouteFrom(routeTo);
            setRouteTo(routeFrom);
          }}
          onRoute={setRoute}
        />
      )}

      <div className="coords">
        {cursor ? `X ${Math.round(cursor.x)}  Z ${Math.round(cursor.z)}` : "— move over the map —"}
      </div>

      <ResistorKey
        terrain={mode === "contour2d"}
        tunnel={showTunnelDepths}
        difference={mode === "difference"}
      />
    </div>
  );
}

function EditTools(props: {
  edit: EditState;
  overlays: Overlays;
  setEdit: (fn: (e: EditState) => EditState) => void;
  pickLayer: (l: ActiveLayer) => void;
  pickTool: (t: Tool) => void;
  onFinish: () => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const { edit, overlays, setEdit, pickLayer, pickTool, onFinish, onSave, dirty } = props;
  const isLine = edit.layer === "highway" || edit.layer === "railway";
  return (
    <div className="edit-tools">
      <div className="btn-row">
        {(["highway", "railway", "landmark", "district"] as ActiveLayer[]).map((l) => (
          <button key={l} className={edit.layer === l ? "active" : ""} onClick={() => pickLayer(l)}>
            {l === "highway" ? "Hwy" : l === "railway" ? "Rail" : l === "landmark" ? "Mark" : "Dist"}
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
        {edit.layer === "district" && (
          <button className={edit.tool === "district-area" ? "active" : ""} onClick={() => pickTool("district-area")}>
            Area
          </button>
        )}
      </div>
      {(edit.tool === "line" ||
        edit.tool === "landmark-area" ||
        edit.tool === "district-area" ||
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
      {isLine && edit.tool === "select" && !edit.activeRouteId && (
        <LineManager
          net={overlays.network(edit.layer as LineKind)}
          netKind={edit.layer as LineKind}
          updateNetwork={(fn) => overlays.updateNetwork(edit.layer as LineKind, fn)}
          selection={edit.selection}
          setEdit={setEdit}
        />
      )}
      <button className={dirty ? "save dirty" : "save"} style={{ width: "100%", marginTop: 8 }} onClick={onSave}>
        {dirty ? "Save changes ●" : "Saved"}
      </button>
    </div>
  );
}

/**
 * List every line on the active layer so it can be merged or deleted without
 * clicking a path on the map — the only way to reach a route today is by
 * clicking one of its segments, which is impossible for a route with no
 * segments left (an "empty" line, e.g. after its nodes were removed some
 * other way).
 */
function LineManager(props: {
  net: Network;
  netKind: LineKind;
  updateNetwork: (fn: (net: Network) => void) => void;
  selection: Selection;
  setEdit: (fn: (e: EditState) => EditState) => void;
}) {
  const { net, netKind, updateNetwork, selection, setEdit } = props;
  const [mergeSel, setMergeSel] = useState<Id[]>([]);
  if (!net.routes.length) return null;

  const toggleMerge = (id: Id) =>
    setMergeSel((sel) => {
      if (sel.includes(id)) return sel.filter((x) => x !== id);
      if (sel.length >= 2) return [sel[1], id]; // keep the two most-recently picked
      return [...sel, id];
    });

  const clearSelectionIf = (id: Id) =>
    setEdit((e) => (e.selection?.type === "route" && e.selection.id === id ? { ...e, selection: null } : e));

  return (
    <div className="line-manager">
      <label className="section-label" style={{ marginTop: 8 }}>
        Lines ({net.routes.length})
      </label>
      <p className="hint">
        Check two lines to merge them, or delete one directly — no need to click a path on the map.
      </p>
      <div className="line-list">
        {net.routes.map((r) => {
          const segCount = routeSegmentCount(net, r);
          const isSelected = selection?.type === "route" && selection.net === netKind && selection.id === r.id;
          return (
            <div className={`line-row${isSelected ? " active" : ""}`} key={r.id}>
              <label className="check line-row-check">
                <input type="checkbox" checked={mergeSel.includes(r.id)} onChange={() => toggleMerge(r.id)} />
                <span className="line-row-name">
                  {r.name || "(unnamed)"}
                  {segCount === 0 && <span className="badge bad">empty</span>}
                </span>
              </label>
              <button
                className="danger line-row-delete"
                title="Delete this line"
                onClick={() => {
                  updateNetwork((n) => deleteRoute(n, r.id));
                  setMergeSel((sel) => sel.filter((x) => x !== r.id));
                  clearSelectionIf(r.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {mergeSel.length === 2 && (
        <button
          style={{ width: "100%", marginTop: 6 }}
          onClick={() => {
            const [a, b] = mergeSel;
            updateNetwork((n) => mergeRoutes(n, a, b));
            clearSelectionIf(b);
            setMergeSel([]);
          }}
        >
          Merge checked lines
        </button>
      )}
    </div>
  );
}

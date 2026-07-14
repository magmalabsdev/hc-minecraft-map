import { type ReactNode, useState } from "react";
import {
  DISRUPTION_TYPES,
  type DisruptionType,
  type Id,
  type Landmark,
  type LandmarkShape,
  type Route,
  type Segment,
  type Station,
  type Vec2,
  validateRoute,
} from "@hcmap/shared";
import { MINECRAFT_ICONS, MINECRAFT_ICON_IDS } from "../icons/minecraftIcons";
import type { LineKind, Overlays } from "../data/useOverlays";
import {
  type EditState,
  type PolyTarget,
  applyToRouteSegments,
  deleteLandmark,
  deleteNodeFromNetwork,
  deletePolyVertex,
  deleteRoute,
  deleteStation,
  moveNode,
  movePolyVertex,
  routeSegmentCount,
  routeSegmentsUniform,
  routesUsingSegment,
  totalRouteLength,
} from "./model";

const SHAPES: LandmarkShape[] = ["marker", "circle", "square", "diamond", "polygon"];

interface Props {
  overlays: Overlays;
  edit: EditState;
  setEdit: (fn: (e: EditState) => EditState) => void;
  editable: boolean;
}

export function Inspector({ overlays, edit, setEdit, editable }: Props) {
  const sel = edit.selection;
  const clear = () => setEdit((e) => ({ ...e, selection: null }));

  let body: ReactNode = null;
  if (!sel) {
    body = (
      <div className="insp-empty">
        {editable
          ? "Select a feature, or use the tools above to draw."
          : "Click a highway, railway, or landmark to see its details."}
      </div>
    );
  } else if (sel.type === "node") {
    body = <NodePanel overlays={overlays} net={sel.net} id={sel.id} editable={editable} clear={clear} />;
  } else if (sel.type === "vertex") {
    body = <VertexPanel overlays={overlays} target={sel.target} index={sel.index} editable={editable} clear={clear} />;
  } else if (sel.type === "route") {
    body = <RouteSection overlays={overlays} net={sel.net} routeId={sel.id} editable={editable} setEdit={setEdit} clear={clear} />;
  } else if (sel.type === "segment") {
    body = <SegmentPanel key={sel.id} overlays={overlays} net={sel.net} segId={sel.id} editable={editable} setEdit={setEdit} clear={clear} />;
  } else if (sel.type === "station") {
    body = <StationPanel overlays={overlays} id={sel.id} editable={editable} clear={clear} />;
  } else if (sel.type === "landmark") {
    body = <LandmarkPanel overlays={overlays} id={sel.id} editable={editable} clear={clear} />;
  }

  return (
    <div className="inspector">
      {sel && (
        <button className="insp-close" title="Close" onClick={clear}>
          ×
        </button>
      )}
      {body}
    </div>
  );
}

// --- line node ---

function NodePanel(p: { overlays: Overlays; net: LineKind; id: Id; editable: boolean; clear: () => void }) {
  const net = p.overlays.network(p.net);
  const node = net.nodes[p.id];
  if (!node) return null;
  return (
    <>
      <h3>Point</h3>
      <div className="field-row">
        <label>
          X
          <input
            type="number"
            disabled={!p.editable}
            value={node.x}
            onChange={(e) => p.overlays.updateNetwork(p.net, (n) => moveNode(n, p.id, Number(e.target.value), node.z))}
          />
        </label>
        <label>
          Z
          <input
            type="number"
            disabled={!p.editable}
            value={node.z}
            onChange={(e) => p.overlays.updateNetwork(p.net, (n) => moveNode(n, p.id, node.x, Number(e.target.value)))}
          />
        </label>
      </div>
      {p.editable && (
        <>
          <p className="hint">Drag the point on the map. Drag a dashed midpoint to add a new point.</p>
          <button
            className="danger"
            style={{ width: "100%" }}
            onClick={() => {
              p.overlays.updateNetwork(p.net, (n) => deleteNodeFromNetwork(n, p.id));
              p.clear();
            }}
          >
            Delete point
          </button>
        </>
      )}
    </>
  );
}

// --- polygon vertex ---

function getPolygon(overlays: Overlays, target: PolyTarget): Vec2[] | undefined {
  if (target.kind === "landmark")
    return overlays.landmarks.landmarks.find((l) => l.id === target.id)?.polygon;
  return overlays.railways.stations.find((s) => s.id === target.id)?.polygon;
}

function applyPoly(overlays: Overlays, target: PolyTarget, fn: (poly: Vec2[]) => void) {
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
}

function VertexPanel(p: { overlays: Overlays; target: PolyTarget; index: number; editable: boolean; clear: () => void }) {
  const poly = getPolygon(p.overlays, p.target);
  const v = poly?.[p.index];
  if (!poly || !v) return null;
  return (
    <>
      <h3>Vertex</h3>
      <div className="field-row">
        <label>
          X
          <input
            type="number"
            disabled={!p.editable}
            value={v.x}
            onChange={(e) => applyPoly(p.overlays, p.target, (poly) => movePolyVertex(poly, p.index, Number(e.target.value), v.z))}
          />
        </label>
        <label>
          Z
          <input
            type="number"
            disabled={!p.editable}
            value={v.z}
            onChange={(e) => applyPoly(p.overlays, p.target, (poly) => movePolyVertex(poly, p.index, v.x, Number(e.target.value)))}
          />
        </label>
      </div>
      {p.editable && (
        <>
          <p className="hint">Drag on the map. Drag a midpoint to add a vertex.</p>
          <button
            className="danger"
            style={{ width: "100%" }}
            disabled={poly.length <= 3}
            onClick={() => {
              applyPoly(p.overlays, p.target, (poly) => deletePolyVertex(poly, p.index));
              p.clear();
            }}
          >
            Delete vertex
          </button>
        </>
      )}
    </>
  );
}

// --- route (whole highway / rail line) ---

function RouteSection(p: {
  overlays: Overlays;
  net: LineKind;
  routeId: Id;
  editable: boolean;
  setEdit: (fn: (e: EditState) => EditState) => void;
  clear: () => void;
}) {
  const net = p.overlays.network(p.net);
  const route = net.routes.find((r) => r.id === p.routeId);
  if (!route) return null;
  const v = validateRoute(route);
  const len = Math.round(totalRouteLength(net, route));
  const segCount = routeSegmentCount(net, route);
  const uWidth = routeSegmentsUniform(net, route, (s) => s.width);
  const uFlat = routeSegmentsUniform(net, route, (s) => s.flat);
  const uLit = routeSegmentsUniform(net, route, (s) => s.lit);
  const uPaved = routeSegmentsUniform(net, route, (s) => s.paved ?? true);
  const setIndet = (mixed: boolean) => (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = mixed;
  };
  const patch = (fn: (r: Route) => void) =>
    p.overlays.updateNetwork(p.net, (n) => {
      const r = n.routes.find((x) => x.id === p.routeId);
      if (r) fn(r);
    });
  const batch = (fn: (seg: Segment) => void) =>
    p.overlays.updateNetwork(p.net, (n) => {
      const r = n.routes.find((x) => x.id === p.routeId);
      if (r) applyToRouteSegments(n, r, fn);
    });

  return (
    <div className="route-section">
      <h3>{p.net === "highway" ? "Highway" : "Rail line"}</h3>
      <label className="stack">
        Name
        <input disabled={!p.editable} value={route.name} onChange={(e) => patch((r) => (r.name = e.target.value))} />
      </label>
      <div className="field-row">
        <label>
          Color
          <input
            type="color"
            disabled={!p.editable}
            value={route.color ?? "#4a90d9"}
            onChange={(e) => patch((r) => (r.color = e.target.value))}
          />
        </label>
      </div>
      <div className="badges">
        <span className={`badge ${v.isLoop ? "loop" : "line"}`}>{v.isLoop ? "Loop" : "Line"}</span>
        <span className={`badge ${v.ok ? "ok" : "bad"}`}>{v.ok ? "valid" : "invalid"}</span>
        <span className="badge">{route.nodeIds.length} pts</span>
        <span className="badge">{len} blk</span>
      </div>
      {!v.ok && <p className="err">{v.errors.join(" ")}</p>}

      {p.editable && (
        <>
          <label className="section-label" style={{ marginTop: 8 }}>
            Whole route · {segCount} segment{segCount === 1 ? "" : "s"}
          </label>
          <p className="hint">Applies to every path along this route at once.</p>
          <div className="field-row">
            <label>
              Width
              <input
                type="number"
                min={1}
                value={uWidth ?? ""}
                placeholder="mixed"
                onChange={(e) => {
                  const w = Number(e.target.value);
                  batch((s) => (s.width = w));
                  patch((r) => (r.defaults.width = w));
                }}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              ref={setIndet(uFlat === undefined)}
              checked={uFlat ?? false}
              onChange={(e) => {
                batch((s) => (s.flat = e.target.checked));
                patch((r) => (r.defaults.flat = e.target.checked));
              }}
            />
            Flat
          </label>
          <label className="check">
            <input
              type="checkbox"
              ref={setIndet(uLit === undefined)}
              checked={uLit ?? false}
              onChange={(e) => {
                batch((s) => (s.lit = e.target.checked));
                patch((r) => (r.defaults.lit = e.target.checked));
              }}
            />
            Lit
          </label>
          <label className="check">
            <input
              type="checkbox"
              ref={setIndet(uPaved === undefined)}
              checked={uPaved ?? true}
              onChange={(e) => {
                batch((s) => (s.paved = e.target.checked));
                patch((r) => (r.defaults.paved = e.target.checked));
              }}
            />
            Paved
          </label>
          <div className="row-buttons" style={{ marginTop: 6 }}>
            <button onClick={() => batch((s) => (s.disruption = { ...(s.disruption ?? {}), active: true }))}>
              Disrupt all
            </button>
            <button
              onClick={() =>
                batch((s) => {
                  if (s.disruption) s.disruption.active = false;
                })
              }
            >
              Clear
            </button>
          </div>
          <div className="row-buttons">
            <button
              onClick={() =>
                p.setEdit((e) => ({ ...e, tool: "line", activeRouteId: route.id, selection: { type: "route", net: p.net, id: route.id } }))
              }
            >
              Continue drawing
            </button>
            <button
              className="danger"
              onClick={() => {
                p.overlays.updateNetwork(p.net, (n) => deleteRoute(n, p.routeId));
                p.clear();
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- one shared segment ---

function SegmentSection(p: { overlays: Overlays; net: LineKind; segId: Id; editable: boolean }) {
  const net = p.overlays.network(p.net);
  const seg = net.segments[p.segId];
  if (!seg) return null;
  const d = seg.disruption;
  const users = routesUsingSegment(net, seg.id);
  const patch = (fn: (s: Segment) => void) =>
    p.overlays.updateNetwork(p.net, (n) => {
      const s = n.segments[p.segId];
      if (s) fn(s);
    });
  return (
    <div className="segment-section">
      <label className="section-label">This segment</label>
      <div className="field-row">
        <label>
          Width
          <input type="number" min={1} disabled={!p.editable} value={seg.width} onChange={(e) => patch((s) => (s.width = Number(e.target.value)))} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" disabled={!p.editable} checked={seg.flat} onChange={(e) => patch((s) => (s.flat = e.target.checked))} />
        Flat
      </label>
      <label className="check">
        <input type="checkbox" disabled={!p.editable} checked={seg.lit} onChange={(e) => patch((s) => (s.lit = e.target.checked))} />
        Lit
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={!p.editable}
          checked={seg.paved ?? true}
          onChange={(e) => patch((s) => (s.paved = e.target.checked))}
        />
        Paved
      </label>

      <div className="disruption-box">
        <label className="check">
          <input
            type="checkbox"
            disabled={!p.editable}
            checked={!!d?.active}
            onChange={(e) =>
              patch((s) => {
                s.disruption = {
                  ...(s.disruption ?? {}),
                  active: e.target.checked,
                  type: s.disruption?.type ?? "construction",
                };
              })
            }
          />
          <b>Disruption active</b>
        </label>
        {d?.active && p.editable && (
          <>
            <label className="stack">
              Type
              <select
                value={d.type ?? "construction"}
                onChange={(e) => patch((s) => (s.disruption!.type = e.target.value as DisruptionType))}
              >
                {DISRUPTION_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Enter values that deviate from the standard.</p>
            <div className="field-row">
              <label>
                Width
                <input
                  type="number"
                  placeholder={String(seg.width)}
                  value={d.width ?? ""}
                  onChange={(e) => patch((s) => (s.disruption!.width = e.target.value === "" ? undefined : Number(e.target.value)))}
                />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={d.flat ?? seg.flat} onChange={(e) => patch((s) => (s.disruption!.flat = e.target.checked))} />
              Flat (disrupted)
            </label>
            <label className="check">
              <input type="checkbox" checked={d.lit ?? seg.lit} onChange={(e) => patch((s) => (s.disruption!.lit = e.target.checked))} />
              Lit (disrupted)
            </label>
            <label className="stack">
              Note
              <input type="text" value={d.note ?? ""} onChange={(e) => patch((s) => (s.disruption!.note = e.target.value))} />
            </label>
          </>
        )}
      </div>
      <p className="hint">
        Shared by {users.length} route{users.length === 1 ? "" : "s"}
        {users.length ? `: ${users.map((r) => r.name).join(", ")}` : ""}. A disruption shows on all of them.
      </p>
    </div>
  );
}

function SegmentPanel(p: {
  overlays: Overlays;
  net: LineKind;
  segId: Id;
  editable: boolean;
  setEdit: (fn: (e: EditState) => EditState) => void;
  clear: () => void;
}) {
  const net = p.overlays.network(p.net);
  const routes = routesUsingSegment(net, p.segId);
  const [routeId, setRouteId] = useState(routes[0]?.id ?? "");
  const chosen = routes.find((r) => r.id === routeId) ?? routes[0];
  return (
    <>
      {routes.length > 1 && (
        <label className="stack">
          {p.net === "highway" ? "Highway" : "Rail line"}
          <select value={chosen?.id} onChange={(e) => setRouteId(e.target.value)}>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen && (
        <RouteSection overlays={p.overlays} net={p.net} routeId={chosen.id} editable={p.editable} setEdit={p.setEdit} clear={p.clear} />
      )}
      <hr className="insp-sep" />
      <SegmentSection overlays={p.overlays} net={p.net} segId={p.segId} editable={p.editable} />
    </>
  );
}

// --- station ---

function StationPanel(p: { overlays: Overlays; id: Id; editable: boolean; clear: () => void }) {
  const net = p.overlays.railways;
  const st = net.stations.find((s) => s.id === p.id);
  if (!st) return null;
  const patch = (fn: (s: Station) => void) =>
    p.overlays.updateNetwork("railway", (n) => {
      if (n.kind !== "railway") return;
      const s = n.stations.find((x) => x.id === p.id);
      if (s) fn(s);
    });
  const toggleLine = (lineId: Id, on: boolean) =>
    patch((s) => {
      s.lineIds = on ? [...new Set([...s.lineIds, lineId])] : s.lineIds.filter((l) => l !== lineId);
    });
  return (
    <>
      <h3>🚆 Station</h3>
      <label className="stack">
        Name
        <input disabled={!p.editable} value={st.name} onChange={(e) => patch((s) => (s.name = e.target.value))} />
      </label>
      <label className="section-label" style={{ marginTop: 6 }}>
        Serves lines
      </label>
      {net.routes.length === 0 && <p className="hint">Draw a rail line first.</p>}
      {net.routes.map((line) => (
        <label className="check" key={line.id}>
          <input type="checkbox" disabled={!p.editable} checked={st.lineIds.includes(line.id)} onChange={(e) => toggleLine(line.id, e.target.checked)} />
          <span style={{ color: line.color }}>■</span> {line.name}
        </label>
      ))}
      {p.editable && (
        <>
          <p className="hint">Drag a vertex to reshape, or a midpoint to add one.</p>
          <button
            className="danger"
            style={{ width: "100%" }}
            onClick={() => {
              p.overlays.updateNetwork("railway", (n) => {
                if (n.kind === "railway") deleteStation(n, p.id);
              });
              p.clear();
            }}
          >
            Delete
          </button>
        </>
      )}
    </>
  );
}

// --- landmark ---

function LandmarkPanel(p: { overlays: Overlays; id: Id; editable: boolean; clear: () => void }) {
  const lm = p.overlays.landmarks.landmarks.find((l) => l.id === p.id);
  if (!lm) return null;
  const patch = (fn: (l: Landmark) => void) =>
    p.overlays.updateLandmarks((doc) => {
      const l = doc.landmarks.find((x) => x.id === p.id);
      if (l) fn(l);
    });
  return (
    <>
      <h3>Landmark</h3>
      <label className="stack">
        Name
        <input disabled={!p.editable} value={lm.name} onChange={(e) => patch((l) => (l.name = e.target.value))} />
      </label>
      <div className="field-row">
        <label>
          Color
          <input type="color" disabled={!p.editable} value={lm.color} onChange={(e) => patch((l) => (l.color = e.target.value))} />
        </label>
        <label>
          Shape
          <select disabled={!p.editable} value={lm.shape} onChange={(e) => patch((l) => (l.shape = e.target.value as LandmarkShape))}>
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="section-label" style={{ marginTop: 6 }}>
        Icon
      </label>
      <div className="icon-grid">
        {MINECRAFT_ICON_IDS.map((i) => (
          <button
            key={i}
            type="button"
            title={i.replace(/_/g, " ")}
            disabled={!p.editable}
            className={`icon-btn${lm.icon === i ? " sel" : ""}`}
            onClick={() => patch((l) => (l.icon = i))}
          >
            <img src={MINECRAFT_ICONS[i]} alt={i} />
          </button>
        ))}
      </div>
      {lm.point && (
        <div className="field-row">
          <label>
            X
            <input type="number" disabled={!p.editable} value={lm.point.x} onChange={(e) => patch((l) => (l.point!.x = Number(e.target.value)))} />
          </label>
          <label>
            Z
            <input type="number" disabled={!p.editable} value={lm.point.z} onChange={(e) => patch((l) => (l.point!.z = Number(e.target.value)))} />
          </label>
        </div>
      )}
      {lm.polygon && p.editable && <p className="hint">Drag a vertex to reshape, or a midpoint to add one.</p>}
      {p.editable && (
        <button
          className="danger"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            p.overlays.updateLandmarks((doc) => deleteLandmark(doc, p.id));
            p.clear();
          }}
        >
          Delete
        </button>
      )}
    </>
  );
}

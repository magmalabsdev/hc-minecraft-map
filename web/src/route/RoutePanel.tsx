import { useEffect, useState } from "react";
import type {
  Dimension,
  HighwayNetwork,
  LandmarkCollection,
  RailwayNetwork,
} from "@hcmap/shared";
import {
  type RouteMode,
  type RouteResult,
  computeRoute,
  formatDuration,
} from "./engine";
import { HeightField } from "./heightField";

const MODES: { id: RouteMode; label: string }[] = [
  { id: "walk", label: "Walk" },
  { id: "rail", label: "Rail" },
  { id: "horse", label: "Horse" },
];

interface Props {
  dimension: Dimension;
  highways: HighwayNetwork;
  railways: RailwayNetwork;
  landmarks: LandmarkCollection;
  onRoute: (r: RouteResult | null) => void;
}

export function RoutePanel({ dimension, highways, railways, landmarks, onRoute }: Props) {
  const [mode, setMode] = useState<RouteMode>("walk");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [hf, setHf] = useState<HeightField | null>(null);
  const [result, setResult] = useState<RouteResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void HeightField.load(dimension).then((h) => {
      if (!cancelled) setHf(h);
    });
    return () => {
      cancelled = true;
    };
  }, [dimension]);

  const items = landmarks.landmarks;

  function go() {
    const from = items.find((l) => l.id === fromId);
    const to = items.find((l) => l.id === toId);
    if (!from || !to) return;
    const r = computeRoute(mode, from, to, {
      highways,
      railways,
      heightField: hf,
    });
    setResult(r);
    onRoute(r.ok ? r : null);
  }

  function clear() {
    setResult(null);
    onRoute(null);
  }

  return (
    <div className="route-panel">
      <div className="panel-title">Route finder</div>
      <div className="btn-row">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? "active" : ""}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {items.length < 2 ? (
        <p className="hint">Add at least two landmarks to plan a route.</p>
      ) : (
        <>
          <label className="stack">
            From
            <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">—</option>
              {items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stack">
            To
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">—</option>
              {items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row-buttons">
            <button className="active" onClick={go} disabled={!fromId || !toId}>
              Find route
            </button>
            <button onClick={clear}>Clear</button>
          </div>
        </>
      )}

      {result && (
        <div className="route-result">
          {result.ok ? (
            <>
              <div className="route-stat">
                <b>{result.distanceBlocks.toLocaleString()}</b> blocks
              </div>
              <div className="route-stat">
                <b>{formatDuration(result.timeSeconds)}</b> by {result.mode}
              </div>
              {result.mode !== "rail" && (
                <div className="hint">
                  {result.deviated
                    ? "Route deviates off-road across smooth terrain."
                    : "Route follows the roadway (terrain too rough to shortcut)."}
                </div>
              )}
              {result.mode !== "rail" && !hf && (
                <div className="hint">No heightmap loaded — following roads only.</div>
              )}
            </>
          ) : (
            <div className="err">{result.message}</div>
          )}
        </div>
      )}
    </div>
  );
}

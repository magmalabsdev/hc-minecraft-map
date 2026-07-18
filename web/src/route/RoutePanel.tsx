import { useEffect, useState } from "react";
import type { Dimension, HighwayNetwork, RailwayNetwork } from "@hcmap/shared";
import {
  type RouteMode,
  type RoutePlace,
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

export type PickWhich = "from" | "to" | null;

interface Props {
  dimension: Dimension;
  highways: HighwayNetwork;
  railways: RailwayNetwork;
  from: RoutePlace | null;
  to: RoutePlace | null;
  pick: PickWhich;
  onPick: (which: PickWhich) => void;
  onClearEndpoint: (which: "from" | "to") => void;
  onSwap: () => void;
  onRoute: (r: RouteResult | null) => void;
}

const PLACE_GLYPH: Record<RoutePlace["kind"], string> = {
  landmark: "📍",
  station: "🚆",
  district: "🗺️",
  point: "✛",
};

export function RoutePanel(props: Props) {
  const { dimension, highways, railways, from, to, pick, onPick, onClearEndpoint, onSwap, onRoute } =
    props;
  const [mode, setMode] = useState<RouteMode>("walk");
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

  // Recompute whenever both endpoints, the mode, the loaded terrain, or the
  // underlying networks change.
  useEffect(() => {
    if (!from || !to) {
      setResult(null);
      onRoute(null);
      return;
    }
    const r = computeRoute(mode, from, to, { highways, railways, heightField: hf });
    setResult(r);
    onRoute(r.ok ? r : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, mode, hf, highways, railways]);

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

      <Endpoint
        label="From"
        place={from}
        picking={pick === "from"}
        onPick={() => onPick(pick === "from" ? null : "from")}
        onClear={() => onClearEndpoint("from")}
      />
      <div className="route-swap-row">
        <button className="route-swap" title="Swap" onClick={onSwap} disabled={!from && !to}>
          ⇅
        </button>
      </div>
      <Endpoint
        label="To"
        place={to}
        picking={pick === "to"}
        onPick={() => onPick(pick === "to" ? null : "to")}
        onClear={() => onClearEndpoint("to")}
      />

      <p className="hint">
        {pick
          ? `Click a landmark, station, district — or anywhere on the map — to set the ${pick} point.`
          : "Pick a start and destination by clicking anything on the map."}
      </p>

      {result && (
        <div className="route-result">
          {result.ok ? (
            <>
              <div className="route-stat">
                <b>{formatDuration(result.timeSeconds)}</b> by {result.mode}
              </div>
              <div className="route-stat">
                <b>{result.distanceBlocks.toLocaleString()}</b> blocks
              </div>
              {result.mode === "rail" ? (
                <div className="route-legs">
                  <div className="route-leg">
                    🚶 Walk to <b>{result.boardStation}</b> ·{" "}
                    {formatDuration(result.walkToStationSeconds ?? 0)}
                  </div>
                  <div className="route-leg">
                    🚆 Ride to <b>{result.alightStation}</b> ·{" "}
                    {formatDuration(result.railSeconds ?? 0)}
                    {result.transfers
                      ? ` · ${result.transfers} transfer${result.transfers > 1 ? "s" : ""}`
                      : " · direct"}
                  </div>
                  <div className="route-leg">
                    🚶 Walk to destination · {formatDuration(result.walkFromStationSeconds ?? 0)}
                  </div>
                </div>
              ) : (
                <>
                  <div className="hint">
                    {result.deviated
                      ? "Route deviates off-road across smooth terrain."
                      : "Route follows the roadway (terrain too rough to shortcut)."}
                  </div>
                  {!hf && <div className="hint">No heightmap loaded — following roads only.</div>}
                </>
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

function Endpoint(props: {
  label: string;
  place: RoutePlace | null;
  picking: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  const { label, place, picking, onPick, onClear } = props;
  return (
    <div className={`route-endpoint${picking ? " picking" : ""}`}>
      <span className="route-endpoint-label">{label}</span>
      <button className="route-endpoint-value" onClick={onPick} title="Pick on map">
        {place ? (
          <>
            <span className="route-place-glyph">{PLACE_GLYPH[place.kind]}</span>
            {place.name}
          </>
        ) : picking ? (
          <em>Click the map…</em>
        ) : (
          <em>Pick on map</em>
        )}
      </button>
      {place && (
        <button className="route-endpoint-clear" title="Clear" onClick={onClear}>
          ×
        </button>
      )}
    </div>
  );
}

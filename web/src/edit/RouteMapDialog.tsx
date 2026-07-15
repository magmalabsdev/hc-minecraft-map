import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type RailwayNetwork, type Route, orderedRouteStops, stationTransferLines } from "@hcmap/shared";
import { type LabeledStop, computeSnakeLayout } from "./routeMapLayout";
import { createMeasureText, downloadCanvasPng, renderRouteMapCanvas, slugifyRouteName } from "./routeMapRender";

interface Props {
  route: Route;
  net: RailwayNetwork;
  onClose: () => void;
}

const MIN_FOOTPRINT = 8;
const MAX_PREVIEW_PX = 480;

export function RouteMapDialog({ route, net, onClose }: Props) {
  const stops = useMemo(() => orderedRouteStops(route, net), [route, net]);
  const [widthBlocks, setWidthBlocks] = useState(() => Math.min(800, Math.max(200, stops.length * 40)));
  const [heightBlocks, setHeightBlocks] = useState(() => Math.min(800, Math.max(160, stops.length * 20)));
  const [includePlanned, setIncludePlanned] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureText = useMemo(() => createMeasureText(), []);

  // "Include planned" also reveals this route's own not-yet-built stations,
  // not just transfers to other not-yet-built-through lines — unchecked, the
  // diagram reflects what's actually ridable today.
  const labeledStops: LabeledStop[] = useMemo(
    () =>
      stops
        .filter((stop) => includePlanned || stop.station.built !== false)
        .map((stop) => ({
          stop,
          transferLines: stationTransferLines(stop.station, route.id, net, includePlanned),
        })),
    [stops, route.id, net, includePlanned],
  );

  const layout = useMemo(
    () => computeSnakeLayout(labeledStops, { width: widthBlocks, height: heightBlocks }, measureText),
    [labeledStops, widthBlocks, heightBlocks, measureText],
  );

  const isLoop = route.nodeIds.length >= 2 && route.nodeIds[0] === route.nodeIds[route.nodeIds.length - 1];
  const sizeValid = widthBlocks >= MIN_FOOTPRINT && heightBlocks >= MIN_FOOTPRINT;
  const enoughStops = labeledStops.length >= 2;
  const hiddenByPlannedFilter = !enoughStops && stops.length >= 2 && !includePlanned;
  const canGenerate = sizeValid && enoughStops;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canGenerate) return;
    canvas.width = widthBlocks;
    canvas.height = heightBlocks;
    void renderRouteMapCanvas(canvas, layout, {
      routeColor: route.color ?? "#4a90d9",
      routeName: route.name,
      isLoop,
    });
  }, [layout, canGenerate, widthBlocks, heightBlocks, route.color, route.name, isLoop]);

  const previewScale = Math.max(1, Math.min(8, MAX_PREVIEW_PX / Math.max(widthBlocks, heightBlocks, 1)));

  // Rendered via a portal: an ancestor panel (.side) uses backdrop-filter,
  // which creates a containing block for position:fixed descendants — without
  // a portal to document.body, this "full-viewport" overlay would actually be
  // confined to that panel's small bounding box instead of the real viewport.
  return createPortal(
    <div className="route-map-overlay" onClick={onClose}>
      <div className="route-map-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="route-map-header">
          <h3>Generate route map — {route.name}</h3>
          <button className="insp-close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {stops.length === 0 ? (
          <p className="hint">
            No stations found along this line. Add stations and assign them to this line first.
          </p>
        ) : (
          <>
            {enoughStops ? (
              <div className="route-map-preview">
                {canGenerate ? (
                  <canvas
                    ref={canvasRef}
                    className="route-map-canvas"
                    // Only `width` is set — `height: auto` in CSS derives the
                    // correct proportional height from the canvas's intrinsic
                    // width/height attributes, so it can never end up
                    // stretched even if the container constrains this width.
                    style={{ width: Math.round(widthBlocks * previewScale) }}
                  />
                ) : (
                  <p className="hint">Footprint must be at least {MIN_FOOTPRINT}×{MIN_FOOTPRINT} blocks.</p>
                )}
              </div>
            ) : (
              <p className="hint">
                {hiddenByPlannedFilter
                  ? "This line only has one built station right now — check “Include planned stations & transfers” below to preview the rest of the plan."
                  : "Only one station on this line — need at least two to draw a diagram."}
              </p>
            )}

            {isLoop && (
              <p className="hint">
                This is a loop — both ends of the diagram are the same station.
              </p>
            )}
            {layout.warnings.map((w) => (
              <p className="hint" key={w}>
                {w}
              </p>
            ))}

            <div className="field-row">
              <label>
                Width (blocks)
                <input
                  type="number"
                  min={MIN_FOOTPRINT}
                  value={widthBlocks}
                  onChange={(e) => setWidthBlocks(Number(e.target.value))}
                />
              </label>
              <label>
                Height (blocks)
                <input
                  type="number"
                  min={MIN_FOOTPRINT}
                  value={heightBlocks}
                  onChange={(e) => setHeightBlocks(Number(e.target.value))}
                />
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={includePlanned}
                onChange={(e) => setIncludePlanned(e.target.checked)}
              />
              Include planned stations &amp; transfers (not yet built)
            </label>

            <div className="row-buttons" style={{ marginTop: 8 }}>
              <button
                disabled={!canGenerate}
                onClick={() => {
                  const canvas = canvasRef.current;
                  if (!canvas) return;
                  downloadCanvasPng(canvas, `${slugifyRouteName(route.name)}-${widthBlocks}x${heightBlocks}.png`);
                }}
              >
                Download PNG
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

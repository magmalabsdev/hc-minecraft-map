import { RESISTOR_COLORS, resistorColorHex } from "@hcmap/shared";

const DIGITS = Array.from({ length: 10 }, (_, i) => i);

/** Readable text color (near-black or near-white) for a swatch of this hue. */
function contrastText(digit: number): string {
  const [r, g, b] = RESISTOR_COLORS[digit];
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 140 ? "#14161a" : "#f2f2f2";
}

/**
 * Legend for the resistor color code used across several views: the tens
 * digit picks one of these 10 hues. Only shown while a view that actually
 * uses this code is active (Terrain 2D's band background, Tunnel view,
 * and/or the Difference view).
 */
export function ResistorKey(props: { terrain: boolean; tunnel: boolean; difference: boolean }) {
  if (!props.terrain && !props.tunnel && !props.difference) return null;
  return (
    <div className="resistor-key">
      <div className="resistor-key-swatches">
        {DIGITS.map((d) => (
          <div
            key={d}
            className="resistor-key-swatch"
            style={{ background: resistorColorHex(d), color: contrastText(d) }}
          >
            {d}
          </div>
        ))}
      </div>
      <div className="resistor-key-caption">
        Resistor color code — tens digit picks the hue.
        {props.terrain &&
          " Terrain 2D: colors elevation (Y); zoomed in, the ones digit shows as a corner dot, zoomed out it shades the color light (0-4) or dark (5-9)."}
        {props.tunnel && " Tunnel view: colors tunnel depth (Y); the ones digit shows as a dashed overlay color."}
        {props.difference &&
          " Difference: |current top-block height − freshly-generated top-block height|, simulated block-accurately from the seed. Tens digit = cell color, ones digit = corner dot, same as Terrain 2D. Black = untouched; any strong color = terraformed, with the same color whether raised or dug. \"Remove natural features\" hides narrow tree-canopy bumps (<~5 wide, ≤16 tall) and shallow carver ravines (≤32 deep); uncheck it to see every difference."}
      </div>
    </div>
  );
}

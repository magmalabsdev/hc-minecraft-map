import type { Dimension } from "@hcmap/shared";

/**
 * Tile-source resolution. The base map reads from the committed snapshot first
 * (works with no backend); the live mirror proxy is used for fresh player /
 * marker data when a local backend is present.
 */

export type BaseVariant = "terrain" | "minimal" | "bands" | "biome" | "difference";

/**
 * Prefix an absolute app path with Vite's base URL, so the app works both at the
 * site root (local dev) and under a subpath (GitHub Pages: /<repo>/).
 */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, "");
}

export function snapshotTileUrlTemplate(
  dim: Dimension,
  variant: BaseVariant,
): string {
  return assetUrl(`/snapshot/${dim}/${variant}/{z}/{x}/{y}.png`);
}

export function manifestUrl(dim: Dimension): string {
  return assetUrl(`/snapshot/${dim}/manifest.json`);
}

export function contoursUrl(dim: Dimension): string {
  return assetUrl(`/snapshot/${dim}/derived/contours.geojson`);
}

export function snapshotMarkersUrl(dim: Dimension): string {
  return assetUrl(`/snapshot/${dim}/markers.json`);
}

export function liveMarkersUrl(dim: Dimension): string {
  return assetUrl(`/api/mirror/maps/${dim}/live/markers.json`);
}

export function livePlayersUrl(dim: Dimension): string {
  return assetUrl(`/api/mirror/maps/${dim}/live/players.json`);
}

export interface BackendStatus {
  available: boolean;
  editable: boolean;
}

/** Detect whether a local backend is running (enables fresh data + editing). */
export async function checkBackend(): Promise<BackendStatus> {
  try {
    const res = await fetch(assetUrl("/api/health"), { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { available: false, editable: false };
    const body = (await res.json()) as { editable?: boolean };
    return { available: true, editable: Boolean(body.editable) };
  } catch {
    return { available: false, editable: false };
  }
}

export async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// --- live data shapes (subset of BlueMap's live JSON) ---

export interface LivePlayer {
  name?: string;
  uuid?: string;
  foreign?: boolean;
  position: { x: number; y: number; z: number };
}

export interface BlueMapMarker {
  label?: string;
  detail?: string;
  type?: string;
  position?: { x: number; y: number; z: number };
}

export interface BlueMapMarkerSet {
  label?: string;
  markers?: Record<string, BlueMapMarker>;
}

export type BlueMapMarkers = Record<string, BlueMapMarkerSet>;

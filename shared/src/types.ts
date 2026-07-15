/**
 * The editable network data model.
 *
 * The core idea (from the spec): highways and railways are a SHARED GRAPH of
 * nodes and segments. A physical `Segment` owns width / flat / lit / disruption
 * and can be traversed by many named `Route`s; a disruption on a segment
 * therefore surfaces on every route that uses it.
 *
 * Segments are keyed by the canonical (unordered) pair of their endpoint node
 * ids (see `pairKey` in graph.ts). That is what makes sharing automatic: two
 * routes that traverse the same pair of nodes reference the exact same segment.
 */

export type Id = string;

export interface Vec2 {
  x: number;
  z: number;
}

/** A clickable / draggable point in the network graph. */
export interface Node {
  id: Id;
  x: number;
  z: number;
  /** Optional surface height, filled from the terrain heightmap when known. */
  y?: number;
}

/** Standard physical properties of a piece of road / track. */
export interface SegmentProps {
  /** Width in blocks. */
  width: number;
  flat: boolean;
  lit: boolean;
  /** Whether the road surface is paved. Missing in legacy data => treat as true. */
  paved: boolean;
  /**
   * Whether this has actually been built, vs. only planned. Missing => treat
   * as true (built). Planned/unbuilt segments are hidden outside edit mode and
   * excluded from route-finding; never overridden by a disruption.
   */
  built?: boolean;
}

/** The kind of disruption affecting a segment. "construction" renders specially. */
export type DisruptionType =
  | "construction"
  | "closure"
  | "hazard"
  | "flooding"
  | "other";

export const DISRUPTION_TYPES: { id: DisruptionType; label: string }[] = [
  { id: "construction", label: "Construction" },
  { id: "closure", label: "Closure" },
  { id: "hazard", label: "Hazard" },
  { id: "flooding", label: "Flooding" },
  { id: "other", label: "Other" },
];

export function disruptionTypeLabel(t: DisruptionType | undefined): string {
  return DISRUPTION_TYPES.find((d) => d.id === t)?.label ?? "Disruption";
}

/**
 * A deviation from a segment's standard values. Any override field left undefined
 * keeps the standard value. When `active`, routes render the segment in the
 * disruption style and display the disrupted values.
 */
export interface Disruption {
  active: boolean;
  /** What kind of disruption this is (drives styling + description). */
  type?: DisruptionType;
  width?: number;
  flat?: boolean;
  lit?: boolean;
  paved?: boolean;
  note?: string;
}

/** The physical road/track between two nodes. Authoritative + shareable. */
export interface Segment extends SegmentProps {
  /** Canonical pair key of the two endpoint node ids (see pairKey). */
  id: Id;
  a: Id;
  b: Id;
  disruption?: Disruption;
}

/** A named path over shared nodes/segments. first === last node => loop. */
export interface Route {
  id: Id;
  name: string;
  /** Ordered node ids. Consecutive pairs map to shared segments. */
  nodeIds: Id[];
  /** Display color for the route (rail lines especially). */
  color?: string;
  /** Defaults used to seed newly-created segments while editing this route. */
  defaults: SegmentProps;
}

export type NetworkKind = "highway" | "railway";

/** A railway station: a polygon assigned to one or more rail lines. */
export interface Station {
  id: Id;
  name: string;
  /** Ring of block coords. */
  polygon: Vec2[];
  /** Rail line (route) ids this station serves. */
  lineIds: Id[];
  /**
   * Whether this station has actually been built, vs. only a planned footprint.
   * Missing => treat as true (built). Planned/unbuilt stations are hidden
   * outside edit mode.
   */
  built?: boolean;
}

export interface HighwayNetwork {
  kind: "highway";
  nodes: Record<Id, Node>;
  /** Keyed by canonical pair key. */
  segments: Record<Id, Segment>;
  routes: Route[];
}

export interface RailwayNetwork {
  kind: "railway";
  nodes: Record<Id, Node>;
  segments: Record<Id, Segment>;
  routes: Route[];
  stations: Station[];
}

export type LandmarkShape =
  | "marker"
  | "circle"
  | "square"
  | "diamond"
  | "polygon";

/**
 * A landmark icon id — the name of a Minecraft item/block texture. The concrete
 * registry (id -> embedded texture) lives in the web app
 * (`web/src/icons/minecraftIcons.ts`); the default is "map".
 */
export type LandmarkIcon = string;

export interface Landmark {
  id: Id;
  name: string;
  /** A point landmark, OR a polygon area landmark (one of the two is set). */
  point?: Vec2;
  polygon?: Vec2[];
  color: string;
  shape: LandmarkShape;
  icon: LandmarkIcon;
}

export interface LandmarkCollection {
  landmarks: Landmark[];
}

/** Convenience empty documents used to seed new data files. */
export function emptyHighwayNetwork(): HighwayNetwork {
  return { kind: "highway", nodes: {}, segments: {}, routes: [] };
}

export function emptyRailwayNetwork(): RailwayNetwork {
  return { kind: "railway", nodes: {}, segments: {}, routes: [], stations: [] };
}

export function emptyLandmarks(): LandmarkCollection {
  return { landmarks: [] };
}

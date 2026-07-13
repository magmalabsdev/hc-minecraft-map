import L from "leaflet";

/**
 * A Leaflet CRS for Minecraft block coordinates.
 *
 * We use an identity transformation (a=1,b=0,c=1,d=0) over CRS.Simple so that a
 * block (x, z) projects directly to pixel (x, z) at zoom 0. Because Leaflet's
 * pixel-Y grows downward, mapping latitude<-z means +z is south (down) and -z is
 * north (up) — matching Minecraft's convention. Tile (i, j) at zoom 0 therefore
 * lines up exactly with BlueMap lowres tile (i, j).
 */
export const MinecraftCRS = L.Util.extend({}, L.CRS.Simple, {
  transformation: new L.Transformation(1, 0, 1, 0),
}) as L.CRS;

/** Zoom at which 1 block == 1 pixel and tiles are addressed natively. */
export const NATIVE_ZOOM = 0;
export const TILE_SIZE = 500;

/** Block (x, z) -> Leaflet LatLng. */
export function blockToLatLng(x: number, z: number): L.LatLng {
  return L.latLng(z, x);
}

/** Leaflet LatLng -> block coordinates. */
export function latLngToBlock(ll: L.LatLng): { x: number; z: number } {
  return { x: ll.lng, z: ll.lat };
}

/** GeoJSON [x, z] pair -> Leaflet LatLng (for contour / overlay rendering). */
export function xzToLatLng(coords: number[]): L.LatLng {
  return L.latLng(coords[1], coords[0]);
}

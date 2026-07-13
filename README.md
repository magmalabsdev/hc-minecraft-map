# HC SMP Map

An interactive web map of the [Hack Club SMP](https://mc.hackclub.com) — terrain
background plus a community-editable network of highways, railways, and landmarks,
with route-finding between them.

The terrain is mirrored from the server's live **BlueMap**; the road / rail /
landmark network is this project's own data, created in a local-only **edit mode**
and committed as JSON so the published site is a static, read-only viewer.

## Layout

```
shared/     TS data model + coordinate/graph helpers (used by web and server)
server/     Express: BlueMap mirror proxy, snapshot preprocessing, data persistence
web/        React + Vite viewer/editor (Leaflet 2D; three.js 3D planned)
snapshot/   Committed mirrored terrain tiles + derived height/minimal/contour data
data/       Committed overlay documents: highways.json, railways.json, landmarks.json
```

## Quick start

```bash
npm install

# 1. Bake a terrain snapshot around spawn (writes into snapshot/).
#    Omit flags for the default ~4000-block box; smaller = faster & smaller commit.
npm run mirror -w server -- --dim world --minX -600 --minZ -600 --maxX 600 --maxZ 600

npm run mirror -w server -- --dim world --minX -4000 --minZ -4000 --maxX 4000 --maxZ 4000

# 2. Run backend (mirror proxy + data API) and web dev server together.
npm run dev
# → web on http://localhost:5173, backend on http://localhost:8787
```

Open http://localhost:5173. Switch dimensions, map types (Terrain 2D / Minimal 2D /
Terrain 3D), and toggle contour lines and the live players/markers overlay.

### Edit mode

Edit mode is enabled only when the app can reach the local backend (`npm run dev`
on localhost). It writes changes back to `data/*.json` via the backend, which
refuses write/mirror requests from non-loopback clients.

## How the terrain works

BlueMap sends no CORS headers, so the browser can't read tile pixels or 3D data
cross-origin. `server/` mirrors a bounded region same-origin and preprocesses each
BlueMap lowres tile — whose bottom half encodes a per-block heightmap — into:

- `snapshot/<dim>/terrain/<tx>/<tz>.png` — full-colour top-down tiles
- `snapshot/<dim>/minimal/<tx>/<tz>.png` — muted, hillshaded "Minimal" style
- `snapshot/<dim>/derived/contours.geojson` — contour lines from the heightmap

The viewer reads the committed snapshot first (works with no backend); the mirror
proxy supplies fresh player/marker data when the backend is running.

## Status

- [x] M0 monorepo scaffold + shared model
- [x] M1 mirror proxy + preprocess pipeline + snapshot
- [x] M2 2D viewer: Terrain/Minimal modes, contours, dimensions, live overlay
- [x] M3 3D terrain (three.js heightmap, reuses the snapshot; lazy-loaded)
- [x] M4 highway/railway/landmark overlays (toggleable)
- [x] M5 local edit mode: draw/drag/connect points, inspector, station polygons
- [x] M6 disruptions (per shared segment; propagate to every route that uses it)
- [x] M7 route finding: walking / railway / horse, terrain-aware deviation

The published build is fully static: `npm run build` bundles `snapshot/` and
`data/` into `web/dist`, which runs with no backend (edit mode simply stays off).

### Known follow-ups
- 3D uses a self-contained heightmap mesh (not BlueMap's `.prbm` geometry) — good
  relief, but not block-accurate 3D. Swapping in BlueMap's three.js loader is future work.
- "Flat biome" logic for horse routing approximates flatness from height-slope
  variance (true biome data isn't in BlueMap tiles).
- Contour density / snapshot size scale with the mirrored region; keep it bounded.

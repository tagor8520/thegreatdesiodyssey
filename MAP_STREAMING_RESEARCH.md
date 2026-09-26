# Coordinate-to-Procedural-World Research and MVP Design

**Date:** 2026-09-15
**Implemented target:** browser-only, no API key, 1:10 horizontal scale, low-end hardware first.

## Goal

A player enters latitude/longitude. The browser downloads a small public vector-map chunk, generates roads first, then procedurally extrudes buildings. As the player reaches a chunk edge, at most the immediately needed neighboring chunks load in the background. Total world extent must not increase steady client memory.

## Source options considered

### 1. OpenFreeMap / OpenMapTiles vector tiles — selected primary

- Public instance: `https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf`
- No registration or API key.
- OpenFreeMap states that its public instance is free, permits commercial use, and currently has no map-view/request limit.
- Static CDN-style vector tiles are a better application dependency than running a database query for each moving user.
- OpenMapTiles exposes `transportation` and `building` layers. Its building schema can contain approximated `render_height` and `render_min_height` values.
- No SLA is offered, so the runtime cannot assume permanent availability.

Sources:

- [OpenFreeMap project and public-instance terms](https://openfreemap.org/)
- [OpenFreeMap tile URL/version documentation](https://github.com/hyperknot/openfreemap)
- [OpenMapTiles schema](https://openmaptiles.org/schema/)

### 2. OpenStreetMap Shortbread vector tiles — selected fallback

- Public endpoint: `https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt`
- No API key.
- Official OSMF service, currently max zoom 14.
- Lean schema has `streets` and `buildings`, but the building layer deliberately does not provide height. That is acceptable because this project permits stylized Z/height.
- OSMF requires attribution, caching, modest interactive use, valid browser referrers, and no bulk/offline scraping.
- Availability is best effort. The service recommends that the endpoint be configurable and that applications link to “Fix the map.”

Sources:

- [OSMF Shortbread TileJSON](https://vector.openstreetmap.org/shortbread_v1/tilejson.json)
- [Shortbread 1.1 schema](https://shortbread-tiles.org/schema/1.1/)
- [OSMF vector tile usage policy](https://operations.osmfoundation.org/policies/vector/)

### 3. Public Overpass API — not selected as the default runtime source

Overpass is excellent for prototypes and selective analysis, and this query would retrieve the basic data:

```overpass
[out:json][timeout:20];
(
  way["highway"](south,west,north,east);
  way["building"](south,west,north,east);
);
out geom(south,west,north,east);
```

However, the main public instance's current guidance says a regularly used app should stay around fewer than 100 queries and 10 MB per day in aggregate, cache/rate-limit requests, avoid parallel scripts, and not expect high reliability. That is not a viable production budget for every player's movement. A project-operated Overpass instance could be supported later, but that violates the current “no infrastructure” constraint.

Sources:

- [Overpass API and public-instance guidance](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [Overpass geometry output](https://dev.overpass-api.de/overpass-doc/en/full_data/osm_types.html)

### 4. Overture Maps PMTiles — strong future option, not MVP default

Overture publishes roads/buildings as open GeoParquet and browser-readable PMTiles on public object storage. PMTiles supports HTTP range requests, tile pyramids, and client-side loading without an API server. Overture's public visualization tiles are explicitly not described as a production-ready cartographic basemap, and adopting them adds PMTiles/MVT source-specific schema work. It is a good second provider or self-controlled release source after the MVP.

Source: [Overture PMTiles documentation](https://docs.overturemaps.org/examples/overture-tiles/)

## Legal and attribution requirements

OSM data is available under ODbL and is free of data license fees, but attribution is mandatory. The game view therefore permanently shows a nearby, legible link to OpenStreetMap copyright/ODbL information. OpenMapTiles schema attribution and OpenFreeMap hosting credit are also shown. The UI includes OSM's recommended “Fix the map” link.

If this project later publishes cached/compiled map databases, it must review ODbL derivative-database and share-alike obligations separately. Rendering a game view is not the same legal operation as redistributing a derived database.

Sources:

- [OSMF Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
- [OSMF License FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ)

## Scale and projection

- MVT source coordinates use Web Mercator XYZ tiles.
- The coordinate selected by the player becomes a local floating origin `(0, 0)`.
- Tile deltas are converted to approximate local ground metres using `cos(latitude)`.
- Horizontal map coordinates are multiplied by `0.1`: **10 real metres = 1 game unit**.
- Building footprints and road centerlines retain the vector-tile X/Z shape at that scale.
- Building height uses OpenMapTiles `render_height` when available; otherwise it is deterministic and stylized from footprint/feature identity.
- The avatar and travel speed are intentionally game-stylized; “1:10” is a horizontal world/footprint contract, not an exact human simulation contract.

Web Mercator distortion is negligible for the initial local exploration area. For travel across hundreds of kilometres, the world must periodically rebase the local origin and update the latitude scale.

## Chunk size decision

Both selected public sources currently expose detailed buildings at **zoom 14**. A z14 tile is approximately 2.45 km wide at the equator and roughly 2.0–2.3 km across much of India. This is larger than a strict 1 × 1 km source chunk, but it has useful advantages:

- one compressed binary request rather than many JSON records;
- CDN/browser caching;
- geometry already clipped and simplified;
- only gameplay-relevant roads, buildings, water, land cover, and label/decor source layers are decoded;
- all buildings in one tile are combined into one mesh;
- all roads, curbs, and markings in one tile are combined into one mesh;
- land and water each have one separately budgeted mesh, while deterministic details are instanced by type.

Requesting z15/z16 URLs does not create more detailed source data when the provider max zoom is 14. A strict 1 km network chunk requires a custom z15 tileset, a project proxy/cache, or Overpass. The MVP instead limits **resident tiles to four**, starts with one, and fetches neighbors only within 20% of an edge.

## Minecraft-inspired vegetation and ambient-life decision

Minecraft world generation combines seeded randomness with continuous, multi-octave noise so adjacent chunks remain coherent, then adds biome-specific features in later generation steps. The coordinate world applies that architecture to ambience rather than copying game code: a source-tile-stable three-octave value-noise field controls vegetation patches; a jittered global lattice supplies reproducible candidate points; mapped roads, water, and exact building polygons reject invalid candidates; and biome rules choose voxel herbs, grasses, flowers, shrubs, and trees. A separate lightweight feature step anchors small bird and bee populations to those plant patches.

The dense ground cover remains one instanced draw per visual family. Only a bounded set of bird/bee instances exists at all, and since `gdo:ambientLifeMotion:v1` their motion is evaluated entirely in the shared sprite vertex program from packed instance attributes rather than by rewriting matrices on the CPU, so a steady frame still adds no per-creature scene object, draw call, or matrix upload.

Sources:

- [Minecraft Wiki: seeded randomness, octave noise, chunks, and staged features](https://minecraft.wiki/w/World_generation)
- [Red Blob Games: octave noise and irregular tree-placement fields](https://www.redblobgames.com/maps/terrain-from-noise/)
- [Three.js InstancedMesh documentation](https://threejs.org/docs/#api/en/objects/InstancedMesh)

## Browser pipeline

```text
latitude/longitude
  → Web Mercator z14 tile address
  → fetch compressed MVT (HTTP cache enabled)
  → module Web Worker decodes PBF
  → generate one indexed road ribbon buffer
  → transfer road/curb/marking typed arrays to main thread
  → yield/cancellation point
  → triangulate map water and land-cover surfaces
  → derive biome; evaluate seeded octave vegetation fields on a jittered lattice
  → seed bounded trees, herbs, tall grass, birds, bees and street furniture
  → transfer context meshes, instanced decoration/life descriptors and map-derived labels
  → yield/cancellation point
  → triangulate and extrude building footprints
  → transfer one facade-shaded building buffer + compact broad-phase AABBs and exact polygon rings
  → Three.js mounts the phased tile with shared materials/resources
```

Procedural generation happens on the user's local machine. The server delivers only source vector data.

## Low-resource controls in the MVP

- No WebGL context before a landing choice.
- Coordinate mode dynamically imports its engine.
- 30 FPS target.
- `powerPreference: low-power`.
- No antialiasing, SSAO, PMREM, post-processing, or shadows.
- Device pixel ratio begins at 0.85 and can drop to 0.6 after sustained slow frames.
- Curated and coordinate modes share one renderer/scene/camera bootstrap, atmospheric sky, colour pipeline, lighting recipe, palette, water-normal generator, and teardown contract.
- Shared ground, road, land, animated-water, facade, and decoration materials are reused across resident tiles.
- One road draw, one facade draw, one land draw, one water draw, and at most twelve instanced detail-family draws per tile, regardless of feature count; absent families cost no draw.
- Geometry and MVT parsing run in a Worker.
- Roads are visibly committed first; map context is committed second; buildings remain the final worker phase.
- Maximum two simultaneous map requests.
- Maximum four resident tiles.
- Provider priority/URLs live in `public/map-providers.json`, so an operator can switch a disrupted service without rebuilding the JavaScript bundles.
- Hard safety caps: 14,000 road segments, 6,000 batched road-detail quads, 2,600 buildings, 180,000 generated building vertices, 1,100 low-poly ground-cover clusters, and 1,340 total decoration/life instances per source tile.
- Typed arrays are transferred, not copied.
- Coarse building collision is indexed into local grid cells.
- Mobile detection enables a flexible left-side analog joystick and translucent Run, Jump, and camera buttons; touch-drag on the remaining viewport controls looking.
- First-person is the default camera; `V`/`C` and the mobile camera action switch to the closer third-person view.
- The HUD tracks FPS, main-thread CPU time, worst frame gap, long tasks, draw calls, triangles, geometry count, download bytes, and worker tile-generation timing.
- Exit terminates the worker and disposes all CPU/GPU resources.

## Known limitations

1. The mapped surface is flat; no DEM/elevation source is used.
2. Building collisions use spatially indexed AABBs for the broad phase and exact mapped footprint rings for the narrow phase; complex vertical parts and roof shapes are intentionally excluded.
3. Building parts/holes are rendered, but complex OSM 3D roof semantics are not implemented.
4. Vector tiles can split a feature at a tile edge, producing an internal seam wall.
5. Provider availability cannot be guaranteed without project-operated hosting.
6. The source max zoom makes dense-city downloads larger than a custom 1 km tileset.
7. Safety caps can omit low-priority geometry/details in exceptionally dense tiles; the HUD reports truncation.
8. Map layer coverage varies by place and provider; unmapped areas intentionally fall back to a deterministic regional ground palette.
9. Long-distance travel eventually needs floating-origin rebasing and changing Mercator scale.

## Implemented checkpoint: bounded persistent tile cache (`MAP-09`)

Item 4 of the production evolution above is now implemented as `gdo:tileCache:v1`. The cache is a policy layer with a swappable byte-store adapter: Cache Storage for persistence where the browser allows it, and a bounded in-memory LRU everywhere else (private mode, refused quota, Node tests). Keys are `gdo:tileCache:v<n>:<provider>:<z>/<x>/<y>`, so provider identity and schema version are part of the key rather than extra metadata, and a schema bump invalidates every previous payload instead of trusting it.

Ceilings are explicit and per profile: 6 MiB/24 entries on low, 16 MiB/64 on balanced, 32 MiB/128 on high, one entry ≤ 3 MiB, and 4,096 prune checks per pass. An unknown or hostile profile name resolves to the low ceilings, so a bad argument can never widen storage. Every write trims least-recently-used records first, never evicts the tiles the player currently stands in (the world announces its resident set, bounded to four tiles, and the worker pins those keys in every provider key space), and reports which ceiling bound. TTL comes from provider cache semantics — `max-age`/`s-maxage`, `Expires` dates, `no-store`/`private` — bounded to one minute on the low end and fourteen days on the high end, with a six-hour fallback so a stale tile can never live forever.

Attribution is a storage precondition, not a label. A payload is only persisted when the provider that served it can still be credited, the credit text is stored with the record, and reopening a cache whose provider credit changed deletes those payloads rather than serving them under the wrong attribution. Payloads are validated by the real tile decoder *before* they are stored, so an HTML error body served with HTTP 200 falls through to the next provider and is never cached; a stored payload the decoder later refuses is invalidated on first read instead of being re-served. A storage that refuses to cooperate degrades to a plain network load.

Operators must declare `attribution` in `public/map-providers.json` for a provider to be cacheable; the shipped configuration does, and a provider that omits it is still used live but never persisted.

Automated evidence: `npm run check` passes 193 tests and the production build, with 8 cache-policy tests, 3 fetcher/retainer tests, and one world integration test proving that retention is announced once per resident-set change (never per frame), that the load request carries the profile, that phase-reported cache diagnostics reach the runtime stats, budget metrics, and debug snapshot, and that over-ceiling values fail the low-profile budget descriptively. A Node audit streamed 16 requests across 10 distinct 240 KiB tiles with 6 revisits through the production fetcher over a Cache-Storage-shaped adapter and measured **10 downloads and 6 cache hits** (2,457,600 bytes downloaded instead of 3,932,160), then streamed 40 distinct tiles under pressure: **24 resident entries, 5,898,240 bytes of the 6,291,456-byte ceiling, 16 evictions, zero over-ceiling writes, and 700 bounded prune checks**. An HTML error body was rejected and stored nothing, an uncredited provider was fetched but never persisted, a warm reopen kept all 24 entries, and a changed credit text purged all 24. These are deterministic Node measurements through the browser-shaped Cache Storage API, not a real-browser persistence or quota-eviction measurement.

## Recommended production evolution

1. Measure real tile byte/feature distributions across dense India, rural India, coast, and mountains.
2. Add a project-controlled, versioned provider configuration and health switch.
3. If usage grows, generate a custom PMTiles/MVT planet or India extract with exactly the required layers and z15 chunks.
4. Add Cache Storage/IndexedDB LRU with an explicit byte quota and provider cache semantics.
5. Add terrain elevation only through a free/public DEM source whose redistribution and request policy are suitable.
6. Extend the existing map-context phase with provider-compatible landmark categories and selectively richer furniture.
7. Split visual and collision LODs; use exact polygons only near the player.
8. Add floating-origin rebasing before supporting journeys beyond the local city area.

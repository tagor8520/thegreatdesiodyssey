# Canonical Feature Roadmap

**Roadmap version:** 1.0.0
**Established:** 2026-09-16
**Scope:** all implementation work synthesized from the repository audit and six research documents.
**Status authority:** this file records product/technical completion; [`CHANGELOG.md`](./CHANGELOG.md) records changes over time.

## 1. Purpose

This folder turns the repository's research into one build queue. It answers four questions:

1. What is already in the running source?
2. What is only partial or still missing?
3. What is the team actively building?
4. What must be built first because later features depend on it?

The source research remains authoritative for detailed algorithms, budgets, and acceptance tests. This document is the canonical place for **status, category, dependency, rank, and build order**.

## 2. Status legend

| Status | Meaning |
|---|---|
| **ADDED** | Present in the current runtime and covered by a repeatable check or direct source audit. |
| **PARTIAL** | A useful path exists, but one or more researched acceptance gates remain open. |
| **ACTIVE** | The current implementation lane; code or validation is being worked on now. |
| **QUEUED** | Approved and ordered, but no implementation slice is active. |
| **DEFERRED** | Intentionally postponed until its dependency/performance gate is met. |
| **REJECTED** | Researched but not accepted as a default architecture. |

A feature does not become **ADDED** merely because code was written. It must satisfy its listed test/build/lifecycle gate. Visual features additionally require the prescribed screenshot/movement audit when browser tooling is available.

## 3. Consolidated research index

| Source | What it contributes to this roadmap | Primary categories |
|---|---|---|
| [`PROJECT_AUDIT.md`](../PROJECT_AUDIT.md) | Current topology, lifecycle, scaling, draw-call and streaming risks, target architecture, contribution pipeline | Foundation, quality, content, networking |
| [`MAP_STREAMING_RESEARCH.md`](../MAP_STREAMING_RESEARCH.md) | Free map providers, attribution, Web Mercator/1:10 scale, zoom/chunk selection, roads-first browser pipeline | Map streaming, geographic truth |
| [`PROCEDURAL_WORLD_FEATURE_RESEARCH.md`](../PROCEDURAL_WORLD_FEATURE_RESEARCH.md) | Missing world-feature catalogue, generation graph, seed/map-truth contracts, broad implementation batches | Terrain, water, urban fabric, gameplay |
| [`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`](../VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md) | Continuous environmental influences, style bible, lighting, weather, composition, effects and global budgets | Biomes, rendering, atmosphere |
| [`MINIMAL_PHYSICS_RESEARCH.md`](../MINIMAL_PHYSICS_RESEARCH.md) | Collider roles, character motion, support/water interaction, optional ragdoll/rigid-body decision and physics budgets | Collision, movement, interactions |
| [`CLIPPING_AND_LAYERING_RESEARCH.md`](../CLIPPING_AND_LAYERING_RESEARCH.md) | Exact hitbox contracts, swept player/camera queries, semantic query/render/surface layers and placement correctness | Collision, camera, layering |
| [`PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md`](../PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md) | Generated texture catalogue, recursive vegetation, LOD/face compilation, wind, support slots and object grammars | Materials, vegetation, object detail |

## 4. Non-negotiable build invariants

Every stage must preserve these requirements:

1. Procedural generation and rendering execute locally in the browser.
2. Map data arrives in small bounded chunks from free/public, out-of-the-box sources with visible attribution and deterministic fallbacks.
3. Roads are generated and made navigable before buildings.
4. Neighbor chunks prefetch near a boundary and remain under explicit request/residency limits.
5. Coordinate horizontal scale remains approximately 1:10.
6. Mapped building horizontal footprints and source-tile ownership remain exact; approximate height is allowed.
7. First-person remains the default coordinate camera; TPP remains switchable.
8. Touch UI is device-gated, uses a flexible left joystick, exposes gameplay actions on the right, and remains approximately 20% opaque.
9. Visual boxes, particles, foliage, interaction triggers, broad-phase bounds, and placement clearances never become solid hitboxes implicitly.
10. Low-end/mobile budgets are ceilings shared across features, not independent allowances to stack.
11. A stable feature/seed version owns every deterministic output. Changes to palette or quality do not move authoritative objects.
12. When a feature exceeds a cap, it prunes/skips/falls back deterministically; it does not run unbounded work.

## 5. Task categories

| Prefix | Category | Owns |
|---|---|---|
| `FND` | Foundation and governance | runtime ownership, version contracts, feature registry, lifecycle, changelog |
| `QLT` | Quality and diagnostics | profiles, counters, deterministic tests, performance and visual audits |
| `MAP` | Map ingestion and streaming | providers, projection, worker stages, cache, ownership, schema normalization |
| `COL` | Collision, camera, and support | query roles, exact solids, sweeps, ground/step/water, dynamic proxies |
| `LAY` | Surface/render/query layering | elevation bands, bridge/tunnel levels, depth, transparency, label occlusion |
| `TER` | Terrain and hydrology | elevation, slope, geology, water classes, shorelines |
| `MAT` | Procedural materials | generated textures, shader masks, filtering, palette/style library |
| `VEG` | Vegetation and ecology | deterministic fields, fractal grammars, LOD, placement, wind |
| `DET` | Procedural object detail | buildings, roofs, facades, props, vehicles, bridges, landmarks |
| `ENV` | Lighting, atmosphere, and effects | sky/time/weather, fog, shadows, particles, audio |
| `LIF` | Ambient life and agents | birds, bees, people, traffic, bounded activity simulation |
| `GME` | Exploration and gameplay | controls, labels/map, discovery, interactions, missions, traversal modes |
| `PHY` | Optional physical interactions | pushables, projectiles, knockdown/ragdoll, breakables |
| `CNT` | Content pipeline | state schema, validators, landmark recipes, contributor tooling |
| `NET` | Persistence and multiplayer | saves, protocol, server authority, synchronization |

## 6. Current implementation snapshot

### Added and verified

- Shared procedural renderer primitives, color handling, generated water normal, quality profiles, lazy 3D landing path, and lifecycle-aware disposal.
- Coordinate validation, Web Mercator conversion, zoom-14 1:10 local scale, free-provider configuration, worker generation, road-first delivery, and capped boundary prefetch.
- Mapped roads, markings, curbs, land cover, water, place names, exact building rings, deterministic stylized heights, facade shader detail, parapets, and basic rooftop tanks.
- Exact packed-ring player collision after an AABB/grid broad phase, including concave footprint and hole tests.
- Deterministic basic vegetation/ground-cover placement, mapped obstacle rejection, rocks, parked cars, birds, and bees.
- FPP-default coordinate controls, switchable TPP, keyboard/pointer input, device-gated touch joystick/actions, and runtime performance counters.
- Network-free canonical dense/sparse/concave/hole/bridge/coast/provider fixtures, byte-stable remount/disposal checks, a toggleable query/layer/support debug overlay, and automated low-profile budget assertions.
- A versioned 175,852-byte shared material library supplies deterministic seamless noise, a guttered 24-layer semantic mask atlas, R8 dither, an sRGB palette LUT, and the water normal. Ground, road, facade, roof, bark, leaf, and water recipes reuse it without adding per-tile textures or voxel draw families.
- A versioned plant-skeleton IR compiles shared broadleaf, palm, shrub, herb, grass, and bamboo archetypes from independent keyed random channels under hard depth/node/envelope/retry/module caps. Placement records refer to archetype keys instead of triggering per-instance recursion.
- A separate versioned exposed-face compiler bakes oriented segment boxes and crown boxes into indexed typed upload arrays, strips connected caps/contained faces, merges compatible coplanar crown faces, packs palette/wind/detail attributes, and enforces per-archetype/cache limits without CSG or collision creation.
- A versioned near/mid/far compiler preserves each skeleton's pivot/envelope/bounds and family silhouette while reducing boxes monotonically. Individual projected width/height, profile hysteresis, stable reevaluation slots, focus-cell bypass, one-active-LOD selection, and owner-aware capped state are deterministic and tested.
- Coordinate plants now render from global resident family/LOD pools instead of tile-local plant meshes. Two low variants share each tier draw through paired vertex streams; source owner/stable ID, exact eviction/repack, custom palette/age/stiffness/phase attributes, post-usable-phase upload, one active LOD, context restoration, diagnostics, and hard resource caps are tested.
- Water polygons, waterways, shorelines, banks, and mapped wetlands now compile into a bounded transferable signed-distance/support domain. Its v2 schema normalizes provider aliases into unknown/stream/canal/river/lake/ocean classes, preserves directed mapped waterway tangents, associates bounded dominant flow with matching river/canal/stream polygons, keeps lake/ocean flow at zero, and carries class through adjacent shore/bank queries. Intersecting line ribbons are conservatively omitted from the transparent mesh while their class/flow/query truth remains available.
- The version-2 object grammar keeps ordinary mapped buildings on the shared analytical facade/parapet path while compiling a stable maximum-eight focus-tile subset into one visual-only detail batch. Exact roof slots produce stair heads, solar pairs, or vents; a bounded ground-road index selects outward road-facing entrance, canopy, cornice, balcony, and utility modules. Footprint-hashed selection, fixed scans/boxes/bytes/draw caps, focus-tile visibility, transfer, remount, and diagnostics are tested without changing mapped collision rings or creating implicit proxies.
- The version-1 street-furniture grammar compiles lamps, benches, bollards, bins, signs, shelters, and utility boxes through the same silhouette/surface/accent IR. Canonical ground-road tangents and normals place source-owned records outside carriageways while bounded reservations protect crossings/intersections, endpoints, building entrance belts, mapped water, spawn calm space, and prior ambience. Seven fixed geometries feed global owner pools with deterministic eviction/remount and no visual-derived collision, camera, interaction, or clearance proxies.
- Plant placement now uses family/role-specific declared base, root, and crown extents against exact building rings, route reservations, terrain support, water/shore domains, and mapped land kind. A bounded 16-sample policy can shrink and shift branch/crown organs through one custom instance attribute without moving source-owned anchors or creating geometry/collision proxies.
- A versioned continuous vegetation profile now blends tropical, subtropical, arid, upland, riparian, and urban influences from latitude, interpolated absolute-coordinate macro fields, terrain, mapped land/water, and bounded road/building proximity. Each aligned plant record retains quantized dominant-three IDs/weights plus bounded aspect, variant, palette, age, and stiffness controls; geometry stays in one fixed two-variant-per-family cache, including bamboo, and focus-ground colour transitions are smoothed.
- A versioned shared whole-plant wind field now deforms those resident pools in the vertex shader. World-aligned direction, low-frequency smoothed gust/turbulence, per-vertex height/bend/root roles, and per-instance stable phase/stiffness produce bounded coherent sway without touching placement, collision, support, ownership, clearances, or instance matrices. Reduced motion removes gust/turbulence and caps the remaining calm sway; one clock uniform write, zero wind matrix updates, and zero steady-frame wind allocations are low-profile gates.
- Elevated transport grades now receive `gdo:bridgeGrammar:v1` detail compiled from the canonical physical-level deck rather than from provider feature order. Rail lines, rail posts, deck fascia, end/joint bands, terrain-reaching piers, and sparse non-solid lamps/signs render from seven fixed family geometries in one owner-scoped pool. Rails are only emitted when the resulting walkable corridor still fits the authoritative player profile, piers exist only where a real measured opening under the deck can hold them, and bridge detail exposes empty solid, interaction, and camera proxy lists.
- Mapped landmark footprints now compile through a versioned `gdo:landmarkGrammar:v1` grammar over `DET-02`. The largest eligible footprint on a tile is promoted to one hero: plinth/piers/lintel/tier masses are carved around the reserved mapped-hole, arch/door, and viewing-corridor voids, and repeated voussoirs, colonnades, crenellations, dome ribs, and finials come from bounded spacing loops that are admitted or pruned whole. The compiled hero is hidden-face reduced into one visual-only merged mesh per tile, the mapped shell's extruded geometry and single enclosing collider are removed in place, and one tight AABB per load-bearing module replaces them, so arches and doors stay walkable while ornament never earns collision.
- Coordinate birds and bees now render as pooled flat sprites whose entire motion runs in one shared vertex program. Ten-triangle flat silhouettes of coplanar quads replace the former 144-triangle 3D bodies; position, elongated non-looping travel, bounded lateral weave, climb/hover, wing flap, appearance envelope, and camera-distance fade come from per-instance attributes, so a steady frame writes one clock uniform and zero matrices. Agents fade in and out of a deterministic per-cycle window with a dormant gap instead of orbiting forever, stay visual-only with no collision surface, and release their cloned geometry on eviction under fixed per-family and owner caps.
- A versioned `gdo:tileCache:v1` persistent cache now sits in front of map streaming. Cache Storage is used where the browser allows it and a bounded in-memory LRU everywhere else, keys carry provider identity and schema version, and per-profile ceilings (6 MiB/24 on low) plus a 3 MiB per-entry limit are enforced by least-recently-used trims that never evict the four resident tiles the world pins. Provider lifetime comes from bounded `Cache-Control`/`Expires` semantics, and a payload is only stored once the real decoder accepts it and the serving provider can still be credited; a credit change or a schema bump purges instead of serving stale bytes.
- Curated streaming/quality/draw-call improvements and shared engine ownership.

### Partial

- Curated and coordinate modes share a runtime surface and visual primitives but still have separate world-generation/player/content implementations.
- Coordinate collision has exact static footprints, tight continuous player sweep/slide, bounded depenetration, semantic masks, packed building spans, and grid-bounded terrain/road/bridge/tunnel support with deterministic step/drop/slope rules.
- Coordinate and curated TPP use near-plane-aware continuous obstruction with fast inward/slow outward response; curated bridges, landmarks, signs, skyline towers, and railway masses now have tight proxies, while moving visual audits remain open.
- Water, terrain, roads, and labels use central semantic descriptors; provider bridge/tunnel/numeric levels resolve to distinct physical grades, and same-grade road joins/crossings receive bounded deterministic merge patches. Transparent-water moving validation remains open.
- Coordinate terrain now uses a seam-free 33×33 deterministic fallback grid per resident tile. The same height/normal query grounds terrain, roads, buildings, land cover, details, labels, player steps, and camera clearance; optional public DEM enrichment remains deferred.
- Material mips, derivative-filtered facade/style edges, uniform-controlled distance/profile fades, and normal-first fading are implemented in both modes; moving low-pixel-ratio shimmer capture remains open.
- Ambient life is now deterministic, GPU-driven, flat, and pooled, but it has no explicit screen-space or activity scheduler beyond per-cycle appearance windows, camera-distance fade, and per-family/owner caps; the `COL-09` capped dynamic hash it would consume is still queued.

### Active now

- `COL-05`: moving visual validation of the new coordinate TPP obstruction sweep.
- `LAY-03`: transparent-water order and low-profile moving visual validation.
- `LIF-02`: explicit screen-space/activity scheduler budgets on top of the landed ambient pools; its `COL-09` capped dynamic hash is still queued, and moving bird/bee composition still needs capture tooling.
- `DET-09`: moving landmark/arch/colonnade composition capture; its grammar, opening, compound, pool, and collision gates are landed.

## 7. Canonical dependency chain

```text
FND governance + QLT baseline
              ↓
MAP truth/version contracts
              ↓
COL role/query contracts ──→ swept player ──→ swept camera/support
              ↓                         ↓
LAY semantic levels/depth ──────────────┘
              ↓
TER elevation/hydrology topology
              ↓
MAT generated material library
              ↓
VEG grammar/LOD/ecology ──→ DET support-slot object grammars
              ↓                         ↓
ENV weather/water polish ───────────────┘
              ↓
LIF bounded agents
              ↓
GME exploration systems
              ↓
PHY optional interactions
              ↓
CNT scalable authoring ──→ NET persistence/multiplayer
```

Why this order:

- Traversal, camera, and semantic levels must be trustworthy before adding denser geometry.
- Terrain/support height must exist before plants, props, roads, and water can conform to it.
- Material and batching contracts must exist before many new families create shader/draw-call fragmentation.
- Vegetation/object compilers need support slots, clearances, tile ownership, LOD, and diagnostics first.
- Ambient agents and gameplay depend on stable traversable surfaces and spatial queries.
- Optional rigid-body features and multiplayer are last because they multiply simulation, authority, and determinism costs.

## 8. Canonical feature matrix

`Order` is the canonical implementation rank, not a promise that every lower-ranked optional item ships. `P0` protects architecture/correctness; `P1` provides the core world; `P2` adds depth; `P3` is optional/late.

### Stage 0 — baseline and governance

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 001 | FND-01 | P0 | One test/build command | ADDED | — | `npm run check` passes tests and production build |
| 002 | FND-02 | P0 | Shared renderer/scene/camera ownership | ADDED | FND-01 | Both current modes mount/dispose through `ProceduralEngine` |
| 003 | FND-03 | P0 | Lazy landing and mode selection | ADDED | FND-02 | Initial shell does not load WebGL world until selected |
| 004 | FND-04 | P0 | Low/balanced/high quality profiles | ADDED | FND-02 | Deterministic URL override and constrained auto-profile tests |
| 005 | FND-05 | P0 | Canonical roadmap and changelog | ADDED | FND-01 | Matrix, dependencies, ownership, and dated change entries maintained |
| 006 | FND-06 | P0 | Feature/schema/seed version registry | ADDED | FND-05 | Versioned namespaces cover tile, collision, materials, grammars, content and saves |
| 007 | FND-07 | P0 | Shared lifecycle/disposal contract | PARTIAL | FND-02 | All workers, observers, textures, geometries and listeners prove zero-growth remount |
| 008 | FND-08 | P1 | Curated/coordinate domain interface | PARTIAL | FND-06,FND-07 | Shared world/player/query interfaces without forcing one visual scale |

### Stage 1 — diagnostics and geographic truth

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 010 | QLT-01 | P0 | Runtime FPS/CPU/draw/triangle counters | ADDED | FND-02 | Coordinate and curated counters visible without allocations/spam |
| 011 | QLT-02 | P0 | Determinism and lifecycle test fixtures | ADDED | FND-01,FND-06 | All canonical typed outputs remount byte-equivalent; tile geometry/worker ownership is released and tested |
| 012 | QLT-03 | P0 | Canonical fixture tile matrix | ADDED | QLT-02 | Network-free dense/sparse/concave/hole/bridge/coast and equivalent-provider fixtures compile through production builders |
| 013 | QLT-04 | P0 | Query/layer/LOD debug overlay | ADDED | COL-01,LAY-01 | Debug/F3 toggles one capped line batch plus bounds, masks, owners, support, LOD, timings and budget status |
| 014 | QLT-05 | P0 | Automated low-profile budget assertions | ADDED | QLT-01,QLT-03 | Fixture output passes applicable ceilings; every named memory/draw/triangle/query/worker/request/residency breach fails descriptively |
| 015 | QLT-06 | P1 | TPP/FPP visual audit capture matrix | DEFERRED | COL-05,TER-04,MAT-03 | Moving screenshots/video at urban, rural, coast, wetland, mountain, arid locations |
| 020 | MAP-01 | P0 | Coordinate validation and Web Mercator | ADDED | FND-01 | Round-trip and unsafe-coordinate tests |
| 021 | MAP-02 | P0 | Approximately 1:10 zoom-14 tile scale | ADDED | MAP-01 | Latitude-adjusted tile-size tests |
| 022 | MAP-03 | P0 | Free provider list, fallback, attribution | ADDED | MAP-01 | No API key; visible attribution; bounded retry |
| 023 | MAP-04 | P0 | Worker decoding and compact typed arrays | ADDED | MAP-02,MAP-03 | Browser worker generates transferable geometry under caps |
| 024 | MAP-05 | P0 | Roads-first phased generation | ADDED | MAP-04 | Road phase mounts before context/buildings |
| 025 | MAP-06 | P0 | Boundary-directed lazy neighbor loading | ADDED | MAP-05 | ≤4 resident tiles, ≤2 active requests, cancellation tests |
| 026 | MAP-07 | P0 | Half-open source-tile ownership | ADDED | MAP-04 | Regeneration across eviction has no duplicate transform records |
| 027 | MAP-08 | P0 | Normalized provider feature schema | PARTIAL | MAP-03,MAP-04 | One semantic map adapter covers OpenMapTiles and Shortbread classes/levels |
| 028 | MAP-09 | P1 | Bounded persistent tile cache | ADDED | MAP-06,FND-06 | Versioned Cache-Storage/memory adapter with per-profile byte/entry ceilings, LRU plus resident-set pinning, bounded provider TTL, refusal of uncredited or undecodable payloads, and a cache-first fetch path |
| 029 | MAP-10 | P2 | Overture/PMTiles production option | DEFERRED | MAP-08,MAP-09 | Only after hosting/range-request operational decision |

### Stage 2 — collision, camera, and semantic layering

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 030 | COL-01 | P0 | Role-specific query-mask contract | ADDED | FND-06,MAP-08 | Solid/support/camera/fade/LOS/interaction/placement roles are explicit and tested |
| 031 | COL-02 | P0 | Exact mapped static footprint query | ADDED | MAP-07 | Packed rings/holes remain authoritative after grid broad phase |
| 032 | COL-03 | P0 | Tight swept coordinate-player motion | ADDED | COL-02 | `.058` total profile, sweep/slide, bounded depenetration and counters pass tests |
| 033 | COL-04 | P0 | Packed building vertical spans | ADDED | COL-01,COL-02 | Base/top and mask transfer align 1:1 with footprint polygons |
| 034 | COL-05 | P0 | Near-plane-derived TPP camera sweep | ACTIVE | COL-03,COL-04 | Algorithm/response tests pass; moving visual audit remains |
| 035 | COL-06 | P0 | Curated camera structure obstruction | PARTIAL | COL-01,COL-05,FND-08 | All current static bridge/landmark/sign/skyline/rail masses have tight tested compounds; moving audit remains |
| 036 | COL-07 | P0 | Shared support/ground/step/slope query | ADDED | COL-01,COL-03,TER-03 | Terrain/road/bridge levels, normals, grounding, steps, drops and slope rejection are deterministic and grid-bounded |
| 037 | COL-08 | P1 | Water/swim/fall support semantics | QUEUED | COL-07,TER-05 | Surface/depth/exit rules in both modes |
| 038 | COL-09 | P1 | Capped dynamic spatial hash | QUEUED | COL-01,QLT-05 | 64/128/256 profile caps; primitive-only dynamic proxies |
| 039 | COL-10 | P1 | Placement/support-domain query | ADDED | COL-01,LAY-01 | Exact insets, role/size checks, 2,048-slot tile cap, occupancy and prune/skip fallback tested |
| 040 | LAY-01 | P0 | Semantic generation/surface/query descriptor | ADDED | COL-01,MAP-08 | Generation stages, surface elevations, render bands, depth policy and masks centralized |
| 041 | LAY-02 | P0 | Grade/bridge/tunnel level resolution | ADDED | LAY-01 | Provider levels stay physically separate; same-grade joins/crossings get ≤1,200 deterministic merge patches |
| 042 | LAY-03 | P0 | Opaque/transparent render policy | ACTIVE | LAY-01,QLT-05 | Bounded Three sorting/render bands added; moving water audit remains |
| 043 | LAY-04 | P0 | Water polygon/waterway overlap removal | ADDED | MAP-08,LAY-03 | Intersecting waterway ribbons are conservatively suppressed against exact mapped water polygons; query domains retain the hidden waterway |
| 044 | LAY-05 | P1 | DOM label line-of-sight | QUEUED | COL-04,COL-01 | Sparse capped LOS hides labels behind blockers |
| 045 | LAY-06 | P1 | Camera-fade eligibility/dither | DEFERRED | COL-05,MAT-02 | Opaque/alpha-tested screen-door fade; no broad blended foliage |

### Stage 3 — terrain, hydrology, and core mapped world

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 050 | TER-01 | P1 | Mapped land/water/building/place extraction | ADDED | MAP-08 | Both provider schemas produce bounded surfaces/names |
| 051 | TER-02 | P1 | Roads, widths, markings, curbs, crossings | ADDED | MAP-05 | Batched readable road geometry under detail cap |
| 052 | TER-03 | P0 | Deterministic terrain-height field | ADDED | MAP-07,FND-06 | Seeded 33×33 tile grids share exact border samples and expose height/normal at any coordinate |
| 053 | TER-04 | P1 | Optional public elevation enrichment | DEFERRED | TER-03,MAP-09 | Cached bounded request with deterministic fallback; no hard dependency |
| 054 | TER-05 | P0 | Road/building/water terrain conformance | ADDED | TER-03,LAY-01,COL-07 | Roads/land/details drape, buildings use terrain foundations, and fallback terrain stays below water datum |
| 055 | TER-06 | P1 | Slope/cliff/terrace geology | QUEUED | TER-03,TER-05 | Morphology and collision agree; projected detail budget passes |
| 056 | TER-07 | P1 | Shoreline/bank/wetland domains | ADDED | TER-03,TER-05,LAY-04 | Versioned bounded polygon/waterway fields expose signed water distance, shore/bank/wetland class, support, bounds, caps, and transferable ownership |
| 057 | TER-08 | P1 | Water class and flow-direction fields | ADDED | MAP-08,TER-07 | Provider-neutral stream/canal/river/lake/ocean classes, mapped line/associated polygon flow, still-water zero flow, compact v2 transfer, malformed fallback, association/byte caps, lifecycle, fixtures, and diagnostics pass |
| 058 | TER-09 | P2 | Rail/transit/airport geometry families | QUEUED | MAP-08,LAY-02,TER-05 | Semantic transport styles and crossings under cap |
| 059 | TER-10 | P2 | Walls, barriers and entrances | QUEUED | MAP-08,COL-01,COL-10 | Exact compounds preserve gates/openings |

### Stage 4 — procedural material foundation

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 060 | MAT-01 | P1 | Existing shader palette/hash/water normal | ADDED | FND-02 | Deterministic generated water normal and bounded material families |
| 061 | MAT-02 | P0 | Shared tiny generated texture library | ADDED | FND-06,QLT-05 | Deterministic noise/mask/dither/LUT/water library is shared, reference-counted, seam/checksum tested, and 175,852 bytes incl. mips |
| 062 | MAT-03 | P0 | Mip/distance/derivative anti-alias policy | PARTIAL | MAT-02 | Mip/filter, derivative-edge, distance/profile, and normal-first fade tests pass; moving low-pixel-ratio shimmer capture remains |
| 063 | MAT-04 | P1 | Style/material semantic library | ADDED | MAT-02,LAY-01 | Ground/road/facade/roof/bark/leaf/water recipes share palette/masks without per-tile textures or extra voxel families |
| 064 | MAT-05 | P1 | Surface detail catalogue rollout | QUEUED | MAT-03,MAT-04,TER-07 | Prioritized generated patterns; no downloaded baseline textures |
| 065 | MAT-06 | P2 | Bounded generated sign atlas/LRU | DEFERRED | MAT-02,LAY-05 | Only if 3D signs beat existing DOM labels within memory cap |

### Stage 5 — vegetation and ecology compiler

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 070 | VEG-01 | P1 | Deterministic biome-aware placement fields | ADDED | MAP-07,TER-01 | Octave field/jittered lattice reproduces across eviction |
| 071 | VEG-02 | P1 | Existing trees/palms/shrubs/herbs/grass | PARTIAL | VEG-01 | Basic pooled templates exist; silhouette/LOD costs remain open |
| 072 | VEG-03 | P0 | Plant skeleton/grammar IR | ADDED | FND-06,MAT-04,COL-10 | Six versioned families, keyed channels, shared archetype cache/placement references, and depth/node/envelope/retry/module caps are deterministic and tested |
| 073 | VEG-04 | P0 | Exposed-face small-box compiler | ADDED | VEG-03,QLT-05 | Versioned typed geometry bakes oriented segments, removes connected caps/contained crown faces, merges compatible coplanar faces, and stays within upload/cache caps without runtime CSG |
| 074 | VEG-05 | P0 | Near/mid/far archetype LOD compiler | ADDED | VEG-03,VEG-04 | One skeleton yields family-capped monotonic geometries with stable pivot/envelope/bounds, individual projected-size thresholds, hysteresis, staggered capped selection, and deterministic remount |
| 075 | VEG-06 | P0 | Resident family/LOD batch pools | ADDED | VEG-05,MAP-07 | Global paired-variant family/LOD pools keep stable owner/placement IDs, exact deterministic eviction/repack, custom palette/trait attributes, one active LOD, deferred upload, context lifecycle, and bounded draw/geometry/triangle costs |
| 076 | VEG-07 | P1 | Role-specific ecological clearances | ADDED | COL-10,TER-07,VEG-03 | Actual base/root/crown extents, exact rings, route/water/support/land domains, bounded 16-sample crown adaptation, diagnostics, and GPU branch/crown transforms replace the universal halo |
| 077 | VEG-08 | P1 | Continuous biome morphology variants | ADDED | TER-03,TER-07,VEG-05 | Absolute macro fields and mapped terrain/water/land/human modifiers blend six artistic influences; dominant-three quantization, bounded morphology traits, fixed shared recipes, provider equivalence, seam continuity, remount, malformed-input, and low-budget gates pass |
| 078 | VEG-09 | P1 | GPU whole-plant wind | ADDED | VEG-05,MAT-04 | Versioned shared world-aligned field, smoothed gust/turbulence, height/bend and stable instance phase/stiffness response, fixed roots, culling margin, reduced-motion fallback, lifecycle/diagnostics, and one-uniform/zero-matrix/zero-allocation low gates pass |
| 079 | VEG-10 | P2 | Branch-group/detail wind | DEFERRED | VEG-09,QLT-05 | Up to four coherent phase groups; reduced-motion gate |
| 080 | VEG-11 | P2 | Optional cached space-colonized archetypes | DEFERRED | VEG-05,QLT-05 | Shared archetypes only; never per-tree runtime search |

### Stage 6 — procedural object detail

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 090 | DET-01 | P1 | Existing facade/parapet/tank detail | ADDED | TER-01,MAT-01 | Batched facade/parapet detail and exact-support recipe-driven roof tanks pass footprint tests |
| 091 | DET-02 | P0 | Object recipe and support-slot IR | ADDED | COL-10,LAY-01,FND-06 | Versioned IR separates silhouette/surface/accent visuals from solid/interaction/camera proxies under hard budgets |
| 092 | DET-03 | P0 | Concave/hole-safe roof slot resolver | ADDED | DET-02,COL-10 | Exact edge/hole tests and inset slots now own every generated roof-tank anchor |
| 093 | DET-04 | P1 | Building/roof/facade grammar | ADDED | DET-02,DET-03,MAT-04 | Ordinary shader facades remain default; a footprint-stable maximum-eight focus-tile subset gets one visual-only road-facing facade/roof batch under slot, scan, box, triangle, byte, draw, transfer, remount, and collision-isolation gates |
| 094 | DET-05 | P1 | Street-furniture grammar | ADDED | DET-02,TER-02 | Seven visual-only DET-02 families use canonical ground-road frames, bounded crossing/entrance/water/spawn/ambience reservations, source ownership, global fixed-geometry pools, deterministic transfer/remount, collision isolation, and explicit entry/test/triangle/GPU/draw/byte gates |
| 095 | DET-06 | P1 | Rocks/geology grammar | QUEUED | DET-02,TER-06 | Major-mass proxies only; small chips visual |
| 096 | DET-07 | P1 | Vehicle grammar and tight proxy | QUEUED | DET-02,COL-09,TER-02 | Wheels/mirrors/lights cannot expand body collision |
| 097 | DET-08 | P1 | Bridge grammar and compounds | ADDED | DET-02,LAY-02,COL-07 | Seven fixed deck/rail/pier families compile from the physical-level deck; rails leave the player corridor clear, piers reach measured terrain support, and moving visual validation still needs capture tooling |
| 098 | DET-09 | P2 | Landmark grammar and openings | ADDED | DET-02,DET-04,QLT-05 | Repeated tiers/columns/voussoirs/crenellations/ribs/finials compile from bounded loops into one merged hidden-face batch replacing the mapped shell; arch/door voids stay genuinely walkable and no compound is one enclosing AABB |
| 099 | DET-10 | P2 | Prop/food grammar and triggers | QUEUED | DET-02,COL-01,GME-05 | Interaction range remains separate from solid proxy |

### Stage 7 — atmosphere, effects, and living world

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 110 | ENV-01 | P1 | Shared sky/light/fog baseline | ADDED | FND-02 | Both modes share color/lighting primitives and disposal |
| 111 | ENV-02 | P1 | Time-of-day light/sky state | QUEUED | MAT-04,QLT-05 | Bounded uniform updates, readable night, no per-frame allocation |
| 112 | ENV-03 | P1 | Water visual classes | QUEUED | TER-08,MAT-04,LAY-03 | Opaque/one-family low path and bounded blended higher path |
| 113 | ENV-04 | P1 | Weather state machine | QUEUED | ENV-02,TER-07 | Deterministic transitions, environment response, low-profile fallback |
| 114 | ENV-05 | P1 | Bounded weather/shore effects | QUEUED | ENV-03,ENV-04,MAT-03 | Alpha-test/dither, strict screen/overdraw counts |
| 115 | ENV-06 | P2 | Procedural ambient audio zones | QUEUED | TER-07,ENV-04 | Browser-generated/packaged legal audio with distance/activity caps |
| 116 | ENV-07 | P2 | Optional AO/contact-depth benchmark | DEFERRED | QLT-05,MAT-04 | Only if low/balanced GPU budget proves value |
| 120 | LIF-01 | P1 | Existing deterministic birds and bees | ADDED | VEG-01 | Bounded flat sprites appear/disappear on deterministic per-cycle windows; no CPU transforms |
| 121 | LIF-02 | P1 | Ambient-life scheduler and pools | PARTIAL | COL-09,VEG-07,QLT-05 | Owner-scoped bounded pools, distance fade, and per-cycle activity windows exist; explicit screen-space scheduling and the `COL-09` hash remain |
| 122 | LIF-03 | P1 | GPU bird/insect group motion | ADDED | LIF-02,MAT-04 | Zero CPU matrix rewrite for far ambience; one clock uniform per steady frame |
| 123 | LIF-04 | P2 | Bounded pedestrians | QUEUED | LIF-02,TER-05,GME-03 | Route graph, despawn/reuse, no dense global simulation |
| 124 | LIF-05 | P2 | Bounded traffic/boats | QUEUED | LIF-02,DET-07,TER-08 | Coarse path movement and capped dynamic proxies |

### Stage 8 — exploration and gameplay

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 130 | GME-01 | P0 | Desktop movement/look/jump/run | ADDED | COL-02 | Normalized input, frame-rate tests, blur reset |
| 131 | GME-02 | P0 | FPP-default and switchable TPP | ADDED | GME-01 | Keyboard and touch camera controls |
| 132 | GME-03 | P0 | Device-gated complete touch controls | PARTIAL | GME-01 | Current movement/run/jump/camera added; future actions must auto-register |
| 133 | GME-04 | P1 | Place labels and coordinate HUD | PARTIAL | TER-01 | Added projection/overlap; LOS and richer map remain open |
| 134 | GME-05 | P1 | Shared interaction/action registry | QUEUED | COL-01,FND-08 | Desktop/touch/UI expose every registered gameplay action |
| 135 | GME-06 | P1 | Discovery journal/visited places | QUEUED | GME-04,GME-05,FND-06 | Deterministic place IDs and bounded local state |
| 136 | GME-07 | P1 | Coordinate minimap/navigation | QUEUED | MAP-08,GME-04 | Lightweight map-derived guidance without duplicate world renderer |
| 137 | GME-08 | P2 | Procedural local activities/missions | QUEUED | GME-06,DET-10,LIF-02 | Reproducible objectives from real place/road/land context |
| 138 | GME-09 | P2 | Swimming/boat traversal | QUEUED | COL-08,TER-08,GME-05 | Enter/exit/support/camera rules and touch action |
| 139 | GME-10 | P2 | Accessibility/remapping/reduced motion | QUEUED | GME-05,VEG-09,ENV-04 | Keyboard/touch mapping, motion/effect settings persist |

### Stage 9 — optional physics, content, and network scale

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 150 | PHY-01 | P2 | Simple query-driven doors/gates | QUEUED | COL-09,GME-05,DET-04 | Bounded kinematic proxy; no full engine required |
| 151 | PHY-02 | P2 | Capped pushables/projectiles | DEFERRED | COL-09,QLT-05 | Fixed step and sleeping pool prove budget |
| 152 | PHY-03 | P3 | Pose-fall knockdown | DEFERRED | GME-05,QLT-05 | Visual/state-machine baseline before rigid bodies |
| 153 | PHY-04 | P3 | Small PBD puppet benchmark | DEFERRED | PHY-03 | 6–10 particles, bounded constraints, low profile may disable |
| 154 | PHY-05 | P3 | Lazy true-ragdoll engine benchmark | DEFERRED | PHY-03,QLT-05 | Only after measured comparison; static map remains query-driven |
| 155 | PHY-06 | P3 | Breakable props/rope/flags | DEFERRED | PHY-02,DET-10 | Strict island/pool budgets and deterministic reset |
| 160 | CNT-01 | P1 | Versioned state-content schema | QUEUED | FND-06,FND-08,DET-02 | Current experimental JSON gains schema, validation and migration |
| 161 | CNT-02 | P1 | State/landmark recipe compiler | QUEUED | CNT-01,DET-09 | No contributor-authored Three.js required for supported modules |
| 162 | CNT-03 | P1 | Content validation/preview tool | QUEUED | CNT-01,CNT-02,QLT-03 | Bounds, budgets, attribution, openings and determinism checks |
| 163 | CNT-04 | P2 | More state/landmark packs | QUEUED | CNT-02,CNT-03 | Added only through validated pipeline |
| 170 | NET-01 | P2 | Versioned local save | QUEUED | FND-06,GME-06,CNT-01 | Migration-safe settings/discovery/progress |
| 171 | NET-02 | P3 | Multiplayer protocol decision | DEFERRED | NET-01,COL-09 | Authority, interest management, IDs and abuse model documented |
| 172 | NET-03 | P3 | Spatial interest management | DEFERRED | NET-02,MAP-07 | Synchronize local neighborhood, never global world |
| 173 | NET-04 | P3 | Multiplayer avatars/interactions | DEFERRED | NET-03,GME-05 | Capped interpolation, disconnect cleanup, no procedural geometry transfer |

## 9. Rejected default paths

These remain documented so they are not accidentally reintroduced:

- per-box `Mesh`, material, collider, event listener, or timer;
- one rigid-body collider per map feature or decorative voxel;
- runtime CSG for procedural attachments or plants;
- dense transparent foliage/weather and unsorted overlapping water;
- full 3D WFC, volumetric cloud raymarching, sampled atmosphere, universal SSAO, or global high-agent simulation on the baseline;
- unbounded Overpass as the streaming backend;
- downloaded high-resolution textures as a substitute for the generated material library;
- arbitrary building AABBs as authoritative narrow-phase collision;
- `renderer.sortObjects = false` while expecting `renderOrder` to establish water order;
- optional elevation/climate/network providers without deterministic local fallbacks;
- multiplayer or ragdoll integration before fixed budgets, IDs, and query contracts.

## 10. Work-in-progress limits

To prevent half-built systems from accumulating:

- At most **one P0 foundation/correctness epic** is `ACTIVE` at a time.
- At most **one independent P1 content/visual epic** may run beside it.
- A feature slice must include tests, lifecycle handling, diagnostics, budget impact, changelog entry, and documentation update before the next dependency starts.
- If blocked, mark it `PARTIAL` with a concrete open gate; do not call it done.
- New ideas enter this matrix with an ID and dependencies before implementation.

Current WIP: moving visual completion gates for `COL-05`, `COL-06`, `LAY-03`, and `MAT-03` remain blocked on capture tooling. The deterministic `VEG-03` → `VEG-09` vegetation stack, `TER-07` → `TER-08` hydrology field, and `DET-01` → `DET-05` mapped-building/street-furniture detail stack are implemented. `MAT-05` remains ordered after the blocked `MAT-03` visual gate; `DET-06` and `DET-07` still wait on `TER-06` and `COL-09`, respectively. `DET-08` bridge deck/rail/pier modules and tight structural compounds are implemented, and `DET-09` now compiles repeated landmark modules plus exact opening compounds that never enclose an arch in one AABB; its moving landmark-composition capture stays open with the other capture gates. `MAP-09` adds the bounded persistent tile cache with LRU/TTL and attribution-safe storage. `VEG-10` detail/branch-group wind remains intentionally deferred.

## 11. Definition of done

Every completed feature must prove:

1. **Correctness:** deterministic unit/fixture tests and no regression in exact map ownership/traversal.
2. **Lifecycle:** cancellation, tile eviction, remount, and disposal leave no owned listeners/workers/GPU resources.
3. **Performance:** it fits the relevant low/balanced/high ceilings without borrowing an undocumented budget.
4. **Fallback:** missing map/provider/device capability produces a bounded deterministic result.
5. **Controls:** any action is accessible on desktop and eligible touch UI.
6. **Visual quality:** where applicable, moving FPP/TPP captures show no unacceptable clipping, popping, shimmer, depth-order error, or repetitive failure.
7. **Documentation:** matrix status and [`CHANGELOG.md`](./CHANGELOG.md) are updated in the same change.

## 12. Next five canonical slices

1. Complete moving visual gates for `COL-05`, `COL-06`, and `LAY-03` when capture tooling is available.
2. Complete `MAT-03` with moving low-pixel-ratio road/ground/facade/water shimmer captures; its automated shader policy is already present.
3. Add `MAT-05`: extend the shared style library with bounded generated regional surface-detail recipes after `MAT-03` closes.
4. Add `COL-08` water/swim/fall support semantics: the next dependency-complete slice now that `TER-05`, `TER-07`, and `TER-08` are landed. `DET-10` prop/food modules still wait on the queued `GME-05` interaction registry.
5. Complete the moving FPP/TPP captures for `DET-08` bridge composition plus pier/deck pop and for `DET-09` landmark/arch/colonnade composition alongside the pending obstruction, transparent-water, and shimmer gates.

The completed fixture and budget gates must run against every later material, vegetation, object, and environment batch.

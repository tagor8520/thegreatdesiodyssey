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

A feature does not become **ADDED** merely because code was written. It must satisfy its listed test/build/lifecycle gate. A visual or moving feature is proved by the **deterministic programmatic audits** below, never by browser capture: automated Chromium installation, screenshots, and video are **not** project dependencies and must not gate any status.

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
13. Every claim is verified programmatically: deterministic unit/fixture tests, a scripted audit over real state, and readable debug hooks/loggers. Browser capture tooling is retired and is never a blocker.

### 4.1 Programmatic verification policy (retires the capture gate)

Video/screenshot capture was the last gate that could not run in this environment. It is now **deleted as a dependency**, and the evidence it used to provide is produced by three deterministic surfaces instead:

| Surface | Owns | Where |
|---|---|---|
| Lifecycle ledger | live/released counts per kind, zero-growth remount proof, leak naming | `src/engine/LifecycleContract.js`, `runLifecycleAudit` |
| Movement audit | clipping, render-band ordering, LOD churn, subpixel/mip/fade, step stability, resident churn, determinism | `src/engine/MovementAudit.js`, `runMovementAudit` |
| Debug hooks and logger | `window.__gdo` probe/step/audit entry points plus a bounded `[gdo:*]` log ring | `src/engine/DebugHooks.js` |

A moving feature is accepted when the scripted audit records the numeric state a reviewer used to look for in a video — camera clearance against real blockers, live render orders and transparency flags, per-family LOD selection, a CPU mirror of the derivative fade, and per-step continuity — and the report's verdicts pass on the real runtime. Historical checkpoint notes in the research docs that say "capture unavailable" are kept as history, not as open gates.

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
- Ambient life is now scheduled in screen space instead of merely pooled. `gdo:ambientLifeScheduler:v1` offers every resident sprite once per frame and draws it only when it is in front of the camera and inside the frustum margin, projects to enough pixels to read (with hysteresis so a source at the threshold cannot flicker), is inside its deterministic appearance window, and wins a bounded per-frame budget; the losers are parked at zero scale in the very instance attribute the vertex program multiplies, so parking costs no draw call and no CPU transform. Pruning is deterministic (projected size, priority, then stable id), the budget is declared per profile, the world drives it from its own render camera every frame, and the verdict plus its counters reach the HUD line, the `__gdo` payload, and the debug snapshot.
- State content is versioned instead of experimental. `gdo:contentSchema:v1` declares the state-pack contract (required/optional fields, colour and slug formats, buff types and ranges, spawn bounds, voxel row shape, collectible and voxel caps) and validates a pack with stable `path:code` errors; unknown fields are preserved with a warning so a newer pack still loads; legacy packs without a version migrate forward through named pure steps (`v0->v1:stamp-schema-version`, `v0->v1:detach-buff-objects`) that never mutate their input and are idempotent; and the shipped `kerala`/`maharashtra` packs now carry the marker. `StateManager.loadState` runs the shared loader, refuses a bad pack before spawning anything with its reasons in `stateDiagnostics()`, and reports a migration through the console.
- The DOM label layer is now a tested module instead of an inline loop. `gdo:mapLabels:v1` owns the per-frame placement decision: the `GME-04` LOS verdict filters first (an occluded name never takes a slot), then the screen margin, the profile range, and a sparse no-overlap layout decide what is placed, the element pool is capped per profile (14 low), counters name why each hidden name is hidden (`offscreen`, `range`, `occluded`, `overlap`, `overflow`), and the caller keeps the DOM through a tiny adapter so the same code runs against real spans, stubs, and `node --test`. The coordinate HUD page reads the layer's diagnostics into `world.mapLabelDiagnostics`, the debug payload carries them as `mapLabels`, and the pool itself is registered with the `FND-07` lifecycle ledger.
- The visited-places journal is now bounded local state instead of a HUD-only counter. `gdo:discoveryJournal:v1` derives each record's id from the mapped name, its canonical kind, and a merged coordinate cell, so the same place always hashes the same and a name that walks a few units does not fork into two records. The world feeds it one throttled pass over the same `GME-04` label list the HUD already shows: a name enters the journal as `sighted` inside the profile sight distance (120 units low), and only becomes `visited` after the player dwells inside the visit radius (18 units for 1.5 s, reset by stepping out), while the record set stays a hard cap (48/96/160) whose eviction order is deterministic — sighted before visited, then the oldest observation, then the id — so replaying the same walk keeps the same journal byte for byte. The versioned namespaced payload round-trips through a Web-Storage-like adapter that refuses a foreign namespace or a newer schema, counts a full or unreadable store instead of throwing, and is written only when something became visited plus a slow heartbeat, so a reload keeps what the player found without a storage write per frame. `discoveryRecords`, `discoveryVisited`, `discoverySighted`, `discoveryEvictions`, `discoveryRejected`, and `discoverySteadyFrameAllocations` join the low-profile budget surface, the HUD names the found/total count, and the `discovery` debug payload carries the live summary, the journal counters, and the storage verdicts.
- The curated island's camera obstruction is now the same declared query the mapped world answers. `gdo:structureSweep:v1` owns the island's live structural boxes — landmark compounds, ordinary skyline towers, the elevated railway deck and its piers, bridge decks/rails/piers, and sign boards/posts — and answers the `FND-08` `dynamicSweep` member with the identical record shape the coordinate sweep serves, so a consumer of `querySweep` needs no branch for which world answered. Bridges and signs push into that one live array rather than a private copy, so a blocker added after construction is visible to the very next query, every box is named and carries its role and query mask, and the masks are honoured: a fade-eligible or player-solid box is invisible to a camera query. The candidate set is bounded at 256 boxes on low and a pathological frame is pruned nearest-first with the count reported; the record is the caller's own, so a steady sweep allocates nothing. The third-person camera's pull-back is now that sweep's contact time instead of an inline blocker loop, and the island's own counters (`sweeps`, `candidates`, `culled`, `pruned`, `hits`) reach `querySnapshot().sweep`.
- Content is now **data compiled into modules** rather than code a contributor has to write. `gdo:recipeCompiler:v1` compiles a collectible's voxel rows into scaled, bounding-box-centred modules — the exact layout the legacy hand-written builder produced, proved position-, size-, colour-, material-, and shadow-flag-identical — and compiles a landmark from bounded parametric ops (`box`, `grid`, `step`, `tier`; template fields for offsets, signs, and indices) plus declared openings. An opening is a reservation and never a box: a module wholly inside it is dropped and counted, a module that borders it is reported as its boundary, and one that merely touches it is left alone, so a stepped arch keeps its masonry and its walkable passage. Compiled modules are visual/camera proxies; `solidProxies` stays empty unless the recipe declares a `footprint`, and interaction proxies are never implied. Caps are per profile (512 modules per recipe and 4,096 per pack on low, declared in `PerformanceBudget` as `contentRecipeModulesPerRecipe`/`contentRecipeModules`) and overflow keeps the first modules with the count reported and a stable fingerprint over the recipe's **local** layout. `VoxelBuilder.buildVoxelMesh` is now a thin adapter over the compiler, so the shipped content packs, the coordinate collectibles, and the avatar limbs share one layout authority; `StateManager` spawns from the compiled list and reports `recipeNamespace`/`recipeFingerprint`/`recipeModules`/`recipeFamilies`; and the curated gateway and chariot compounds are data in `landmarkRecipes.js` compiled into the same 34 tight camera boxes the island's `COL-06` sweep already used, with the arch reservation proved clear.
- Content is checked **before** it reaches the runtime, by one tool with one report. `gdo:contentValidator:v1` runs the ordered checks `schema`, `bounds`, `budget`, `attribution`, `openings`, `determinism` over a state pack or a landmark recipe: schema refusal skips the rest *by name* rather than claiming they passed; bounds measure real spawn separation against a declared area; budgets judge the compiled counts (not the declared voxel lists), report compiler pruning as a failure, agree with the shipped low-profile budget, and say when a pack only fits a higher profile; attribution resolves every declared mapped source against the real provider table; openings probe each arch with the `COL-06` sweep on both axes at its centre height, so masonry that protrudes into a passage fails even though it was never enclosed; and determinism recompiles to prove a fingerprint is stable. The same call renders a bounded ASCII plan with a colour legend, `npm run validate:content` prints it (with `--json`, `--list`, `--landmarks`, and a non-zero exit on failure), and the page exposes it as `__gdo.validateContent` so a contributor can paste a pack into a console and read the CLI's verdict. `CONTRIBUTING.md` now documents this as the supported authoring path.
- The movement audit is now a matrix instead of a single sweep. `gdo:auditMatrix:v1` runs the scripted `runMovementAudit` script over the six canonical biomes — dense urban, sparse rural, mapped coast, wetland basin, mountain terrace, and arid basin (the last three are new canonical fixtures with their own mapped land, water, wadi, rail, and relief, compiled through the same worker phases as a live tile) — and records each fixture's seven verdicts, its movement fingerprint, and five measured budgets (resident tiles, mounted draw calls, drawn triangles, max collision candidates, live lifecycle resources) in one report with its own deterministic fingerprint. A verdict failure is named by fixture and verdict, and a fixture that cannot report its budgets fails the matrix instead of passing silently. The audited first-person clearance was also corrected to mean what its verdict says: a near-plane-sized probe at the eye itself, so the audit fails when the camera is inside or clipping into a blocker and no longer fires whenever the avatar stands facing a facade it stopped at; third-person keeps the player-to-camera sweep.
- One shared lifecycle contract (`gdo:lifecycle:v1`) now owns every runtime resource. The engine, the coordinate world, all five render pools, the tile geometries, the worker, the DOM listeners, the observers, the timers, and the borrowed material-library handles register in a single owner-scoped ledger that disposes newest-first, contains a throwing disposer, and is capped per profile (384 live resources on low). Three fixture world mount/unmount cycles return to byte-identical idle counters, an injected leak names the exact growing kinds, and the last engine reference disposes without leftovers.
- Moving behaviour is now audited programmatically instead of captured. `runMovementAudit` drives a fixed-step script over the real player, camera, and world and issues deterministic verdicts for clipping (camera clearance against real blockers), ordering (live render bands and transparency flags), popping (per-family plant LOD churn), shimmer (a CPU mirror of the generated-material derivative fade reporting texels per pixel), stability (per-step travel and non-finite state) and residency (tile enters/leaves), plus a two-pass fingerprint that proves determinism. `window.__gdo` exposes `probe()`, `step()`, `ledger()`, `audits.run('movement')` and a bounded `[gdo:*]` log ring; the debug panel shows the same lifecycle line and audit verdict.
- A versioned `gdo:tileCache:v1` persistent cache now sits in front of map streaming. Cache Storage is used where the browser allows it and a bounded in-memory LRU everywhere else, keys carry provider identity and schema version, and per-profile ceilings (6 MiB/24 on low) plus a 3 MiB per-entry limit are enforced by least-recently-used trims that never evict the four resident tiles the world pins. Provider lifetime comes from bounded `Cache-Control`/`Expires` semantics, and a payload is only stored once the real decoder accepts it and the serving provider can still be credited; a credit change or a schema bump purges instead of serving stale bytes.
- One shared domain contract (`gdo:domainInterface:v1`) now describes both playable worlds and both avatars without forcing one visual scale. A world domain declares its id, metres-to-world-unit scale, either finite bounds or a streamed chunk size and residency cap, and the capabilities it actually has (coordinates, terrain support, dynamic sweep, labels, interaction, vertical grades, streaming); a player domain declares its world, known camera modes, and control capabilities. `describeDomainCompliance` checks a live implementation against its descriptor member by member — including capability-backed members such as `querySweep`, `visibleLabels`, and bounds accessors — and `createSupportQuery` hides the scale difference behind one frozen `{x, z, y, kind, slopeRadians, metresAboveSupport}` result. The curated island (1 unit/m, fixed 256 × 256, analytic terrain) and the streamed coordinate world (0.1 unit/m, four resident 2,048-unit tiles, provider-mapped terrain sweep) are proved compliant by the same integration test, and the debug snapshot reports each domain's id, scale, capabilities, and live compliance verdict.
- Place labels are now occlusion-tested instead of merely projected. `gdo:labelLos:v1` sweeps one near-plane-sized probe from the live camera eye to each label anchor through the shared role-aware query with the `LOS_BLOCKER` mask only, so grass, birds, bees, and street furniture can never hide a name; the test budget refills by elapsed time and stays inside the per-profile 20/40/80 tests-per-second ceiling with at most 5/10/14 labels tested per frame, verdicts are cached per label and re-tested on a stable rotation, and the tester returns the caller's array plus one reused diagnostics view so a steady frame allocates nothing. The coordinate HUD gained the matching map readout: the support kind and level under the avatar, the local water class (only claimed inside water or at its shoreline), the nearest mapped name with its distance and kind, the resident tile, and the serving provider schema — all reported through the same debug snapshot the audit reads.
- One semantic map adapter (`gdo:mapSemantics:v1`) now sits between the two provider schemas and every consumer. A single layer table resolves both vocabularies (`transportation`/`streets`, `building`/`buildings`, `water`/`water_polygons`, `place`/`place_labels`, `landuse`/`land`/`sites`, `waterway`/`water_lines`), road classes normalize onto one canonical family list (OpenMapTiles `class`/`subclass` and Shortbread's raw OSM `kind`, `link`, `rail`, and `*_construction` included), and vertical levels come from `brunnel`/`layer` or the boolean bridge/tunnel flags with the same canonical surface heights. Building heights distinguish a published `render_height` from a marker-only `buildings` feature whose stylized replacement stays a deterministic function of the footprint hash, land cover canonicalizes both spellings onto the renderer's colour classes, water bodies resolve their canonical class at the schema boundary instead of guessing downstream, and place labels read `rank` or `population` through one canonical class and rank. The serving provider's schema travels with the tile from the worker, is declared in `public/map-providers.json`, and is reported with the adapter's vocabulary in the debug snapshot.
- Curated streaming/quality/draw-call improvements and shared engine ownership.

### Partial

- Curated and coordinate modes share a runtime surface, the lifecycle ledger, the movement audit, and visual primitives, but still have separate world-generation/player/content implementations.
- Coordinate collision has exact static footprints, tight continuous player sweep/slide, bounded depenetration, semantic masks, packed building spans, and grid-bounded terrain/road/bridge/tunnel support with deterministic step/drop/slope rules.
- Coordinate and curated TPP use near-plane-aware continuous obstruction with fast inward/slow outward response; curated bridges, landmarks, signs, skyline towers, and railway masses have tight proxies. The coordinate sweep is now covered by the movement audit and reaches shared consumers through the `FND-08` `querySweep` member; the curated sweep still runs on its own bridge blockers because the island domain declares no `dynamicSweep` capability.
- Water, terrain, roads, and labels use central semantic descriptors; provider bridge/tunnel/numeric levels resolve to distinct physical grades, and same-grade road joins/crossings receive bounded deterministic merge patches. Transparent-water order is now checked every audit step against the live material flags.
- Coordinate terrain now uses a seam-free 33×33 deterministic fallback grid per resident tile. The same height/normal query grounds terrain, roads, buildings, land cover, details, labels, player steps, and camera clearance; optional public DEM enrichment remains deferred.
- Material mips, derivative-filtered facade/style edges, uniform-controlled distance/profile fades, and normal-first fading are implemented in both modes. The shimmer gate is now the audit's subpixel verdict over the CPU mirror of the same derivative formula.

### Active now

Nothing else is `ACTIVE`: the retired capture gates for `COL-05`, `LAY-03`, `MAT-03`, `DET-08` and `DET-09` are closed by the movement audit, so their rows are `ADDED`.

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
| 007 | FND-07 | P0 | Shared lifecycle/disposal contract | ADDED | FND-02 | One ledger owns workers, listeners, observers, timers, materials, geometries and nodes; three world mount/unmount cycles return to identical idle counters, leaks are named per kind, per-profile ceilings and the `__gdo` debug hook are tested |
| 008 | FND-08 | P1 | Curated/coordinate domain interface | ADDED | FND-06,FND-07 | `gdo:domainInterface:v1` declares world/player domains with declared capabilities; the island (1 unit/m, fixed 256×256) and the coordinate world (0.1 unit/m, streamed 4-tile residency) both pass `describeDomainCompliance` against one live integration test, and `createSupportQuery` serves both at their own scale |

### Stage 1 — diagnostics and geographic truth

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 010 | QLT-01 | P0 | Runtime FPS/CPU/draw/triangle counters | ADDED | FND-02 | Coordinate and curated counters visible without allocations/spam |
| 011 | QLT-02 | P0 | Determinism and lifecycle test fixtures | ADDED | FND-01,FND-06 | All canonical typed outputs remount byte-equivalent; tile geometry/worker ownership is released and tested |
| 012 | QLT-03 | P0 | Canonical fixture tile matrix | ADDED | QLT-02 | Network-free dense/sparse/concave/hole/bridge/coast and equivalent-provider fixtures compile through production builders |
| 013 | QLT-04 | P0 | Query/layer/LOD debug overlay | ADDED | COL-01,LAY-01 | Debug/F3 toggles one capped line batch plus bounds, masks, owners, support, LOD, timings and budget status |
| 014 | QLT-05 | P0 | Automated low-profile budget assertions | ADDED | QLT-01,QLT-03 | Fixture output passes applicable ceilings; every named memory/draw/triangle/query/worker/request/residency breach fails descriptively |
| 015 | QLT-06 | P1 | Deterministic movement-audit matrix | ADDED | COL-05,TER-04,MAT-03 | The scripted movement audit runs over all six canonical biome fixtures (dense-urban, sparse-rural, mapped-coast, wetland-basin, mountain-terrace, arid-basin) through one matrix report: every fixture records its seven verdicts, its movement fingerprint, and five measured budgets, a failing verdict is localized to the fixture that caused it, an unmeasurable budget fails instead of passing silently, and the matrix fingerprint is deterministic |
| 020 | MAP-01 | P0 | Coordinate validation and Web Mercator | ADDED | FND-01 | Round-trip and unsafe-coordinate tests |
| 021 | MAP-02 | P0 | Approximately 1:10 zoom-14 tile scale | ADDED | MAP-01 | Latitude-adjusted tile-size tests |
| 022 | MAP-03 | P0 | Free provider list, fallback, attribution | ADDED | MAP-01 | No API key; visible attribution; bounded retry |
| 023 | MAP-04 | P0 | Worker decoding and compact typed arrays | ADDED | MAP-02,MAP-03 | Browser worker generates transferable geometry under caps |
| 024 | MAP-05 | P0 | Roads-first phased generation | ADDED | MAP-04 | Road phase mounts before context/buildings |
| 025 | MAP-06 | P0 | Boundary-directed lazy neighbor loading | ADDED | MAP-05 | ≤4 resident tiles, ≤2 active requests, cancellation tests |
| 026 | MAP-07 | P0 | Half-open source-tile ownership | ADDED | MAP-04 | Regeneration across eviction has no duplicate transform records |
| 027 | MAP-08 | P0 | Normalized provider feature schema | ADDED | MAP-03,MAP-04 | One semantic adapter (`gdo:mapSemantics:v1`) resolves layer role, road class, vertical level, building height, land cover, water class and place class for OpenMapTiles and Shortbread; a live provider-semantics fixture pair compiles byte-identical road/building/water geometry from each vocabulary |
| 028 | MAP-09 | P1 | Bounded persistent tile cache | ADDED | MAP-06,FND-06 | Versioned Cache-Storage/memory adapter with per-profile byte/entry ceilings, LRU plus resident-set pinning, bounded provider TTL, refusal of uncredited or undecodable payloads, and a cache-first fetch path |
| 029 | MAP-10 | P2 | Overture/PMTiles production option | DEFERRED | MAP-08,MAP-09 | Only after hosting/range-request operational decision |

### Stage 2 — collision, camera, and semantic layering

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 030 | COL-01 | P0 | Role-specific query-mask contract | ADDED | FND-06,MAP-08 | Solid/support/camera/fade/LOS/interaction/placement roles are explicit and tested |
| 031 | COL-02 | P0 | Exact mapped static footprint query | ADDED | MAP-07 | Packed rings/holes remain authoritative after grid broad phase |
| 032 | COL-03 | P0 | Tight swept coordinate-player motion | ADDED | COL-02 | `.058` total profile, sweep/slide, bounded depenetration and counters pass tests |
| 033 | COL-04 | P0 | Packed building vertical spans | ADDED | COL-01,COL-02 | Base/top and mask transfer align 1:1 with footprint polygons |
| 034 | COL-05 | P0 | Near-plane-derived TPP camera sweep | ADDED | COL-03,COL-04 | Algorithm/response tests pass, and the scripted movement audit proves every sample stayed clear of blockers with bounded per-step travel |
| 035 | COL-06 | P0 | Curated camera structure obstruction | ADDED | COL-01,COL-05,FND-08 | `gdo:structureSweep:v1` owns the island's live structural boxes and answers the declared `dynamicSweep` member with the same record shape the coordinate world serves (`hit`/`time`/normals/`blockerId`/`blockerRole`/`blockerMask`/`blockerDistance`/`startedOverlapping`), bridges and sign proxies push into that one array so a blocker added after construction is visible to the very next query, landmark/arch openings, skyline towers, the elevated railway deck and its piers are individually named tight compounds, the candidate set is bounded (256 low, pruned nearest-first and reported when exceeded), query masks decide which structures a consumer may hit, and the third-person camera's pull-back is that sweep's own contact time — and the curated avatar's orbit camera clips through it instead of a private blocker loop |
| 036 | COL-07 | P0 | Shared support/ground/step/slope query | ADDED | COL-01,COL-03,TER-03 | Terrain/road/bridge levels, normals, grounding, steps, drops and slope rejection are deterministic and grid-bounded |
| 037 | COL-08 | P1 | Water/swim/fall support semantics | ADDED | COL-07,TER-05 | `gdo:waterContact:v1` turns the mapped surface plus depth into `dry`/`wading`/`swimming`/`submerged` with the research's single-sample submersion formula and its buoyancy/drag step, keeps a swimming eye above the water plane, refuses an exit whose bank is deeper than the declared ceiling, and classifies fall impact into light/stumble/knock-down bands measured in body heights with the fall speed capped; the coordinate world reads mapped polygons/waterways (raised road decks stay dry) and the curated island reads its fixed water plane, both through the same sensor and the same `/__gdo` water diagnostics |
| 038 | COL-09 | P1 | Capped dynamic spatial hash | ADDED | COL-01,QLT-05 | `gdo:dynamicProxy:v1` holds moving solids as primitive-only proxies (circle/capsule/AABB/OBB/short compound) in a 4-unit hashed grid with the researched 64/128/256 caps enforced by named skip, reinserts only when a proxy crosses a cell boundary, exact overlap and continuous sweep results merged with the static tiles behind one semantic mask in `collidesCircle`/`sweepCircle`/`sweepSphere`, and the ledger-owned grid reported through the debug snapshot |
| 039 | COL-10 | P1 | Placement/support-domain query | ADDED | COL-01,LAY-01 | Exact insets, role/size checks, 2,048-slot tile cap, occupancy and prune/skip fallback tested |
| 040 | LAY-01 | P0 | Semantic generation/surface/query descriptor | ADDED | COL-01,MAP-08 | Generation stages, surface elevations, render bands, depth policy and masks centralized |
| 041 | LAY-02 | P0 | Grade/bridge/tunnel level resolution | ADDED | LAY-01 | Provider levels stay physically separate; same-grade joins/crossings get ≤1,200 deterministic merge patches |
| 042 | LAY-03 | P0 | Opaque/transparent render policy | ADDED | LAY-01,QLT-05 | Bounded sorting/render bands pass, and the movement audit reads the live bands every step: transparent water sorts above opaque geometry and its order never regresses |
| 043 | LAY-04 | P0 | Water polygon/waterway overlap removal | ADDED | MAP-08,LAY-03 | Intersecting waterway ribbons are conservatively suppressed against exact mapped water polygons; query domains retain the hidden waterway |
| 044 | LAY-05 | P1 | DOM label line-of-sight | ADDED | COL-04,COL-01 | Sparse capped LOS hides labels behind blockers: `gdo:mapLabels:v1` places a pooled DOM name only when the `LOS_BLOCKER` verdict cleared it, it is in front of the camera inside a small screen margin, it is inside the profile range, and it does not overlap a name already placed — with a per-profile element cap, per-reason hide counters, and zero steady-frame allocations |
| 045 | LAY-06 | P1 | Camera-fade eligibility/dither | QUEUED | COL-05,MAT-02 | Opaque/alpha-tested screen-door fade; no broad blended foliage. Dependency-complete now that `COL-05` and `MAT-02` are landed |

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
| 062 | MAT-03 | P0 | Mip/distance/derivative anti-alias policy | ADDED | MAT-02 | Mip/filter, derivative-edge, distance/profile and normal-first fade tests pass; the CPU mirror of the derivative fade reports texels-per-pixel per surface and the movement audit requires mip or fade for every subpixel sample |
| 063 | MAT-04 | P1 | Style/material semantic library | ADDED | MAT-02,LAY-01 | Ground/road/facade/roof/bark/leaf/water recipes share palette/masks without per-tile textures or extra voxel families |
| 064 | MAT-05 | P1 | Surface detail catalogue rollout | QUEUED | MAT-03,MAT-04,TER-07 | Prioritized generated patterns; no downloaded baseline textures. Dependency-complete now that `MAT-03` is landed |
| 065 | MAT-06 | P2 | Bounded generated sign atlas/LRU | DEFERRED | MAT-02,LAY-05 | Only if 3D signs beat existing DOM labels within memory cap |

### Stage 5 — vegetation and ecology compiler

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 070 | VEG-01 | P1 | Deterministic biome-aware placement fields | ADDED | MAP-07,TER-01 | Octave field/jittered lattice reproduces across eviction |
| 071 | VEG-02 | P1 | Existing trees/palms/shrubs/herbs/grass | ADDED | VEG-01 | The pooled templates are now measured, not assumed: `gdo:plantSilhouetteAudit:v1` walks 64 scripted steps over the live resident pools and returns deterministic verdicts for the research's low-profile ceilings (box modules after LOD ≤ 6k, vegetation triangles ≤ 75k, pools ≤ 18, sources ≤ 48), for near/mid/far silhouette retention and monotonic cost per compiled family, for the far tier's declared detail width against the projected-pixel threshold, for three distinct large-plant silhouettes in one walk with family/type agreement, and for one active LOD per instance with hysteresis holds and a capped reevaluation rate |
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
| 097 | DET-08 | P1 | Bridge grammar and compounds | ADDED | DET-02,LAY-02,COL-07 | Seven fixed deck/rail/pier families compile from the physical-level deck; rails leave the player corridor clear, piers reach measured terrain support, and the movement audit bounds pier/deck pop through the pooled-entry and LOD-churn verdicts |
| 098 | DET-09 | P2 | Landmark grammar and openings | ADDED | DET-02,DET-04,QLT-05 | Repeated tiers/columns/voussoirs/crenellations/ribs/finials compile from bounded loops into one merged hidden-face batch replacing the mapped shell; arch/door voids stay genuinely walkable, no compound is one enclosing AABB, and the movement audit proves the resident hero set stays clear while swapping |
| 099 | DET-10 | P2 | Prop/food grammar and triggers | QUEUED | DET-02,COL-01,GME-05 | Interaction range remains separate from solid proxy |

### Stage 7 — atmosphere, effects, and living world

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 110 | ENV-01 | P1 | Shared sky/light/fog baseline | ADDED | FND-02 | Both modes share color/lighting primitives and disposal |
| 111 | ENV-02 | P1 | Time-of-day light/sky state | ADDED | MAT-04,QLT-05 | `gdo:timeOfDaySky:v1` derives the solar position from latitude/longitude/day-of-year and blends the research's seven elevation phases into sky, light, fog, exposure, star, and lamp uniforms; the low-profile clock writes at most 14 uniforms per update at 10 Hz and allocates nothing in steady state; `createTimeOfDayLighting` is the only `three` bridge and drives the coordinate world and the curated island from one model; the scripted `gdo:timeOfDayAudit:v1` run measures night readability floors, day/night contrast, star/lamp behaviour, exposure bounds, and the write budget, and the movement audit accepts a `timeOfDay` override for research item 8 |
| 112 | ENV-03 | P1 | Water visual classes | QUEUED | TER-08,MAT-04,LAY-03 | Opaque/one-family low path and bounded blended higher path |
| 113 | ENV-04 | P1 | Weather state machine | QUEUED | ENV-02,TER-07 | Deterministic transitions, environment response, low-profile fallback |
| 114 | ENV-05 | P1 | Bounded weather/shore effects | QUEUED | ENV-03,ENV-04,MAT-03 | Alpha-test/dither, strict screen/overdraw counts |
| 115 | ENV-06 | P2 | Procedural ambient audio zones | QUEUED | TER-07,ENV-04 | Browser-generated/packaged legal audio with distance/activity caps |
| 116 | ENV-07 | P2 | Optional AO/contact-depth benchmark | DEFERRED | QLT-05,MAT-04 | Only if low/balanced GPU budget proves value |
| 120 | LIF-01 | P1 | Existing deterministic birds and bees | ADDED | VEG-01 | Bounded flat sprites appear/disappear on deterministic per-cycle windows; no CPU transforms |
| 121 | LIF-02 | P1 | Ambient-life scheduler and pools | ADDED | COL-09,VEG-07,QLT-05 | Owner-scoped bounded pools, camera-distance fade, per-cycle activity windows, and an explicit screen-space scheduler: sources are offered every frame and drawn only when on screen, large enough to read (`minProjectedPixels` with hysteresis), inside their appearance window, and inside the per-frame budget — the rest are parked at zero scale in the instance stream they already own, and the schedule is deterministic, zero-allocation, and surfaced through diagnostics |
| 122 | LIF-03 | P1 | GPU bird/insect group motion | ADDED | LIF-02,MAT-04 | Zero CPU matrix rewrite for far ambience; one clock uniform per steady frame |
| 123 | LIF-04 | P2 | Bounded pedestrians | QUEUED | LIF-02,TER-05,GME-03 | Route graph, despawn/reuse, no dense global simulation |
| 124 | LIF-05 | P2 | Bounded traffic/boats | QUEUED | LIF-02,DET-07,TER-08 | Coarse path movement and capped dynamic proxies |

### Stage 8 — exploration and gameplay

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 130 | GME-01 | P0 | Desktop movement/look/jump/run | ADDED | COL-02 | Normalized input, frame-rate tests, blur reset |
| 131 | GME-02 | P0 | FPP-default and switchable TPP | ADDED | GME-01 | Keyboard and touch camera controls |
| 132 | GME-03 | P0 | Device-gated complete touch controls | ADDED | GME-01 | The on-screen pad, the keyboard filter, the held-state resolution, and the help sentence are all generated from the shared `gdo:actionRegistry:v1` table, so move/look/run/jump/camera exist on both surfaces and a newly declared action reaches the pad, the key filter, and the help line with no UI edit, proved by a live-player test that registers an action and dispatches it |
| 133 | GME-04 | P1 | Place labels and coordinate HUD | ADDED | TER-01 | `gdo:labelLos:v1` occludes labels through the shared `LOS_BLOCKER` sweep at the per-profile 20/40/80 tests-per-second ceiling with 5/10/14 labels per frame, verdicts cached and re-tested on rotation; the HUD gained a map readout (support kind/level, local water class, nearest mapped name and tile, provider schema) proved on real colliders and labels |
| 134 | GME-05 | P1 | Shared interaction/action registry | ADDED | COL-01,FND-08 | `gdo:actionRegistry:v1` declares each action once with its kind, keyboard codes, pointer gesture, and touch control; the registry is built from the `FND-08` player-domain capability record so an action the domain cannot implement is skipped with a named reason instead of being half-wired, caps prune deterministically, `keyboardHint`/`pointerHint` feed the on-screen help, handlers plug behaviour in without editing the key filter, and the live table reaches the `__gdo` debug payload |
| 135 | GME-06 | P1 | Discovery journal/visited places | ADDED | GME-04,GME-05,FND-06 | `gdo:discoveryJournal:v1` derives a deterministic place id from the mapped name, canonical kind, and a merged coordinate cell, and is fed from the same `GME-04` label source the HUD shows on one pass per label-refresh cadence; a name is `sighted` inside the profile sight distance (120 units low) and only `visited` after the player dwells inside the visit radius (18 units for 1.5 s), the record set is a hard cap (48/96/160) whose eviction order is deterministic (sighted before visited, then oldest, then id), and its versioned namespaced payload round-trips through a Web-Storage-like store that refuses a foreign namespace or a newer schema and counts a blocked/full store instead of throwing; `discoveryRecords`/`discoverySteadyFrameAllocations` join the low-profile budget surface and the `discovery` debug payload carries the summary, the journal counters, and the storage verdicts |
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
| 160 | CNT-01 | P1 | Versioned state-content schema | ADDED | FND-06,FND-08,DET-02 | The experimental state JSON now carries `schemaVersion` 1 and is read through one declared schema: every required field, colour, id slug, buff type/multiplier/duration, spawn coordinate, voxel row and list cap is validated with stable path+code errors, unknown fields warn instead of failing, legacy v0 packs migrate forward in pure named steps, and the loader refuses a bad pack before anything spawns |
| 161 | CNT-02 | P1 | State/landmark recipe compiler | ADDED | CNT-01,DET-09 | `gdo:recipeCompiler:v1` turns contributor **data** into the module list the runtime consumes: a collectible's voxel rows compile to scaled, bounding-box-centred modules (the layout the legacy builder computed, proved byte-equivalent), and a landmark is declared as bounded parametric ops (`box`/`grid`/`step`/`tier`, 64 ops and 256 repeats max) plus the openings that must stay walkable. Opening reservations never become boxes — an entirely-enclosed module is dropped and counted, a module that merely borders the opening is named as its boundary, and a module that touches it is left alone — while a landmark stays visual-only unless the recipe declares a footprint, so no implicit solid or interaction proxy can appear. Caps are per profile (512 modules per recipe / 4,096 per pack on low, mirrored in `PerformanceBudget`), an overflowing recipe keeps the first modules and reports the count, and every compile carries a fingerprint over its **local** layout so the same recipe placed elsewhere is the same recipe. `VoxelBuilder` is now a thin adapter over the compiler (so the content packs, coordinate collectibles, and avatar limbs all take one path), `StateManager` spawns from the compiled list and reports `recipe*` counters, and the curated island's gateway and chariot compounds are compiled from `landmarkRecipes.js` data into the exact 34 boxes the island's `COL-06` sweep already used |
| 162 | CNT-03 | P1 | Content validation/preview tool | ADDED | CNT-01,CNT-02,QLT-03 | `gdo:contentValidator:v1` runs the six ordered checks — `schema`, `bounds`, `budget`, `attribution`, `openings`, `determinism` — over a state pack or a landmark recipe and returns a printable report plus a machine-readable summary. `schema` is the `CNT-01` loader, so a refused pack skips the later checks by name instead of passing them; `bounds` measures real spawn distances (2-unit minimum) against a declared area; `budget` judges the **compiled** module counts against the profile ceilings, cross-checks the shipped low-profile budgets, reports pruning as a failure, and advises when a pack only fits a higher profile; `attribution` verifies every declared mapped source against `public/map-providers.json` and fails an unverifiable credit; `openings` sweeps the real `COL-06` query through each declared opening on both axes at its centre height, so protruding masonry fails even when it is not enclosed, and reports modules the compiler had to drop; `determinism` recompiles and matches an optional pinned fingerprint. The preview is a bounded (32×16) ASCII plan with a colour legend, `npm run validate:content` prints it from the terminal with a non-zero exit on failure and `--json`/`--list` modes, and the page installs the same tool as `__gdo.validateContent`/`contentChecks`/`previewContent`, which answers unusable input instead of throwing |
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
- Content enters the game only through the validated pipeline: a pack or landmark recipe is checked by `gdo:contentValidator:v1` (`npm run validate:content`, or `__gdo.validateContent` in a page), and a pack that fails a check is fixed, never shipped around the tool.

Current WIP: `FND-08`, `MAP-08`, `GME-03`, `GME-04`, `GME-05`, `VEG-02`, `COL-08`, `ENV-02`, `COL-09`, `LIF-02`, `CNT-01`, `QLT-06`, `LAY-05`, `GME-06`, `COL-06`, `CNT-02`, and `CNT-03` all landed with their listed gates, so **no row is `PARTIAL` any more**. No gate is blocked on capture tooling any more — that dependency is deleted, and every moving claim is proved by the lifecycle ledger, the scripted movement audit, and the `__gdo` debug hook. `FND-07` landed the shared lifecycle/disposal contract with three-cycle zero-growth remount proofs and per-profile live-resource ceilings, and the retired capture gates for `COL-05`, `LAY-03`, `MAT-03`, `DET-08` and `DET-09` are closed against it. `FND-08` landed the shared world/player/query interface: the curated island and the coordinate world are declared under one versioned contract and are proved compliant by a live integration test. `GME-05` then landed the one interaction/action registry (`gdo:actionRegistry:v1`) that keys off the `FND-08` player-domain capabilities, and `GME-03` closed with the device-gated pad, the keyboard filter, and the help sentence all generated from that table, so a future gameplay action reaches desktop, touch, and UI together. `COL-06` then closed the last `PARTIAL` row: the curated island answers the declared `dynamicSweep` member through one bounded structural sweep that bridges and signs share, so its camera obstruction and the mapped world's are consumed through identical semantics. `CNT-02` then made content a compiled data path and `CNT-03` put a validator in front of it, so a contributor's pack is checked — and previewed — before the runtime ever sees it. `CNT-04`'s packs are dependency-clear next and must arrive through that validated pipeline. The deterministic `VEG-03` → `VEG-09` vegetation stack, `TER-07` → `TER-08` hydrology field, and `DET-01` → `DET-05` mapped-building/street-furniture detail stack are implemented. `LIF-02` closed the ambient row with the screen-space/activity scheduler on top of the landed pools: every resident sprite is offered once per frame and drawn only when it is on screen, large enough to read, inside its appearance window, and inside the declared budget, with the rest parked at zero scale without a draw call, a CPU matrix, or a steady-frame allocation — `LIF-04` and `LIF-05` can now consume it. `GME-06` then closed the discovery row with the bounded visited-places journal behind the `GME-04` readout: deterministic place ids, a sight-range-gated local record set with a hard cap and a deterministic eviction order, a dwell-based sighting-to-visit transition, a versioned namespaced payload that survives a reload through a store that refuses to guess, and its own budget keys, HUD count, and debug payload — so `GME-07` and `GME-08` have a real visited/sighted source to consume. `MAT-05` and `LAY-06` are now dependency-complete and queued; `DET-06` and `DET-07` still wait on `TER-06` and `COL-09`, respectively. `DET-08` bridge deck/rail/pier modules and tight structural compounds are implemented, and `DET-09` compiles repeated landmark modules plus exact opening compounds that never enclose an arch in one AABB; both are bounded by the audit's churn verdicts. `VEG-02` then closed the vegetation row with a measured silhouette/LOD cost audit over the live pools: a 64-step scripted walk reports the box modules and triangles actually drawn after LOD, checks near/mid/far retention and monotonic cost for every compiled family, proves the far tier keeps no detail below the low-profile screen threshold, requires three distinct large-plant silhouettes with type/family agreement, and bounds LOD switching, hysteresis, and reevaluation rate — deterministically, from the `__gdo` `silhouette` audit. `MAP-09` adds the bounded persistent tile cache with LRU/TTL and attribution-safe storage. `VEG-10` detail/branch-group wind remains intentionally deferred.

## 11. Definition of done

Every completed feature must prove:

1. **Correctness:** deterministic unit/fixture tests and no regression in exact map ownership/traversal.
2. **Lifecycle:** cancellation, tile eviction, remount, and disposal leave no owned listeners/workers/GPU resources, proved by the shared ledger and a zero-growth remount audit rather than by inspection.
3. **Performance:** it fits the relevant low/balanced/high ceilings without borrowing an undocumented budget.
4. **Fallback:** missing map/provider/device capability produces a bounded deterministic result.
5. **Controls:** any action is accessible on desktop and eligible touch UI.
6. **Moving quality:** where applicable, the scripted movement audit proves no unacceptable clipping (negative camera clearance), popping (LOD/resident churn above threshold), shimmer (subpixel surface without mip or fade), depth-order error (transparent band sorting at or below opaque), or instability, and reports the failure by verdict, path, and sample index.
7. **Documentation:** matrix status and [`CHANGELOG.md`](./CHANGELOG.md) are updated in the same change.

## 12. Next five canonical slices

1. Add `CNT-04`'s additional state/landmark packs, now that the validated pipeline (`CNT-01` schema, `CNT-02` compiler, `CNT-03` tool) is the only way content can be added; `NET-01` follows.
2. Add `LAY-06`'s camera-fade eligibility/dither over the landed material dither and the `FADE_ELIGIBLE` mask — the `COL-05`/`MAT-02` dependencies are landed, and `COL-06` now gives both worlds the same sweep member to consult.
3. Add `MAT-05`'s surface-detail catalogue rollout — `MAT-03`/`MAT-04` are landed and the generated-pattern catalogue is the last unshipped material slice.
4. Add `DET-10`'s prop/food grammar and triggers over the landed `GME-05` interaction registry and the `GME-06` journal, keeping interaction range separate from the solid proxy.
5. Extend the `QLT-06` matrix with a `water`/`wetland` movement path set (swim, wade, and shoreline transitions) now that `COL-08` answers water contact in both modes.

`GME-07`'s coordinate minimap and `GME-08`'s local activities can read the `GME-06` visited/sighted places instead of inventing their own progress state; `LIF-04`/`LIF-05` can consume the `LIF-02` scheduler; `DET-06`/`DET-07` still wait on `TER-06`/`COL-09`.

The completed fixture and budget gates must run against every later material, vegetation, object, and environment batch.

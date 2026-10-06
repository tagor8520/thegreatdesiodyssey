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
| [`VISUAL_GATES.md`](./VISUAL_GATES.md) | The visual acceptance gate register: why perceptual gates exist, which code each one tests, the capture harness, all open visual criteria, and the dependency-correct closing sequence | Quality, diagnostics, visual acceptance |

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
- State packs are now versioned, validated and migratable (`CNT-01`, 2026-10-05). `src/engine/ContentSchema.js` declares the content format as a table of fields — name, type, required, and a description a contributor can read — and the validator walks that table, so the schema and the checks cannot drift apart. Validation keeps two kinds of finding apart: **errors** (a bad buff type, a repeated voxel coordinate, a malformed tuple, an undeclared field, a spawn outside the declared bounds) fail loudly and name the field with its path, while **warnings** (no `bounds`, no `provenance`, a description whose stated numbers no longer match the buff, two spawns inside the 1.8-unit pickup radius) are advisory and never block a build. A migration ladder turns legacy v0 files into v1 — stamping the version, dropping coincident voxels that z-fight, normalising hex case so the material cache holds one entry per colour — and refuses a file stamped from the future rather than validating it against an older schema. Both shipped packs are stamped v1 and validate; the shipped files are the gate's real fixture, and the browser tier proves the bytes served over HTTP are byte-identical to the bytes validated on disk. Authoring caps are derived from the shared low-profile ceiling, not invented: the per-pack voxel cap is half the 180,000-triangle budget at 12 triangles per voxel. **The runtime loader is wired but dormant** — `StateManager.loadState` now fetches, migrates and validates, and rejects invalid content without touching the scene, but no entry point mounts it, so the validator ships zero bytes today; mounting these packs in a live runtime is `CNT-02`/`CNT-04`'s job, and the browser scenario prints that gap rather than implying coverage.
- One action registry now owns every gameplay binding in both live runtimes (`GME-05`, 2026-10-05). `src/engine/ActionRegistry.js` declares 12 actions with their kind (`hold`/`tap`), keyboard codes, runtimes, surfaces, touch control, grid placement, size, group and inventory slot; `ActionInput` is the single listener owner and the single source of held/virtual/analogue state, while `src/engine/TouchControls.js` renders both runtimes' on-screen controls from the same declarations. Desktops, touch and the in-game inventory therefore cannot disagree about what an action is: a key bound twice in one runtime is a thrown invariant, a declared touch action with no rendered control fails the gate, and the inventory keys and buttons both resolve through `slotForAction`. The registry also closed two real defects the work surfaced rather than described: the curated runtime shipped with **no touch controls at all**, and the first CSS-driven button sizing rendered RUN and MAP 15px tall on a 390px phone. Touch target size is now a 44px floor asserted in Node, and a source-level test fails the build if any module outside the registry names a registered gameplay key. The frozen `/classic.html` explorer keeps its own keymaps by `AGENTS.md` rule and is excluded by name, not by accident.
- Water polygons, waterways, shorelines, banks, and mapped wetlands now compile into a bounded transferable signed-distance/support domain. Its v2 schema normalizes provider aliases into unknown/stream/canal/river/lake/ocean classes, preserves directed mapped waterway tangents, associates bounded dominant flow with matching river/canal/stream polygons, keeps lake/ocean flow at zero, and carries class through adjacent shore/bank queries. Intersecting line ribbons are conservatively omitted from the transparent mesh while their class/flow/query truth remains available.
- The version-2 object grammar keeps ordinary mapped buildings on the shared analytical facade/parapet path while compiling a stable maximum-eight focus-tile subset into one visual-only detail batch. Exact roof slots produce stair heads, solar pairs, or vents; a bounded ground-road index selects outward road-facing entrance, canopy, cornice, balcony, and utility modules. Footprint-hashed selection, fixed scans/boxes/bytes/draw caps, focus-tile visibility, transfer, remount, and diagnostics are tested without changing mapped collision rings or creating implicit proxies.
- The version-1 street-furniture grammar compiles lamps, benches, bollards, bins, signs, shelters, and utility boxes through the same silhouette/surface/accent IR. Canonical ground-road tangents and normals place source-owned records outside carriageways while bounded reservations protect crossings/intersections, endpoints, building entrance belts, mapped water, spawn calm space, and prior ambience. Seven fixed geometries feed global owner pools with deterministic eviction/remount and no visual-derived collision, camera, interaction, or clearance proxies.
- Plant placement now uses family/role-specific declared base, root, and crown extents against exact building rings, route reservations, terrain support, water/shore domains, and mapped land kind. A bounded 16-sample policy can shrink and shift branch/crown organs through one custom instance attribute without moving source-owned anchors or creating geometry/collision proxies.
- A versioned continuous vegetation profile now blends tropical, subtropical, arid, upland, riparian, and urban influences from latitude, interpolated absolute-coordinate macro fields, terrain, mapped land/water, and bounded road/building proximity. Each aligned plant record retains quantized dominant-three IDs/weights plus bounded aspect, variant, palette, age, and stiffness controls; geometry stays in one fixed two-variant-per-family cache, including bamboo, and focus-ground colour transitions are smoothed.
- A versioned whole-plant wind field exists but is **not enabled by default** (owner decision 2026-10-03; `VEG-09`/`VEG-10` are `REJECTED` as default paths). When switched on with `wind: true` it deforms those resident pools in the vertex shader, without touching placement, collision, support, ownership, clearances, or instance matrices. The default path compiles **no wind ALU at all** behind `#ifdef GDO_PLANT_WIND`, writes no clock uniform, and withholds no culling margin from geometry bounds; the code and lifecycle tests are retained so the decision is reversible by one flag.
- Curated streaming/quality/draw-call improvements and shared engine ownership.
- A capped dynamic spatial hash carries moving solids beside the static tile grids (`COL-09`). Four primitives are admitted — circle, capsule, AABB and oriented box — each with an explicit finite Y span, plus compounds capped at four primitives; anything else, including a mesh or a nested compound, is rejected by name. The active-proxy cap is a hard profile limit (64 low / 128 balanced / 256 high, and the low-profile budget now carries the 64 ceiling): exceeding it throws naming the profile and the owner rather than evicting, because an evicted solid would let the player walk through a moving obstacle. Storage is preallocated to the cap and re-bucketing happens only when a proxy crosses a cell boundary, so a steady frame allocates nothing and a proxy sliding inside its cell costs one bounds recomputation. The hash reuses the same exported collision math as the static path, and its circle, capsule and box sweeps are exact; the oriented-box sweep expands the moving radius into the half extents, which is conservative at the corners and can stop the player marginally early but never lets them pass through. `sweepCircle`, `sweepSphere` and `collidesCircle` merge static and dynamic candidates and report the earliest contact, tagging a dynamic one with `dynamicHandle`/`dynamicOwner` so a caller can tell it from a tile footprint. Proxies are queried under the same mask and Y-span contract as static geometry, so a `SOLID|CAMERA` vehicle stays out of placement queries exactly as a building does. Handles are monotonic and never reused — a stale handle must not resolve to a different proxy — so release-and-replace is observed as storage-slot reuse. The hash ships **empty**: it is the structure the vehicle, platform and agent features need, and those remain their own slices (`DET-07`, `PHY-01`, `PHY-02`, `LIF-02`).
- Ambient life now runs on a budgeted scheduler rather than a per-frame walk (`LIF-02`, which also closes `LIF-01`). `src/geo/GeoAmbientLife.js` keeps birds and bees in preallocated typed arrays with no per-agent objects: a **drawn set** capped by the profile's visible ceiling (a fixed ring of 30 / 60 / 100 entries at low / balanced / high) and a separate **per-frame work** budget (24 / 48 / 96 poses), plus a 72 m distance limit, a 0.6 px screen floor and an activity multiplier, each cull counted by its reason. An agent that leaves the drawn set is **collapsed to zero scale** rather than left at its last pose, so a culled bird cannot freeze mid-air; a tile that streams out releases its slots; and the scheduler's steady cost was measured flat in agent count (about 16 bytes per pass at 64 agents, slightly negative at 8) against a per-agent control that costs one object per agent per pass. `GeoWorld.setAmbientActivity()` is the hook `ENV-04`'s weather and a dusk state will drive.
- A shared lifecycle/disposal contract is proven for both runtimes (`FND-07`). Every owner detaches what it subscribes to and releases what it allocates, verified across repeat remounts rather than a single clean teardown: `GeoWorld` stores its worker `message`/`error` handlers by name and removes them before `terminate()`, the landing shell delegates input from the persistent host element instead of re-binding handlers to markup it is about to discard, and `npm test` carries a ledger that counts workers, observers, listeners, geometry and texture releases per class. `tools/visual-audit/lifecycle.mjs` adds the browser-side instrument, and the `remount-lifecycle` scenario measures all five classes through the real landing flow in both modes; its collectability step distinguishes app-owned resources from framework bookkeeping by dropping the instrument's own references and forcing a collection. Textures and observers cannot be reached from Node (both need a WebGL context), so they are proven in the browser tier only.

### Partial

- Curated and coordinate modes share a runtime surface, visual primitives, **and now a named query/traversal interface** (`FND-08`, 2026-10-05). The interface is six members — `supportAt`, `collidesCircle`, `moveCircle`, `resolveGroundStep`, `clipCamera`, `readDiagnostics` — plus a scale descriptor. The coordinate runtime *is* its own implementation (`GeoWorld`); the curated runtime gets one from `CuratedDomain`, which adapts the biome terrain lattice, the bridge rail boxes and the player's shipped collision box into the same shape. Both players traverse through it: the curated player's ground sampling and horizontal move now go through `moveCircle`/`resolveGroundStep`/`supportUnderFoot` rather than private arithmetic. World *generation* and *content* remain deliberately separate — that separation is the feature's own clause, not an unfinished half.
- Coordinate collision has exact static footprints, tight continuous player sweep/slide, bounded depenetration, semantic masks, packed building spans, and grid-bounded terrain/road/bridge/tunnel support with deterministic step/drop/slope rules.
- Coordinate and curated TPP use near-plane-aware continuous obstruction with fast inward/slow outward response. **Curated is closed (`COL-06`)**: bridges, landmarks, signs, skyline towers, and railway masses carry tight proxies, and the 2026-10-03 moving audit sampled 313 frames across all six families with zero penetrations and the Gateway arch compound preserved. The two modes' sweep radii differ by design because their near planes do (coordinate FOV 68 / near `.02` → `.03–.04`; curated FOV 42 / near `1` → `.93`), so curated compresses on far more frames; this is a near-plane consequence, not a defect. **Coordinate mode is now closed too (`COL-05`)**: with the offline fixture provider serving mapped buildings, the 2026-10-04 orbit matrix sampled 480 frames across five fixtures at both distance extremes with zero penetrations, and the compression-latency probe resolved on the first affected frame.
- Water, terrain, roads, and labels use central semantic descriptors; provider bridge/tunnel/numeric levels resolve to distinct physical grades, and same-grade road joins/crossings receive bounded deterministic merge patches. Transparent-water moving validation remains open.
- Coordinate terrain now uses a seam-free 33×33 deterministic fallback grid per resident tile. The same height/normal query grounds terrain, roads, buildings, land cover, details, labels, player steps, and camera clearance; optional public DEM enrichment remains deferred.
- Material mips, derivative-filtered facade/style edges, uniform-controlled distance/profile fades, and normal-first fading are implemented in both modes; moving low-pixel-ratio shimmer capture remains open.

### Active now

- `MAT-03`: the low-pixel-ratio capture was delivered on 2026-10-04 and it is **inconclusive** — the statistic cannot detect aliasing even with the entire anti-alias policy stripped, so it certifies nothing either way. Anisotropic filtering is no longer part of the question (see §9); the remaining gate needs a real-GPU capture. See `VISUAL_GATES.md` §4 A4.

### Reproducing this snapshot

The counts above are a point-in-time audit of this folder, not the output of a committed script. There is currently **no** roadmap parser, link checker, or CI job in the repository, so reproduce them by hand:

```bash
# tests + production build totals
npm run check

# status totals and matrix-entry count, scoped to section 8 only
awk '/^## 8\. Canonical feature matrix/,/^## 9\. Rejected default paths/' feature-roadmap/README.md \
  | grep -oE '\| (ADDED|PARTIAL|ACTIVE|QUEUED|DEFERRED) \|' | sort | uniq -c
awk '/^## 8\. Canonical feature matrix/,/^## 9\. Rejected default paths/' feature-roadmap/README.md \
  | grep -cE '^\| [0-9]{3} \|'
```

Expected result at the time of writing: `64 ADDED`, `3 PARTIAL`, `0 ACTIVE`, `29 QUEUED`, `15 DEFERRED`, `2 REJECTED`, `113` total. (This line previously read `58 ADDED … 33 QUEUED`, which had been wrong since the `CNT-01` closure updated the matrix but not the baseline; it was corrected on 2026-10-05 alongside `GME-04`/`LAY-05`, and re-derived on 2026-10-06 for `LIF-01`/`LIF-02`.) The `awk` scoping matters — counting statuses across the whole file would also match status words in prose and in §9–§12. Include `REJECTED` in the pattern when regenerating, or the two `VEG` entries will be missed.

Historical counts differ: before 2026-10-03 the totals were `52 ADDED`, `9 PARTIAL`, `2 ACTIVE`, `34 QUEUED`, `16 DEFERRED`. `COL-06` moved `PARTIAL` → `ADDED`, and `VEG-09`/`VEG-10` moved to `REJECTED`. On 2026-10-04 `COL-05` and `LAY-03` moved `ACTIVE` → `ADDED`, leaving no `ACTIVE` item for the first time, so §10's blocked-item exception is currently unused rather than repealed. `MAP-08` moved `PARTIAL` → `ADDED` the same day once its cross-provider gate was actually tested.

Regenerate these numbers whenever matrix status changes, and keep this section, [`CHANGELOG.md`](./CHANGELOG.md), and the top-level [`README.md`](../README.md) consistent in the same change. If a parser or link audit is added later, replace this section with its command.

**Caveat on the quoted fixture totals.** Figures such as the **1,044**-plant / **11**-pool / **208,452**-byte / **11,190**-triangle provider-equivalence mount, the **138,376**-byte street-furniture capacity, and the **19**-draw / **111,418**-triangle / **654,957**-byte worst-tile estimates are *observed measurements* quoted in prose. Only the `175,852`-byte material-library figure is stated in source (`src/reference/README.md`).

The automated gates assert **ceilings**, not these literals: `assertLowProfileBudget` compares a metrics object against `GDO_LOW_PROFILE_BUDGETS` and fails descriptively when a named metric exceeds its budget. The tests therefore verify that the totals stay *under* their committed budgets, not that they equal the numbers written here — a fixture total may drift while `npm run check` still passes. Treat the quoted values as a point-in-time report, re-derive them from the relevant fixture before citing them in a changelog or release note, and prefer updating the figure over assuming the gate caught a change.

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
| 007 | FND-07 | P0 | Shared lifecycle/disposal contract | ADDED | FND-02 | Workers, observers, textures, geometries and listeners hold steady across mount → exit → mount. Node gate: `src/engine/ResourceLedger.test.js` (3 remounts, worker subscriptions removed, every armed geometry/texture released). Browser gate: `npm run visual:audit -- remount-lifecycle` exit 0 — coordinates `1w/2o/41l → 0w/0o/6l` flat per cycle with 0 orphans, curated `0w/1o/167l → 0w/0o/7l` with 100% release; discarded React roots retained in dev but **collected in production** (`tools/visual-audit/probe-fnd07-production.mjs` exit 0), registered as §6.F3 |
| 008 | FND-08 | P1 | Curated/coordinate domain interface | ADDED | FND-06,FND-07 | One named six-member interface (`src/engine/WorldDomain.js`) implemented by a real `GeoWorld` and by `CuratedDomain`; one probe drives both and both pass the same semantics. Node gate `src/reference/WorldDomain.test.js` (7 tests, incl. negative controls), browser gate `npm run visual:audit -- domain-interface` exit 0 2026-10-05: curated advanced 5.200 in 53 steps to a rail, coordinates 4.942 in 50 to a dynamic proxy, camera blocked on the forward segment and clear on the control. Guard: footprint ratio `10.000x` (the 1:10 invariant) and disjoint sweep clamps `[.03,.04]` vs `[.6,1.25]` |

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
| 027 | MAP-08 | P0 | Normalized provider feature schema | ADDED | MAP-03,MAP-04 | Closed 2026-10-04 against a fixture that tags each provider natively (roads: `class` vs `kind`; buildings: `render_height` present vs absent). Every provider-invariant view is byte-identical — roads positions/indices, water, land, water-domain vertices, semantic water classes, exact colliders, collision rings and masks — while height-dependent views diverge by design, since Shortbread carries no height field and uses the documented hash fallback |
| 028 | MAP-09 | P1 | Bounded persistent tile cache | QUEUED | MAP-06,FND-06 | Size/version/LRU policy and attribution-safe storage |
| 029 | MAP-10 | P2 | Overture/PMTiles production option | DEFERRED | MAP-08,MAP-09 | Only after hosting/range-request operational decision |

### Stage 2 — collision, camera, and semantic layering

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 030 | COL-01 | P0 | Role-specific query-mask contract | ADDED | FND-06,MAP-08 | Solid/support/camera/fade/LOS/interaction/placement roles are explicit and tested |
| 031 | COL-02 | P0 | Exact mapped static footprint query | ADDED | MAP-07 | Packed rings/holes remain authoritative after grid broad phase |
| 032 | COL-03 | P0 | Tight swept coordinate-player motion | ADDED | COL-02 | `.058` total profile, sweep/slide, bounded depenetration and counters pass tests |
| 033 | COL-04 | P0 | Packed building vertical spans | ADDED | COL-01,COL-02 | Base/top and mask transfer align 1:1 with footprint polygons |
| 034 | COL-05 | P0 | Near-plane-derived TPP camera sweep | ADDED | COL-03,COL-04 | Algorithm/response tests pass; coordinate orbit audit passed 2026-10-04 (`npm run visual:audit -- coordinate-matrix`): 480 frames across 5 fixtures, 0 penetrations, 675 exact-ring tests, compression resolved on the first affected frame |
| 035 | COL-06 | P0 | Curated camera structure obstruction | ADDED | COL-01,COL-05,FND-08 | Static compounds tested; moving audit passed 2026-10-03 (`npm run visual:audit -- curated-camera`): 313 sampled frames across 6 families, 0 penetrations, arch compound preserved, 0 console errors |
| 036 | COL-07 | P0 | Shared support/ground/step/slope query | ADDED | COL-01,COL-03,TER-03 | Terrain/road/bridge levels, normals, grounding, steps, drops and slope rejection are deterministic and grid-bounded |
| 037 | COL-08 | P1 | Water/swim/fall support semantics | QUEUED | COL-07,TER-05 | Surface/depth/exit rules in both modes |
| 038 | COL-09 | P1 | Capped dynamic spatial hash | ADDED | COL-01,QLT-05 | 64/128/256 profile caps enforced by rejection (never eviction), primitive-only proxies in four shapes plus capped compounds, reinsert only on a cell-boundary crossing, and merged into the live player/camera queries. `src/geo/GeoDynamicProxies.test.js` (24 tests, one negative control per contract); live proof `node tools/visual-audit/diagnose-dynamic-proxies.mjs` exit 0 on `dense-urban`: cap 64 refused the 65th add naming the owner, a placed solid changed a verified-clear sweep from no-hit to hit at t=0.4188 for both `sweepCircle` and `sweepSphere`, and the static world's tiles/bytes/collider floats were unchanged by adding and removing proxies |
| 039 | COL-10 | P1 | Placement/support-domain query | ADDED | COL-01,LAY-01 | Exact insets, role/size checks, 2,048-slot tile cap, occupancy and prune/skip fallback tested |
| 040 | LAY-01 | P0 | Semantic generation/surface/query descriptor | ADDED | COL-01,MAP-08 | Generation stages, surface elevations, render bands, depth policy and masks centralized |
| 041 | LAY-02 | P0 | Grade/bridge/tunnel level resolution | ADDED | LAY-01 | Provider levels stay physically separate; same-grade joins/crossings get ≤1,200 deterministic merge patches |
| 042 | LAY-03 | P0 | Opaque/transparent render policy | ADDED | LAY-01,QLT-05 | Sorting/render bands added; moving water audit passed 2026-10-04 (`npm run visual:audit -- water-order`): 24/24 identical-input renders pixel-identical, water band 100 above all opaque bands, 0 non-water transparent materials, both provider vocabularies resolve the lake once |
| 043 | LAY-04 | P0 | Water polygon/waterway overlap removal | ADDED | MAP-08,LAY-03 | Intersecting waterway ribbons are conservatively suppressed against exact mapped water polygons; query domains retain the hidden waterway |
| 044 | LAY-05 | P1 | DOM label line-of-sight | ADDED | COL-04,COL-01 | Sparse capped LOS hides labels behind blockers. Delivered inside the `GME-04` slice: `src/geo/GeoLabelLos.js` schedules the rays, `LOS_BLOCKER`-only, and a browser scenario proves a name behind a wall is hidden while a clear name stays visible, with four negative controls. Gate: `npm run visual:audit -- label-los` exit 0 (2026-10-05) |
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
| 062 | MAT-03 | P0 | Mip/distance/derivative anti-alias policy | PARTIAL | MAT-02 | Mip/filter, derivative-edge, distance/profile, and normal-first fade tests pass. Low-pixel-ratio shimmer capture delivered 2026-10-04 at the production pixel-ratio floor and is **inconclusive**: p99.9 is `4.1` for production, mip-disabled, and all-fades-stripped alike (`1.000x` sensitivity), so the metric cannot certify the policy. Anisotropic filtering is deliberately not used (see §9). Needs a real-GPU capture |
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
| 078 | VEG-09 | P1 | GPU whole-plant wind | REJECTED | VEG-05,MAT-04 | Rejected as a default path 2026-10-03: the per-vertex cost is not judged worth the effect. Code, tests, and versioned field remain and are reachable through an explicit opt-in (`wind: true`); the default compiles no wind ALU, writes no clock uniform, and withholds no culling margin. Re-enabling is a product decision, not a cleanup |
| 079 | VEG-10 | P2 | Branch-group/detail wind | REJECTED | VEG-09,QLT-05 | Moot while VEG-09 is rejected as a default; no branch-group phase ships without revisiting that decision |
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
| 097 | DET-08 | P1 | Bridge grammar and compounds | QUEUED | DET-02,LAY-02,COL-07 | Traversable deck/rails/openings agree with visuals |
| 098 | DET-09 | P2 | Landmark grammar and openings | QUEUED | DET-02,DET-04,QLT-05 | Repeated modules batched; arches never use one enclosing AABB |
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
| 120 | LIF-01 | P1 | Existing deterministic birds and bees | ADDED | VEG-01 | Bounded instances exist; CPU transforms remain. **Both halves now hold**: the shipped determinism is kept (a bird's orbit is seeded from its placement, not from iteration order) and the CPU transforms are budgeted rather than walked. Delivered inside the `LIF-02` slice — one implementation, two rows. Gate: `src/geo/GeoAmbientLife.test.js` (10 tests) + `npm run visual:audit -- ambient-life` exit 0 (2026-10-06) |
| 121 | LIF-02 | P1 | Ambient-life scheduler and pools | ADDED | COL-09,VEG-07,QLT-05 | Screen/distance/activity budgets; no per-agent object graphs. `src/geo/GeoAmbientLife.js` holds the pool: preallocated typed arrays, a **drawn** set capped by the profile's visible ceiling (a fixed ring of 30/60/100 entries), a separate per-frame **work** budget (24/48/96 poses), distance ≤72 m, a 0.6 px screen floor and an activity multiplier, each cull counted by reason. Node gate `src/geo/GeoAmbientLife.test.js` (10 tests) + browser gate `npm run visual:audit -- ambient-life` exit 0 (2026-10-06): 58 agents resident on 4 tiles against a 30 ceiling, 17 drawn, **17 of 58 instances moved in the renderer's own buffers** in one pass (allowance 41), activity 0 → drawn 0 with 17 collapsed, restored → 17, five negative controls each exit 1 |
| 122 | LIF-03 | P1 | GPU bird/insect group motion | QUEUED | LIF-02,MAT-04 | Zero CPU matrix rewrite for far ambience |
| 123 | LIF-04 | P2 | Bounded pedestrians | QUEUED | LIF-02,TER-05,GME-03 | Route graph, despawn/reuse, no dense global simulation |
| 124 | LIF-05 | P2 | Bounded traffic/boats | QUEUED | LIF-02,DET-07,TER-08 | Coarse path movement and capped dynamic proxies |

### Stage 8 — exploration and gameplay

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 130 | GME-01 | P0 | Desktop movement/look/jump/run | ADDED | COL-02 | Normalized input, frame-rate tests, blur reset |
| 131 | GME-02 | P0 | FPP-default and switchable TPP | ADDED | GME-01 | Keyboard and touch camera controls |
| 132 | GME-03 | P0 | Device-gated complete touch controls | PARTIAL | GME-01 | Current movement/run/jump/camera added; future actions must auto-register |
| 133 | GME-04 | P1 | Place labels and coordinate HUD | ADDED | TER-01 | Projection and overlap (existing) plus throttled line-of-sight and the richer readout. Gate: `npm run visual:audit -- label-los` exit 0 (2026-10-05) — the search finds a standing position with a wall strictly between eye and name (`t=0.375`), the layer hides that label within the update interval (`dom.hidden`, `data-los=blocked`), a clear-ray label stays visible, every label ray asks for `LOS_BLOCKER` and nothing else, the low-profile `20/s × 5` ceiling holds, the panel prints `labels los:low … age…ms blocker…`, and the HUD's nearest place plus bearing/distance is recomputed from the runtime's own coordinates. Node gate: `src/geo/GeoLabelLos.test.js` (8 tests) |
| 134 | GME-05 | P1 | Shared interaction/action registry | ADDED | COL-01,FND-08 | One registry (`src/engine/ActionRegistry.js`) is the only keymap: 12 actions declared per runtime with `kind`/`codes`/`runtimes`/`surfaces`/`touch`/`group`/`slot`, and `ActionInput` is the only listener owner in either player. Touch markup is generated from it (`mountTouchControls`), so a declared touch action with no control cannot exist. Node gate `src/engine/ActionRegistry.test.js` (14 tests: registry invariants, per-runtime code collisions, surface group floors, markup↔registry equality, `ActionInput` behaviour, and a source scan proving no module outside the registry hard-codes a gameplay key — the check that removed a second `Digit1-3` keymap in `GameUI.jsx` and a second `F3` listener in `GeoGame.js`); browser gate `npm run visual:audit -- action-surfaces` exit 0 2026-10-05 in both real runtimes: every declared touch control driven with real pointer events (joystick drag → forward/right, released to zero), every inventory slot reached by both its button and its key, per-runtime bindings verified disjoint (`KeyM` map vs none, `KeyV` none vs camera, `F3` none vs debug), and both runtimes measured on a 390x844 touch viewport with 52/72/46px targets while a mouse-driven browser is refused them |
| 135 | GME-06 | P1 | Discovery journal/visited places | QUEUED | GME-04,GME-05,FND-06 | Deterministic place IDs and bounded local state |
| 136 | GME-07 | P1 | Coordinate minimap/navigation | QUEUED | MAP-08,GME-04 | Lightweight map-derived guidance without duplicate world renderer |
| 137 | GME-08 | P2 | Procedural local activities/missions | QUEUED | GME-06,DET-10,LIF-02 | Reproducible objectives from real place/road/land context |
| 138 | GME-09 | P2 | Swimming/boat traversal | QUEUED | COL-08,TER-08,GME-05 | Enter/exit/support/camera rules and touch action |
| 139 | GME-10 | P2 | Accessibility/remapping/reduced motion | QUEUED | GME-05,ENV-04 | Keyboard/touch mapping, motion/effect settings persist. `VEG-09` was removed as a dependency: wind is `REJECTED` as a default path, and reduced-motion control still ships via `setReducedMotion()`, so accessibility never depended on wind |

### Stage 9 — optional physics, content, and network scale

| Order | ID | Pri | Feature | Status | Depends on | Completion gate / next action |
|---:|---|---|---|---|---|---|
| 150 | PHY-01 | P2 | Simple query-driven doors/gates | QUEUED | COL-09,GME-05,DET-04 | Bounded kinematic proxy; no full engine required |
| 151 | PHY-02 | P2 | Capped pushables/projectiles | DEFERRED | COL-09,QLT-05 | Fixed step and sleeping pool prove budget |
| 152 | PHY-03 | P3 | Pose-fall knockdown | DEFERRED | GME-05,QLT-05 | Visual/state-machine baseline before rigid bodies |
| 153 | PHY-04 | P3 | Small PBD puppet benchmark | DEFERRED | PHY-03 | 6–10 particles, bounded constraints, low profile may disable |
| 154 | PHY-05 | P3 | Lazy true-ragdoll engine benchmark | DEFERRED | PHY-03,QLT-05 | Only after measured comparison; static map remains query-driven |
| 155 | PHY-06 | P3 | Breakable props/rope/flags | DEFERRED | PHY-02,DET-10 | Strict island/pool budgets and deterministic reset |
| 160 | CNT-01 | P1 | Versioned state-content schema | ADDED | FND-06,FND-08,DET-02 | `src/engine/ContentSchema.js`: a declarative field table (`STATE_CONTENT_FIELDS`) that the validator walks, so the schema *is* the table; `validateStateContent` reporting errors separately from advisory warnings; a strictly increasing migration ladder (`MIGRATIONS`, legacy v0 → v1) that repairs coincident voxels and hex-case drift and refuses files from the future; and `loadStateContent`/`parseStateContent`, now the only path `StateManager.loadState` uses. Authoring caps are derived from the shared profile ceiling rather than invented (pack cap = half the 180,000-triangle low-profile budget at 12 triangles/voxel). Both shipped packs are stamped `schemaVersion: 1` and validate. Node gate `src/engine/ContentSchema.test.js` + `src/engine/StateManager.test.js` (17 tests: every error class via a fixture that must produce it, the migrated file byte-equal to the shipped one, migration repair notes, and the loader rejecting invalid content without touching the scene); browser gate `npm run visual:audit -- content-schema` exit 0 2026-10-05: both packs fetched over the dev server and validated in-page by the real module, **byte-identical (SHA-256) to the files the Node tier validated**, with the legacy-migration and rejection paths exercised in the browser too. **Honest gap:** nothing mounts `StateManager`, so the validator ships zero bytes today — connecting these packs to a live runtime is `CNT-02`/`CNT-04` |
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
- anisotropic filtering — `REJECTED` as a default path (owner decision, 2026-10-04). Trilinear mip selection alone is the accepted policy; do not add it as a "fix";
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

**Blocked-item rule.** An item may remain `ACTIVE` beyond the two-epic limit only when its implementation, tests, lifecycle, diagnostics, budget gates, and changelog entry are all complete and the *sole* open gate is external to the code — a capture run, a fixture, or a provider. Such items perform no ongoing implementation work, so they do not consume a WIP slot. The item returns to normal counting the moment its gate is schedulable.

**Capture tooling is no longer a blocker (resolved 2026-10-03).** A working headless WebGL 2.0 harness now exists using `@sparticuz/chromium`, whose Chromium binary ships inside the npm tarball and therefore installs from the npm registry — the only reachable endpoint in this environment. Verified: Chromium 153 boots, WebGL 2.0 renders under SwiftShader, `fwidth` compiles, `readPixels` returns correct values, and full-page screenshots work. Curated mode booted with **zero console errors** (39 calls / 22k tris / 36 chunks) and correctly auto-selected the low-power profile. See [`VISUAL_GATES.md`](./VISUAL_GATES.md) for the harness record, the full gate register, and the closing sequence.

This tooling change altered *why* the visual gates were open, not whether they were. Current state after the 2026-10-03 curated capture run:

| Item | Status | Blocker |
|---|---|---|
| `COL-06` | **`ADDED`** | None — closed by `npm run visual:audit -- curated-camera`: 313 swept frames, 0 penetrations, arch compound preserved. |
| `COL-05` | **`ADDED`** | None — closed 2026-10-04 by `coordinate-matrix`: 480 swept frames, 0 penetrations. |
| `LAY-03` | **`ADDED`** | None — closed 2026-10-04 by `water-order`: 24/24 pixel-identical renders, band order proven. |
| `FND-07` | **`ADDED`** | None — closed 2026-10-04 by `ResourceLedger.test.js` + `remount-lifecycle` + the production probe. Dev-only React root retention is recorded as `VISUAL_GATES.md` §6.F3, not a blocker. |
| `MAT-03` | `PARTIAL` | The capture exists and its metric is blind: the statistic cannot detect aliasing even with the whole policy stripped. Needs a real-GPU capture or an owner decision. |

This table previously listed `COL-05` and `LAY-03` as `ACTIVE` after both had closed; that contradicted §8 and the §6 counts. Corrected 2026-10-04.

SwiftShader is a conformant software rasterizer, so **correctness and appearance** gates (clipping, depth order, popping, gross shimmer, silhouette identity) are decidable with it. It is **not** a performance proxy — it runs at 3–10 FPS here — so no FPS or frame-time claim may be made from it. Performance gates still require real hardware.

**Remaining data prerequisite — RESOLVED 2026-10-04.** Coordinate-mode gates needed mapped buildings and water, which arrive from network vector tiles this environment cannot reach. The **offline fixture provider** now supplies them: `src/geo/GeoFixtureTileEncoder.js` encodes `GeoFixtures` into spec-valid MVT, `npm run fixture:tiles` writes the canonical `.pbf` artefacts under `public/fixture-tiles/`, and `tools/fixture-provider/vite-plugin.mjs` registers a development-only provider entry in the `/map-providers.json` response. It declares `apply: 'serve'`, so it cannot enter a production build; verified `dist/` carries no fixture provider, no fixture reference, and zero `.pbf` files. Because `GEO_FIXTURE_EXTENT` matches MVT's standard extent, encode→decode is exact and the decoded tiles drive the production builders to byte-identical output.

Current WIP: the deterministic `VEG-03` → `VEG-08` vegetation stack, `TER-07` → `TER-08` hydrology field, and `DET-01` → `DET-05` mapped-building/street-furniture detail stack are implemented. `VEG-09` whole-plant wind and its dependent `VEG-10` are **`REJECTED` as default paths** by owner decision on 2026-10-03 (per-vertex cost not judged worth the effect); the code and tests remain behind an explicit `wind: true` opt-in that the default never enables. `COL-06` closed the same day. `COL-05` and `LAY-03` closed on 2026-10-04 once the fixture provider made mapped buildings and water reachable, so no item currently depends on the blocked-item rule. `MAT-03` remains `PARTIAL` for a different reason: its capture exists but is **inconclusive**, because the statistic cannot detect aliasing even when the whole anti-alias policy is stripped, so it neither confirms nor refutes the policy. Anisotropic filtering is a settled question by owner decision (§9) and is no longer part of the gate; what remains is a real-GPU capture. Recorded in `VISUAL_GATES.md` §4 A4. `MAT-05` remains ordered after `MAT-03`. `DET-06` still waits on `TER-06`. `DET-07` no longer waits on anything: `COL-09` closed on 2026-10-05, so it and `PHY-02` are dependency-complete (and `PHY-01` stopped needing `GME-05` when that closed), while `NET-02` still needs `NET-01`. `LIF-02` closed on 2026-10-06 and took `LIF-01` with it, so the bird/bee slice is no longer `PARTIAL`. `DET-08` (bridge deck/rail/pier modules and tight structural compounds) remains the next dependency-complete object build, now beside `LIF-03` (GPU bird/insect motion), which the `LIF-02` closure made dependency-complete.

`FND-07` closed on 2026-10-04 and was the largest transitive lever in the matrix — 20 open items depended on it. `COL-09` closed on 2026-10-05 and was the second: it settles the dynamic-solid query contract that **`DET-07`** (vehicle grammar), **`PHY-01`** (doors/gates), **`PHY-02`** (pushables/projectiles), **`LIF-02`** (ambient-life scheduler) and **`NET-02`** (interest management) were all waiting on. `FND-08` closed on 2026-10-05, and **`GME-05`** closed the same day: the shared action registry is the only keymap in both live runtimes, and desktop, touch and the in-game inventory now expose the same declared actions through one named surface. **`CNT-01`** also closed on 2026-10-05: state packs now carry a version, a schema, a validator and a migration ladder, and both shipped packs validate in Node and in the browser against the same bytes. The remaining open set is 4 `PARTIAL`, 30 `QUEUED` and 15 `DEFERRED` (**49 items**), of which **25 are dependency-complete** and **24 are still hard-blocked** behind other unfinished features. (The `DEFERRED` count is in the open set because those items are neither `ADDED` nor `REJECTED`; an earlier version of this paragraph quoted only the non-deferred items while the completeness arithmetic counted all of them.) Closing `GME-05` unblocked three items that were waiting only on it: **`DET-10`** (prop/food grammar), **`PHY-01`** (query-driven doors/gates) and **`PHY-03`** (pose-fall knockdown, still `DEFERRED` as a scope decision). Three of its other direct dependents remain blocked on something else — `GME-06` needs `GME-04`, `GME-09` needs `COL-08`, `GME-10` needs `ENV-04` — and `NET-04` still needs `NET-03`. `CNT-01` is the first closure in this sequence that unblocked **nothing outright**: its three direct dependents each wait on something else as well — `CNT-02` needs `DET-09`, `CNT-03` needs `CNT-02`, `NET-01` needs `GME-06` — so its 7-item closure is a chain to be walked rather than a queue that opened. **`GME-04`** closed on 2026-10-05 and took **`LAY-05`** (DOM label line-of-sight) with it — the two rows describe the same deliverable in different categories, and the same scheduler and gate satisfy both, so the record says one implementation closed two rows rather than inventing a second. The closure made three items dependency-complete that were only waiting on it: **`GME-06`** (discovery journal — `GME-04`, `GME-05`, `FND-06` are now all `ADDED`), **`GME-07`** (minimap — `MAP-08`, `GME-04`) and **`MAT-06`** (sign atlas, still `DEFERRED` by scope). **`LIF-02`** closed on 2026-10-06 and took **`LIF-01`** (existing deterministic birds and bees, `PARTIAL`) with it. The two rows are the same work seen twice: `LIF-01` records that bounded bird/bee instances exist while *"CPU transforms remain"* — the unbounded per-frame walk — and `LIF-02` is the scheduler that bounds them, so one implementation closed both rows rather than inventing a second slice. It is the same pattern the register already uses for **`GME-04`**/**`LAY-05`**. `LIF-02` is also the first `COL-09` dependent to close, and the record needs a correction for that: **it placed no proxy into the dynamic hash** — ambient fauna are non-colliding budgeted instances, so the hash still ships empty and `DET-07`, `PHY-01` and `PHY-02` remain its consumers. An earlier paragraph in this file predicted `LIF-02` would be the first consumer, and that prediction was wrong rather than merely unfulfilled. Closing it made **`LIF-03`** (GPU bird/insect motion, deps `LIF-02` + `MAT-04`) dependency-complete; its three other direct dependents stay blocked — `LIF-04` needs `GME-03`, `LIF-05` needs `DET-07`, `GME-08` needs `GME-06`.

The remaining open set is 3 `PARTIAL`, 29 `QUEUED` and 15 `DEFERRED` (**47 items**), of which **24 are dependency-complete** and **23 are hard-blocked**. Recomputing leverage across the dependency-complete items puts **`GME-06`** (5 in its closure, 2 direct) first, then **`ENV-02`** (4, 1), then **`MAT-03`**, **`MAP-09`** and **`DET-09`** (3 each). `DET-09` is worth noting: closing it would complete `CNT-02`, and the content chain (`CNT-02` → `CNT-03` → `CNT-04`) hangs off it. **`LIF-03`** is a leaf by comparison — nothing depends on it — so it buys ambience quality rather than reachability.

**Systemic gap recorded.** Several features are marked `ADDED` on structural gates while their own research specifications list visual criteria that have never been observed — most notably the entire `VEG-03` → `VEG-09` stack, where *whether the wind looks correct* has never been seen. These are catalogued in [`VISUAL_GATES.md`](./VISUAL_GATES.md) §4 Group B. They are not currently blocking items in the matrix, but they should be closed before the vegetation and object-detail stacks are considered finished rather than merely tested.

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

Ordered by what is actually blocked, following the closing sequence in [`VISUAL_GATES.md`](./VISUAL_GATES.md) §5.

1. ~~Build the **offline fixture provider**.~~ **DONE 2026-10-04** — see §11. `COL-05` and `LAY-03` closed from it the same day.
2. Resolve **`MAT-03`**: the capture is done and its metric is blind, so no software configuration decides the shimmer criterion. Options are a real-GPU capture using the same statistics, or an owner decision waiving the criterion for trilinear-only selection — recorded as a decision with the gate restated, never closed on evidence that does not support it.
3. Re-scope the **Group B** criteria for `VEG-04`, `VEG-05`, `VEG-07`, and `VEG-08` to their static properties (silhouette family identity, branch cracks, clearance conformance) — the wind criteria are moot now that `VEG-09` is rejected. These remain observable in the fallback world.
4. ~~Close **`COL-05`** and **`LAY-03`**.~~ **DONE 2026-10-04.** The `CLIPPING` §10.1 near/far depth question was **not** resolved — it needs the far-plane/fog comparison, not the grazing frames, so it remains open on its own terms.
5. Add **`DET-08`**: compile bridge deck/rail/pier modules and tight structural compounds while preserving traversable openings and physical levels. Write its visual gate alongside the code rather than after it.

~~Close **`FND-07`**.~~ **DONE 2026-10-04.** Dependency-complete and the largest transitive lever in the matrix (20 open items downstream). The next leverage items, in order, are `COL-09` (12 downstream, 5 direct) and `GME-04` (7, 2).

~~Close **`COL-09`**.~~ **DONE 2026-10-05.** The capped dynamic spatial hash is implemented and its contract is proven in both tiers, so `DET-07`, `PHY-01`, `PHY-02`, `LIF-02` and `NET-02` are dependency-complete on this side. **The hash ships empty** — no moving solid exists in the product yet; those five items place proxies into it as they land. Next by recomputed leverage (2026-10-05, after `FND-08`): **`GME-05`** (shared interaction/action registry — 14 items in its closure, 7 direct, unblocked by `FND-08`), then **`CNT-01`** (7, 3), **`GME-04`** (place labels / coordinate HUD, 7, 2), **`LIF-02`** (4, 4) and **`ENV-02`** (4, 1). Note that the "shared interaction/action registry" is **`GME-05`**, not `GME-04`.

Then `MAT-05` after `MAT-03` closes, and `DET-09` after `DET-08`.

~~Close **`GME-05`**.~~ **DONE 2026-10-05.** The shared interaction/action registry is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4e: one registry declares every gameplay action per runtime and per surface, `ActionInput` is the only listener owner in either player, and both runtimes' touch controls are rendered from those declarations. Implementing the gate found and fixed two real defects — the curated runtime had no touch controls at all, and touch buttons rendered 15px tall on a phone. It unblocked `DET-10`, `PHY-01` and `PHY-03`.

~~Close **`CNT-01`**.~~ **DONE 2026-10-05.** The versioned state-content schema is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4f: a declarative field table, errors separated from advisory warnings, a v0 → v1 migration ladder that repairs what legacy files got wrong and refuses files from the future, and a loader that rejects invalid content without touching the scene. Both shipped packs are stamped and validated in both tiers, and the browser tier proves the served bytes are byte-identical to the validated ones. It unblocked nothing on its own — `CNT-02` still needs `DET-09` — and the recorded gap is that no runtime mounts the loader yet.

~~Close **`LIF-02`**.~~ **DONE 2026-10-06** (and **`LIF-01`** with it — same deliverable, two rows). The ambient-life scheduler is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4h. The load-bearing part is that the gate does not trust the scheduler's own counters: it reads the **renderer's instance buffers** and counts how many instances actually moved in one pass, so the pre-`LIF-02` frame loop — which the first negative control re-installs verbatim — fails at 58 moved against an allowance of 41. It found and fixed a real defect in the implementation itself: the first version bounded only the *update rate*, so a resident set larger than the ceiling still drew every agent. The record's prediction that `LIF-02` would place the first proxy into the `COL-09` hash was **wrong** — fauna are non-colliding, the hash still ships empty — and the paragraph above says so.

**Next slice (measured 2026-10-06, after `LIF-02`/`LIF-01`).** The owner's order — `LIF-02` then `ENV-02` — has its first half done, and the recomputed graph agrees on what follows: **`ENV-02`** (time-of-day light/sky state, 4 in its closure, 1 direct) is next, and it is the slice the ambient scheduler was built to feed — `setAmbientActivity` exists so a dusk or weather state can wind a family down without a second animation path. The largest remaining lever is **`GME-06`** (discovery journal, 5 in its closure, 2 direct), so it is the natural pick if gameplay state is preferred over ambience; `GME-07` (minimap) is dependency-complete beside it. If the content chain is preferred instead, `DET-09` completes `CNT-02` and is therefore the entry point to `CNT-03` and `CNT-04`.

**Slice 6 — `FND-08`. DONE 2026-10-05.** The curated/coordinate domain interface is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4d. Both runtimes are driven by one probe in both tiers; the scale guard holds the 1:10 footprint ratio and the disjoint camera clamps. Its two direct dependents (`GME-05`, `CNT-01`) are now dependency-complete, and by the same measure `GME-05` became the leader at 14 items in its closure.

**Slice 7 — `GME-05`. DONE 2026-10-05.** The shared interaction/action registry is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4e. Twelve actions are declared once and reached from desktop, touch and the in-game inventory; the curated runtime got the touch controls it never had, and the registry-driven sizing fixed a 15px phone target. It unblocked `DET-10`, `PHY-01` and `PHY-03`.

**Slice 8 — `CNT-01`. DONE 2026-10-05.** The versioned state-content schema is implemented and its gate is registered in `VISUAL_GATES.md` §4 A4f. The advertised low-code content path now has a contract: a field table, a validator that names the offending field, a migration ladder, and a loader. Both shipped packs validate in both tiers, and the browser tier compares SHA-256 hashes so "the served bytes are the validated bytes" is a check rather than an assumption. The recorded gap is that no live runtime mounts the loader (`CNT-02`/`CNT-04`).

The completed fixture and budget gates must run against every later material, vegetation, object, and environment batch. No FPS or frame-time claim may be derived from the software-rasterizer harness; performance gates still require real hardware.

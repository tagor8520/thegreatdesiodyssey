# The Great Desi Odyssey — Technical, Product, and Scalability Audit

**Audit date:** 2026-09-15
**Baseline:** `6cca7483cf0eb515277b248ab2282586d66a1b81`
**Scope:** Current `/` game, legacy `/classic.html` game, content model, performance architecture, product aim, and defensibility.

## 1. Executive summary

The Great Desi Odyssey is a browser-based 3D voxel exploration prototype about Indian regions, landmarks, food, and internet culture. Its current playable loop is:

> enter the three-state world → walk/explore → cross bridges → collect regional foods → increase a local-session score.

The project is technically a **static multi-page Vite site**. The current `/` game uses **Three.js + React**, while `/classic.html` uses a separate, older vanilla Three.js implementation. There is no production backend, database, account system, authoritative multiplayer server, persistent inventory, global leaderboard, chat, or content delivery service.

The current game has a promising small-world renderer: deterministic terrain, chunk lifecycle ownership, cancellable generation, instancing, fixed/sub-stepped movement, and explicit disposal. However, it is not yet architected for an India-scale world. The main blockers are:

1. **Two competing game implementations.** Most source code belongs to the legacy game, but `/` runs `src/reference/*`. Several docs describe systems that are not connected to the current game.
2. **The “streamer” loads the complete current map.** At the overview focus, the default 150-unit load radius selects all 64 chunks of the 256 × 256 world.
3. **Too many potential draw submissions and shadow casters.** A static scene inspection of the current world, bridges, actors, and food found 425 `InstancedMesh` objects/materials and 9,310 instances before adding the player, signs, water, and environment. The geometry is modest; state changes/draw submissions and full-scene shadows are the larger concern.
4. **Expensive effects are unconditional.** The current game starts with full-resolution SSAO, a DPR cap of 1.5, a 2048² soft shadow map, PMREM environment lighting, and shadows on every voxel batch. There is no low-power profile or adaptive resolution.
5. **The game allocates and renders behind the landing page.** WebGL, post-processing, all managers, all 35 pickups, and world streaming begin before the player clicks Start. Exit hides gameplay but does not release or pause the world.
6. **Map extent, content, and gameplay are hardcoded.** World bounds, biome decisions, landmark positions, water size, player bounds, bridges, signs, and item placement are all tied to the current 256-unit world.
7. **The advertised low-code JSON path is not active.** The two state JSON files are not consumed by `/` or `/classic.html`; `StateManager`, `MapGenerator`, and `MultiplayerClient` are currently disconnected modules.

The recommended strategy is **not a full engine rewrite** and not an ECS migration. Keep the manager-based design, select one canonical runtime, then introduce lifecycle control, quality profiles, renderer budgets, chunk-addressed content, worker generation, shared palette materials, per-chunk interactables/collision, and a separate low-cost overview map.

A good north-star property is:

> A 100× increase in total map area must not materially increase steady-state render cost, update cost, or memory at a fixed camera and player position.

---

## 2. What the project is trying to become

The stated vision is a continuous “Virtual Bharat” that combines:

- explorable voxel versions of Indian states and landmarks;
- regional culture, festivals, food, and meme lore;
- collectible discovery, rarity, badges, and a global leaderboard;
- accessible, language-light interaction;
- state-specific multiplayer spaces, proximity communication, and spatial chat;
- community-created regional content under a respect/moderation standard.

### Current product reality

The implemented `/` experience is a polished **three-region vertical slice**, not yet a virtual universe:

- Maharashtra, Karnataka, and Kerala are selected with coordinate rules rather than state content packages.
- The active world is 256 × 256 units.
- The player can move, run, jump, use a map camera, cross three bridges, and collect 35 food instances.
- Score and pickups live only in browser memory and reset on refresh.
- Trains and a houseboat are cosmetic actors.
- Multiplayer timing/ping hooks exist at the mount boundary, but no transport is attached.
- Desktop keyboard/mouse is required; there are no mobile movement controls.

The clearest current positioning is:

> A lightweight, no-install, culturally specific 3D exploration game and a future community platform for building a voxel map of India.

---

## 3. Technology inventory

| Area | Current technology |
|---|---|
| Language | JavaScript ES modules and JSX; no TypeScript |
| 3D engine | Three.js `0.170.x`, WebGL |
| UI | React / React DOM `19.x` for the current game; imperative DOM for the legacy game/docs |
| Build | Vite `6.x`, Rollup multi-page build |
| Rendering | `MeshStandardMaterial`, instancing, directional shadows, fog, PMREM sky IBL |
| Post-processing | `EffectComposer`, `SSAOPass`, `OutputPass` |
| Procedural media | GLSL, generated voxel transforms, Canvas2D sign textures, generated water normal map |
| Audio | Web Audio API synthesized pickup chimes |
| Physics | Custom analytical terrain and AABB movement/collision; no physics library |
| Tests | Node's built-in test runner; eight tests in `src/reference` |
| Deployment | Static files; suitable for CDN/Netlify/Vercel/static hosting |
| Backend | None in this repository |
| Persistence | None |
| Networking | Unused WebSocket client prototype; no server |
| Content pipeline | Mostly JavaScript-authored geometry; two unused JSON state files |
| 3D assets | No GLTF/OBJ gameplay models; geometry is generated at runtime |

### Build baseline

The audited build succeeds and the eight explicit gameplay/streaming tests pass. `npm audit` reported no known vulnerabilities. The production build's two significant current-game JavaScript chunks are approximately:

- current-game main: **287.9 kB raw / 92.1 kB gzip**;
- shared Three.js/post-processing chunk: **491.0 kB raw / 123.7 kB gzip**.

This is reasonable for a browser 3D game, but the landing route should not have to parse and initialize all of it before Start. The package currently has no `test` script, no lint/typecheck script, and no visible CI configuration.

---

## 4. Repository and page topology

```text
index.html ----------------------> src/reference/main.jsx   (current game)
reference.html ------------------> src/reference/main.jsx   (same current game)
classic.html --------------------> src/main.js              (legacy game)
vision/contribution/tnc.html ----> src/ui/DocRenderer.js    (static docs)

src/reference/*     Current coherent runtime, despite the “reference” name
src/engine/*        Mostly legacy engine modules
src/world/*         Mostly legacy world modules
src/ui/*            Legacy UI and docs UI
src/network/*       Disconnected WebSocket prototype
public/content/*    Images plus disconnected state JSON
```

### Critical architecture inconsistency

The README says the architecture is vanilla JavaScript without React, and that new JSON state files are automatically parsed. That is not true for the current `/` application:

- `/` imports React and mounts `src/reference/main.jsx`.
- Neither current nor classic entry point imports `StateManager`.
- The JSON state files are therefore not loaded automatically.
- The documented JSON example includes concepts such as zone bounds and landmarks that do not match the two existing JSON files.
- Karnataka has no JSON state file.
- `MapGenerator.STATE_GRID` and `MultiplayerClient` are not imported by either game entry point.

This split is more dangerous than any individual performance issue: contributors can optimize or add content to the wrong implementation without changing the live game.

**Recommendation:** Make `src/reference` the canonical engine for now, rename it during a controlled migration, and either remove the legacy page from the production build or explicitly freeze it as a museum/demo. Do not try to merge both implementations line by line.

---

## 5. How the current `/` game works

### 5.1 Startup and lifecycle

`mountReferenceGame()` in `src/reference/main.jsx`:

1. creates a canvas and React overlay;
2. creates a Three.js scene, renderer, and camera;
3. constructs biome, bridge, player, sign, environment, audio, and item managers;
4. creates 35 food pickups immediately;
5. starts one `requestAnimationFrame` loop;
6. displays the React landing screen over the already-running 3D scene.

Clicking Start only enables and reveals the player. Clicking Exit hides/disables the player and returns to the landing UI; it does not dispose the renderer/world or stop the frame loop. Full disposal exists, but is only used when the mount itself is torn down or during HMR.

### 5.2 Frame process

The current frame flow is:

```text
requestAnimationFrame
  ├─ calculate capped delta and world time
  ├─ if playing:
  │    ├─ Player.update(delta)
  │    │    └─ sub-step movement at <= 1/120 s
  │    └─ ItemManager.update(time, playerBounds)
  ├─ else: update overview camera
  ├─ BiomeManager.update(focus, time)
  │    ├─ evict distant chunks
  │    ├─ filter/sort all descriptors by distance
  │    ├─ run chunk generators within a 3 ms soft budget
  │    └─ stream/animate train and boat
  ├─ Environment.update(time)
  ├─ EffectComposer.render(delta)
  └─ publish FPS to React every 500 ms
```

This is correctly a **single game loop**. React does not own simulation, and telemetry updates only twice per second, so React itself is not the main runtime bottleneck.

### 5.3 World representation

The active world contract is hardcoded in `BiomeManager.js`:

```text
bounds:       -128 <= X,Z < 128
world size:   256 × 256
chunk size:   32
chunk count:  8 × 8 = 64
tile size:    4
terrain:      8 × 8 tile columns per chunk
water:        one 256 × 256 plane below terrain columns
```

`terrainHeight(x,z)` analytically chooses water/land and stepped Kerala hills. `biomeAt(x,z)` divides land into Maharashtra, Karnataka, and Kerala. River shape, landmark ownership, train line, vegetation, and buildings are deterministic coordinate rules.

A `BiomeManager` generator processes one strip of eight terrain tiles, yields, then eventually calls `VoxelBatch.build()`. This makes generation cancellable and usually spreads CPU work across frames. Final instance-buffer construction/upload is still an unbounded main-thread step.

### 5.4 Rendering model

`VoxelBatch` groups boxes by `color:metalness`. Each group becomes one `InstancedMesh` with:

- a box geometry owned by that batch;
- a newly allocated material;
- an instance matrix per voxel/box;
- shadow casting and receiving enabled.

This is much better than one Three.js `Mesh` per block, but it creates one renderable/material **per color per chunk or asset batch**. It optimizes object count but not enough draw submissions, material count, shadow work, or hidden box faces.

### 5.5 Movement and collision

Player terrain height is an O(1) analytical query aligned to rendered four-unit tile centers. Movement:

- normalizes diagonal input;
- accelerates/decelerates with exponential interpolation;
- splits frames into steps no larger than 1/120 second;
- caps simulation catch-up at 100 ms;
- tests four footprint corners against terrain and bridges;
- uses bridge deck and rail AABBs;
- respawns after falling below the world.

This is appropriately simple for the current game. It will scale poorly only when global bridge/collider arrays become large, because bridge queries linearly scan all bridge segments/rails.

### 5.6 Content and game state

Current foods, terrain, landmarks, bridges, signs, and placements are JavaScript definitions. `ItemManager` creates all food instances for the entire map during startup and iterates every uncollected item every playing frame. This is fine for 35 objects but not for thousands of items across India.

The UI store is local and immutable. There is no save layer or server authority. Hotbar selection communicates intent through `onSelect`, but selection does not currently grant or use an item.

### 5.7 Networking status

`mountReferenceGame` accepts two integration seams:

- `getWorldTime()` for shared actor animation time;
- `subscribePing()` for measured latency.

`src/network/MultiplayerClient.js` separately implements JSON-over-WebSocket remote-player snapshots and 100 ms interpolation, but nothing imports it. It lacks a matching server, authentication, server reconciliation, input validation, interest management, persistent identity, inventory authority, and a complete disposal/reconnect lifecycle.

---

## 6. Performance findings

### 6.1 Measured structural baseline

A Node-side construction of all 64 chunks at the normal center focus, plus train, houseboat, all bridges, and all food, produced this lower-bound scene inventory:

| Metric | Observed |
|---|---:|
| Loaded world chunks | 64 / 64 |
| `InstancedMesh` objects | 425 |
| Box/asset instances | 9,310 |
| Unique geometry objects | 104 |
| Unique material objects | 425 |
| Approximate instanced triangles | 111,720 |
| Shadow-casting instanced meshes | 425 |

This excludes the player, signs, water, environment, and post-processing passes. It is a structural count, not an exact GPU frame capture: frustum culling can remove some meshes, while shadows and post-processing add more passes.

The triangle count is not alarming. The high number of independently submitted meshes/materials, broad shadow participation, SSAO, and render-target pixel count are more likely constraints on low-end devices.

### 6.2 The current load radius defeats steady-state streaming

At map focus `(0, -7)`, the default 150-unit radius selects **all 64 descriptors**. The streaming system controls startup pacing and can evict chunks near a world edge, but it does not reduce the normal overview's steady-state memory or scene complexity.

For a larger finite descriptor list, `BiomeManager.update()` also performs a full descriptor `filter()` and distance `sort()` every frame. This makes update work dependent on total world size, which violates the desired scaling property.

### 6.3 Highest-cost hotspots

| Priority | Hotspot | Why it matters |
|---|---|---|
| P0 | Eager WebGL/game initialization | Landing consumes GPU/CPU/memory before user intent; Exit does not free it |
| P0 | Two runtime architectures | Performance and content work can target dead/legacy code |
| P0 | 425 material/renderable batches | CPU submission/state-change cost; many are also shadow casters |
| P0 | Unconditional SSAO + 1.5 DPR | Pixel cost and multiple full-size render targets dominate integrated/mobile GPUs |
| P0 | 2048² broad soft shadows | Expensive shadow rendering and memory; every voxel batch casts |
| P1 | All 64 chunks loaded in overview | No current steady-state streaming benefit |
| P1 | Full descriptor scan/sort each frame | Cost grows with total map area |
| P1 | All items/signs/bridges global | Startup, update, rendering, and collision grow with content count |
| P1 | Full boxes for terrain columns | Hidden side/bottom faces and excess transforms compared with a surface mesh |
| P1 | Main-thread final chunk build/upload | The 3 ms generator budget cannot cap the final GPU upload step |
| P2 | Large sign canvases | Three 1024 × 384 textures are excessive for world signs on low mode |
| P2 | Full 3D overview map | A larger world would require loading/rendering far more content for `M` |
| P2 | Fixed water plane and bounds | Immediate blockers to increasing map dimensions |
| P2 | Linear bridge collision scans | Becomes costly when many bridge segments exist globally |

### 6.4 Existing good performance decisions

These should be retained:

- deterministic coordinate-based generation;
- chunk ownership and explicit disposal;
- load/unload hysteresis;
- cancellable generator jobs;
- distance-to-chunk-AABB prioritization;
- aggregate chunk frustum culling through `InstancedMesh` bounds;
- one animation loop;
- capped/sub-stepped physics;
- analytical terrain queries instead of scene raycasts;
- opaque water rather than transparency sorting;
- generated low-resolution water normals;
- UI telemetry throttled to 2 Hz;
- pausing simulation/render when the document is hidden.

---

## 7. Recommended target architecture

A manager/system architecture remains suitable. The project does not need an ECS merely to support a larger map.

```text
App Shell
  ├─ static/light landing and docs
  ├─ lazy game import
  └─ start / pause / exit / dispose lifecycle

GameRuntime (single RAF and ownership root)
  ├─ QualityManager
  ├─ RenderSystem
  ├─ PlayerSystem
  ├─ WorldStreamer
  │    ├─ Manifest / chunk address resolver
  │    ├─ priority queue + cancellation
  │    ├─ worker generation/decoding
  │    ├─ staged GPU uploader
  │    └─ memory-budgeted LRU cache
  ├─ SpatialIndex
  │    ├─ nearby colliders
  │    ├─ interactables/items
  │    └─ actors/players
  ├─ GameplayState
  ├─ AudioSystem
  └─ optional NetworkClient

Content Build Pipeline
  state source files
    → schema validation
    → deterministic placement checks
    → chunk partitioning
    → compact compiled chunk data
    → manifest/version/hash generation
    → visual + performance checks
```

### 7.1 Lifecycle-first shell

Before Start, show a CSS/HTML/React landing page with no WebGL context. Dynamically import and mount the game only after user intent. On Exit, either fully dispose it or retain a deliberately bounded warm cache and stop rendering. On pause/hidden/blur, clear input and throttle or stop updates.

This is the highest-confidence low-resource improvement because it reduces idle resource use to nearly zero without changing world visuals.

### 7.2 Quality profiles and adaptive rendering

Introduce `low`, `balanced`, `high`, and `auto` profiles. Example starting values:

| Setting | Low | Balanced | High |
|---|---:|---:|---:|
| DPR ceiling | 0.75–1.0 | 1.0–1.25 | 1.5 |
| SSAO | Off | Off or half-resolution | On |
| Shadow map | 512 | 1024 | 2048 |
| Shadow casters | Player + nearest hero assets | Near chunks only | Wider near field |
| Draw distance | Short | Medium | Long |
| Decoration density | 35–50% | 70% | 100% |
| Target FPS | 30/45 | 60 | 60 |

`auto` should use frame-time hysteresis, not only device labels: lower internal pixel ratio after sustained slow frames and restore it slowly after sustained headroom. Respect reduced motion, battery/data saving signals where available, and preserve a manual override.

Do not use SSAO as the only source of voxel depth. Encode inexpensive baked/vertex corner shading or palette variation so low mode still looks intentional.

### 7.3 Render batches

Replace “one material per color per chunk” with:

- one shared box geometry globally;
- one shared palette material per render family;
- `instanceColor` for voxel color;
- at most a small split for opaque dielectric, metallic/emissive, and special materials;
- shared ownership through a resource registry rather than disposing shared resources per chunk.

This can reduce hundreds of material objects and many per-chunk color draw groups. It will not by itself combine chunk draw calls, which is desirable because chunks still need independent culling and eviction.

For terrain, build one indexed stepped-surface mesh per chunk (tops plus only exposed shoreline/cliff faces), or use greedy meshing. Terrain does not need one full six-sided box instance per tile. Keep boxes/instancing for props where it preserves the art style.

### 7.4 Chunk-addressed world streaming

Do not prebuild or scan a list of every world chunk each frame. Derive nearby chunk coordinates directly from player position:

```text
center chunk = floor(position / chunkSize)
for coordinates in a bounded radius:
    calculate distance/priority
    request missing chunks
```

Use a priority queue and state machine such as:

```text
absent → requested → generating/decoding → upload-queued → resident → evicting
```

Use both spatial hysteresis and hard budgets:

- maximum resident CPU bytes;
- maximum estimated GPU bytes;
- maximum chunk jobs;
- maximum worker time/concurrency;
- maximum main-thread upload milliseconds per frame;
- LRU eviction outside the protected near radius.

Total world extent should affect manifest size and storage, but not per-frame neighborhood enumeration.

### 7.5 Worker generation and compact data

A Web Worker cannot create Three.js/WebGL objects for the main renderer, but it can:

- evaluate deterministic terrain/content rules;
- decode compressed chunk files;
- generate typed position/index/color buffers;
- produce collision and interactable metadata;
- transfer `ArrayBuffer`s without copying.

The main thread should convert a bounded amount of prepared data into GPU resources each frame. Avoid arrays of small JavaScript transform arrays for large chunks; use packed typed arrays.

### 7.6 Stream gameplay, not just terrain

Every chunk package should own layers such as:

- terrain mesh;
- static props/vegetation;
- hero landmark and LOD metadata;
- water/shore metadata;
- collision data;
- items/interactables;
- actor spawn descriptors;
- audio zones;
- state/region tags.

Items outside active chunks should be compact records, not live scene objects updated each frame. Collected IDs should be stored separately so regenerated chunks reconcile correctly. Signs, bridges, and landmark colliders should be registered/unregistered with chunk activation.

### 7.7 Spatial queries

Use chunk-local or grid-hashed collision/interactable lists. The player should query only its current and neighboring cells. Bridge height can be represented analytically per bridge segment or through nearby collider lists rather than scanning every bridge in India.

The existing analytical terrain query should remain the authoritative source for movement. Ensure the render generator and query use exactly the same versioned terrain function/data.

### 7.8 Larger-world camera and water

Do not make overview mode render the full gameplay world. Build a separate India/state overview representation with:

- simplified state polygons or very coarse terrain tiles;
- landmark icons/impostors;
- player marker;
- no normal gameplay decorations, collisions, pickups, shadows, or SSAO.

Use a camera-centered/repositioned water plane or water chunk tiles instead of one fixed 256-unit plane.

For maps in the low thousands of units, Three.js float precision is still acceptable. Add local chunk coordinates and origin rebasing only when world coordinates become large enough to produce visible jitter; do not introduce floating-origin complexity prematurely.

### 7.9 Multiplayer at scale

The eventual network model should be server-authoritative for movement limits, inventory, pickup claims, score, and persistence. Use area-of-interest subscriptions aligned with world chunks so a client receives only nearby players/actors. Quantized binary snapshots can follow after protocol correctness; JSON at 10–20 Hz is adequate for an early small test.

Required server-side capabilities include:

- identity/session authentication;
- room/state shard assignment;
- input/state validation;
- pickup conflict resolution;
- persistence and leaderboard storage;
- moderation/reporting;
- rate limits and protocol validation;
- observability and reconnect/resume semantics.

The current client interpolation code is a prototype, not a complete multiplayer architecture.

---

## 8. Content architecture and contributor process

The strategic content model should be data-driven, but raw voxel arrays alone are not enough. Define and version a real schema for:

- state identity, display/localized names, and geographic bounds;
- biome palettes and terrain parameters;
- chunk/zone ownership;
- landmarks with footprints, LODs, and collision policy;
- collectible definitions and spawn rules;
- roads, rivers, bridge anchors, and portals;
- cultural provenance, contributor credit, review status, and content warnings;
- performance budgets per chunk/asset.

Recommended contribution process:

1. Author state/landmark source in JSON or a browser editor.
2. Validate it against a versioned JSON Schema.
3. Run deterministic overlap, traversal, and spawn checks.
4. Compile content into chunk-addressed runtime packages.
5. Generate preview screenshots and a performance report.
6. Require cultural review and attribution/provenance review.
7. Publish a hashed manifest so clients/CDNs can cache unchanged chunks.

This converts “low-code contribution” from documentation into a real product capability and is also one of the strongest potential moats.

---

## 9. Product moat assessment

### 9.1 Current moat: weak/nascent

There is no meaningful technical moat in the current code by itself. Three.js, procedural boxes, seeded generation, instancing, and chunk streaming are standard and reproducible. The game also has no implemented network effects, persistent player graph, exclusive content corpus, creator tooling, backend data, or live economy.

The strongest current assets are instead:

- a distinctive India-first theme;
- a coherent voxel aesthetic;
- a broad and emotionally resonant content surface;
- browser/no-install distribution;
- the beginnings of a deterministic lightweight world engine;
- a contribution-oriented product story.

### 9.2 Defensible moat to build

The best defensibility is a reinforcing system, not a proprietary renderer:

1. **Cultural content graph:** a deep, reviewed, attributed corpus of regional landmarks, foods, stories, memes, festivals, sound, and local language metadata.
2. **Contributor network:** trusted regional creators, visible credit, state ownership/stewardship, review reputation, and fast contribution tools.
3. **Creation pipeline:** a web-based voxel/landmark editor, schema validation, instant preview, automatic chunking/LOD/performance checks, and one-click contribution.
4. **Community and social graph:** persistent identity, cooperative collection, regional events, state lobbies, safe communication, and recurring live content.
5. **Low-end browser performance:** excellent reach on inexpensive phones/laptops can become a real distribution advantage if measured and continuously protected.
6. **Brand and authenticity:** respectful humor, strong moderation, regional review, and recognizable original art direction.

The compounding loop should be:

```text
better tools → more regional contributors → richer authentic world
→ more explorers/social activity → more recognition and feedback
→ stronger contributor incentives → better content
```

### 9.3 Moat risks

- Calling the project “open-source” while applying an All Rights Reserved custom restriction creates ambiguity. GitHub currently detects no standard license. “Source available” may be more accurate unless an OSI-approved license is selected.
- Contributors need clear ownership, reuse, attribution, and commercial terms. Ambiguity can prevent the contributor network from forming.
- A strict zero-external-asset policy simplifies consistency and downloads but can limit cultural richness and creator velocity. Treat it as an art/performance constraint with tooling support, not ideology.
- Meme content can age quickly or create moderation/IP risk. Provenance, review, and retirement/versioning workflows are necessary.
- Breadth without gameplay depth can produce a large but shallow sightseeing map. State expansion should follow a repeatable core loop and retention model.

---

## 10. Prioritized implementation plan

### Phase 0 — Establish one truth

1. Declare the current `src/reference` runtime canonical.
2. Rename/move it in a controlled change and freeze/remove the legacy production entry.
3. Update README and contribution docs to match reality.
4. Add `npm test`, lint/typecheck (or JSDoc checking), build, and content-validation scripts to CI.
5. Add a benchmark/debug panel using `renderer.info`, resident chunks, generation/upload queues, frame-time percentiles, and memory estimates.

### Phase 1 — Immediate low-resource wins

1. Render a lightweight landing shell and lazy-import the game after Start.
2. Fully stop/dispose on Exit; pause rendering when appropriate.
3. Add quality profiles; default `auto` conservatively.
4. Disable SSAO in low/balanced initially.
5. Lower DPR and shadow map size; restrict shadow casters to player/near hero assets.
6. Reduce sign texture resolution on low mode.
7. Use a separate simplified overview map so overview no longer forces all gameplay chunks resident.

### Phase 2 — Reduce render submissions

1. Add a shared resource/palette registry.
2. Use per-instance colors and a small number of render families.
3. Convert terrain columns to chunk surface/greedy meshes.
4. Stream and batch pickups, signs, and decorations with their chunks.
5. Add distance/LOD policies for landmarks and actors.

### Phase 3 — Make map extent independent

1. Replace fixed descriptor arrays with coordinate-derived neighborhood enumeration.
2. Add a chunk state machine, priority queue, cancellation, and memory-budgeted LRU.
3. Move generation/decoding to workers using transferable typed arrays.
4. Cap and stage GPU uploads.
5. Replace fixed world bounds/water with manifest bounds and camera-centered/chunk water.
6. Add a spatial hash for collision and interactions.

### Phase 4 — Build the real state content pipeline

1. Define versioned schemas and manifests.
2. Compile content into chunk packages.
3. Migrate the existing three states as the reference implementation.
4. Add preview, traversal, overlap, schema, and per-chunk budget tests.
5. Add provenance, localization, contributor credit, and cultural review metadata.

### Phase 5 — Add persistence and multiplayer deliberately

1. Build accounts/session identity and persistent collection state.
2. Add an authoritative pickup/score service.
3. Add chunk-aligned area-of-interest multiplayer.
4. Add leaderboard, state lobbies, chat/moderation, and live operations only after the core protocol is observable and abuse-resistant.

---

## 11. Proposed performance acceptance criteria

These are starting engineering targets and should be calibrated against named test devices.

### Scaling invariant

- Test at 256², 2,048², and a 100×-area synthetic map.
- At a fixed player position, resident chunk count, update work, draw calls, and memory must stay within a small constant range independent of total world area.
- No per-frame iteration over all world chunks, items, landmarks, colliders, or players.

### Low profile

- No WebGL context or game bundle initialization before Start.
- Stable 30 FPS with p95 frame time below 33 ms on the selected low-end reference device.
- Ground-view render calls at or below approximately 60–80.
- Estimated steady GPU allocation below approximately 128 MB.
- No main-thread chunk generation/upload task over 8 ms; normal upload budget near 2 ms/frame.
- Memory plateaus during a 10-minute traversal and returns near its earlier level after eviction/revisit.

### Balanced profile

- Stable 60 FPS with p95 frame time near/below 16.7 ms on the selected entry-level laptop/reference phone.
- Ground-view render calls near/below 100.
- Estimated steady GPU allocation below approximately 256 MB.
- Dynamic resolution reacts gradually without visible oscillation.

### Correctness

- Deterministic chunk fingerprints for the same seed/content version.
- Revisit restores uncollected/collected state correctly.
- No bridge/river traversal regression at chunk boundaries.
- Cancellation never uploads an evicted chunk.
- Context loss and restore rebuild all generated resources.
- All resource owners pass repeated mount/start/travel/exit/dispose leak tests.

---

## 12. Decisions needed before optimization code begins

1. Is `src/reference` officially the product runtime, and can `/classic.html` be frozen or removed?
2. What is the first required map size: all India around 1,000 × 1,100 units, a much larger continuous world, or effectively unbounded procedural terrain?
3. Which exact low-end devices and browser versions are contractual targets?
4. Is 30 FPS acceptable on low mode, or is 60 FPS mandatory everywhere?
5. Must overview show all of India in live 3D, or can it use a simplified map representation?
6. Is the world fully procedural, curated chunk content, or a hybrid?
7. Is the contributor model truly open-source, source-available, or a commercial creator program?
8. Is multiplayer needed in the next milestone, or should performance/content tooling come first?

## Bottom line

The project has a solid vertical-slice foundation and several good engineering instincts, but it should currently be treated as a **prototype with a scalable-streaming seed**, not yet a scalable India-wide engine. The fastest path is:

> unify the runtime → instrument it → stop eager work → add low-power quality profiles → reduce batches/shadows → make all world systems chunk-owned → move generation off-thread → activate a validated content pipeline.

The likely long-term moat is not Three.js code. It is the combination of authentic regional content, creator tooling and stewardship, persistent social collection, trusted moderation, recognizable brand, and unusually good performance on low-cost devices.

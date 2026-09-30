# Clipping, Hitbox, and Automatic Layering Research

**Research date:** 2026-09-16
**Status:** design authority with implementation checkpoints through 2026-09-17. Exact mapped collision rings, role masks, swept player/camera queries, terrain/road support, layer policy, exact support slots, hydrology overlap/domain fields, vegetation role clearances, and `DET-04` visual-only building detail isolation are implemented; later dynamic/fade/label systems and moving browser audits remain pending.
**Target:** the shared browser-local procedural engine, with Coordinate Explorer as the first proving ground and low-end/mobile hardware as the limiting profile.

## Programmatic verification policy (supersedes browser capture)

**Status:** browser capture tooling is retired as a project dependency. Automated Chromium installation, screenshots, and video are deleted from the acceptance gates, and no checkpoint below may remain `PARTIAL`/`DEFERRED` because of them; the historical notes that say "capture unavailable" are kept as dated history.

The evidence a moving capture used to provide is produced deterministically instead:

- `src/engine/MovementAudit.js` — fixed-step scripted paths over the real runtime with verdicts for determinism, clipping (camera clearance against real blockers), render-band ordering, LOD/resident churn, subpixel/mip/fade, and per-step stability. Failure reports name the verdict, path, and sample index.
- `src/engine/DebugHooks.js` — `window.__gdo` exposes `probe()`, `ledger()`, `step(dt, steps)`, `log.text()`, and `audits.run('movement')`, with a bounded `[gdo:*]` log ring a test can read back.
- `src/engine/LifecycleContract.js` — one owner-scoped ledger proves zero-growth remount and names any leaked worker, listener, geometry, material, mesh, node, timer, or handle.

A moving claim is accepted when those reports pass on the real runtime and the numbers are recorded in the roadmap changelog. Human viewing remains useful, but it is not a gate.

## 1. Recommendation in one sentence

Keep mapped building rings authoritative, replace arbitrary padding and point samples with **role-specific tight proxies plus bounded swept queries**, and drive surface height, render pass, visibility, collision, camera obstruction, and placement from one semantic layer descriptor without ever treating those different kinds of “layer” as interchangeable.

```text
map feature / generated object
           ↓
semantic role + stable owner + vertical span
           ↓
┌─────────────────────────────────────────────────────────────┐
│ visible geometry │ solid proxy │ trigger │ camera proxy     │
│ placement extent │ render band │ query mask │ support layer │
└─────────────────────────────────────────────────────────────┘
           ↓
static packed tile index + tiny dynamic proxy grid
           ↓
swept player / swept camera / sparse LOS and placement queries
```

The main rule is simple:

> A broad-phase bound may be conservative. An authoritative narrow-phase hitbox may not falsely occupy visible empty space.

## 2. “Clipping” is eight separate problems

Using one word for every artifact leads to the wrong fixes.

| Problem | Symptom | Correct family of fix | Not a fix |
|---|---|---|---|
| Collision penetration/tunnelling | player or moving prop crosses a wall | swept shape query, contact skin, depenetration | `renderOrder`, clipping planes |
| Oversized solid proxy | player stops in visible empty space | tighter authoritative narrow phase, debug comparison | shrinking the broad-phase AABB |
| Camera obstruction/intersection | TPP camera enters a wall or loses the avatar | swept near-plane proxy, vertical spans, asymmetric recovery | making every wall transparent |
| Near/far camera clipping | close geometry vanishes or distant detail is cut | camera near/far policy, self-fade in pathological TPP cases | bigger collision AABBs |
| Z-fighting/coplanarity | roads, land, decals, or modules flicker | semantic surface offsets, topology cleanup, polygon offset for decals | transparent blending |
| Transparent ordering | water/foliage layers blend in the wrong order | opaque/alpha-tested substitutes, bounded sorting/pass rules | more Y offsets alone |
| Procedural module intersection | tanks float outside roofs; branches enter walls | support-domain tests, occupancy/clearance, deterministic skip/prune | per-triangle collision at runtime |
| DOM label occlusion | a place name appears through a building | sparse line-of-sight query or in-scene label | CSS z-index |

Three.js material clipping planes only discard rendered fragments. They do not repair movement, update collision, stop a camera, or resolve procedural placement, so they are not the proposed general solution.

## 3. Current repository audit

### 3.1 What is already correct and must be preserved

- `GeoTileBuilder.buildBuildingGeometry()` retains mapped polygon rings, including holes, in packed typed arrays.
- `GeoWorld.collidesCircle()` uses building AABBs only to find candidates, then calls `circleIntersectsFootprint()` for an exact circle-versus-packed-ring narrow phase.
- A rotated or L-shaped building therefore does **not** make the empty corners of its AABB solid.
- Building collision arrays remain owned by the source tile and are disposed with that tile.
- Roads are generated and transferred before buildings in `GeoTileWorker.js`.
- The player update is substepped to at most 1/60 s even when the rendered frame gap reaches 100 ms.
- Curated bridge deck and rail proxies are separate AABBs rather than one oversized bridge box.
- Visual decoration boxes do not currently become player colliders automatically.

These are foundations, not systems to replace.

### 3.2 Concrete risks and defects

| Area | Current behavior | Finding |
|---|---|---|
| Coordinate player | `BODY_RADIUS = 0.09` | collision diameter is `0.18`, while the widest visible arm envelope is about `0.113`; this is the clearest oversized movement-proxy risk |
| Coordinate movement | substepped, X then Z endpoint overlap tests | ordinary tunnelling risk is reduced, but contacts stop harshly, corner behavior is axis-order dependent, and the code does not return time-of-impact or contact normal |
| Safe spawn | radius `0.16` | this is a spawn-clearance query, not the movement hitbox; diagnostics must label it accordingly |
| Coordinate building broad phase | one AABB per mapped polygon | intentionally conservative and correct because exact rings reject false positives; it must not be presented as the “hitbox” in debug UI |
| Building collision height | no packed base/top span | acceptable for ground walking, but makes every footprint an infinite vertical camera blocker |
| TPP camera | samples a horizontal circle every ~`0.12`, at most 32 samples | misses 3D facade/roof/terrain semantics and computes only an approximate first contact |
| TPP smoothing | final camera position lerps toward the already-clipped desired point | after sudden obstruction, the old camera can remain behind or inside the blocker while it eases inward; emergency compression should not be smoothed this way |
| Camera proxy | fixed radius `0.07` | unrelated to the actual camera near plane; at FOV 68°, near `.02`, 16:9, the near-plane half-diagonal is about `.028` |
| Curated TPP camera | only clamps camera above terrain | no structure/bridge/landmark obstruction test |
| Surface layering | land `.006–.012`, water `.02`, roads `.025`, bridge roads `.055`, curbs `roadY-.002`, markings `roadY+.007/.009` | useful local fixes but scattered magic numbers, not a semantic contract |
| Renderer ordering | `renderer.sortObjects = false` | in Three r170 this skips render-list sorting, so `renderOrder` is not consulted; `tile.water.renderOrder = 1` does not establish the intended order |
| Transparency | tile water is transparent, opacity `.90`, `depthWrite:false` | opaque objects still depth-test correctly, but overlapping water fragments can double blend and transparent tiles are not distance sorted |
| Water geometry | polygon water and waterway ribbons can share a mesh | source overlap can produce self-overdraw that object sorting cannot solve because Three.js does not sort triangles within a mesh |
| Labels | projected DOM labels, overlap suppression only | labels do not participate in WebGL depth and can show through buildings |
| Placement halo | `blockedByMap()` hard-codes `.22` around all buildings | this is not a hitbox, but one clearance for flowers, trees, cars, and furniture can create unnecessary empty halos |
| Rooftop tank | placed at the center of the footprint AABB | for concave footprints or holes, the AABB center can fall outside the roof surface |
| Merged boxes | overlapping complete cubes are merged without unioning faces | hidden/intersecting faces remain, increasing triangle cost and allowing internal coplanarity artifacts |
| Curated collectibles | ±`1.6` AABB or radius `1.5` pickup test | intentionally forgiving **interaction trigger**, not a solid hitbox; it should be named and debugged separately |
| Curated player | movement AABB is generally smaller than visible arms/torso | not an oversized-hitbox example; any future unification should still use an explicit measured profile |

### 3.3 Important Three.js ordering fact

Three r170 collects opaque, transmissive, and transparent objects into separate lists and renders them in that pass order. When `sortObjects` is true, the default comparisons use group order, `renderOrder`, material, and depth. When it is false, the lists retain traversal order and `renderOrder` is not applied.

That means the current combination:

```js
renderer.sortObjects = false;
tile.water.renderOrder = 1;
```

is not a manual transparent-order policy. It is effectively traversal-order transparency. With only a few water meshes it may look acceptable, but it is not safe to expand with glass, rain, faded foliage, and particles.

## 4. Authoritative bounds contract

Every generated or mapped object should expose separate roles. One `Box3` must never silently serve all of them.

```js
{
  id,                         // stable procedural/map feature identity
  ownerTile,                  // exactly one half-open source-tile owner
  visualBounds,               // culling and diagnostics only
  solidProxy,                 // movement obstruction; null by default
  interactionProxy,           // pickup/use trigger; can intentionally be generous
  cameraProxy,                // blocker or fade-eligible proxy
  placementExtent,            // spacing/ecology, not gameplay collision
  supportProxy,               // ground/deck/step surface where relevant
  verticalSpan: [baseY, topY],
  queryMask,
  renderBand,
  surfaceLayer,
}
```

### 4.1 Rules

1. **Visual detail is non-solid by default.** A small box, leaf cluster, sill, lamp arm, wheel, bird wing, or roof accent does not opt itself into collision.
2. **Broad-phase bounds can overestimate; narrow-phase solids cannot.** A building AABB remains useful, but packed rings decide the hit.
3. **Total movement clearance must fit the intended body envelope.** `shape radius + contact skin` should not exceed the measured authoritative profile unless a documented gameplay rule requires it.
4. **Interaction forgiveness is explicit.** A pickup trigger can be wider than its model, but UI/debug labels it “interaction range,” never “hitbox.”
5. **Placement spacing is explicit.** Tree crown spacing, road setback, and a flower’s base clearance are different values.
6. **Camera blocking is semantic.** Walls, terrain, bridge decks, and large trunks can block the camera; grass blades and bees should not.
7. **Silhouette protrusions do not mutate mapped building rings.** Coordinate-mode facade and roof detail stays visual unless a separately justified gameplay proxy is added.
8. **Culling bounds do not become collision.** `computeBoundingBox()` and `computeBoundingSphere()` are rendering data.

### 4.2 Coordinate player profile

`MINIMAL_PHYSICS_RESEARCH.md` recommends testing radii in the `0.05–0.06` range against the current compatibility value `0.09`. The stricter clipping gate should be:

- measure the stable torso/leg navigation envelope, not an animation-wide arm swing;
- start the test matrix around radius `.05–.055`;
- allow `.06` only if overlay diagnostics prove the **shape plus skin** remains inside the intended visible/authoritative envelope;
- use a separate eye/camera margin rather than inflating the player to protect the near plane;
- store one profile per stance only if crouch or other stances are later implemented.

A plausible initial experiment is a `.048–.052` body radius plus `.003–.005` contact skin, but the acceptance gauntlet—not this number—chooses the final setting.

## 5. Lightweight query architecture

### 5.1 Keep static and dynamic worlds separate

**Static tile index**

- Existing 4-unit hashed grid.
- Packed exact building rings and holes.
- Add compact `Float32Array` base/top spans aligned with polygon indices.
- Add only deliberate static proxies: terrain support, bridge deck/rails, major rocks/trunks if gameplay requires them.
- Tile owns and disposes every array.

**Dynamic proxy grid**

- Small spatial hash for moving vehicles, train cars, boats if solid, moving platforms, and future local agents.
- Primitive proxies only: circle/capsule in XZ plus Y span, AABB/OBB, or short compound list.
- Reinsert only after a proxy crosses a cell boundary.
- Hard cap: 64 low, 128 balanced, 256 desktop active dynamic proxies.
- No dynamic body per decorative box.

The movement/controller layer queries both and merges candidate contacts. This is far cheaper than constructing a rigid-body world for every generated element.

### 5.2 Query masks

Three.js `Object3D.layers` and `Raycaster.layers` are useful visibility/raycast masks, but they are not a gameplay collision system. Keep a compact engine-owned mask in proxy data.

| Bit/role | Typical members | Queried by |
|---|---|---|
| `SOLID_PLAYER` | building rings, bridge rails, deliberate large trunk/rock, solid vehicle | player sweep |
| `SUPPORT` | terrain, road/deck surfaces, steps | grounding/snap |
| `CAMERA_BLOCKER` | terrain, walls, roofs, bridge decks, substantial props | TPP camera sweep |
| `FADE_ELIGIBLE` | crown clusters, small foreground clutter | camera visibility fallback |
| `LOS_BLOCKER` | opaque walls/roofs, large terrain | labels and gameplay LOS |
| `INTERACTION` | pickups, switches, POI use zones | use/pickup query |
| `PLACEMENT` | map footprints, roads, water, reserved routes | procedural placement only |
| `DEBUG_ONLY` | proxy visualizers | diagnostic camera/raycaster |

Automatic assignment comes from semantic role, with explicit opt-in overrides. Render visibility can mirror some roles through Three.js layers, but the two masks remain separate.

## 6. Player movement: bounded sweep and slide

The current 1/60 substeps are worth retaining as a safety bound. Replace endpoint-only response incrementally rather than importing a large physics engine for this task.

### 6.1 Proposed query

For each substep:

1. Build a swept broad-phase AABB around start, end, body radius, and skin.
2. Query relevant static tile grid cells and dynamic grid cells.
3. Reject candidates whose vertical span cannot overlap the body.
4. For packed building rings, sweep the body center against ring edges expanded by the body radius:
   - each edge behaves as a segment capsule;
   - vertices provide the round caps;
   - holes retain their existing semantics.
5. Select earliest time of impact `t` in `[0,1]`.
6. Move to `t - skin`.
7. Project the unconsumed displacement onto the contact tangent.
8. Repeat at most two contact iterations; discard the remaining component if still blocked.
9. If the starting point is penetrating after spawn/stream recovery, run one bounded minimum-separation pass.

This adds normals and smooth wall sliding while keeping work proportional to nearby candidate ring edges.

### 6.2 Hard limits

| Quantity | Low/balanced policy |
|---|---:|
| simulation substep | ≤ 1/60 s |
| contact iterations per substep | 2 |
| depenetration iterations | 2, then safe-position fallback |
| dynamic candidates accepted for narrow phase | 32, nearest-first |
| pathological edge candidates | cap and record diagnostic; use endpoint-safe fallback |
| per-frame heap allocation | zero in steady state |

### 6.3 Failure policy

- If exact packed data is absent, use the existing conservative AABB fallback and expose `proxyFallbacks` in diagnostics.
- If a tile is not ready, do not invent a permanent wall at its boundary; retain current resident tile long enough for the prefetched neighbor and apply a short movement safety clamp only at truly unavailable data edges.
- If candidate caps are exceeded, stop at the earliest conservative bound for that substep rather than allowing penetration.

## 7. TPP camera collision and visibility

### 7.1 Proxy derived from the near plane

For perspective camera near distance `n`, vertical FOV `f`, and aspect `a`, the near-plane half-diagonal is:

```text
nearHalfHeight = n · tan(f / 2)
nearHalfWidth  = nearHalfHeight · a
nearRadius     = sqrt(nearHalfWidth² + nearHalfHeight²)
```

At FOV 68°, near `.02`, aspect 16:9, this is about `.028`. A camera sweep radius around `.03–.04`, including a small skin, is therefore defensible. The current `.07` should not remain an unexplained constant.

A sphere is conservative at roll-free orientations. A higher-quality profile can cast the near-plane center plus four corner rays, but the sphere sweep is the recommended low-cost baseline.

### 7.2 3D obstruction algorithm

1. Define a target/pivot that is guaranteed outside the player solid and preferably above the shoulder.
2. Sweep the near-plane sphere from target to desired camera position against `CAMERA_BLOCKER` proxies.
3. For buildings, combine exact XZ ring contact with `[baseY, topY]`; roofs stop the camera only when the swept sphere overlaps their Y span.
4. Include terrain/support height and deliberate bridge/large-prop proxies.
5. Return earliest legal arm length and blocker ID.
6. Apply a nonzero surface skin.
7. **Snap or heavily damp inward compression** so no rendered frame remains behind a newly hit wall.
8. Delay and smoothly damp outward recovery.
9. Add arm-length hysteresis so adjacent thin edges do not cause breathing/chatter.
10. Preserve user yaw/pitch; collision shortens the arm before it attempts any automatic orbit.

### 7.3 Foliage and close-avatar fallback

Use fading only for explicitly eligible clutter:

- structural walls and closed building masses compress the camera;
- crown clusters, reeds, and small clutter can use an opaque screen-door/dither discard near the camera-player segment;
- do not switch many materials to blended transparency;
- do not fade an entire merged building tile because one facade blocks the view;
- if the camera is pathologically close to the avatar, dither the avatar itself before allowing the near plane to cut through it.

A 4×4 Bayer pattern or tiny generated dither texture is adequate. Every surviving fragment remains opaque/depth-writing, avoiding the worst blended-transparent sorting behavior. With antialiasing disabled, alpha-to-coverage is not a dependable baseline.

### 7.4 Curated mode

The shared engine should expose one camera-obstruction interface. Curated mode can initially register:

- analytic terrain support;
- bridge decks and rails already present;
- landmark structural compounds;
- large building masses;
- no leaves, grass, or food-trigger volumes.

This removes the current behavioral split without requiring curated and mapped geometry to share storage formats.

## 8. Procedural-module clipping

Runtime CSG, triangle-triangle tests, and one collider per detail box are all rejected for the low-end target.

### 8.1 Support-domain placement

Each attachment is generated in a local support frame:

```js
{
  origin,            // point on roof/facade/ground/deck
  tangent,
  normal,
  up,
  domain,            // polygon, edge interval, or slot rectangle
  inset,
  moduleOBB,
  priority,
  stableKey,
}
```

Checks are cheap and semantic:

- roof module anchor and all footprint corners must be inside the roof polygon and outside holes after an inset;
- facade module interval must fit on one wall edge and not overlap a reserved door/entrance slot;
- ground module uses its actual base radius rather than a universal `.22` buffer;
- bridge detail is constrained to a deck/rail segment frame;
- crown envelope samples nearby blockers and prunes or flattens the blocked side;
- a module gets 2–4 deterministic candidates, then shrinks or skips.

The current AABB-center rooftop tank should become an inside-polygon sample. Concave buildings that have no inset roof cell simply omit the tank.

### 8.2 Tiny occupancy grid

For generated hero objects or one roof/facade:

- quantize a local occupancy grid at the object’s **surface-detail** scale;
- reserve silhouette and functional slots first;
- place surface detail second;
- place accents last;
- allow declared overlaps such as branch-to-crown or wheel-to-chassis;
- reject undeclared OBB overlap;
- stop after a fixed candidate count.

This is an object-local generation aid, not a global physics voxel world.

### 8.3 Deterministic conflict resolution

Sort candidates by:

```text
semantic priority → stable feature/module key → slot index
```

When the budget or space runs out, drop in this order:

```text
micro accent → optional surface relief → optional secondary silhouette
```

Never drop the authoritative footprint, road, entrance opening, bridge deck, or required support proxy.

## 9. Automatic layering contract

“Layer” must be represented by coordinated descriptors, not one magic integer.

```js
LayerRole = {
  generationStage,
  supportClass,
  elevationBand,
  coplanarPriority,
  renderPass,
  renderOrder,
  depthTest,
  depthWrite,
  queryMask,
  cameraVisibility,
};
```

### 9.1 Generation stages

| Stage | Output | Dependency |
|---:|---|---|
| 0 | decode map + stable IDs | downloaded small MVT chunk |
| 1 | terrain/hydrology supports | map/environment fields |
| 2 | **roads** and route reservations | stage 0/1 |
| 3 | mapped building masses and packed rings | stage 0; roads already emitted/mounted first |
| 4 | land/water context and attachment supports | stage 1–3 semantics |
| 5 | structural silhouette modules | stages 2–4 |
| 6 | vegetation and street furniture | placement reservations |
| 7 | surface/accent detail | support slots and budgets |
| 8 | labels and ambient life | completed semantic scene |

The worker may compute independent data in a different internal order only when the externally visible streaming contract still publishes roads first and cancellation remains possible between phases.

### 9.2 Surface/elevation bands

Physical grade comes first; the band is a tiny local tie-breaker, not a fake bridge height.

| Surface | Suggested relation to support | Notes |
|---|---:|---|
| base terrain | `supportY + 0` | authoritative ground |
| land-cover overlay | `+ landBias` | one centralized, minimal bias; overlapping source kinds need stable priority |
| at-grade road | `+ roadBias` | same support system as terrain |
| curb/shoulder | geometric thickness or below road top | avoid drawing curb lines through crossings |
| road marking | road top + decal bias or polygon offset | no independent arbitrary world height |
| water | hydrologic level, not “above road” ordering | actual vertical relation decides occlusion |
| bridge/tunnel | parsed map level/bridge/tunnel support | never represented by decal bias alone |
| ground decal/contact patch | support + decal bias | polygon offset may be appropriate |
| solid object | rests on support | no layer bias |

Use a small named constant set and scale it with world units/depth precision. Do not accumulate offsets per feature until surfaces visibly float.

Map `layer`, `level`, `bridge`, and `tunnel` tags should map to a bounded physical support level. Missing tags use deterministic defaults and diagnostics, never unbounded source values.

### 9.3 Same-grade road overlap

A Y offset cannot fully solve intersecting road ribbons of equal grade. Preferred order:

1. generate proper joins/intersection fill where affordable;
2. suppress curbs and lane marks through junction reservation zones;
3. use class/coplanar priority as a bounded depth bias for remaining same-grade overlap;
4. never turn a crossing into a visible staircase of large Y offsets.

### 9.4 Render passes

| Pass | Material policy | Sorting policy |
|---|---|---|
| sky/background | depth test/write off | explicit background path/order |
| opaque world | depth test/write on | front-to-back/material sorting where renderer provides it |
| alpha-cut/dither | still depth-writing | opaque-like; bounded discard |
| blended water/effects | depth test on, usually depth write off | back-to-front or explicit bounded pass |
| debug | dedicated layer/material | excluded in production |
| DOM UI | outside WebGL | explicit LOS for world labels |

For the current bounded scene-object count, re-enabling Three’s default sorting is the simplest candidate and should be benchmarked before inventing manual ordering. If sorting stays disabled, implement an actual explicit pass/list order; do not rely on `renderOrder`.

`Object3D.renderOrder` can override default object sorting but opaque and transparent lists remain independent. It does not sort triangles within merged water or foliage geometry.

## 10. Depth and transparency policy

### 10.1 Near/far planes

Depth precision is strongly affected by `far / near`. Coordinate mode currently uses `.02 / 210`, a ratio of 10,500, while fog ends at 175.

Research recommendation:

- first fix coplanar geometry and scattered offsets; exact coplanarity is not cured by a different depth format;
- test near `.03–.04` in both FPP and compressed TPP;
- pull far toward the fog limit plus a small safety margin if no visible feature needs 210;
- retain ordinary depth on low-end hardware;
- do not enable logarithmic depth for this scale: Three documents that its `gl_FragDepth` path can disable early fragment testing and reduce performance;
- reversed depth is only a future capability-gated option and is unnecessary unless the world-scale range changes substantially.

### 10.2 Water

Low profile should test opaque stylized water first. Color, Fresnel-like tint, waves, shore masks, and normals do not require alpha blending.

If `.90` blended water remains:

- restore bounded transparent sorting or render water in one explicit pass;
- eliminate polygon/ribbon duplicates during generation;
- ensure intersecting water surfaces are not expected to sort correctly inside one mesh;
- keep `depthTest:true`;
- use `depthWrite:false` only with deliberate awareness that later transparent layers can show through;
- avoid adding general glass and rain to the same uncontrolled pass.

### 10.3 Foliage and weather

- Box-built foliage stays opaque.
- Any leaf/grass cards use `alphaTest` or dither discard, not soft blending.
- Transparent particle screen coverage is budgeted, not count alone.
- Intersecting transparent planes are not an acceptable tree architecture for this project’s baseline.

### 10.4 Polygon offset

Three’s polygon offset changes fragment depth before depth testing/writing and is suitable for bounded decals or highlighted edges. It should not define the physical hierarchy among terrain, water, roads, bridges, and buildings.

## 11. Tile ownership and streaming invariants

### 11.1 Stable owner

- Every map feature keeps its source-tile owner.
- Every generated placement belongs to the half-open tile containing its anchor: `[minX,maxX) × [minZ,maxZ)`.
- A crown, bridge detail, or facade attachment may visually cross a boundary but is not duplicated into the neighbor.
- Dynamic objects use an actor owner independent of tile meshes, with stable IDs.
- Global render pools store owner handles; tile eviction removes exactly those records.

### 11.2 Cross-boundary queries

A sweep can overlap several resident tiles. Query all intersected tile bounds, deduplicate stable feature IDs where providers duplicate boundary features, and retain exact per-tile rings.

Do not merge all static collisions into one unowned global mesh. That would make cancellation, memory accounting, eviction, and deterministic reload harder.

### 11.3 Visual overhang

A tile must not be evicted while a large owner-held crown/module can still be visible just outside its anchor tile. Expand streaming/culling relevance by the maximum declared visual overhang, not by duplicating geometry.

### 11.4 Versioning

Stable keys should include:

```text
worldRecipeVersion / source z-x-y / feature ID or stable geometry hash / module role / slot
```

Quality changes choose a different compiled LOD but must not change placement ownership or collision rings.

## 12. Diagnostics

### 12.1 Required overlays

| Overlay | Display |
|---|---|
| bounds roles | visual bounds grey, broad phase amber, solid proxy red, trigger cyan, camera proxy violet, placement extent green |
| exact buildings | packed outer rings and holes, polygon index, tile owner, base/top span |
| player | measured visual envelope, body shape, skin, swept path, contact normal, remaining slide |
| camera | desired/actual arm, swept sphere, near-plane rectangle, hit point, blocker ID, recovery state |
| surfaces | semantic surface class, support level, actual Y, bias, render pass/order |
| transparency | object traversal/sort index, depth-write state, overdraw-prone overlaps |
| module occupancy | support domain, accepted/rejected slots, rejection reason |
| labels | label ray, blocker, LOS update age |
| streaming | tile bounds, owner IDs, visual overhang, query tiles |

### 12.2 Counters

```text
player sweeps / edge tests / contacts / depenetrations
camera sweeps / compressed frames / min arm / blocker changes
proxy fallbacks / candidate-cap events
solid proxy outside visual envelope violations
module attempts / skips / shrinks / overlap rejects
water overlap removals / transparent meshes
label LOS tests / hidden labels
surface bias range / near-coplanar pairs
```

Counters use fixed arrays/ring buffers and remain off or sampled in production.

## 13. Low-resource budgets

These budgets fit inside, rather than add on top of, `VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`.

| Resource | Low | Balanced | High/desktop |
|---|---:|---:|---:|
| Active dynamic solid proxies | 64 | 128 | 256 |
| Player contact iterations/substep | 2 | 2 | 3 |
| Camera sweeps/rendered frame | 1 | 1 | 1–2 |
| Camera narrow-phase candidate cap | 24 | 40 | 64 |
| Label LOS tests/second | 20 | 40 | 80 |
| Simultaneously LOS-tested labels | 5 | 10 | 14 |
| Module candidates per slot | 2 | 3 | 4 |
| Local module occupancy cells/hero object | ≤ 512 | ≤ 1,024 | ≤ 2,048 |
| Added steady collision/query memory | ≤ 256 KB | ≤ 512 KB | ≤ 1 MB |
| Added steady draw calls for debug-off clipping | 0 | 0 | 0 |
| Blended world material families | 1–2 | ≤ 3 | ≤ 5 |
| Generated camera-fade textures | one shared ≤ 8×8 mask | same | same |

CPU acceptance is more important than nominal counts:

- player + camera queries should average under `0.35 ms` low and `0.6 ms` balanced on the target audit device;
- 99th percentile should stay under `1.5 ms` outside tile-build frames;
- no steady-state allocations from movement, camera, label LOS, or layer resolution;
- dynamic-grid maintenance should update only moved/cell-crossing proxies.

## 14. Degradation and failure handling

Order of degradation under sustained frame pressure:

1. reduce label LOS update frequency and candidate count;
2. disable optional clutter fading while keeping camera wall compression;
3. stop querying non-structural camera blockers such as foliage;
4. simplify dynamic proxies from compounds to one tight primitive;
5. retain exact mapped building rings and player collision at all quality levels.

Never degrade by:

- enlarging hitboxes;
- replacing exact building rings with their AABBs as final collision;
- turning off player collision;
- making all structural walls transparent;
- duplicating tile-owned collision globally;
- allowing unloaded-neighbor movement to cross unvalidated geometry silently.

If a procedural module cannot be placed within candidate/budget limits, skip it. Missing accent detail is better than intersecting geometry, floating props, or an enlarged solid proxy.

## 15. Acceptance tests

### 15.1 Hitbox correctness

1. **Visible-envelope test:** sample all movement proxy support directions; `body radius + skin` never exceeds the approved player profile.
2. **Passage gauntlet:** corridors just below and just above `2 × (radius + skin)` block/pass consistently from both directions.
3. **L-building test:** player enters every visibly empty broad-phase corner without collision.
4. **Hole test:** a mapped courtyard hole remains traversable where an entrance/path permits access.
5. **Broad/narrow debug test:** AABB overlap alone never reports an authoritative hit when the exact ring rejects it.
6. **Detail isolation:** enabling roof/facade/small-box detail produces byte-identical mapped collision-ring arrays.
7. **Trigger separation:** collectible interaction range may be larger, but never blocks movement and is labelled separately.
8. **Trunk test:** only an opted-in trunk proxy blocks; crown/twig boxes do not.

**`DET-04` checkpoint:** the focus-tile building-detail batch is marked visual-only and shares no generated proxy path. Automated integration compares enabled/disabled output and proves byte-identical collider AABBs, exact vertices/ring/polygon offsets, vertical spans, and query masks. Roof modules revalidate exact support including courtyard holes; facade modules use one bounded mapped-road edge query, project outward, reserve their entrance zone vertically, and create no solid, interaction, or camera proxy. Tile eviction disposes the separate merged detail geometry and deterministic remount reproduces it. Moving FPP/TPP clipping and composition are not capture-gated: the shared movement audit reports camera clearance against real blockers for every fixed-step sample, so a negative clearance fails the audit by verdict, path, and sample index.

### 15.2 Movement

1. Sprint diagonally into long walls and all convex/concave corners at 30, 20, and simulated 10 FPS gaps; no penetration or tunnelling.
2. Wall contact preserves tangential motion without X/Z-order sticking.
3. Starting `skin/2` inside a wall depenetrates in bounded iterations.
4. A dynamic vehicle crossing the player path uses swept relative motion or a conservative stop; it cannot teleport through.
5. Candidate-cap fallback blocks conservatively and increments a diagnostic.

### 15.3 Camera

1. Orbit 360° around rectangular, rotated, L-shaped, concave, and thin buildings at minimum and maximum TPP distance.
2. Camera never renders from inside a `CAMERA_BLOCKER` and its near-plane corners remain legal.
3. Emergency inward compression resolves in the first affected rendered frame; outward recovery is smooth and hysteretic.
4. Camera can pass above a low building only when the packed vertical span permits it.
5. Low bridge/ceiling and terrain tests preserve legal pitch as far as possible.
6. Foliage fade affects only eligible clutter; structural walls remain opaque.
7. Pathological close TPP self-fade prevents avatar near-plane slicing.

### 15.4 Geometry and rendering

1. Inspect road/land/water overlap and a four-tile corner from all cardinal directions and low grazing angles; no flicker.
2. Compare sort enabled/disabled test harness: the chosen production policy has deterministic water order.
3. Overlapping waterway/polygon source features do not darken from duplicate blending.
4. No alpha-blended foliage family is introduced.
5. Surface offsets remain within the named contract and do not accumulate per source layer indefinitely.
6. FPP at walls does not expose building interiors through the near plane.

### 15.5 Procedural modules

1. Roof details remain inside concave roof polygons and outside holes with the specified inset.
2. Facade modules stay attached to their wall frame and do not cover reserved entrances.
3. No undeclared module OBB overlap survives the conflict resolver.
4. Fixed seed + feature ID + quality produces stable module decisions; lower quality removes detail without moving solids.
5. Budget overflow drops accents first and terminates in bounded attempts.

### 15.6 Labels and ownership

1. A label behind a building is hidden within the LOS update interval; a label in front remains visible.
2. Label LOS does not use collectible, grass, bird, or bee proxies.
3. Reloading/evicting a tile reproduces the same collision/module checksums.
4. A boundary-spanning tree/module has one owner and one render instance.
5. Evicting a neighbor cannot remove the owner tile’s proxy or detail.

### 15.7 Performance

- Existing 30 FPS low-profile target remains met in the agreed coordinate audit locations.
- Query timings, draw calls, triangles, and memory stay under the declared ceilings.
- No per-box `Object3D`, collider, material, timer, or event listener is created.
- Context loss/Exit disposes all added proxy arrays, debug geometry, textures, and global-pool owner handles.

## 16. Phased recommendation

### Phase 0 — diagnostics and invariants

- Add role-specific debug overlays and counters.
- Measure player visible envelope and current false-block cases.
- Add tests proving packed rings remain authoritative.
- Add semantic layer constants without changing visuals.

### Phase 1 — correctness first

- Test the smaller player profile and skin.
- Add building vertical spans.
- Implement bounded player sweep/slide over existing ring candidates.
- Replace AABB-center roof placement with inside-polygon slots.

### Phase 2 — camera and labels

- Replace camera point sampling with one swept near-plane sphere.
- Add asymmetric compression/recovery and diagnostics.
- Register curated blockers through the same interface.
- Add throttled label LOS using `LOS_BLOCKER` masks.

### Phase 3 — render/surface layering

- Centralize support/elevation bands.
- Re-enable default sort or implement a real explicit water pass after benchmark.
- Remove duplicate water overlap and reserve junctions before drawing markings/curbs.
- Add dither-only eligible clutter fade if still needed.

### Phase 4 — dynamic proxies and module occupancy

- Add the capped dynamic spatial hash only when gameplay has meaningful moving solids.
- Add per-object occupancy/slot resolution for richer procedural detail.
- Keep all small visual boxes non-solid unless explicitly promoted.

No phase should wait for a full rigid-body engine.

## 17. Sources

### Three.js rendering and query behavior

- [Three.js `WebGLRenderer.sortObjects`](https://threejs.org/docs/pages/WebGLRenderer.html) — sorting exists chiefly to improve transparent rendering; custom transparent sorting is available.
- [Three.js `Object3D.renderOrder`](https://threejs.org/docs/pages/Object3D.html) — explicit object order participates in normal sorting; opaque and transparent objects remain independent.
- [Three.js `Material`](https://threejs.org/docs/pages/Material.html) — depth write/test, alpha test, and polygon-offset semantics.
- [Three.js transparency manual](https://threejs.org/manual/en/transparency.html) — object sorting cannot solve all intersecting transparent triangles; alpha test is appropriate for sharp foliage masks.
- [Three.js `Layers`](https://threejs.org/docs/pages/Layers.html) and [`Raycaster`](https://threejs.org/docs/pages/Raycaster.html) — camera/raycaster membership masks, not gameplay collision authority.
- [Three.js `BatchedMesh`](https://threejs.org/docs/pages/BatchedMesh.html) — optional varied-geometry batching with per-object culling/visibility; it requires a compatibility gate before adoption here.
- [Three.js renderer logarithmic-depth option](https://threejs.org/docs/pages/WebGLRenderer.html) — useful only for huge scale differences and can disable early fragment testing through `gl_FragDepth`.
- [Khronos depth-buffer precision](https://wikis.khronos.org/opengl/Depth_Buffer_Precision) — push near outward and pull far inward; large `far/near` ratios reduce distant precision.

### Collision and camera principles

- [`MINIMAL_PHYSICS_RESEARCH.md`](./MINIMAL_PHYSICS_RESEARCH.md) — repository-specific fixed-step, move-and-slide, exact static proxy, CCD, and engine comparison.
- [Rapier character controller](https://rapier.rs/docs/user_guides/javascript/character_controller/) — shape-cast move-and-slide, contact offset, slopes, autostep, ground snap, and query filtering.
- [Unity Character Controller manual](https://docs.unity3d.com/Manual/class-CharacterController.html) — established skin-width, step, and slope concepts independent of this project’s engine choice.
- [Three.js forum: CSS/HTML label occlusion](https://discourse.threejs.org/t/how-can-css2dobject-be-occluded-by-mesh-objects-like-sprite/30025) — DOM labels require an explicit visibility/occlusion test.

## 18. Decision summary

1. Exact mapped rings stay authoritative and tile-owned.
2. The coordinate player’s `.09` radius is a compatibility value to replace only after a measured `.05–.06` test matrix.
3. Broad bounds, solids, triggers, camera blockers, and placement clearances become named separate roles.
4. Player movement uses a capped swept ring query with slide; no full physics dependency is required.
5. TPP camera uses one 3D near-plane-derived sweep, fast inward compression, slow outward recovery, and vertical spans.
6. Small visual boxes are non-solid by default.
7. Surface, render, visibility, and collision layers share semantic input but remain distinct systems.
8. The current `sortObjects=false` plus water `renderOrder=1` is not a valid ordering policy in Three r170.
9. Opaque/alpha-cut/dither detail is preferred over adding blended transparent families.
10. Procedural intersections are handled by support domains, tiny occupancy data, deterministic retries, prune/skip—not runtime CSG.

# Minimal Physics, Collision, and Ragdoll Research

**Research date:** 2026-09-16

**Scope:** the smallest useful physics layer for the browser-local coordinate world, preserving exact mapped collision and low-end mobile performance.

## 1. Executive decision

Do **not** replace the current world with a general-purpose rigid-body simulation.

Use a layered hybrid:

1. **Custom kinematic character controller** for the player and ordinary NPC movement.
2. **Exact lightweight static collision** derived from map polygons, terrain height, bridge decks, walls, and simple proxy shapes.
3. **Sensors and analytic motion** for water, pickups, doors, projectiles, vehicles, vegetation reactions, and most effects.
4. **A tiny lazy-loaded rigid-body island only if true ragdolls or tumbling props are added.**

```text
rendered world (detailed, instanced, merged)
                    │
                    ▼
physics proxy world (small, exact where gameplay requires it)
  ├─ support surfaces: terrain, roads, bridges, steps
  ├─ static solids: exact footprints, walls, rails, fences
  ├─ sensors: water, POIs, pickups, triggers
  ├─ kinematic actors: player, NPCs, vehicles, doors
  └─ bounded dynamics: one ragdoll + a few nearby props
```

The important rule is: **visual complexity must not become physics complexity**. Grass, every branch, facade windows, birds, rain, traffic, and distant buildings do not need dynamic colliders.

## 2. Current physics and collision audit

### Coordinate mode

The current `GeoPlayer` and `GeoWorld` already implement a useful minimal foundation:

- A coordinate avatar is a kinematic point/vertical character with a horizontal body radius of `0.09` game units.
- Horizontal movement is integrated in bounded substeps of at most `1/60 s`.
- X and Z are attempted separately, producing a basic axis-aligned slide response.
- Jump uses an upward velocity of `1.65` and gravity of `5.2 game units/s²`.
- The ground is fixed at `y = 0`.
- Building broad phase uses source-footprint AABBs in a 4-game-unit spatial grid.
- Narrow phase uses exact packed polygon rings, preserving concave corners and courtyard holes.
- The third-person camera uses the same collision query with a smaller circle and shortens itself before entering buildings.
- Spawn searches concentric samples until it finds a non-colliding point.
- Streaming transfers compact collider arrays with each building tile and disposes them with the tile.

### Curated/reference mode

The curated `Player` has additional handcrafted physics:

- AABB avatar bounds.
- Terrain/shoreline height sampling at four footprint corners.
- Bridge-deck height and bridge-rail collision.
- Gravity, jump, respawn below the world, and bounded substeps up to `1/120 s`.
- Tests for crossing every bridge, jumping/landing, frame-rate consistency, and river-fall respawn.

### What is already correct

- Keeping the player kinematic instead of making it a dynamic rigid body.
- Fixed maximum substeps to reduce frame-rate-dependent tunnelling.
- A cheap broad phase before exact collision.
- Accurate footprint geometry instead of oversized mapped-building AABBs.
- Separate camera collision.
- Simple gravity and direct velocity control for responsive gameplay.

### Missing or fragile behavior

1. Coordinate mode has no terrain-height or ground-normal query; the floor is always `y = 0`.
2. Coordinate building collision has no vertical interval, so it cannot distinguish walking under a bridge, stepping onto a low surface, or moving above a roof.
3. X-then-Z movement is biased by world axes and does not use the actual wall normal. It can feel sticky at acute/rotated corners.
4. Collision is tested at the destination, not swept continuously along the full displacement.
5. There is no capsule skin/contact offset, slope limit, stair step-up, floor snap, ceiling test, or head clearance.
6. Water is visual geometry, not a player sensor; the coordinate player can walk across it.
7. Plants, street furniture, bridge rails, fences, walls, piers, and other future structures have no player collision policy.
8. No common collider layers/masks distinguish solids, supports, sensors, camera blockers, and dynamic objects.
9. No moving-platform or kinematic-door support exists.
10. There are no dynamic props, forces, impulses, projectile queries, ropes, buoyancy, knockdown, or ragdoll state.
11. The coordinate TPP avatar is one merged static mesh; it has no independently transformable body segments for ragdoll rendering.
12. Physics timing is substepped from each render delta but does not use a shared accumulator with render interpolation and an explicit maximum catch-up count.

## 3. What “minimal physics” should mean here

### Must simulate

- Player gravity, jumping, ground contact, wall collision, sliding, slopes, small steps, bridge traversal, and falling.
- Camera obstruction.
- Water/trigger entry.
- A very small set of nearby interactive objects.
- A ragdoll only while a visible knockdown/death needs it.

### Should be query-driven, not simulated

- Pickups and discoveries: overlap/squared-distance sensors.
- Bullets/throws: ray or swept-sphere query plus a simple ballistic path.
- Doors and gates: authored one-axis interpolation with collision proxy update.
- Cars and transit: kinematic map-graph routes; visual wheel rotation.
- Elevators/platforms: kinematic transforms and passenger displacement.
- Swimming/wading: water depth/state function, not fluid simulation.
- Buoyancy: one vertical spring and damping term.
- Vegetation response: shader displacement around the player.
- Cloth, flags, wires: vertex shader or a tiny position-constraint chain.
- Breakage: pooled pre-authored fragments and impulses, not mesh fracture.

### Should remain visual only

- Ground cover, flowers, leaves, rain, snow, dust, insects, birds, distant traffic, facade details, clouds, and water ripples.
- Individual tree branches and roots unless a particular trunk is an intentional gameplay blocker.
- Every window, awning, roof tank, sign, lamp, or small stone.

## 4. Recommended collision architecture

### 4.1 Collider roles

| Role | Examples | Representation | Response |
|---|---|---|---|
| Support | terrain, road, sidewalk, bridge deck, step | height/normal sampler or simple plane | stand, slope, floor snap |
| Static solid | building, retaining wall, bridge rail, fence, cliff | exact 2D ring + Y interval; capsule/box for local structures | stop and slide |
| Sensor | water, POI, pickup, ladder, hazard, biome zone | polygon/circle/AABB with no contact response | enter/stay/exit event |
| Kinematic | player, NPC, vehicle, door, platform | capsule/box/sphere with authored movement | queried movement; pushes only by rule |
| Dynamic | ball, can, crate fragment, ragdoll segment | sphere/capsule/box | gravity, contacts, damping, sleep |
| Camera-only | opaque building, large rock, roof | circle/sphere/segment query | shorten or fade camera |

A rendered object may have no collider, and one collider may represent many rendered details.

### 4.2 Core interfaces

```js
physics.sampleSupport(x, z, previousY)
// → { y, normalX, normalY, normalZ, surfaceId, materialId, velocity? }

physics.sweepCharacter(position, displacement, characterConfig)
// → { position, remaining, grounded, groundNormal, contacts, supportId }

physics.overlapSensors(shape, mask)
// → stable sensor IDs

physics.raycast(origin, direction, maxDistance, mask)
physics.sweepSphere(origin, radius, displacement, mask)

physics.queryNearby(bounds, mask)
// → only local collider proxies
```

Gameplay should depend on these interfaces, not directly on a future third-party physics library. That keeps the custom controller, a pure-JS prototype, and a WASM engine interchangeable.

### 4.3 Collision layers

Recommended bit groups:

```text
WORLD_SOLID     buildings, cliffs, walls, rails
WORLD_SUPPORT   terrain, roads, decks, steps
PLAYER          local player capsule
ACTOR           NPC kinematic capsules
DYNAMIC_PROP    balls, loose props, fragments
RAGDOLL         active body segments
SENSOR          water, pickups, triggers
CAMERA          camera blockers
```

Low profile interaction matrix:

- Player ↔ world solid/support/sensor/dynamic prop.
- Actor ↔ world solid/support/sensor; actor-to-actor uses avoidance, not rigid contact.
- Dynamic prop ↔ world solid/support; prop-to-prop optional only nearby.
- Ragdoll ↔ world solid/support; no ragdoll-to-ragdoll and no ordinary prop collision on low profile.
- Camera ↔ camera/world blockers only.
- Sensors never resolve contact.

## 5. Minimal character controller

### 5.1 Shape

Use an upright capsule conceptually, while retaining a specialized 2.5D implementation where possible:

```js
{
  radius: 0.05–0.06,           // test against current 0.09 compatibility value
  standingHeight: 0.20–0.21,
  crouchingHeight: 0.15,       // only if crouch is added
  skin: 0.004–0.006,
  maxSlope: 45°,
  stepHeight: 0.025–0.035,
  floorSnap: 0.02–0.04,
  maxSlides: 3
}
```

These numbers must be tuned in game units and against the approximately 1:10 world. The current `0.09` radius has a `0.18`-unit diameter while the visible avatar is only about `0.11` units wide at its arms, so it should be retained as a regression baseline rather than accepted automatically. Test the smaller range through mapped alleys and door-like gaps before changing it. The skin should be a small fraction of the final radius. Character-controller references consistently use a contact offset to prevent numerical sticking.

### 5.2 Horizontal swept circle against exact footprint rings

Mapped buildings are vertical prisms for ordinary walking. Therefore the most useful initial shape cast is a circle swept through X/Z, accepted only when the player's vertical interval overlaps the prism's Y interval.

For each desired move:

1. Form a swept broad-phase AABB around start, destination, and radius.
2. Query only spatial-grid cells touched by that AABB.
3. Find the earliest circle-vs-ring-edge or endpoint time of impact.
4. Move to just before contact, preserving `skin` distance.
5. Remove the inward component of remaining displacement using the contact normal.
6. Repeat for at most three contacts to slide around one wall and one corner.
7. If the controller begins overlapped, use nearest-ring distance for bounded depenetration.

```text
remaining -= normal * min(dot(remaining, normal), 0)
```

This removes the current world-axis bias and handles rotated walls naturally. Fixed small substeps remain as a safety limit, but collision correctness no longer depends entirely on them.

### 5.3 Vertical interval

Extend each solid proxy with:

```text
minY, maxY, supportTop, stepAllowed, ceiling
```

Only apply horizontal blocking when:

```text
playerFeet < collider.maxY - skin
and
playerHead > collider.minY + skin
```

This is necessary for bridges, tunnels, overhangs, roofs, stairs, and future terrain.

### 5.4 Ground and slope

`sampleSupport()` should return both height and normal. The controller then:

- projects desired ground movement onto walkable support;
- rejects upward movement on slopes above the limit;
- applies gravity when no support exists;
- snaps down a small distance when descending a walkable slope or step;
- preserves a short grounded grace period only if gameplay tuning needs it;
- tests head clearance before stepping up or standing from crouch.

A single centre ray is cheap but unreliable on edges. Sample the capsule centre plus a small footprint pattern, or use a compact sphere/shape cast when DEM terrain is introduced.

### 5.5 Step-up

Attempt step-up only after a low horizontal obstacle blocks the ordinary move:

1. Raise by at most `stepHeight`.
2. Verify head/body clearance.
3. retry horizontal sweep;
4. sweep/snap downward to a walkable support;
5. commit only if all checks pass.

Do not infer stairs from rendered facade details. Steps, sidewalks, bridge decks, and explicit site geometry should emit support proxies.

### 5.6 Moving support

A support sample may include a kinematic velocity. While grounded, add that support displacement before player input. Keep the player's own movement kinematic; do not make the player a force-driven body.

### 5.7 Water

Water is a sensor and state machine:

- test exact mapped water polygons/line corridors;
- compare feet/chest/head against water height/depth;
- emit `dry`, `wading`, `swimming`, or `submerged` state;
- alter speed, gravity, camera, sound, and particles by state;
- apply one drag/buoyancy approximation if swimming is implemented.

No fluid solver is needed.

## 6. Static world collider generation

### Buildings

Keep exact packed rings and courtyard holes. Add base/top height. For character collision, polygon-prism queries remain smaller and more accurate than thousands of wall boxes.

### Terrain

When DEM arrives, share one height/normal function between rendering, player, camera, props, and ragdolls. Do not build a dense physics triangle mesh if a 33×33/49×49 height field can answer support queries.

### Roads and sidewalks

Treat them primarily as support/material overrides on terrain. Curbs become small steps only where visibly raised; road markings never collide.

### Bridges

Emit separate deck support, rail solids, and underpass clearance. Do not represent a bridge as one blocking AABB.

### Walls and fences

Use segment capsules or thin oriented boxes with explicit gate gaps. Skip collision for decorative vegetation fences unless they visually read as solid.

### Rocks and trees

Only medium/large trunks and hero rocks collide. Use a circle/capsule proxy. Small stones, roots, crown geometry, herbs, and shrubs remain non-solid to prevent traversal frustration.

### Tile boundaries

- Ownership uses stable source tile + feature ID.
- Duplicate edge features are deduplicated by stable geometry hash.
- Neighbor queries can read immediate loaded-tile collider grids.
- A collision-critical destination tile must reach its collider phase before the player can cross deeply into it; roads can still render first.
- Eviction cannot remove colliders under the player, active ragdoll, or dynamic body. Pin the owning tile briefly or freeze/rehome dynamics.

## 7. Ragdoll options

### Option A — pose-fall illusion, no rigid-body engine

Use independently transformable voxel body segments with a short deterministic animation:

- initial directional lean from impact/fall velocity;
- pelvis follows a ballistic arc;
- limbs use damped spring rotations with seeded phase;
- ground height clamps each visual segment approximately;
- final pose selected from several stable lying variants;
- blend or respawn after settling.

**Advantages:** no dependency, tiny CPU cost, exact art control, deterministic.

**Limitations:** does not tumble correctly down terrain or collide independently with walls.

This is enough if ragdoll is a rare playful reaction rather than a core mechanic.

### Option B — small position-based puppet

Represent the body as points with distance and bend constraints, integrate with Verlet/PBD, project constraints 3–5 times, and collide points/spheres with nearby world proxies.

Position Based Dynamics is attractive for simple ropes, flags, chains, and secondary motion because it manipulates positions directly and is robust for visually plausible constraints. A complete self-colliding rotational ragdoll, however, becomes a physics-engine project of its own.

**Decision:** suitable for ropes/flags and a stylized 5–7-point puppet prototype; not the recommended final true ragdoll if angular joint limits and reliable wall contacts matter.

### Option C — lazy-loaded true rigid-body ragdoll

Use a mature solver only while ragdoll/dynamic gameplay is active.

Minimal voxel body:

| Segment | Bodies | Collider | Joint |
|---|---:|---|---|
| pelvis + torso/core | 1 | box/capsule | root |
| head | 1 | sphere/box | limited spherical neck |
| upper arms | 2 | capsules | spherical shoulders |
| forearms | 2 | capsules | limited revolute elbows |
| thighs | 2 | capsules | spherical hips |
| shins | 2 | capsules | limited revolute knees |
| **Total** | **10** | simple primitives | **9 joints** |

Do not simulate hands, feet, fingers, face, clothing, backpack, hair, or multiple spine bones. Render those as children of the nearest segment.

### Ragdoll lifecycle

```text
ANIMATED
  → HANDOFF (copy segment world poses and root momentum)
  → ACTIVE (world collision, gravity, damping)
  → SETTLING (lower update/solver profile)
  → SLEEP/FROZEN (static visual pose)
  → RECOVER BLEND or FADE/RECYCLE
```

Distance/quantity LOD:

| State | Low profile | Balanced/high |
|---|---|---|
| Near camera, first ragdoll | active, target 30–60 Hz after testing | active 60 Hz |
| Second ragdoll | pose-fall or immediately frozen | active only while inside 4 game units |
| 2–6 game units away | sleep/freeze as soon as valid | 30 Hz or sleeping |
| Beyond 6 game units | frozen pose, fade, or recycle | frozen pose or recycle |
| Over quantity cap | freeze/recycle oldest non-player | freeze/recycle farthest non-player |

Rules:

- The normal playable controller is disabled during player ragdoll.
- FPP switches to a stable nearby TPP camera; never tumble the camera with the head.
- Initial impulse is clamped.
- Adjacent/self collisions are disabled on low profile to avoid jitter and cost.
- Ragdoll collides only with nearby ground, exact building boundaries, rails, and hero obstacles.
- Sleep after low linear/angular speed for a short window.
- Force-freeze after a maximum active time.
- For recovery, find a safe upright capsule position near the pelvis before blending to standing.
- If no safe point exists, respawn instead of forcing the capsule through geometry.

### Physics scale

The coordinate avatar is only about `0.2` game units tall because the map is approximately 1:10. General physics engines are commonly tuned around metre-like units and may become unstable with extremely small shapes and tolerances.

Use an adapter:

```text
physicsPosition = (gamePosition - localPhysicsOrigin) × 10
renderPosition  = localPhysicsOrigin + physicsPosition ÷ 10
```

This makes the avatar roughly 2 physics units tall. It is a numerical conversion, not a claim that all gameplay acceleration uses real-world SI values: the current controller's stylized gravity must be converted by the same adapter and then tuned in the ragdoll arena. Keep the physics island centred near the player and rebase only when no active simulation is in contact, or rebuild sleeping bodies relative to a new origin.

### Feeding exact static collision to the optional island

Do not mirror all loaded render meshes into the rigid-body world. At ragdoll activation:

1. Query static features intersecting the local active radius.
2. Convert nearby outer and courtyard ring edges into pooled thin oriented boxes/capsules with the feature's exact vertical interval.
3. Add explicit bridge decks/rails, walls, fence segments, and hero rock/tree primitives.
4. Build a coarse local heightfield patch, or a ground plane only when the sampled terrain is demonstrably flat.
5. Keep stable feature IDs on proxies so tile unload/update can remove the correct bodies.
6. Rebuild only after crossing a local-cell boundary, never every rendered frame.
7. Cap proxy segments and pin any source tile supporting an active body until that body sleeps, freezes, or moves away.

These boundary proxies preserve exact footprint outlines and holes without a concave rigid body for every building. The authoritative player query continues to use packed source rings directly.

### Reproducibility

Ragdoll outcome depends on runtime input, exact handoff pose, fixed-step count, body insertion order, and floating-point behavior. Treat generated collider layout and initial ragdoll setup as reproducible; do not promise identical replay unless the full input/tick stream and solver snapshot are recorded.

Rapier's JavaScript documentation states cross-platform deterministic behavior for the same version and exactly equal initial conditions, but it also warns that all setup operations must themselves be deterministic. A deterministic solver does not make variable browser input timing or `Math.sin`-derived setup deterministic automatically.

## 8. Library evaluation

Registry sizes were checked on 2026-09-16 and are package/distribution values, not final Vite gzip sizes.

| Option | Runtime | Relevant features | Current package observation | Fit |
|---|---|---|---|---|
| Existing custom code | JavaScript | exact rings, spatial grid, kinematic movement | no added bytes | Best for player/static world |
| `cannon-es@0.20.0` | pure JavaScript | primitives, trimesh/heightfield, constraints, sleeping, collision filters; ragdoll example | npm tarball ~165 KB; ESM file ~346 KB before bundling/minification | Good lazy-loaded proof of concept for one ragdoll/few props; source activity is limited |
| `@dimforge/rapier3d-compat@0.20.0` | Rust/WASM + JS | robust colliders, CCD, sensors, joints/motors, sleeping, scene queries, built-in KCC, snapshots/determinism | npm tarball ~3.32 MB; WASM ~2.02 MB plus ~244 KB JS glue before transfer compression | Strongest long-term engine; large relative to this low-resource app |
| `three-mesh-bvh@0.9.15` | JavaScript | fast ray/shape queries over triangle meshes | npm tarball metadata ~0.54 MB; unpacked ~2.33 MB | Useful only if terrain/building collision becomes arbitrary triangle mesh; unnecessary for current exact 2D prisms |
| Custom PBD/Verlet | JavaScript | points, distance/bend constraints, ropes, simple puppet | small local implementation | Good for secondary motion, risky for full ragdoll |

### Architectural comparison

| Question | Custom queries/controller | Cannon-es | Rapier | Static BVH |
|---|---|---|---|---|
| Preserve packed exact footprint rings | native; no conversion | needs proxy bodies | needs proxy colliders | needs triangulated geometry |
| Player move-and-slide | implement specialized 2.5D sweeps | application/controller work | built-in KCC exists | queries only; response is custom |
| Terrain support | direct height/normal sampler | heightfield/trimesh or custom | heightfield/trimesh or custom | good for arbitrary triangle terrain |
| True ragdoll/joints | not without building a solver | yes | yes, broad joint/query support | no |
| Sleeping/dynamic contacts | custom per feature | yes | yes | no |
| Streaming cost | lowest; current tile ownership remains | local bodies must mirror features | local colliders must mirror features | build/refit/dispose BVHs per mesh/tile |
| Initial load effect | none | small if lazy | meaningful WASM if not lazy | avoidable if lazy |
| Best role in this game | authoritative traversal/static world | small optional dynamics experiment | leading technical backend for robust dynamics | future irregular mesh query accelerator only |

Rapier's built-in character controller is capable, but adopting it would require mirroring every relevant streamed source feature into Rapier. That duplication is not justified while the packed-ring controller is smaller, exact, and already integrated with tile ownership.

### Recommended decision

1. Ship the improved custom character/static collision first with **no new dependency**.
2. Refactor the voxel avatar into transformable segments and prototype Option A.
3. If true wall/terrain-reactive ragdoll materially improves the game, benchmark one 10-body ragdoll in both `cannon-es` and Rapier behind a dynamic import.
4. Treat Rapier as the leading **technical** backend because of its robust queries, joints, sleeping, CCD, determinism support, and active development.
5. Choose `cannon-es` only if its substantially smaller transferred/initialized footprint wins and the bounded one-ragdoll stability suite passes on low-end hardware.
6. Keep Rapier if physics expands into multiple ragdolls, tumbling props, reliable CCD, replay snapshots, or complex constraints.
7. Do not add `three-mesh-bvh` while exact footprint rings + height fields answer all required queries more cheaply.

A physics engine should not become part of the initial coordinate-mode bundle. Lazy-load it on the first event or prefetch after the world becomes interactive on capable profiles.

## 9. Other minimal physics features

### 9.1 Pushable balls and cans

For round/cylindrical objects, a tiny analytic solver is sufficient:

- position, linear velocity, optional spin scalar;
- gravity;
- ground normal/support height;
- swept circle/sphere against static world;
- restitution and friction;
- sleep threshold;
- maximum 4–8 active objects near player.

Use a rigid-body engine only if boxes need to tumble and stack.

### 9.2 Throws and projectiles

- Integrate a ballistic point/sphere at fixed steps.
- Sweep from previous to new position so fast throws cannot tunnel.
- On hit, emit gameplay event and pooled visual effect.
- Do not create a dynamic body for bullets.
- Limit bounce count; recycle outside active radius.

### 9.3 Doors, gates, and barriers

- One scalar open amount or hinge angle.
- Authored easing or spring-damped angle.
- Thin oriented box/capsule collider updated only while moving.
- Sensor checks prevent closing through the player.
- No general constraint solver is necessary.

### 9.4 Vehicles

Traffic follows the mapped road graph kinematically. Vehicles:

- have a route parameter, speed, steering interpolation, and simple forward safety sensor;
- use a capsule/box only near the player;
- stop/yield by rules rather than rigid collision;
- apply a bounded knockback/knockdown event instead of solving a car-person impact;
- never simulate suspension or tyre friction on low profile.

### 9.5 Buoyancy and swimming

For a body at water height `h`:

```text
submersion = clamp((h - bodyBottom) / bodyHeight, 0, 1)
verticalAcceleration += buoyancy * submersion - drag * velocityY * submersion
horizontalVelocity *= exp(-waterDrag * submersion * dt)
```

One sample at the body centre is enough for player/props. No waves alter gameplay collision unless explicitly designed.

### 9.6 Rope, wires, and flags

- Static sag curve for ordinary utility wires.
- Vertex-shader wind for flags and cloth banners.
- Optional 5–10 point PBD chain only for an interactive rope near player.
- No self-collision, no tearing, no cloth triangle solver.

### 9.7 Vegetation reaction

Use a player/impact position uniform to bend nearby vegetation vertices. Do not attach colliders or springs to every plant. Large tree trunks may be static circles; crowns and branches remain visual.

### 9.8 Breakable props

- Define 3–8 reusable chunks per prop archetype.
- Spawn from a small pool with one outward impulse recipe.
- Collide with ground only on low profile.
- Fade/freeze rapidly.
- Never fracture mapped building geometry dynamically.

### 9.9 Fall, knockdown, and recovery

- Track vertical speed at support contact.
- Small impact: camera/animation response only.
- Medium impact: stumble or pose-fall.
- Large impact: true ragdoll if loaded, otherwise deterministic fall pose.
- Recovery checks an upright capsule and navigable support.
- Always cap impulses and maximum fall speed.

## 10. Fixed timestep and scheduling

The current bounded substeps are a good start. A shared accumulator is more explicit and allows interpolation:

```js
const FIXED_DT = 1 / 60;
const MAX_STEPS = 3;
accumulator = Math.min(accumulator + Math.min(frameDt, 0.1), FIXED_DT * MAX_STEPS);

let steps = 0;
while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
  previousState.copy(currentState);
  simulate(FIXED_DT);
  accumulator -= FIXED_DT;
  steps++;
}
renderInterpolate(previousState, currentState, accumulator / FIXED_DT);
```

Glenn Fiedler's fixed-timestep guidance explains why unbounded variable timesteps can change behavior or cause tunnelling, and why catch-up work needs headroom to avoid a spiral of death.

Recommended rates:

| System | Low | Balanced/high |
|---|---:|---:|
| Player/controller | 60 Hz fixed | 60 Hz fixed |
| Camera obstruction | render rate or after player tick | render rate |
| Simple sensors | 15–30 Hz, event cached | 30 Hz |
| Nearby props | 30 Hz + interpolation | 60 Hz |
| Active ragdoll | 30–60 Hz after stability test | 60 Hz |
| Sleeping/frozen bodies | 0 Hz | 0 Hz |
| Far vehicles | 5–10 Hz route update | 10–15 Hz |
| Near vehicles | 20–30 Hz | 30 Hz |

Do not put this tiny physics island in a Worker initially. Main/Worker transform synchronization, SharedArrayBuffer isolation headers, and latency are not justified at these body counts. Static collider generation remains in the existing map worker.

## 11. Budgets

### Low profile hard ceilings

| Resource | Ceiling |
|---|---:|
| Player shape sweeps per fixed tick | 4 ordinary, 8 worst-case step/corner |
| Slide/contact iterations | 3 |
| Support samples per player tick | 5 or one shape cast |
| Nearby static collider candidates after broad phase | 64 typical, 256 hard cap |
| Dynamic rigid bodies | 16 total |
| Active true ragdolls | 1 |
| Bodies per ragdoll | 10 |
| Joints per ragdoll | 9 |
| Loose interactive props | 6 active |
| Constraint/solver iterations | minimum that passes tests; begin 4–6 |
| Active physics radius | 6 game units around player |
| Settling-to-sleep target | under 1.5 s after low motion |
| Forced ragdoll freeze | 3 s low / 5 s balanced |
| Physics main-thread p95 | ≤ 1.0 ms low, ≤ 1.5 ms balanced |
| Physics long step | never > 4 ms in normal audit |
| Catch-up steps per rendered frame | 3 |
| Collision/sensor buffers | target ≤ 256 KiB/tile; investigate any tile > 512 KiB |
| Four-tile custom collision working set | target ≤ 2 MiB excluding render geometry |
| Optional solver incremental heap | target ≤ 12 MiB low, hard acceptance decision at 16 MiB |
| One ragdoll transforms/state | target ≤ 64 KiB excluding shared geometry/materials |

Memory targets must be measured from browser heap/WASM memory before and after initialization; npm package size is not runtime memory. If a cap is reached, recycle or freeze the oldest/farthest non-player body. Do not silently increase solver work.

### Graceful degradation order

1. **Never degrade** exact player/building collision, support safety, ceilings, bridge rails, or water state.
2. Stop spawning loose props and visual fragments.
3. Reduce sensor and far-vehicle update frequency.
4. Put settled dynamics to sleep earlier and change a mid-distance ragdoll to a frozen visual pose.
5. Drop from two ragdolls to one, then fall back to deterministic pose-fall.
6. Do not initialize the optional solver when device-memory/performance gates fail.
7. If the dynamic import, WASM initialization, or adapter throws, recover to pose-fall and report one diagnostic—never prevent world entry.
8. If catch-up exceeds the fixed-step cap, discard bounded excess time, record it, and preserve responsiveness rather than attempting an unbounded recovery spiral.

Dense map collision may require more candidate processing, but it must use spatial subdivision or split work—not an inaccurate oversized fallback shape.

## 12. Diagnostics

Add to the existing HUD/debug payload:

- fixed physics steps this frame;
- physics CPU average/p95/worst;
- broad-phase candidates;
- shape casts/rays/overlaps;
- player contacts and grounded/support ID;
- active/sleeping/frozen body counts;
- active ragdolls and joints;
- maximum penetration correction;
- CCD/sweep hits;
- physics tile pins;
- dropped/capped catch-up time;
- physics library and version if dynamically loaded.

Debug mode should draw proxies, normals, support points, sensor boundaries, and swept paths. It must remain completely disabled in normal rendering.

## 13. Acceptance tests

### Deterministic static collision

- Same fixture payload generates byte-identical collider rings, vertical extents, layer IDs, and stable feature IDs.
- Tile eviction/reload returns identical collision results.
- Courtyard holes remain traversable.
- Concave and rotated footprint corners do not inherit oversized AABB blocking.

### Character movement

- Walk parallel to mapped walls at 0°, 15°, 45°, 75°, and 90° without sticking.
- Run diagonally into a wall and slide with no world-axis preference.
- Approach every concave/convex corner from both sides.
- Cannot tunnel through the thinnest supported wall at maximum run speed and the maximum permitted frame gap.
- Step onto every allowed curb/step and reject anything above `stepHeight`.
- Walk up/down slopes through the limit; reject steeper slopes.
- Remain grounded over terrain/road seams and descend without hovering.
- Jump under low clearance without entering the ceiling.
- Cross bridges both directions, pass below where clearance allows, and collide with rails.
- Enter/leave water polygons with one stable event sequence.
- Camera never passes through a solid building, but ignores grass, sensors, and ragdolls.

### Ragdoll

- Fixed initial poses/impulses at pelvis, shoulder, and foot do not explode or separate joints.
- Drop onto flat ground, slope, stair, wall corner, bridge rail, and courtyard boundary.
- No segment penetrates a solid farther than the allowed tolerance after settling.
- Adjacent mass ratios, joint limits, damping, and sleep thresholds are recorded as versioned data.
- One ragdoll sleeps/freezes within budget.
- Exceeding the ragdoll cap freezes/recycles the oldest safely.
- Player recovery finds a collision-free upright location or respawns.
- FPP camera remains stable during knockdown.
- Disposing coordinate mode removes bodies, joints, colliders, timers, and dynamically loaded adapter state.

### Performance

- Benchmark no physics, player-only, one ragdoll, and ragdoll + six props separately.
- Measure download, parse/compile, WASM initialization, first-step, warm-step p50/p95, memory, and frame gaps.
- Audit constrained software rendering and real mobile-class hardware.
- A lazy physics import never delays roads-first initial world loading.

## 14. Implementation sequence

### Batch 1 — collision correctness, no dependency

1. Introduce collider roles/layers and stable vertical extents.
2. Add support/sensor data to worker output.
3. Implement swept exact-ring character movement with actual contact normals and at most three slides.
4. Add skin, floor snap, step-up, slope/head checks, and height-aware camera collision.
5. Add water entry state and bridge support proxies.
6. Add debug proxy visualization and movement regression fixtures.

### Batch 2 — minimal interactions

1. Add shared ray and swept-sphere queries.
2. Add one analytic ball/can pool.
3. Add kinematic door/gate and moving-support contract.
4. Add fall-impact tiers and a deterministic pose-fall avatar.
5. Add simple buoyancy/drag only if swimming is introduced.

### Batch 3 — ragdoll benchmark

1. Refactor the merged avatar into 10 independently transformable visual segments while retaining a one-draw or bounded-draw animated mode.
2. Build a fixed ragdoll test arena with flat, slope, stairs, exact wall corner, courtyard, and bridge rail.
3. Prototype lazy `cannon-es` and lazy Rapier adapters against the same interface and data.
4. Compare transferred bytes, initialization, p95 step, joint stability, sleep, disposal, and constrained browser support.
5. Keep only the winning true-ragdoll adapter, or retain pose-fall if true physics does not justify its cost.

## 15. Approaches not recommended

- Replacing exact building polygons with oversized physics AABBs.
- Making the player a dynamic rigid body; it reduces control and introduces pushing/jitter problems.
- Sending every rendered triangle into a physics engine.
- One collider per plant, window, lamp, pebble, road marking, or bird.
- Dynamic simulation for map traffic.
- Full fluid simulation for rivers/rain/swimming.
- Permanent active ragdolls or active-ragdoll locomotion.
- Self-collision on every ragdoll segment.
- Global CCD for all bodies; use sweeps/CCD only for the player and fast projectiles.
- Loading a 2 MB WASM solver before the first playable road/building tile when no dynamic object exists.
- Running tiny physics in a Worker before profiling proves the main thread is the problem.
- Assuming fixed timestep alone guarantees replay determinism.
- Letting dynamic bodies keep source tiles resident indefinitely.
- Simulating at real-world scale without accounting for the game's 1:10 coordinate units.

## 16. Sources

### Character collision and timing

- [Rapier JavaScript character controller](https://rapier.rs/docs/user_guides/javascript/character_controller/) — kinematic move-and-slide, shape recommendations, skin offset, slopes, steps, snap-to-ground, dynamic impulses, and filtering.
- [Rapier colliders](https://rapier.rs/docs/user_guides/javascript/colliders/) — solid/sensor separation, primitive/mesh/heightfield shapes, friction, and filters.
- [Unity Character Controller reference](https://docs.unity3d.com/Manual/class-CharacterController.html) — capsule, skin width, slope limit, and step offset as established controller concepts.
- [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/) — fixed-step integration, interpolation, frame clamps, and spiral-of-death limits.
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) — accelerated raycasting and shape queries if arbitrary static triangle meshes become necessary.

### Rigid bodies and ragdolls

- [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/) — body types, sleeping, gravity, damping, and CCD.
- [Rapier joints](https://rapier.rs/docs/user_guides/javascript/joints/) — spherical shoulders, revolute knees/elbows, joint degrees of freedom, limits, and motors.
- [Rapier JavaScript determinism](https://rapier.rs/docs/user_guides/javascript/determinism/) — identical initial-condition requirements and cross-platform caveats.
- [`cannon-es`](https://github.com/pmndrs/cannon-es) and [API docs](https://pmndrs.github.io/cannon-es/docs/) — lightweight pure-JS bodies, constraints, filters, sleeping, and ragdoll examples.
- [Position Based Dynamics](https://matthias-research.github.io/pages/publications/posBasedDyn.pdf) — direct constraint projection for robust visual simulation and secondary motion.
- [XPBD](https://dl.acm.org/doi/10.1145/2994258.2994272) — improved constraint compliance independent of timestep/iteration count for future rope/cloth work.

## 17. Final recommendation

The correct “minimal physics” upgrade is primarily a **collision-query upgrade**, not a physics-engine installation:

- exact swept footprint collision;
- capsule-like move-and-slide;
- vertical extents, ground normals, slopes, steps, ceilings, and bridge support;
- sensors for water and interaction;
- analytic motion for ordinary props and projectiles;
- shader/PBD approximations for environmental motion;
- one strictly budgeted lazy ragdoll island only after a measured prototype.

This keeps movement reliable and the world interactive without sacrificing the current local generation, roads-first loading, exact mapped footprints, or low-resource performance.

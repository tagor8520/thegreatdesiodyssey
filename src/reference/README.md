# Tri-state reference client

### Third-person mouse camera

Click the canvas to capture the mouse, move it to orbit horizontally/vertically, scroll to zoom, and press Escape to release. If pointer lock is unavailable, hold the left mouse button and drag. WASD is relative to camera yaw; the character turns toward travel while the camera can orbit independently. Pitch and zoom are bounded, and the camera stays above terrain. M releases the mouse and enters the overview; pressing M again restores the previous orbit angle. Hotbar clicks never capture the mouse. `ThirdPersonCamera.js` owns the listeners and removes them during player teardown. The camera derives a bounded sweep sphere from its near plane, compresses immediately at tight bridge/landmark/sign/skyline/railway compounds, recovers outward slowly, and preserves real arch/under-sign openings. All current static structural families have proxy coverage; moving behaviour is now checked programmatically by the shared movement audit and its lifecycle ledger instead of by browser capture.

Run `npm run dev`, then open `/` to load the lightweight landing shell. The Three.js/React game bundle and WebGL context are created only after Start; Exit disposes them and returns to the shell. `/reference.html` uses the same flow, while the original explorer is preserved at `/classic.html`. React owns only the in-game overlay. Run all tests with `npm test`.

## Reference composition

The supplied image uses an elevated, near-frontal diorama camera: Maharashtra occupies the upper left, Karnataka the upper right, and Kerala the foreground. Warm sunlight emphasizes sandstone and voxel edges; blue water separates the regions. The stats panel sits at the top left and the three-item inventory sits at the bottom center.

Coordinates are Y-up, X east/right, and +Z south/toward the default camera. The world spans 256 × 256 units. Maharashtra is west of the central river and north of Z=12; Karnataka is east and north; Kerala fills the south. A sinusoidal north–south river and a southern backwater branch connect the regions. Terrain columns cover a single water plane, preventing separate water patches from producing seams.

This implementation recreates that composition with procedural voxel geometry. It does not reproduce the reference's intricate carvings, buildings, crowds, photographic food icons, waterfalls, or cinematic depth of field. The inventory contains original inline vector drawings of the three requested items. Sky reflections are environment-map reflections, not reflections of moving boats or nearby buildings; those require a separately budgeted planar reflection or screen-space reflection pass.

## Modules and ownership

| Module | Contract |
| --- | --- |
| `GameUI.jsx` | `GameUI({store, onSelect})`, `createUIStore()`, `ITEMS`. React subscribes to immutable snapshots through `useSyncExternalStore`; telemetry updates twice a second. |
| `BiomeManager.js` | `new BiomeManager(scene, options)`, `update(focus, worldSeconds)`, `dispose()`. Owns streamed meshes and animated actors. Exports terrain/biome queries. |
| `VoxelBatch.js` | Groups boxes by material into instanced draws; owns/disposes each batch's GPU resources and samples the active engine-shared procedural material masks without adding draw families. |
| `Environment.js` | `new Environment({scene, renderer, camera, ambientOcclusion, pixelRatio, materialLibrary, materialDetail})`, `resize(w,h,dpr)`, `update(worldSeconds)`, `render(dt)`, `dispose()`. Owns water, PMREM, lights, and composer targets while borrowing the engine-owned water normal when supplied. |
| `Player.js` | Procedural adventurer, keyboard input, substepped movement/gravity, terrain and bridge collision, river respawn, animated limbs, and LERP follow/overview camera. |
| `BridgeManager.js` | Three arched voxel bridges with terrain-matched endpoints, deck/rail/pier camera compounds, player collision queries, and shared curated structural blockers from biome/sign managers. |
| `HoardingManager.js` | The three requested welcome signs, using generated 1024px CanvasTextures with independently readable front/back faces. |
| `ItemManager.js` | Seven food definitions, deterministic regional placement, bob/rotation animation, one-shot AABB pickups, score events, and disposal. |
| `main.jsx` | `mountReferenceGame(container, {getWorldTime, subscribePing, onSelect})` returns scene, camera, gameplay managers, store, and an idempotent `dispose()`. A single requestAnimationFrame loop updates gameplay and rendering. |

## Streaming

The manager divides the world into 64 chunks, each 32 units wide, with four-unit terrain tiles. It prioritizes chunks by distance to their ground-plane bounds. The manager's standalone defaults remain 150/190, while the game selects smaller profile-specific radii (90/122 on low and 112/148 on balanced). Nearby chunk coordinates are enumerated from the focus rather than filtering the complete descriptor list each frame. Hysteresis prevents boundary churn. A generator yields between strips of eight terrain tiles and uses a profile-specific soft CPU budget. Final GPU upload is still main-thread work; hard worst-case guarantees require worker-generated typed arrays and staged uploads.

Generation uses a seed and integer coordinates, so revisiting a chunk reproduces its transforms. Canceling a pending chunk drops the generator before its GPU allocation step. Completed chunks own their geometry/materials and release them when evicted. Landmarks have one owning chunk. The preview load radius keeps their overhanging geometry in view; increase streaming distance to cover a wider gameplay camera's visible footprint.

The train and houseboat have separate manager-owned lifetimes to avoid duplicate entities at chunk borders. Their motion is derived from world time, rather than accumulated frame deltas. They remain cosmetic objects without boarding or actor collision. The playable character uses `tileHeight` to sample the same four-unit tile centers used by terrain generation, plus bridge deck/rail colliders. Decorative buildings and trees do not yet have gameplay colliders. Multiplayer transport is supplied by the caller.

## UI and network integration

The root overlay and stats are `pointer-events: none`; only slot buttons accept pointer events. Keys 1–3 and buttons select slots; editable fields and modified/repeated keystrokes are ignored. Buttons preserve keyboard focus outlines and expose accessible labels and pressed state. Movement uses WASD/arrows, Space jumps, Shift runs, and M toggles an overview. The camera follows automatically. Input clears on blur and tab hiding. Desktop keyboard input is required for movement; a mobile movement pad is not implemented.

`onSelect(item)` reports local selection intent; selection does not grant an item. World pickups award local-session points and update the score/discovery count in React immediately. The three hotbar slots retain their regional artwork; they are not a seven-item inventory. Multiplayer inventory ownership, pickup validation, and reconciliation still belong to the server. Refreshing resets local pickup progress.

## Playable systems

The adventurer spawns in Maharashtra at (-42, 3, -20) beside a visible Vada Pav pickup. The procedural model includes an open denim shirt, graphic tee, red gamcha headband and tail, and pixel sunglasses. Movement accelerates smoothly, normalizes diagonal input, and splits physics into steps no larger than 1/120 second. A frame contributes at most 100ms of simulation to prevent runaway catch-up. A step up to 0.55 units is automatic; jump to climb the two-unit terraces. Falling into a river returns the player to spawn without removing earned points.

The stone bridge at Z=-8 joins Maharashtra and Karnataka; wooden bridges at X=-42 and X=42 cross the southern backwater into Kerala's lower land. Segment tops use a sine arch and interpolate between actual endpoint terrain heights. Deck AABBs exactly match the generated slabs; rail AABBs prevent walking off the side while allowing jumping over them. Their collision data exists independently of streamed terrain meshes.

Five instances of each food spawn on matching biome terrain, separated from each other and the large landmark footprints. A deterministic seed keeps layouts reproducible. Seven distinct voxel recipes represent Vada Pav (10), Cutting Chai (15), Filter Coffee (15), Mysore Pak (20), Banana Chips (10), Podi Dosa (25), and Kerala Porotta (30). Items rotate and bob; conservative world-space AABBs cover those animations. Pickups remove the item from the live map before emitting a score event and disposing its GPU resources. Collecting all 35 items yields 625 points and an on-screen completion message.

Run `node --test src/reference/Gameplay.test.js src/reference/BiomeManager.test.js` for bridge traversal, jump/landing, respawn, movement normalization, deterministic streaming, and scoring tests.

For multiplayer, provide `getWorldTime()` in seconds relative to the shared session epoch. Provide `subscribePing(report)` from the existing network transport; it must return its unsubscribe function. Pass measured round-trip time in milliseconds to `report`, and `null` when disconnected. The standalone preview shows `Ping: —` because no server is attached. The label becomes `WebGL Stats: 60 FPS, Ping: 12ms` when those are the actual measurements, rather than reporting invented values. The module does not install a second socket or guess your server protocol.

## Rendering and lifecycle

Rendering is profile-driven. Auto selects low on constrained/mobile devices and balanced elsewhere; high must be explicitly requested with `?quality=high`. Low omits shadows, PMREM, SSAO, and composer render targets, caps DPR at 0.85, and targets 30 FPS. Balanced uses a 1.1 DPR ceiling and 1024² player-focused shadows without SSAO. High enables the PMREM/SSAO pipeline and broader voxel shadows. Adaptive resolution lowers the DPR ceiling after sustained slow samples.

Voxel colors use per-instance color attributes, so palette colors share dielectric or metallic materials instead of creating one material/draw family per color. Shared box geometry/materials are reference-counted and released when their final owning batch is disposed. Those same material families now sample the procedural engine's packed surface noise and semantic mask atlas; low/balanced/high detail changes only uniforms and preserves the draw/program family count. Water borrows the engine-owned seamless normal instead of allocating another texture, fades normal strength before macro colour variation becomes subpixel, and does not dispose the borrowed texture. The final engine owner reference-counts and disposes the complete 175,852-byte generated library.

`../engine/PlantGrammar.js` supplies deterministic normalized broadleaf, palm, shrub, herb, grass, and bamboo skeleton IR plus shared archetype and placement-reference contracts. `../engine/PlantGeometryCompiler.js` transforms those skeletons into exposed-face indexed typed arrays. `../engine/PlantLodCompiler.js` now derives family-aware near/mid/far forms from the same skeleton, keeping its pivot, bounds, envelope, palette topology, and placement stable while monotonically reducing boxes and triangles. Selection measures each yawed/scaled plant's own projected width and height, applies profile-specific 15–18% hysteresis, staggers reevaluation by stable ID, bypasses the periodic interval on focus-cell transitions, and never keeps two LODs drawn. Low mode allows at most 4 Hz and 5,360 selector entries; remounting the same owner/source reproduces its result. No compiler produces runtime CSG, per-box scene objects, or collision proxies. Current visible voxel vegetation remains unchanged until `VEG-06` installs owner-aware resident draw pools. Keeping the compiler stack unreferenced by the render path preserves the production bundle and prevents per-instance recursion.

The mount owns the animation loop, ResizeObserver, UI root, controls, and event listeners. Disposal removes all of them. Tab visibility resets FPS sampling. WebGL context restoration rebuilds generated sky and composer resources. In an existing engine, use its single animation loop and call manager/environment methods there; replace its render call with `environment.render(dt)`, and call resize/dispose from the same engine lifecycle.

API references: [React external-store subscriptions](https://react.dev/reference/react/useSyncExternalStore), [Three.js r170 SSAOPass](https://github.com/mrdoob/three.js/blob/r170/examples/jsm/postprocessing/SSAOPass.js), [MeshStandardMaterial](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial).

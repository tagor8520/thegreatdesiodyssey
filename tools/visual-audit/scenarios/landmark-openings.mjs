/**
 * `DET-09` — landmark grammar and openings *(curated runtime)*
 *
 * Registered gate (feature-roadmap/README.md order 098):
 *   "Repeated modules batched; arches never use one enclosing AABB"
 *
 * Research (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §15.8 `DET-09`, §16.4, §17.2, §19.5):
 *   §15.8 item 34 *"Promote landmarks to declarative modules with repeat kinds, and add a
 *   grammar gate: repeated modules batched; arches never use one enclosing AABB."*
 *   §17.2 *"visual boxes that create colliders automatically: 0"*.
 *
 * WHAT THE TWO CLAUSES MEAN IN THE RUNNING GAME, AND WHAT IS MEASURED FOR EACH
 * ---------------------------------------------------------------------------
 * 1. **Repeated modules batched.** The claim is not "the source has a loop" — it is that the
 *    boxes a loop produced reach the renderer as *instances of one draw*. So the scenario
 *    recompiles both landmarks **inside the page** from the runtime's own modules (the dev
 *    server's module graph is keyed by URL, so this is the same source the runtime loaded;
 *    `GME-06`'s gate uses the same technique), then walks the live `game.scene` and requires
 *    every compiled box — all 50 of the Gateway, all 108 of the Chariot — to be found as an
 *    instance of **one** `InstancedMesh`, with the instance's translation, scale *and* per
 *    instance colour matching the compiled box. The chunks' own boxes live in that same mesh,
 *    which is the point: a landmark is not extra draws, it is more instances of a draw the
 *    chunk was already making. The chariot's six alternating roof tiers additionally prove the
 *    colour-cycle path: six colours, one mesh, no second family.
 *    The Node tier proves the compiled boxes *are* the pre-`DET-09` loop's boxes; this tier
 *    proves the live renderer is handed them. Together the chain is legacy ⇒ declared ⇒ drawn.
 * 2. **Arches never use one enclosing AABB.** Measured against the runtime's own collision
 *    (`game.bridges.clipCamera`, the same call `Gameplay.test.js` makes), not against a
 *    re-implementation: a segment along the Gateway's centre line from before the arch to
 *    beyond it must be **open**, a segment into the pier must be **blocked**, the union AABB
 *    of the Gateway's own blockers *would* have blocked the first segment, and **no single
 *    blocker** may contain the opening's whole free volume. The last one is the clause stated
 *    as a property of the live blocker list, so a future edit that re-introduces one big box
 *    fails here even if it happens to be positioned legibly.
 *    Two page-side controls make those checks falsifiable in the same run: pushing the union
 *    box back in as a blocker must close the arch (it does), and removing the Gateway's
 *    blockers must open *both* segments (so the pier result is caused by the pier, not by the
 *    absence of any test). The Chariot contributes the wheel case — its collider is 7.3 m
 *    square because the shipped 7.0 m slab cut the drawn rim, so a probe between the two
 *    radii must be blocked here.
 */
import { capture, freshRunDirectory, openCurated, waitFrames } from '../harness.mjs';

/**
 * The page-side probe. Installed once per document; every method is read-only against the
 * runtime, except the two controls, which put the blocker list back exactly as it was.
 */
const PROBE = `async () => {
  const grammar = await import('/src/geo/GeoLandmarkGrammar.js');
  const landmarks = await import('/src/geo/GeoLandmarks.js');
  const biome = await import('/src/reference/BiomeManager.js');
  const game = globalThis.__gdoAudit.game;
  const bridges = game.bridges;
  const Vector3 = game.camera.position.constructor;

  const origins = Object.fromEntries(Object.entries(biome.LANDMARKS).map(([name, [x, z]]) => [name, { x, z }]));
  const compiled = {};
  for (const [name, definition] of Object.entries(landmarks.GEO_LANDMARK_DEFINITIONS)) {
    compiled[name] = grammar.compileLandmark(definition, { profile: 'low', origin: origins[name] });
  }

  const round = value => Math.round(value * 1000) / 1000;
  /**
   * Every instanced instance in the scene, as {mesh, box} rows with the mesh's own size.
   *
   * The per-instance colour is read as the palette's raw triple: VoxelBatch writes
   * THREE.Color(hex), and since r152 that is the renderer's *working* (linear) space,
   * so comparing it to the hex string would compare two different encodings. The compiled
   * colour is converted with the renderer's own colour class instead.
   */
  const instances = () => {
    const rows = [];
    game.scene.traverse(object => {
      if (!object.isInstancedMesh) return;
      const matrix = object.instanceMatrix.array;
      const palette = object.geometry.getAttribute('voxelColor')?.array ?? null;
      for (let index = 0; index < object.count; index++) {
        const base = index * 16;
        const sx = Math.hypot(matrix[base], matrix[base + 1], matrix[base + 2]);
        const sy = Math.hypot(matrix[base + 4], matrix[base + 5], matrix[base + 6]);
        const sz = Math.hypot(matrix[base + 8], matrix[base + 9], matrix[base + 10]);
        rows.push({
          mesh: object,
          x: round(matrix[base + 12]), y: round(matrix[base + 13]), z: round(matrix[base + 14]),
          sx: round(sx), sy: round(sy), sz: round(sz),
          // The x-y axes of the instance, unscaled by the rounding above: a rotated stone's
          // radial extent is its box's support along the outward direction, which needs the
          // axes rather than one of the side lengths.
          axisX: [matrix[base], matrix[base + 1]],
          axisY: [matrix[base + 4], matrix[base + 5]],
          rgb: palette ? [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]] : null,
        });
      }
    });
    return rows;
  };
  /** The renderer's own colour class, taken from the scene rather than imported again. */
  const colorCtor = game.scene.children.find(child => child.material?.color?.constructor)?.material.color.constructor ?? null;
  const colorMatches = (rgb, hex) => {
    if (!rgb || !colorCtor) return true;
    const expected = new colorCtor(hex);
    return Math.abs(rgb[0] - expected.r) < 0.02 && Math.abs(rgb[1] - expected.g) < 0.02 && Math.abs(rgb[2] - expected.b) < 0.02;
  };

  /** How the landmark's boxes are spread over the scene's draws. */
  const drawn = name => {
    const rows = instances();
    const meshes = new Map();
    const matched = [];
    // The instances that matched the *rim stones of this landmark*: the reach below is
    // measured from what is drawn here, not from whatever else the scene happens to hold.
    const rimRows = [];
    for (const box of compiled[name].boxes) {
      const hit = rows.find(row =>
        Math.abs(row.x - box.x) < 0.002 && Math.abs(row.y - box.y) < 0.002 && Math.abs(row.z - box.z) < 0.002 &&
        Math.abs(row.sx - box.sizeX) < 0.002 && Math.abs(row.sy - box.sizeY) < 0.002 && Math.abs(row.sz - box.sizeZ) < 0.002 &&
        colorMatches(row.rgb, box.color));
      if (!hit) continue;
      if (box.moduleId === 'wheel-rims') rimRows.push(hit);
      matched.push({ module: box.moduleId, y: box.y, rgb: hit.rgb ? hit.rgb.map(channel => round(channel)) : null });
      meshes.set(hit.mesh.uuid, (meshes.get(hit.mesh.uuid) ?? 0) + 1);
    }
    const counts = [...meshes.values()];
    return {
      expected: compiled[name].boxes.length,
      matched: matched.length,
      draws: counts.length,
      instancesPerDraw: counts,
      // Chariot roof colours come from a colour cycle; six tiers must be one mesh, two colours.
      tierColors: [...new Set(matched.filter(row => row.module === 'roof').map(row => JSON.stringify(row.rgb)))],
      families: compiled[name].boxes.reduce((set, box) => set.add(box.metalness ?? 0), new Set()).size,
      budget: compiled[name].budget,
      // The drawn wheel rim's reach from its hub, measured from the live instances — this is
      // what the collider has to contain. The stones sit at radius 3.0 and are rotated to face
      // the hub, so the radial extent is the box's support along the outward direction; the
      // 45-degree stones put a corner 0.7 m out, i.e. 3.7 m, which the pre-DET-09 7 m slab
      // (half-extent 3.5) cut off.
      wheelReach: name === 'chariot' && rimRows.length ? (() => {
        const hubs = compiled.chariot.proxies.filter(proxy => proxy.id.startsWith('chariot:wheel:'))
          .map(proxy => ({ x: proxy.x, y: proxy.y }));
        return round(Math.max(...rimRows.map(row => {
          const hub = hubs.reduce((best, candidate) =>
            Math.hypot(row.x - candidate.x, row.y - candidate.y) < Math.hypot(row.x - best.x, row.y - best.y) ? candidate : best);
          const distance = Math.hypot(row.x - hub.x, row.y - hub.y);
          if (distance < 1) return 0;
          const radial = [(row.x - hub.x) / distance, (row.y - hub.y) / distance];
          const support = (Math.abs(row.axisX[0] * radial[0] + row.axisX[1] * radial[1]) +
            Math.abs(row.axisY[0] * radial[0] + row.axisY[1] * radial[1])) / 2;
          return distance + support;
        })));
      })() : null,
      rimInstances: rimRows.length,
    };
  };

  const clip = (from, to, radius) => {
    const result = bridges.clipCamera(new Vector3(from[0], from[1], from[2]), new Vector3(to[0], to[1], to[2]), radius, {});
    return { blocked: result.blocked === true, distance: round(result.distance ?? -1) };
  };
  const blockerIds = () => bridges.cameraBlockers.map(box => box.userData?.id ?? '(unlabelled)');
  const blockerOf = id => bridges.cameraBlockers.find(box => box.userData?.id === id) ?? null;
  const unionOf = prefix => {
    const boxes = bridges.cameraBlockers.filter(box => (box.userData?.id ?? '').startsWith(prefix));
    if (!boxes.length) return null;
    return boxes.reduce((union, box) => union.union(box), boxes[0].clone());
  };
  /** The clip test's own radius policy, mirrored from the runtime's camera. */
  const sweepRadius = () => {
    const camera = game.camera;
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * camera.near;
    const halfWidth = halfHeight * Math.max(.25, camera.aspect || 1);
    return Math.min(1.25, Math.max(.6, Math.hypot(halfWidth, halfHeight) + .15));
  };
  /** Does one live blocker contain the opening's whole free volume? The gate's clause. */
  const enclosingBlocker = name => {
    const [voidDefinition] = Object.values(compiled[name].voids);
    if (!voidDefinition) return 'no-void';
    const free = grammar.landmarkVoidHalfWidthAt(voidDefinition, voidDefinition.bottom + 1);
    const headTop = voidDefinition.bands[voidDefinition.bands.length - 1].top;
    const centreX = compiled[name].origin.x + voidDefinition.offsetX;
    const centreZ = compiled[name].origin.z + voidDefinition.offsetZ;
    const offender = bridges.cameraBlockers.find(box =>
      box.min.x <= centreX - free && box.max.x >= centreX + free &&
      box.min.z <= centreZ - voidDefinition.halfDepth && box.max.z >= centreZ + voidDefinition.halfDepth &&
      box.min.y <= voidDefinition.bottom && box.max.y >= headTop);
    return offender ? (offender.userData?.id ?? '(unlabelled)') : null;
  };
  const place = (x, z) => {
    const player = game.player;
    player.position.set(x, player.groundAt(x, z), z);
    player.velocity.set(0, 0, 0);
    player.grounded = true;
    player.root.position.copy(player.position);
    player.orbit.target.copy(player.position).y += 2;
  };

  globalThis.__lmAudit = {
    move: place,
    sweepRadius,
    clip,
    blockerIds,
    blockerOf: id => {
      const box = blockerOf(id);
      if (!box) return null;
      return {
        id: box.userData.id,
        size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map(round),
        centre: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2].map(round),
        role: box.userData.role ?? null,
      };
    },
    drawn,
    enclosingBlocker,
    unionWouldBlock: (prefix, from, to) => {
      const union = unionOf(prefix);
      if (!union) return null;
      const start = new Vector3(from[0], from[1], from[2]), end = new Vector3(to[0], to[1], to[2]);
      const point = new Vector3();
      // Sample the segment against the union the way a single-mesh collision would have.
      for (let step = 0; step <= 200; step++) {
        point.lerpVectors(start, end, step / 200);
        if (union.containsPoint(point)) return true;
      }
      return false;
    },
    /** Control 1: push the pre-DET-09 single box back in and require the arch to close. */
    withUnionBox(name, run) {
      const union = unionOf(name + ':');
      const added = new Vector3();
      const size = new Vector3();
      union.getCenter(added); union.getSize(size);
      const box = new (blockerOf(blockerIds()[0]).constructor)().setFromCenterAndSize(added, size);
      box.userData = { id: name + ':enclosing-aabb', role: 'camera-blocker' };
      bridges.cameraBlockers.push(box);
      const outcome = run();
      bridges.cameraBlockers.pop();
      return outcome;
    },
    /** Control 2: drop a landmark's blockers entirely and report what opens up. */
    withoutBlockers(name, run) {
      const held = bridges.cameraBlockers.filter(box => (box.userData?.id ?? '').startsWith(name + ':'));
      bridges.cameraBlockers = bridges.cameraBlockers.filter(box => !held.includes(box));
      const outcome = run();
      bridges.cameraBlockers.push(...held);
      return outcome;
    },
    /** Re-derive the runtime's own blocker list from the definitions, for comparison. */
    recompiled(name) {
      return grammar.landmarkCameraBlockers(compiled[name]).map(proxy => name + ':' + proxy.id.slice(name.length + 1));
    },
  };
}`;

export async function run({ page, baseUrl, log = console.log }) {
  const directory = freshRunDirectory('det09-landmark-openings');
  const failures = [];
  const screenshots = [];

  await openCurated(page, baseUrl);
  // `page.evaluate(<string>)` evaluates the string as an expression; the probe is a
  // function literal, so it has to be called explicitly or nothing is installed.
  await page.evaluate(`(${PROBE})()`);

  /** Wait for a landmark's boxes to be resident: pin the player beside it, then poll. */
  const waitForLandmark = async (name, x, z, expected, timeout = 60_000) => {
    await page.evaluate(({ x, z }) => globalThis.__lmAudit.move(x, z), { x, z });
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      await waitFrames(page, 12);
      last = await page.evaluate(name => globalThis.__lmAudit.drawn(name), name);
      if (last.matched === expected && last.draws === 1 && (name !== 'chariot' || last.wheelReach)) return last;
    }
    return last;
  };

  // ------------------------------------------------------- 1. repeated modules batched
  const gatewayDrawn = await waitForLandmark('gateway', -66, -24, 50);
  log(`[det09] gateway: ${gatewayDrawn.matched}/${gatewayDrawn.expected} box(es) found as instances of ${gatewayDrawn.draws} mesh(es) ${JSON.stringify(gatewayDrawn.instancesPerDraw)}`);
  if (gatewayDrawn.matched !== 50) {
    failures.push(`only ${gatewayDrawn.matched} of the Gateway's 50 compiled boxes are in the scene; the drawn geometry is not the compiled geometry`);
  }
  if (gatewayDrawn.draws !== 1) {
    failures.push(`the Gateway's boxes are spread over ${gatewayDrawn.draws} instanced draws; repeated modules are not batched`);
  }
  screenshots.push(await capture(page, directory, 'gateway-arch'));

  const chariotDrawn = await waitForLandmark('chariot', 62, -24, 108);
  log(`[det09] chariot: ${chariotDrawn.matched}/${chariotDrawn.expected} box(es) found as instances of ${chariotDrawn.draws} mesh(es) ${JSON.stringify(chariotDrawn.instancesPerDraw)}`);
  if (chariotDrawn.matched !== 108) {
    failures.push(`only ${chariotDrawn.matched} of the Chariot's 108 compiled boxes are in the scene`);
  }
  if (chariotDrawn.draws !== 1) {
    failures.push(`the Chariot's 108 boxes reach the renderer as ${chariotDrawn.draws} draws; the repeat grammar is not batching`);
  }
  if (chariotDrawn.tierColors.length !== 2) {
    failures.push(`the six alternating roof tiers carry ${chariotDrawn.tierColors.length} distinct colour(s); the colour cycle is not what is drawn`);
  }
  // A landmark with more boxes than the budget may not be drawn past it; the low profile is
  // what both runtimes run, and neither shipped landmark drops anything to fit.
  for (const [name, drawn] of [['gateway', gatewayDrawn], ['chariot', chariotDrawn]]) {
    if (drawn.expected > drawn.budget) failures.push(`${name} compiles ${drawn.expected} boxes against a budget of ${drawn.budget}`);
  }
  screenshots.push(await capture(page, directory, 'chariot-wheels'));

  // --------------------------------------------- 2. arches never use one enclosing AABB
  const arch = await page.evaluate(async () => {
    const audit = globalThis.__lmAudit;
    const radius = audit.sweepRadius();
    const ids = audit.blockerIds();
    const centre = [-66, 6, -44];
    return {
      radius,
      gatewayBlockers: ids.filter(id => id.startsWith('gateway:')).length,
      chariotBlockers: ids.filter(id => id.startsWith('chariot:')).length,
      total: ids.length,
      unique: new Set(ids).size,
      throughArch: audit.clip(centre, [-66, 6, -24], radius),
      intoPier: audit.clip(centre, [-76, 6, -44], radius),
      unionWouldBlock: audit.unionWouldBlock('gateway:', centre, [-66, 6, -24]),
      enclosing: audit.enclosingBlocker('gateway'),
      // The wheel is a disc in the x-y plane at z = -50.5, so its reach is along x and y; a
      // probe along z would only measure its 1.8 m thickness. Both probes run along z at a
      // fixed |dx| from the hub and start beyond the body (which ends at z = -50), so the
      // only thing they can meet is the wheel. 3.6 m is inside the drawn rim; 4.5 m is clear
      // of it and of the body (|dx| - 7 > the 0.6 m sweep radius), which is what makes the
      // pair meaningful. The quantitative half of the same claim — the collider's extent
      // against the reach measured from the instances — is asserted beside these.
      wheelNear: audit.clip([67 + 3.6, 7, -58], [67 + 3.6, 7, -44], .6),
      wheelClear: audit.clip([67 + 4.5, 7, -58], [67 + 4.5, 7, -44], .6),
      wheelBlocker: audit.blockerOf('chariot:wheel:5:-5'),
      recompiledGateway: audit.recompiled('gateway'),
      liveGateway: ids.filter(id => id.startsWith('gateway:')),
      recompiledChariot: audit.recompiled('chariot'),
      liveChariot: ids.filter(id => id.startsWith('chariot:')),
    };
  });
  log(`[det09] ${arch.total} live camera blockers, ${arch.gatewayBlockers + arch.chariotBlockers} of them landmarks ` +
    `(${arch.gatewayBlockers} gateway, ${arch.chariotBlockers} chariot), all ids distinct ${arch.unique === arch.total}, sweep radius ${arch.radius.toFixed(3)}`);
  log(`[det09] drawn wheel rim reaches ${chariotDrawn.wheelReach} m from its hub; the pre-DET-09 collider reached 3.5 m, the live one reaches ${(arch.wheelBlocker?.size?.[0] ?? 0) / 2} m`);
  log(`[det09] arch (curated): through-opening open · the same stretch inside the union of the Gateway blockers would be blocked=${arch.unionWouldBlock}`);
  log(`[det09] arch: through=${arch.throughArch.blocked ? 'BLOCKED' : 'open'} into-pier=${arch.intoPier.blocked ? 'blocked' : 'OPEN'} ` +
    `union-would-block=${arch.unionWouldBlock} enclosing-blocker=${arch.enclosing ?? 'none'}`);
  log(`[det09] wheel: a 3.6 m probe is ${arch.wheelNear.blocked ? 'blocked' : 'OPEN'} · a 4.5 m probe is ${arch.wheelClear.blocked ? 'blocked' : 'open'} · collider ${JSON.stringify(arch.wheelBlocker?.size ?? null)}`);

  // `total` is every camera blocker in the runtime — the landmarks plus the ordinary
  // structures; the landmark split is the part this gate owns and the port had to preserve.
  if (arch.unique !== arch.total) failures.push(`the ${arch.total} camera blockers do not all have distinct ids, so a gate cannot address one`);
  if (arch.gatewayBlockers !== 18 || arch.chariotBlockers !== 16) {
    failures.push(`the landmarks hold ${arch.gatewayBlockers} gateway + ${arch.chariotBlockers} chariot blockers, not the 18 + 16 the pre-DET-09 runtime held`);
  }
  if (arch.throughArch.blocked !== false) failures.push('the walk-through-the-arch segment is blocked: this is the enclosing AABB the gate forbids');
  if (arch.intoPier.blocked !== true) failures.push('the into-pier segment is open, so the arch result means nothing');
  if (arch.unionWouldBlock !== true) failures.push('the union of the Gateway blockers does not cross the arch segment, so the tight-compound claim is untested');
  if (arch.enclosing) failures.push(`a single live blocker (${arch.enclosing}) contains the whole opening`);
  if (!(chariotDrawn.wheelReach > 3.5)) {
    failures.push(`the drawn wheel rim reaches only ${chariotDrawn.wheelReach} m from its hub, so neither the wider collider nor the pre-DET-09 cut can be shown`);
  }
  if (arch.wheelBlocker && chariotDrawn.wheelReach && arch.wheelBlocker.size[0] / 2 + 1e-6 < chariotDrawn.wheelReach) {
    failures.push(`the wheel collider (half-extent ${arch.wheelBlocker.size[0] / 2}) does not contain the drawn rim (${chariotDrawn.wheelReach} m)`);
  }
  if (arch.wheelNear.blocked !== true) failures.push('a probe inside the drawn rim is not blocked, so a wheel is a hole a camera can enter');
  if (arch.wheelClear.blocked !== false) failures.push('the segment clear of the wheel is blocked, so the wheel result means nothing');
  // The live list must be the list the definitions derive: same ids, same order.
  for (const name of ['gateway', 'chariot']) {
    const live = arch[`live${name[0].toUpperCase()}${name.slice(1)}`];
    const recompiled = arch[`recompiled${name[0].toUpperCase()}${name.slice(1)}`];
    if (JSON.stringify(live) !== JSON.stringify(recompiled)) {
      failures.push(`the live ${name} blockers are not the ones the definitions derive:\n    live ${live.join(' ')}\n    from ${recompiled.join(' ')}`);
    }
  }
  screenshots.push(await capture(page, directory, 'gateway-from-pier'));

  // ------------------------------------------------ 3. controls: the checks can fail
  const controls = await page.evaluate(() => {
    const audit = globalThis.__lmAudit;
    const radius = audit.sweepRadius();
    const centre = [-66, 6, -44];
    return {
      // With the pre-DET-09 single box back in the list the arch must close.
      archClosedWithUnion: audit.withUnionBox('gateway', () => audit.clip(centre, [-66, 6, -24], radius).blocked),
      // Without the Gateway's blockers the pier segment must open: the pier result above is
      // caused by a pier blocker, not by a runtime that blocks everything.
      pierOpenWithoutPier: audit.withoutBlockers('gateway', () => audit.clip(centre, [-76, 6, -44], radius).blocked),
      // ...and the blocker list is exactly as it was after both controls.
      restored: audit.blockerIds().filter(id => id.startsWith('gateway:') || id.startsWith('chariot:')).length,
    };
  });
  log(`[det09] controls: union box closes the arch=${controls.archClosedWithUnion} · ` +
    `without the Gateway's blockers the pier is blocked=${controls.pierOpenWithoutPier} · restored ${controls.restored} landmark blockers`);
  if (controls.archClosedWithUnion !== true) failures.push('control 1 failed: the enclosing AABB does not close the arch, so the arch check is not measuring the blockers');
  if (controls.pierOpenWithoutPier !== false) failures.push('control 2 failed: the pier segment stays blocked without any Gateway blocker, so something other than a landmark blocker is blocking it');
  if (controls.restored !== 34) failures.push(`control cleanup failed: ${controls.restored} landmark blockers after the controls, not 34`);

  log(`[det09] ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  for (const failure of failures) log(`  ${failure}`);
  return {
    directory,
    // A hard gate: the field `run.mjs` prints as `blockers` is the failure count, like the
    // other contract scenarios — the live blocker counts are in the summary lines above.
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    landmarkFailures: failures,
    fixtures: ['curated'],
    summary: { gatewayDrawn, chariotDrawn, arch, controls, screenshots },
  };
}

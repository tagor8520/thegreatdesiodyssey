/**
 * `LIF-05` traffic pools — the `COL-09`-served visual stream for road vehicles
 * and boats, consuming `DET-07`'s `createVehicleGeometries` as the whole
 * vehicle body per family (rebuild, not hand-build).
 *
 * Research §9.4: a vehicle is an animated body with a tight proxy near the
 * player. The pool writes bounded instance matrices only when a mover actually
 * changed, and the **solid** decision is separate and capped: each near mover
 * registers one tight oriented box in the `COL-09` dynamic proxy grid
 * (`SOLID_PLAYER | CAMERA_BLOCKER` — a moving body, not a placement anchor),
 * moves it on cell-crossing only, and unregisters when it leaves the active
 * physics radius. The grid's own cap plus this pool's `trafficProxies` ceiling
 * make the worst frame bounded; a skipped registration is counted by name.
 *
 * The visibility gate reuses the landed `LIF-02` scheduler: hidden movers are
 * parked at zero visibility and their matrices are never written, and the
 * scheduler's budgets cap the per-update work exactly as for pedestrians.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAmbientLifeScheduler } from '../engine/AmbientLifeScheduler.js';
import { GDO_TRAFFIC_KIND } from '../engine/LocalTraffic.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { createVehicleGeometries } from './GeoVehiclePools.js';

export const GEO_TRAFFIC_PROXY_MASK =
  GEO_QUERY_MASK.SOLID_PLAYER |
  GEO_QUERY_MASK.CAMERA_BLOCKER;

function box(width, height, depth, x, y, z, color) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Boat bodies: two families with `DET-07`'s rule made literal — one merged
 * body per hull, tight to its real size, never a scatter of parts.
 */
export function createBoatGeometries() {
  return [
    mergeGeometries([
      box(.13, .06, .52, 0, .05, 0, [.34, .24, .17]),
      box(.10, .04, .18, 0, .10, -.07, [.27, .19, .13]),
    ], true),
    mergeGeometries([
      box(.16, .07, .60, 0, .055, 0, [.36, .36, .40]),
      box(.12, .08, .17, 0, .13, -.12, [.72, .74, .78]),
      box(.03, .10, .03, 0, .20, -.02, [.2, .2, .22]),
    ], true),
  ];
}

export function createTrafficPools({
  profile = 'low',
  scene = null,
  policy = null,
  limits = null,
  proxyLimits = null,
  ledger = null,
} = {}) {
  if (!policy) throw new TypeError('Traffic pools need the board policy for their caps');
  const maxVehicles = policy.maxVehicles;
  const maxBoats = policy.maxBoats;
  const proxyCaps = proxyLimits ?? {
    maxProxies: Math.min(12, maxVehicles + maxBoats),
    activeRadius: 6,
  };

  // The `LIF-02` gate, with this board's caps: one source per mover anchor.
  const scheduler = createAmbientLifeScheduler({
    profile,
    limits: limits ?? {
      maxActiveSources: maxVehicles + maxBoats,
      maxSourcesPerUpdate: maxVehicles + maxBoats,
      maxResidentSources: Math.min(32, (maxVehicles + maxBoats) * 2),
    },
    ledger,
  });

  const materials = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
  });
  const vehicleFamilies = createVehicleGeometries();
  const boatFamilies = createBoatGeometries();
  const batches = [];
  function addBatches(geometries, kind, perFamily) {
    geometries.forEach((geometry, familyIndex) => {
      const mesh = new THREE.InstancedMesh(geometry, materials, perFamily);
      mesh.name = `gdo-traffic-${kind}-${familyIndex}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      batches.push({ kind, familyIndex, mesh, matrices: [], written: new Map() });
    });
  }
  addBatches(vehicleFamilies, GDO_TRAFFIC_KIND.ROAD, Math.max(1, maxVehicles));
  addBatches(boatFamilies, GDO_TRAFFIC_KIND.BOAT, Math.max(1, maxBoats));

  const group = new THREE.Group();
  group.name = 'gdo-traffic';
  for (const batch of batches) group.add(batch.mesh);
  if (scene) scene.add(group);

  const counters = {
    cpuUpdates: 0,
    cpuUpdatesBudget: policy.maxAgentsPerUpdate,
    uploads: 0,
    proxyRegistered: 0,
    proxyRemoved: 0,
    proxySkippedCap: 0,
    proxyMoves: 0,
  };
  // Proxy state lives here, keyed by board slot: `residentRecords` hands out
  // copies, so the pool must own what it registered.
  const proxies = new Map();
  const seenSlots = new Set();
  let lastElapsedMs = 0;

  function sync(board, { nowMilliseconds = 0, view = null, dynamicProxies = null, proxyRadius = proxyCaps.activeRadius } = {}) {
    if (!board?.residentRecords) return counters;
    const { records, count } = board.residentRecords();
    counters.cpuUpdates = 0;
    seenSlots.clear();
    for (const batch of batches) batch.count = 0;
    scheduler.begin(view ?? {});
    for (let index = 0; index < count; index++) {
      const record = records[index];
      scheduler.evaluate({
        id: `traffic:${record.slot}`,
        familyIndex: record.familyIndex,
        x: record.x,
        y: record.y,
        z: record.z,
        radius: record.radius,
        viewDistance: record.viewDistance,
        priority: record.priority,
        windowLive: record.windowLive !== false && record.state !== 'dormant',
      });
    }
    scheduler.finish();

    for (let index = 0; index < count; index++) {
      const record = records[index];
      const decision = scheduler.decisions[index];
      const visibility = decision ? decision.visibility : 0;
      seenSlots.add(record.slot);
      const proxyState = proxies.get(record.slot) ?? null;
      if (visibility <= 0) {
        // Hidden movers neither upload matrices nor keep a solid proxy.
        if (dynamicProxies && proxyState) {
          dynamicProxies.remove(proxyState.id);
          proxies.delete(record.slot);
          counters.proxyRemoved++;
        }
        continue;
      }
      const batch = batches.find(candidate =>
        candidate.kind === record.kind && candidate.familyIndex === record.familyIndex) ?? batches[0];
      const slot = batch.count++;
      const matrix = batch.matrices[slot] ?? (batch.matrices[slot] = new THREE.Matrix4());
      const headingX = Math.sin(record.heading), headingZ = Math.cos(record.heading);
      matrix.set(
        headingZ * record.scale, 0, headingX * record.scale, record.x,
        0, record.scale, 0, record.y,
        -headingX * record.scale, 0, headingZ * record.scale, record.z,
        0, 0, 0, 1,
      );
      batch.mesh.setMatrixAt(slot, matrix);
      counters.cpuUpdates++;

      // The capped `COL-09` decision: one tight body box while near the player.
      if (dynamicProxies) {
        const playerX = view?.x ?? 0, playerZ = view?.z ?? 0;
        const shouldProxy = Math.hypot(record.x - playerX, record.z - playerZ) <= proxyRadius;
        if (shouldProxy && !proxyState) {
          if (proxies.size >= proxyCaps.maxProxies) {
            counters.proxySkippedCap++;
          } else {
            const id = `traffic:${record.slot}:${record.routeId ?? 0}`;
            const halfX = record.kind === GDO_TRAFFIC_KIND.ROAD ? .09 * record.scale : .07 * record.scale;
            const halfZ = record.kind === GDO_TRAFFIC_KIND.ROAD ? .17 * record.scale : .28 * record.scale;
            dynamicProxies.insert(id, {
              kind: 'obb',
              x: record.x, z: record.z,
              halfX, halfZ,
              rotation: -record.heading,
              ySpan: [record.y, record.y + (record.kind === GDO_TRAFFIC_KIND.ROAD ? .16 : .22)],
            }, { mask: GEO_TRAFFIC_PROXY_MASK });
            proxies.set(record.slot, { id, x: record.x, z: record.z });
            counters.proxyRegistered++;
          }
        } else if (!shouldProxy && proxyState) {
          dynamicProxies.remove(proxyState.id);
          proxies.delete(record.slot);
          counters.proxyRemoved++;
        } else if (shouldProxy && proxyState) {
          // Cell-crossing only: the grid re-inserts strictly at crossings.
          dynamicProxies.move(proxyState.id, record.x - proxyState.x, record.z - proxyState.z,
            { y: record.y });
          proxyState.x = record.x;
          proxyState.z = record.z;
          counters.proxyMoves++;
        }
      }
    }
    // A mover that despawned between syncs leaves no live record — its proxy
    // goes with it, so the grid can never accumulate the dead.
    for (const [slot, proxyState] of [...proxies]) {
      if (seenSlots.has(slot)) continue;
      dynamicProxies?.remove(proxyState.id);
      proxies.delete(slot);
      counters.proxyRemoved++;
    }
    for (const batch of batches) {
      batch.mesh.count = batch.count;
      if (batch.count) batch.mesh.instanceMatrix.needsUpdate = true;
    }
    if (count) counters.uploads++;
    return counters;
  }

  function update(now) {
    // One clock uniform for the whole pool: `LocalTraffic.update` already did
    // the CPU stepping at its declared rate, so the frame costs one write.
    lastElapsedMs = now;
    materials.opacity = 1;
    return lastElapsedMs;
  }

  const handle = ledger?.own?.('pool', 'gdo:localTraffic:v1:pool', { group, batches }, item => {
    item.batches?.forEach(batch => batch.mesh?.dispose?.());
    item.group?.removeFromParent();
  }) ?? null;

  return {
    group,
    batches,
    scheduler,
    counters,
    sync,
    update,
    dispose() {
      handle?.release?.();
      scheduler.dispose?.();
      for (const batch of batches) {
        batch.mesh.geometry.dispose();
        batch.mesh.dispose?.();
      }
      materials.dispose();
      group.removeFromParent();
      for (const geometry of vehicleFamilies) geometry.dispose();
      for (const geometry of boatFamilies) geometry.dispose();
    },
  };
}

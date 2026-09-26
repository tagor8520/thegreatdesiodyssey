import * as THREE from 'three';
import { evaluateLowProfileBudget } from '../engine/PerformanceBudget.js';
import {
  GEO_DEBUG_LIMITS,
  buildGeoDebugSnapshot,
  collectGeoRuntimeBudgetMetrics,
} from './GeoDiagnostics.js';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMilliseconds(value) { return Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'n/a'; }

function snapshotText(snapshot, metrics, report) {
  const summary = snapshot.summary;
  const timings = summary.timings ?? {};
  const layers = summary.layers.map(([name, count]) => `${name}:${count}`).join(' · ') || 'none';
  const masks = summary.masks.map(([name, count]) => `${name}:${count}`).join(' · ') || 'none';
  const breaches = report.breaches.map(item => `${item.metric} ${item.actual}/${item.ceiling}`).join(' · ');
  const materials = summary.materials?.records?.map(record =>
    `${record.name}:${record.width}x${record.height} ${record.format}/${record.colorSpace} ${record.wrap} ${record.magFilter}/${record.minFilter} ${formatBytes(record.estimatedBytes)} #${record.checksum}`,
  ).join(' · ') ?? 'unavailable';
  const waterFields = summary.waterDomainProfiles?.map(record => {
    const classes = Object.entries(record.classCounts ?? {}).filter(([, count]) => count)
      .map(([name, count]) => `${name}:${count}`).join(',') || 'unknown:0';
    return `${record.owner} ${classes} flow:${record.flowingPolygons}/${record.mappedFlowSegments}`;
  }).join(' · ') || 'none';
  const buildingFields = summary.buildingGrammarProfiles?.map(record =>
    `${record.owner}${record.visible ? '*' : ''} selected:${record.selectedBuildings}/${record.candidates} boxes:${record.boxes} road:${record.roadTests}`,
  ).join(' · ') || 'none';
  const furnitureFields = summary.streetFurnitureProfiles?.map(record =>
    `${record.owner} placed:${record.placements}/${record.candidates} road:${record.roadTests} reserve:${record.buildingTests + record.decorationTests}`,
  ).join(' · ') || 'none';
  return [
    `DEBUG ${report.ok ? 'PASS' : 'OVER BUDGET'} · ${snapshot.lineSegments} lines${snapshot.truncated ? ' · line cap' : ''}`,
    `owners ${summary.owners.join(', ') || 'none'}`,
    `layers ${layers}`,
    `bounds ${summary.collisionPolygons} · masks ${masks}`,
    `support roads:${summary.roadSupports} slots:${summary.supportSlots} occupied:${summary.occupiedSlots}`,
    `focus ${summary.focusSupport ? `${summary.focusSupport.kind}@${summary.focusSupport.physicalLevel} y=${summary.focusSupport.y.toFixed(3)}` : 'none'} · LOD ${summary.lod}`,
    `worker roads ${formatMilliseconds(timings.roadsMilliseconds)} · context ${formatMilliseconds(timings.contextMilliseconds)} · buildings ${formatMilliseconds(timings.buildingsMilliseconds)}`,
    `render ${metrics.drawCalls} draws · ${Math.round(metrics.triangles / 1000)}k tris · GPU est ${formatBytes(metrics.estimatedGpuBytes)} · collision ${formatBytes(metrics.collisionBytesPerTile)}/tile · mount max ${formatMilliseconds(metrics.mainThreadMountMilliseconds)}`,
    `water fields ${formatBytes(metrics.waterDomainBytesPerTile)}/tile · ${waterFields}`,
    `building grammar visible:${metrics.buildingDetailBuildings} boxes:${metrics.buildingDetailBoxes} tris:${metrics.buildingDetailTriangles} draw:${metrics.buildingDetailAddedDrawCalls} ${formatBytes(metrics.buildingDetailBytesPerTile)}/tile · ${buildingFields}`,
    `street furniture entries:${metrics.streetFurnitureEntries} families:${metrics.streetFurnitureFamilies} active:${summary.streetFurniture?.activeDrawPools ?? 0} tris:${metrics.streetFurnitureVisibleTriangles} draw:${metrics.streetFurnitureAddedDrawCalls} GPU:${formatBytes(metrics.streetFurnitureGpuBytes)} tile:${formatBytes(metrics.streetFurnitureBytesPerTile)} · ${furnitureFields}`,
    `materials ${summary.materials?.ready ? 'ready' : 'generating'} ${formatBytes(metrics.materialTextureBytes)} · ${materials}`,
    `plant IR ${summary.plantGrammar?.profile ?? 'none'} cache:${metrics.plantArchetypes} nodes:${metrics.plantSkeletonNodes} modules:${metrics.plantSkeletonModules}`,
    `plant geometry ${summary.plantGeometry?.profile ?? 'none'} cache:${metrics.plantGeometryArchetypes} boxes:${metrics.plantGeometryBoxes} tris:${metrics.plantGeometryTriangles} ${formatBytes(metrics.plantGeometryBytes)}`,
    `plant LOD ${summary.plantLods?.profile ?? 'none'} sets:${metrics.plantLodSets} geometries:${metrics.plantLodGeometries} ${formatBytes(metrics.plantLodBytes)} entries:${metrics.plantLodEntries} @${metrics.plantLodReevaluationsHz}Hz switches:${summary.plantLodSelector?.switches ?? 0} holds:${summary.plantLodSelector?.hysteresisHolds ?? 0} compile-max:${formatMilliseconds(metrics.plantCompileMilliseconds)}`,
    `plant pools ${summary.plantRender?.profile ?? 'none'} owners:${summary.plantRender?.owners ?? 0} records:${metrics.plantRenderEntries} active:${summary.plantRender?.activeDrawPools ?? 0}/${summary.plantRender?.drawPools ?? 0} tiers:${metrics.plantRenderSourceGeometries} GPU:${formatBytes(metrics.plantRenderGpuBytes)} tris:${metrics.plantRenderVisibleTriangles} draw-delta:${metrics.plantRenderAddedDrawCalls} repacks:${summary.plantRender?.repacks ?? 0} matrix-last:${summary.plantRender?.lastMatrixUploads ?? 0}`,
    `plant wind ${summary.plantRender?.wind?.namespace ?? 'none'} strength:${(summary.plantRender?.wind?.strength ?? 0).toFixed(2)} gust:${(summary.plantRender?.wind?.gustiness ?? 0).toFixed(2)} reduced:${summary.plantRender?.reducedMotion ?? false} uniform/frame:${metrics.plantWindUniformWritesPerFrame} CPU-matrices:${metrics.plantWindCpuMatrixUpdatesPerFrame} alloc:${metrics.plantWindSteadyFrameAllocations}`,
    `bridge ${summary.bridges?.namespace ?? 'none'} modules:${metrics.bridgeEntries} families:${metrics.bridgeFamilies} tris:${metrics.bridgeVisibleTriangles} draw:${metrics.bridgeAddedDrawCalls} compounds:${metrics.bridgeCompounds}/${metrics.bridgeStructuralCompounds} spans/tile:${metrics.bridgeSpansPerTile} piers/tile:${metrics.bridgePiersPerTile} bytes/tile:${formatBytes(metrics.bridgeBytesPerTile)}`,
    `landmarks ${summary.landmarks?.namespace ?? 'none'} heroes:${metrics.landmarkHeroes} boxes:${metrics.landmarkBoxes} boxes/tile:${metrics.landmarkBoxesPerTile} tris:${metrics.landmarkVisibleTriangles} draw:${metrics.landmarkAddedDrawCalls} openings:${metrics.landmarkOpenings} passable:${metrics.landmarkPassableOpenings} compounds:${metrics.landmarkCompounds}/${metrics.landmarkStructuralCompounds} enclosing:${metrics.landmarkEnclosingCompounds} GPU:${formatBytes(metrics.landmarkGpuBytes)} bytes/tile:${formatBytes(metrics.landmarkBytesPerTile)}`,
    `ambient life ${summary.ambientLife?.namespace ?? 'none'} sprites:${metrics.ambientLifeEntries} families:${metrics.ambientLifeFamilies} tris:${metrics.ambientLifeVisibleTriangles}/${metrics.ambientLifeSpriteTriangles} draw:${metrics.ambientLifeAddedDrawCalls} uniform/frame:${metrics.ambientLifeUniformWritesPerFrame} CPU-matrices:${metrics.ambientLifeCpuMatrixUpdatesPerFrame} alloc:${metrics.ambientLifeSteadyFrameAllocations} reduced:${summary.ambientLife?.reducedMotion ?? false} pruned:${summary.ambientLife?.capEvents?.pruned ?? 0}`,
    `query collision:${metrics.maxCollisionCandidates} support:${metrics.maxSupportCandidates}${breaches ? ` · FAIL ${breaches}` : ''}`,
  ].join('\n');
}

/** Debug rendering is one capped line draw and remains absent while disabled. */
export class GeoDebugOverlay {
  constructor(scene, panel = null) {
    this.scene = scene;
    this.panel = panel;
    this.enabled = false;
    this.disposed = false;
    this.lastUpdate = -Infinity;
    this.snapshot = null;
    this.metrics = null;
    this.report = null;
    this.material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .92, depthTest: false });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.name = 'geo-debug-proxies';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10_000;
    this.lines.visible = false;
    scene.add(this.lines);
    if (panel) panel.hidden = true;
  }

  setEnabled(enabled) {
    if (this.disposed) return false;
    this.enabled = Boolean(enabled);
    this.lines.visible = this.enabled;
    if (this.panel) this.panel.hidden = !this.enabled;
    if (this.enabled) this.lastUpdate = -Infinity;
    return this.enabled;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  update(world, focus, renderer, now = performance.now(), force = false) {
    if (this.disposed || !this.enabled || (!force && now - this.lastUpdate < GEO_DEBUG_LIMITS.refreshMilliseconds)) return this.snapshot;
    this.lastUpdate = now;
    const snapshot = buildGeoDebugSnapshot(world, focus);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(snapshot.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(snapshot.colors, 3));
    if (snapshot.positions.length) geometry.computeBoundingSphere();
    const previous = this.lines.geometry;
    this.lines.geometry = geometry;
    previous.dispose();
    this.snapshot = snapshot;
    this.metrics = collectGeoRuntimeBudgetMetrics(renderer, world);
    this.report = evaluateLowProfileBudget(this.metrics);
    if (this.panel) {
      this.panel.textContent = snapshotText(snapshot, this.metrics, this.report);
      this.panel.dataset.budget = this.report.ok ? 'pass' : 'fail';
    }
    return snapshot;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    this.material.dispose();
    if (this.panel) { this.panel.hidden = true; this.panel.textContent = ''; }
    this.snapshot = null;
  }
}

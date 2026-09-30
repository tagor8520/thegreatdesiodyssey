import * as THREE from 'three';
import { buildModuleGroup } from './VoxelBuilder.js';
import { GDO_CONTENT_SCHEMA_NAMESPACE, loadContentState } from './ContentSchema.js';
import { compileStatePack } from './RecipeCompiler.js';
import { GDO_STATE_PACK_IDS, statePackRuntimePath } from './StateCatalog.js';

const PICKUP_RADIUS = 1.8;

export class StateManager {
  /**
   * @param {THREE.Scene} scene
   * @param {object} hud - { hotbar, banner, stateLabel }
   */
  constructor(scene, hud) {
    this.scene = scene;
    this.hud = hud;

    /** @type {Array<{mesh: THREE.Group, data: object, stateData: object, collected: boolean}>} */
    this.activeItems = [];

    this.inventory = [];    // collected items
    this.currentState = null;
    this.clock = new THREE.Clock();

    // `CNT-01`: the last schema verdict for the pack this manager tried to load.
    // A refused pack spawns nothing and keeps its named reasons here, so a bad
    // content file fails loudly at load time instead of halfway through a scene.
    this.lastStateReport = null;
    this.stateLoads = 0;
    this.stateRejections = 0;
    // `CNT-02`: the compiled module list for the current pack (null until one loads).
    this.compiledState = null;
  }

  /** Diagnostics view for the loaded pack: version, migration, verdict, recipes. */
  stateDiagnostics() {
    const report = this.lastStateReport;
    const recipes = this.compiledState?.diagnostics ?? null;
    return Object.freeze({
      namespace: GDO_CONTENT_SCHEMA_NAMESPACE,
      // `CNT-02`: what the pack compiled to, so a debug session sees the module
      // count and the fingerprint the runtime actually spawned.
      recipeNamespace: this.compiledState?.namespace ?? null,
      recipeFingerprint: this.compiledState?.fingerprint ?? null,
      recipeModules: recipes?.modules ?? 0,
      recipeFamilies: recipes?.families ?? 0,
      recipePrunedModules: recipes?.prunedModules ?? 0,
      loads: this.stateLoads,
      rejections: this.stateRejections,
      loaded: Boolean(this.currentState),
      stateId: this.currentState?.stateId ?? null,
      schemaVersion: this.currentState?.schemaVersion ?? 0,
      migratedFrom: report?.migration?.from ?? null,
      migrationSteps: Object.freeze([...(report?.migration?.steps ?? [])]),
      errors: Object.freeze([...(report?.errors ?? [])]),
      warnings: Object.freeze([...(report?.warnings ?? [])]),
    });
  }

  /**
   * Load a state JSON, spawn collectibles into the scene.
   * @param {string} stateId - e.g. "kerala"
   */
  async loadState(stateId) {
    // `CNT-04`: a catalogued pack's URL comes from the catalogue, so the runtime
    // and the validated content folder cannot drift apart.
    const url = GDO_STATE_PACK_IDS.includes(stateId)
      ? statePackRuntimePath(stateId)
      : `/content/states/${stateId}.json`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to load state: ${stateId}`);
      return;
    }
    const stateData = await res.json();
    // `CNT-01`: migrate legacy packs forward, then validate against the declared
    // schema before anything spawns. A refused pack reports every named reason
    // and leaves the scene untouched.
    const report = loadContentState(stateData);
    this.lastStateReport = report;
    this.stateLoads++;
    if (!report.ok) {
      this.stateRejections++;
      console.error(`[Desi Odyssey] State pack "${stateId}" was refused by ${report.namespace}`,
        report.errors.map(error => `${error.path}: ${error.code}`).join(', '));
      return;
    }
    if (report.migration.migrated) {
      console.info(`[Desi Odyssey] Migrated state pack "${stateId}" from v${report.migration.from} to v${report.migration.to}`,
        report.migration.steps.join(', '));
    }
    this.currentState = report.data;

    // Update HUD state label
    if (this.hud.stateLabel) {
      this.hud.stateLabel.textContent = report.data.stateName;
    }

    // `CNT-02`: the pack is compiled once into modules, and the spawn loop reads
    // the compiled list instead of the raw JSON — layout arithmetic and cap
    // enforcement live in the compiler, so a new pack needs no code here.
    this.compiledState = compileStatePack(stateData, { scale: .22, profile: 'low' });
    for (const item of this.compiledState.collectibles) {
      const mesh = buildModuleGroup(item, { scale: .22 });
      const sp = item.spawn;
      mesh.position.set(sp.x, sp.y + 0.5, sp.z);
      mesh.castShadow = true;
      this.scene.add(mesh);

      // Glowing ring beneath item
      const ringGeo = new THREE.RingGeometry(0.3, 0.45, 16);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffdd44,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(sp.x, sp.y + 0.05, sp.z);
      this.scene.add(ring);

      this.activeItems.push({
        mesh,
        ring,
        data: item,
        stateData: { stateName: report.data.stateName },
        collected: false,
        baseY: sp.y + 0.5,
      });
    }

    this._updateHotbar();
  }

  /**
   * Main update — call every frame.
   * @param {THREE.Vector3} playerPos
   * @param {object} playerController - for applyBuff
   * @param {number} elapsed - total elapsed time for animation
   */
  update(playerPos, playerController, elapsed) {
    for (const item of this.activeItems) {
      if (item.collected) continue;

      // Floating bob animation
      item.mesh.position.y = item.baseY + Math.sin(elapsed * 2 + item.data.id.length) * 0.18;

      // Y-axis rotation
      item.mesh.rotation.y = elapsed * 1.5;

      // Ring pulse
      if (item.ring) {
        item.ring.material.opacity = 0.4 + 0.35 * Math.abs(Math.sin(elapsed * 3));
        item.ring.rotation.z = elapsed * 0.8;
      }

      // Distance pickup check
      const dx = playerPos.x - item.mesh.position.x;
      const dz = playerPos.z - item.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < PICKUP_RADIUS) {
        this._collectItem(item, playerController);
      }
    }
  }

  /**
   * @param {object} item
   * @param {object} playerController
   */
  _collectItem(item, playerController) {
    item.collected = true;

    // Remove from scene with a quick scale-out
    this._animatePickup(item.mesh);
    if (item.ring) this.scene.remove(item.ring);

    // Apply buff to player
    playerController.applyBuff(item.data.buff);

    // Add to inventory
    this.inventory.push({
      id: item.data.id,
      name: item.data.name,
      icon: item.data.icon,
      buffLabel: this._buffLabel(item.data.buff),
    });

    // Show banner
    this._showBanner(
      `${item.data.icon} Collected: ${item.data.name}! ${item.data.description}`
    );

    this._updateHotbar();

    console.log(`[Desi Odyssey] Collected: ${item.data.name}`);
  }

  /**
   * Scale-out pickup animation
   * @param {THREE.Group} mesh
   */
  _animatePickup(mesh) {
    const duration = 400; // ms
    const start = performance.now();
    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const s = 1 + t * 1.5;
      mesh.scale.setScalar(s);
      mesh.material && (mesh.material.opacity = 1 - t);
      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        this.scene.remove(mesh);
      }
    };
    requestAnimationFrame(animate);
  }

  _buffLabel(buff) {
    if (buff.type === 'speed')   return `⚡ x${buff.multiplier} Speed`;
    if (buff.type === 'jump')    return `🦘 x${buff.multiplier} Jump`;
    if (buff.type === 'shield')  return `🛡️ Shield`;
    if (buff.type === 'stamina') return `💪 x${buff.multiplier} Stamina`;
    if (buff.type === 'focus')   return `🎯 x${buff.multiplier} Focus`;
    return '✨';
  }

  /**
   * Register an already-built mesh as a collectible (for district JS files).
   * @param {object} itemData   - { id, name, icon, description, buff, stateName }
   * @param {THREE.Group} mesh  - already added to scene
   * @param {THREE.Mesh} ring   - already added to scene (or null)
   * @param {number} baseY      - world Y for the bobbing animation base
   */
  registerCollectible(itemData, mesh, ring, baseY) {
    this.activeItems.push({
      mesh,
      ring,
      data: itemData,
      stateData: { stateName: itemData.stateName ?? 'India' },
      collected: false,
      baseY,
    });
  }

  _showBanner(text) {
    if (!this.hud.banner) return;
    this.hud.banner.textContent = text;
    this.hud.banner.classList.add('active');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      this.hud.banner.classList.remove('active');
    }, 4000);
  }

  _updateHotbar() {
    if (!this.hud.hotbar) return;
    const slots = this.hud.hotbar.querySelectorAll('.hotbar-slot');
    slots.forEach((slot, i) => {
      const inv = this.inventory[i];
      if (inv) {
        slot.innerHTML = `
          <span class="slot-icon">${inv.icon}</span>
          <span class="slot-name">${inv.name}</span>
          <span class="slot-buff">${inv.buffLabel}</span>
        `;
        slot.classList.add('filled');
      } else {
        slot.innerHTML = `<span class="slot-empty">—</span>`;
        slot.classList.remove('filled');
      }
    });
  }

  /**
   * Returns array of currently active buff labels from inventory.
   */
  getQuestHint() {
    if (!this.currentState) return 'Explore the world!';
    const remaining = this.activeItems.filter(i => !i.collected).length;
    if (remaining === 0) return `All items collected in ${this.currentState.stateName}! 🎉`;
    return `Find ${remaining} more item${remaining > 1 ? 's' : ''} in ${this.currentState.stateName}`;
  }
}

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WORLD } from './BiomeManager.js';
import { createProceduralLightRig, createWaterNormalTexture } from '../engine/ProceduralEngine.js';
import { configureSemanticMaterial } from '../engine/ProceduralMaterials.js';

/** Owns lighting, optional sky IBL/postprocessing, water, and render sizing. */
export class Environment {
  constructor({
    scene,
    renderer,
    camera,
    ambientOcclusion = false,
    environmentMap = true,
    shadows = true,
    shadowMapSize = 1024,
    pixelRatio = 1.1,
    fogNear = 135,
    fogFar = 290,
    materialLibrary = null,
    materialDetail = 'low',
  }) {
    this.scene = scene; this.renderer = renderer; this.camera = camera;
    this.pixelRatio = pixelRatio; this.disposed = false;
    this.lastSize = { width: 1, height: 1, devicePixelRatio: 1 };
    this.previous = {
      background: scene.background,
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      fog: scene.fog,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      outputColorSpace: renderer.outputColorSpace,
      shadows: renderer.shadowMap.enabled,
      shadowType: renderer.shadowMap.type,
      pixelRatio: renderer.getPixelRatio(),
    };

    renderer.shadowMap.enabled = shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene.background = new THREE.Color('#9fc8e0');
    scene.fog = new THREE.Fog('#9fc8e0', fogNear, fogFar);

    this.lightRig = createProceduralLightRig(scene, {
      shadows,
      shadowMapSize: Math.min(shadowMapSize, renderer.capabilities.maxTextureSize),
      hemisphereIntensity: shadows ? .65 : .82,
    });
    this.sun = this.lightRig.sun;
    this.fill = this.lightRig.fill;

    this.skyTarget = null;
    if (environmentMap) {
      // PMREM is generated once and omitted entirely on the low-power profile.
      const skyScene = new THREE.Scene(), sky = new Sky();
      sky.scale.setScalar(1000);
      const uniforms = sky.material.uniforms;
      uniforms.turbidity.value = 2.5; uniforms.rayleigh.value = 1.3;
      uniforms.mieCoefficient.value = .004; uniforms.mieDirectionalG.value = .8;
      uniforms.sunPosition.value.copy(this.sun.position).normalize(); skyScene.add(sky);
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.skyTarget = pmrem.fromScene(skyScene, .04, .1, 2000);
      scene.environment = this.skyTarget.texture;
      scene.environmentIntensity = .25;
      pmrem.dispose(); sky.geometry.dispose(); sky.material.dispose();
    } else {
      scene.environment = null;
    }

    this.ownsNormals = !materialLibrary;
    this.normals = materialLibrary?.textures.waterNormal ?? createWaterNormalTexture();
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: '#147aab', roughness: environmentMap ? .19 : .42, metalness: environmentMap ? .12 : 0,
      envMapIntensity: environmentMap ? 1.7 : 0,
      normalMap: this.normals, normalScale: new THREE.Vector2(.55, .55),
    });
    if (materialLibrary) {
      const priorCompile = waterMaterial.onBeforeCompile;
      const priorKey = waterMaterial.customProgramCacheKey.bind(waterMaterial);
      waterMaterial.onBeforeCompile = shader => {
        priorCompile(shader);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          float gdoWaterNormalVisibility = 1.0 - smoothstep(gdoDetailFade.x * 0.65, gdoDetailFade.y * 0.65,
            distance(cameraPosition, vGdoMaterialWorld));
          normal = normalize(vec3(normal.xy * gdoWaterNormalVisibility, max(0.2, normal.z)));`);
      };
      waterMaterial.customProgramCacheKey = () => `${priorKey()}:normal-distance-fade-v1`;
      configureSemanticMaterial(waterMaterial, 'water', materialLibrary, materialDetail);
    }
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(256, 256), waterMaterial);
    this.water.name = 'shared-river-and-backwaters';
    this.water.rotation.x = -Math.PI / 2; this.water.position.y = WORLD.waterY;
    this.water.receiveShadow = shadows; scene.add(this.water);

    // Direct rendering avoids all composer render targets on low/balanced profiles.
    this.composer = null; this.renderPass = null; this.ao = null; this.output = null;
    if (ambientOcclusion) {
      this.composer = new EffectComposer(renderer);
      this.renderPass = new RenderPass(scene, camera); this.composer.addPass(this.renderPass);
      this.ao = new SSAOPass(scene, camera, 1, 1, 16);
      this.ao.kernelRadius = 3; this.ao.minDistance = .001; this.ao.maxDistance = .04;
      this.composer.addPass(this.ao);
      this.output = new OutputPass(); this.composer.addPass(this.output);
    }
  }

  resize(width, height, devicePixelRatio = window.devicePixelRatio || 1) {
    if (this.disposed) return;
    const w = Math.max(1, width), h = Math.max(1, height);
    this.lastSize = { width: w, height: h, devicePixelRatio };
    const ratio = Math.max(.5, Math.min(devicePixelRatio, this.pixelRatio));
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(ratio); this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(ratio); this.composer.setSize(w, h);
    }
  }

  setPixelRatioLimit(limit) {
    if (this.disposed || !Number.isFinite(limit)) return;
    this.pixelRatio = Math.max(.5, limit);
    const { width, height, devicePixelRatio } = this.lastSize;
    this.resize(width, height, devicePixelRatio);
  }

  update(seconds) {
    this.normals.offset.set((seconds * .012) % 1, (seconds * .007) % 1);
  }

  render(deltaSeconds) {
    if (this.disposed) return;
    if (this.composer) this.composer.render(deltaSeconds);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.water.removeFromParent(); this.water.geometry.dispose(); this.water.material.dispose();
    if (this.ownsNormals) this.normals.dispose();
    this.lightRig.dispose();
    if (this.composer) {
      this.composer.passes.forEach(pass => pass.dispose?.());
      this.composer.dispose();
    }
    Object.assign(this.scene, {
      background: this.previous.background,
      environment: this.previous.environment,
      environmentIntensity: this.previous.environmentIntensity,
      fog: this.previous.fog,
    });
    this.skyTarget?.dispose();
    this.renderer.toneMapping = this.previous.toneMapping; this.renderer.toneMappingExposure = this.previous.exposure;
    this.renderer.outputColorSpace = this.previous.outputColorSpace;
    this.renderer.shadowMap.enabled = this.previous.shadows; this.renderer.shadowMap.type = this.previous.shadowType;
    this.renderer.setPixelRatio(this.previous.pixelRatio);
  }
}

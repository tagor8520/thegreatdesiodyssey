#!/usr/bin/env node
/**
 * Diagnostic for defect **F1** — `gdoPlantClearance` exceeds the vertex attribute budget.
 *
 * See `feature-roadmap/VISUAL_GATES.md` §6.F1. The plant pool geometry occupies exactly
 * the 16 vertex attribute slots the WebGL floor guarantees, and SwiftShader's linker
 * rejects a program sitting exactly on that boundary. This script prints the live
 * attribute accounting per instanced mesh plus the context limit, so a fix can be
 * verified as "comfortably under the limit" rather than "still exactly on it".
 *
 *   node tools/visual-audit/diagnose-plant-attributes.mjs      # needs `npm run dev`
 */
import { launch, openCoordinates, selectFixture, waitFrames, readCoordinateStats } from './harness.mjs';

const ORIGIN = 'http://localhost:5173';
const { browser, page, logs } = await launch();
try {
  await selectFixture(page, ORIGIN, { id: 'dense-urban' });
  await openCoordinates(page, ORIGIN);
  // Plant pools are populated with the detail pass, after roads and context.
  for (let attempt = 0; attempt < 45; attempt++) {
    const stats = await readCoordinateStats(page);
    if ((stats.details ?? 0) > 0) break;
    await waitFrames(page, 4);
  }
  await waitFrames(page, 6);

  const info = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const report = {
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maxVaryings: gl.getParameter(gl.MAX_VARYING_VECTORS),
      maxVertexUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      instancedMeshes: [],
    };
    const game = globalThis.__gdoAudit?.game;
    const scenes = [game?.scene, game?.world?.scene, game?.container?.querySelector?.('canvas')?.scene].filter(Boolean);
    for (const scene of scenes) {
      scene.traverse?.(object => {
        if (object.isInstancedMesh) {
          const entries = Object.entries(object.geometry.attributes);
          const instanced = entries.filter(([, a]) => a.isInstancedBufferAttribute);
          const perVertex = entries.filter(([, a]) => !a.isInstancedBufferAttribute);
          report.instancedMeshes.push({
            name: object.name,
            count: object.count,
            perVertex: perVertex.map(([k, a]) => `${k}:${a.itemSize}`),
            perVertexCount: perVertex.length,
            instanced: instanced.map(([k, a]) => `${k}:${a.itemSize}`),
            totalSlots: perVertex.length + instanced.length + 4, // +4 for instanceMatrix columns
          });
        }
      });
    }
    return report;
  });

  console.log(JSON.stringify(info, null, 2));
  console.log('\nconsole errors:');
  for (const entry of logs) console.log(`  ${entry.level}: ${entry.text.split('\n').slice(0, 4).join(' | ')}`);
} finally {
  await browser.close();
}

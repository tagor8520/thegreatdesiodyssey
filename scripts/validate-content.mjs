#!/usr/bin/env node
/**
 * `CNT-03` content validation and preview CLI.
 *
 *   npm run validate:content                       # every shipped state pack
 *   npm run validate:content -- path/to/pack.json  # one pack or landmark file
 *   npm run validate:content -- --landmarks        # the curated landmark recipes
 *   npm run validate:content -- --json             # machine-readable verdicts
 *
 * Exit code is non-zero when any input fails, so the tool drops straight into a
 * contributor's CI. It reads JSON files, never the network.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { runContentCheck } from '../src/engine/ContentValidatorTool.js';
import { compileLandmarkRecipe } from '../src/engine/RecipeCompiler.js';
import { GDO_CURATED_LANDMARKS } from '../src/reference/landmarkRecipes.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(argument => argument.startsWith('--')));
const paths = args.filter(argument => !argument.startsWith('--'));
const roots = ['public/content/states', 'public/map-providers.json'];

const providers = JSON.parse(readFileSync(resolve('public/map-providers.json'), 'utf8')).providers;
const budgetProviderCredits = providers.map(entry => `${entry.id}: ${entry.attribution}`);

function packPaths() {
  if (paths.length) return paths.map(path => resolve(path));
  return readdirSync(resolve(roots[0]))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => resolve(roots[0], name));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const inputs = [];
if (flags.has('--landmarks')) {
  inputs.push({ label: 'curated landmarks', value: Object.values(GDO_CURATED_LANDMARKS), landmarks: true });
} else if (flags.has('--list')) {
  console.log(`provider credits:\n  ${budgetProviderCredits.join('\n  ')}`);
  process.exitCode = 0;
} else {
  for (const path of packPaths()) inputs.push({ label: basename(path), value: readJson(path) });
}

const results = [];
for (const input of inputs) {
  const result = runContentCheck(input.value, {
    providers,
    profile: flags.has('--high') ? 'high' : flags.has('--balanced') ? 'balanced' : 'low',
    preview: !flags.has('--no-preview'),
  });
  results.push({ ...result, label: input.label });
  if (!flags.has('--json')) {
    console.log(`${input.label} · ${result.text}`);
    if (input.landmarks) {
      const compiled = input.value.map(recipe => compileLandmarkRecipe(recipe));
      console.log(`  provenance: ${compiled.map(entry => `${entry.id} ${entry.diagnostics.modules} modules`).join(' · ')}`);
    }
    console.log('');
  }
}

if (flags.has('--json')) {
  console.log(JSON.stringify(results.map(({ label, ok, kind, id, fingerprint, summary }) =>
    ({ label, ok, kind, id, fingerprint, checks: summary.checks })), null, 2));
}

const failed = results.filter(entry => !entry.ok);
if (failed.length) {
  console.error(`${failed.length} of ${results.length} input(s) failed validation: ${failed.map(entry => entry.label).join(', ')}`);
  process.exitCode = 1;
} else if (!flags.has('--json')) {
  console.log(`${results.length} input(s) validated · provider credits available with --list`);
}

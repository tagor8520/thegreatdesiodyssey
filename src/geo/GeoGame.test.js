import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `FND-07`/`ENV-02`: the coordinate mount is the one host file the engine tests
 * never execute, so its own wiring order is audited at the source.
 *
 * A block-scoped binding (`const`/`let`) exists only from the statement that
 * declares it. A statement in the same block that *begins* with such a binding
 * declared later therefore throws `ReferenceError` the moment the mount runs —
 * which is exactly how `world.timeOfDayState = timeOfDay` before
 * `const world = new GeoWorld(...)` took every coordinate launch down while the
 * whole suite stayed green. This audit is a direct source check of that rule:
 * it reports the file, the line, and the statement, and it is deliberately
 * conservative — a statement whose first token is not a later declaration is
 * never reported.
 */

const SOURCE_ROOT = new URL('..', import.meta.url); // `<repo>/src/`

/**
 * The first identifier token a statement really executes with: comments,
 * string/template text, and regular-expression literals are skipped, so a
 * leading comment that mentions a binding is not mistaken for the statement.
 */
function firstIdentifier(text) {
  let index = 0, quote = null, previous = undefined;
  while (index < text.length) {
    const char = text[index], next = text[index + 1];
    if (quote) {
      if (char === '\\') { index += 2; continue; }
      if (char === quote) quote = null;
      index++; continue;
    }
    if (char === '/' && next === '/') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end + 1; continue; }
    if (char === '/' && next === '*') { const end = text.indexOf('*/', index); index = end < 0 ? text.length : end + 2; continue; }
    if (char === '/' && previous && /[({[;,=:!&|?+\-*%<>~^]/.test(previous)) {
      index++;
      let inClass = false;
      while (index < text.length) {
        const inner = text[index];
        if (inner === '\\') { index += 2; continue; }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) { index++; break; }
        else if (inner === '\n') break;
        index++;
      }
      previous = '/';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; index++; continue; }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index;
      while (end < text.length && /[\w$]/.test(text[end])) end++;
      return { name: text.slice(index, end), at: index };
    }
    if (!/\s/.test(char)) previous = char;
    index++;
  }
  return null;
}

function collectSources(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectSources(path, files);
    else if (path.endsWith('.js')) files.push(path);
  }
  return files;
}

/**
 * Statements of one block, at that block's own depth, with the first identifier
 * token of each. `{` opens a nested block (its contents belong to it, not to
 * this statement list) and `;` closes a statement; both are ignored inside
 * strings, template literals, comments, and regular-expression literals.
 */
export function statementsOf(source) {
  const root = { start: 0, statements: [], declarations: new Map() };
  const open = [root];
  const blocks = [];
  let index = 0, statementStart = 0, quote = null, lineComment = false, blockComment = false;
  let previous = undefined;
  const closeStatement = end => {
    const head = firstIdentifier(source.slice(statementStart, end));
    if (head) open.at(-1).statements.push({ name: head.name, at: statementStart + head.at });
    statementStart = end;
  };
  while (index < source.length) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; index++; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 2; continue; } index++; continue; }
    if (quote) {
      if (char === '\\') { index += 2; continue; }
      if (char === quote) quote = null;
      index++; continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 2; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 2; continue; }
    if (char === '/' && previous && /[({[;,=:!&|?+\-*%<>~^]/.test(previous)) {
      // A regular-expression literal: skip it so its words are not read as code.
      index++;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index];
        if (inner === '\\') { index += 2; continue; }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) { index++; break; }
        else if (inner === '\n') break;
        index++;
      }
      while (index < source.length && /[a-z]/.test(source[index])) index++;
      previous = '/';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; index++; previous = char; continue; }
    if (char === '{') {
      closeStatement(index);
      const block = { start: index, statements: [], declarations: new Map(), parent: open.at(-1) };
      open.push(block);
      blocks.push(block);
      index++;
      previous = char;
      statementStart = index;
      continue;
    }
    if (char === '}') {
      closeStatement(index);
      open.pop();
      index++;
      previous = char;
      statementStart = index;
      continue;
    }
    if (char === ';') { closeStatement(index); index++; previous = char; statementStart = index; continue; }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index;
      while (end < source.length && /[\w$]/.test(source[end])) end++;
      const word = source.slice(index, end);
      if (previous === 'const' || previous === 'let') {
        const block = open.at(-1);
        // Only the first declaration of a name in a block matters: a mention
        // after it already runs against a live binding.
        if (!block.declarations.has(word)) block.declarations.set(word, index);
      }
      previous = word;
      index = end;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    index++;
  }
  closeStatement(source.length);
  return { root, blocks };
}

/** Every statement that runs before its own block-scoped declaration. */
export function useBeforeDeclaration(source) {
  const { root, blocks } = statementsOf(source);
  const findings = [];
  for (const block of [root, ...blocks]) {
    for (const statement of block.statements) {
      const declaration = block.declarations.get(statement.name);
      if (declaration !== undefined && statement.at < declaration) {
        findings.push({ name: statement.name, at: statement.at, declaredAt: declaration, block: block.start });
      }
    }
  }
  return findings;
}

function describe(file, source, finding) {
  const line = source.slice(0, finding.at).split('\n').length;
  const text = source.split('\n')[line - 1].trim();
  return `${relative(process.cwd(), file)}:${line} starts with '${finding.name}', declared later on line ` +
    `${source.slice(0, finding.declaredAt).split('\n').length}: ${text.slice(0, 80)}`;
}

test('no host source uses a block-scoped binding before the statement that declares it', () => {
  const files = collectSources(SOURCE_ROOT.pathname.replace(/\/$/, ''));
  assert.ok(files.length > 40, `the audit found ${files.length} source files`);
  const findings = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const finding of useBeforeDeclaration(source)) findings.push(describe(file, source, finding));
  }
  assert.deepEqual(findings, [], `use before declaration:\n${findings.join('\n')}`);
});

test('the coordinate mount is part of that audit and declares the world before wiring it', () => {
  const source = readFileSync(new URL('./GeoGame.js', import.meta.url), 'utf8');
  const findings = useBeforeDeclaration(source);
  assert.deepEqual(findings.map(finding => finding.name), []);
  const declaration = source.indexOf('const world = new GeoWorld(');
  assert.ok(declaration > 0, 'the mount constructs its world');
  assert.ok(source.indexOf('world.timeOfDayState = timeOfDay') > declaration,
    'the day-cycle state is attached after the world exists');
});

/**
 * The mount smoke gate. Nothing else in the suite executes `mountGeoGame`, which
 * is why a missing import and a use-before-declaration could each keep every test
 * green while no coordinate launch ever started. This test loads the real module
 * and runs the real mount on a stubbed device: the DOM, the canvas/WebGL context,
 * the tile worker, and the frame clock are the only fakes, so a broken import,
 * a broken wiring order, or a broken teardown fails here.
 */

const CSS_HOOK = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  return next(specifier, context);
}`;

function createFakeGl() {
  const constants = {
    VERSION: 0x1F02, VENDOR: 0x1F00, RENDERER: 0x1F01, SHADING_LANGUAGE_VERSION: 0x8B8C,
    MAX_VIEWPORT_DIMS: 0x0D3A, SCISSOR_BOX: 0x0C10, VIEWPORT: 0x0BA2,
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF, EXTENSIONS: 0x1F03,
  };
  const plain = {
    getContextAttributes: () => ({
      alpha: true, depth: true, stencil: true, antialias: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'low-power',
    }),
    getExtension: () => null,
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getParameter: name => {
      if (name === constants.VERSION) return 'WebGL 2.0 (gdo test device)';
      if (name === constants.VENDOR) return 'gdo';
      if (name === constants.RENDERER) return 'gdo-test-device';
      if (name === constants.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00';
      if (name === constants.SCISSOR_BOX || name === constants.VIEWPORT) return new Int32Array([0, 0, 1280, 720]);
      if (name === constants.MAX_VIEWPORT_DIMS) return new Int32Array([4096, 4096]);
      if (name === constants.EXTENSIONS) return [];
      return 4096;
    },
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    checkFramebufferStatus: () => 0x8CD5,
    isContextLost: () => false,
  };
  return new Proxy(plain, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) return constants[key] ?? 0x1000;
      return () => undefined;
    },
  });
}

function stubElement(tag = 'div') {
  const element = {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, className: '',
    textContent: '', innerHTML: '', hidden: false, tabIndex: 0, width: 1280, height: 720,
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    append(...nodes) { element.children.push(...nodes); },
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren(...nodes) { element.children = nodes; },
    remove() {}, focus() {}, blur() {}, setPointerCapture() {}, releasePointerCapture() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: () => stubElement(),
    querySelectorAll: () => [stubElement()],
    getContext: () => createFakeGl(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }),
    contains: () => true, closest: () => null,
  };
  return element;
}

/** The smallest device the mount can run on, and the way back out of it. */
function installTestDevice() {
  const frames = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = {
    requestAnimationFrame: callback => frames.push(callback),
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    Worker: class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} },
    document: {
      createElement: tag => stubElement(tag),
      getElementById: () => stubElement(),
      querySelector: () => stubElement(),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      body: stubElement('body'), documentElement: stubElement('html'),
    },
    window: {
      innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
      addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame: () => {},
      location: { href: 'http://localhost/' },
    },
    self: globalThis,
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { maxTouchPoints: 0, userAgent: 'gdo-test-device' }, configurable: true,
  });
  for (const [key, value] of Object.entries(globals)) globalThis[key] = value;
  return {
    frames,
    runFrames(count = 3) {
      for (let frame = 0; frame < count && frames.length; frame++) frames.shift()(16.7 * (frame + 1));
    },
    restore() {
      for (const key of Object.keys(globals)) delete globalThis[key];
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
      else delete globalThis.navigator;
    },
  };
}

test('the coordinate world mounts, runs frames, and disposes on a test device', async () => {
  const device = installTestDevice();
  let scope = null;
  try {
    const { register } = await import('node:module');
    register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);
    // The import itself is the gate: a module-level ReferenceError here is a
    // launch that never starts, exactly like the missing player-domain import.
    const { mountGeoGame } = await import('./GeoGame.js');
    const container = stubElement('main');
    scope = mountGeoGame(container, { latitude: 28.9845, longitude: 77.7064 });
    assert.ok(scope?.dispose, 'the mount returns a disposable handle');
    assert.ok(scope.world, 'the mount built a world');
    assert.ok(scope.player, 'the mount built an avatar');
    assert.ok(scope.renderer?.isWebGLRenderer, 'the mount built a renderer');
    // `ENV-02`: the mount attaches the day-cycle state to the world it built —
    // the wiring that used to run before the world existed.
    assert.equal(typeof scope.world.timeOfDayState?.diagnostics, 'function',
      'the day-cycle state is attached to the world the mount built');
    assert.equal(scope.world.timeOfDayState?.state?.namespace, 'gdo:timeOfDaySky:v1',
      'the attached state is the live sky state');
    device.runFrames(3);
    assert.ok(scope.world.stats, 'the world reports its stats after real frames');
    assert.ok(container.children.length >= 1, 'the canvas and overlay reached the container');
  } finally {
    scope?.dispose();
    device.restore();
  }
});

import {
  GDO_CONTENT_CHECK_IDS,
  GDO_CONTENT_VALIDATOR_NAMESPACE,
  formatValidatorReport,
  validateContentPack,
  validateLandmarkRecipe,
} from './ContentValidator.js';

/**
 * `CNT-03` content validation and preview tool surface.
 *
 * One entry point is shared by everything that wants to check a contributor's
 * data: the CLI (`npm run validate:content`), the page's `__gdo` debug hook, and
 * the tests. It decides what it was handed — a state pack or a landmark recipe —
 * runs the ordered checks, and returns a plain record with the printable report
 * and the machine-readable verdict.
 *
 * No `three` and no DOM: the same call works in Node, in a terminal, or in a
 * browser console.
 */

export const GDO_CONTENT_TOOL_NAMESPACE = GDO_CONTENT_VALIDATOR_NAMESPACE;

/** What did we get? A pack declares collectibles; a landmark declares modules. */
export function describeContentInput(input) {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new TypeError('Content tool needs at least one landmark recipe');
    if (input.every(entry => entry && typeof entry === 'object')) return 'landmark';
  }
  if (!input || typeof input !== 'object') throw new TypeError('Content tool needs a state pack or a landmark recipe');
  if (Array.isArray(input.modules)) return 'landmark';
  if (Array.isArray(input.collectibles) || typeof input.stateId === 'string') return 'state-pack';
  throw new TypeError('Content tool needs a state pack (with `collectibles`) or a landmark recipe (with `modules`)');
}

/** Ordered check states in one flat record, so a caller never parses prose. */
export function summariseContentReport(report) {
  return Object.freeze({
    namespace: report.namespace,
    kind: report.kind,
    id: report.id,
    profile: report.profile,
    ok: report.ok,
    fingerprint: report.fingerprint,
    checks: Object.freeze(report.checks.map(check => Object.freeze({
      id: check.id,
      state: check.skipped ? 'skip' : check.ok ? 'pass' : 'fail',
      detail: check.detail,
    }))),
    failed: Object.freeze(report.checks.filter(check => !check.skipped && !check.ok).map(check => check.id)),
    skipped: Object.freeze(report.checks.filter(check => check.skipped).map(check => check.id)),
  });
}

/**
 * Run every applicable check over one pack or landmark recipe (or a list of
 * landmark recipes) and return the report, its printable text, and its summary.
 */
export function runContentCheck(input, {
  profile = 'low', bounds = null, providers = null, expectedFingerprint = null,
  expectedFingerprints = null, preview = true, previewWidth, previewHeight,
} = {}) {
  const kind = describeContentInput(input);
  const options = { profile, bounds, preview, previewWidth, previewHeight };
  const report = kind === 'landmark'
    ? validateLandmarkRecipe(input, { ...options, expectedFingerprints: expectedFingerprints ?? expectedFingerprint })
    : validateContentPack(input, { ...options, providers, expectedFingerprint });
  return Object.freeze({
    ok: report.ok,
    kind: report.kind,
    id: report.id,
    profile: report.profile,
    fingerprint: report.fingerprint,
    checkIds: GDO_CONTENT_CHECK_IDS,
    text: formatValidatorReport(report).join('\n'),
    summary: summariseContentReport(report),
    report,
  });
}

/** The verdict shape a console caller always gets back, even for bad input. */
function refusedContentResult(message, profile) {
  const summary = Object.freeze({
    namespace: GDO_CONTENT_TOOL_NAMESPACE,
    kind: null, id: null, profile, ok: false, fingerprint: null,
    checks: Object.freeze([Object.freeze({ id: 'schema', state: 'fail', detail: message })]),
    failed: Object.freeze(['schema']), skipped: Object.freeze([]),
  });
  return Object.freeze({
    ok: false, kind: null, id: null, profile, fingerprint: null,
    checkIds: GDO_CONTENT_CHECK_IDS,
    text: `${GDO_CONTENT_TOOL_NAMESPACE} · input refused: ${message}`,
    summary, report: null, preview: null, error: message,
  });
}

/**
 * The `__gdo` extras the page installs, so a contributor can paste a pack or a
 * landmark recipe into a browser console and read the same verdict the CLI
 * prints. A console surface answers instead of throwing: an input the tool
 * cannot even classify comes back as a failed verdict naming the reason, so a
 * typo in a console never breaks the running game's hook.
 */
export function createContentValidatorExtras({ providers = null, profile = 'low' } = {}) {
  const safeRun = (input, options = {}) => {
    try {
      return runContentCheck(input, { providers, profile, ...options });
    } catch (error) {
      return refusedContentResult(error?.message || String(error), profile);
    }
  };
  return {
    /** `__gdo.validateContent(packOrRecipe, options)` → verdict + printable text. */
    validateContent: (input, options = {}) => safeRun(input, options),
    /** The ordered check ids, so a caller can explain what was run. */
    contentChecks: () => [...GDO_CONTENT_CHECK_IDS],
    /** Bounded ASCII preview of a compiled recipe, for a quick look in a console. */
    previewContent: (input, options = {}) => safeRun(input, options).report?.preview ?? null,
  };
}

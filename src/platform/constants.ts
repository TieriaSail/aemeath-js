/**
 * Shared platform constants.
 *
 * Kept in a separate module so that consumers (e.g. ErrorCapturePlugin)
 * can import these without pulling in the entire miniapp adapter.
 */

/**
 * Symbol used to mark Error objects whose stack trace was synthetically created
 * by the adapter (not from actual error source). Consumers check this to avoid
 * reporting misleading stack traces.
 *
 * Uses Symbol.for so the marker is shared across bundles.
 */
export const SYNTHETIC_STACK = Symbol.for('aemeath.syntheticStack');

import type { ErrorInfo } from '../types';

export interface ErrorEvidence {
  schemaVersion: 1;
  captureChannel: string;
  capturePhase: 'early' | 'runtime';
  originalName?: string;
  reasonKind: string;
  stackOrigin: 'original' | 'capture-site' | 'unavailable';
  missingStackReason?: 'browser-redacted' | 'reason-without-stack' | 'unknown';
  browserLocation?: { source?: string; line?: number; column?: number };
  captureStack?: string;
  occurrenceId: string;
  errorObjectId?: string;
  normalization: { issues: string[] };
}

export interface ErrorEvidenceOptions {
  channel?: string;
  phase?: 'early' | 'runtime';
  message?: string;
  synthetic?: boolean;
  source?: string;
  line?: number;
  column?: number;
}

/**
 * Self-contained so the build plugin can embed this exact implementation in
 * the standalone early script. No runtime imports or external closure state.
 * The 8 KiB budget applies to diagnostic graphs/extras, not primary message or
 * original stack: payload sanitization retains its existing reject/split policy.
 */
export function normalizeErrorEvidence(input: unknown, options: ErrorEvidenceOptions = {}): ErrorInfo {
  const issues: string[] = [];
  const seen: object[] = [];
  // Primary stacks may contain thousands of frames. Index reads by object and
  // property rather than scanning every earlier read for every new field.
  // The embedded ES5 script also supports hosts without WeakMap; never attach
  // cache properties to an application's errors or frozen objects.
  type ReadCache = Record<PropertyKey, unknown>;
  const readsByObject = typeof WeakMap === 'function' ? new WeakMap<object, ReadCache>() : undefined;
  const readObjects: object[] = [];
  const readCaches: ReadCache[] = [];
  let bytes = 8192;
  let nodes = 128;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && (typeof v === 'object' || typeof v === 'function');
  const issue = (path: string, kind: string): void => {
    const entry = path.slice(0, 120) + ':' + kind;
    if (issues.length < 16 && issues.indexOf(entry) === -1) issues.push(entry);
  };
  const read = (obj: unknown, key: PropertyKey, path: string): unknown => {
    if (!isObject(obj)) return undefined;
    let cache: ReadCache | undefined;
    if (readsByObject) {
      cache = readsByObject.get(obj);
      if (!cache) { cache = Object.create(null) as ReadCache; readsByObject.set(obj, cache); }
    } else {
      const index = readObjects.indexOf(obj);
      if (index >= 0) cache = readCaches[index];
      else { cache = Object.create(null) as ReadCache; readObjects.push(obj); readCaches.push(cache); }
    }
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    let value: unknown;
    try { value = (obj as Record<PropertyKey, unknown>)[key]; }
    catch { issue(path, 'read-failed'); }
    cache[key] = value;
    return value;
  };
  const primitive = (v: unknown): string => {
    // Never call user-defined toString / valueOf / toJSON.
    if (isObject(v)) return typeof v === 'function' ? '[function]' : '[object]';
    try { return String(v); } catch { return '[unreadable]'; }
  };
  const isPlainObject = (value: object, path: string): boolean => {
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === null || prototype === Object.prototype) return true;
      // A foreign realm has its own Object.prototype. Check the native
      // constructor without invoking a getter or user-defined conversion hook.
      if (Object.getPrototypeOf(prototype) !== null) return false;
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      return typeof constructor?.value === 'function' &&
        Function.prototype.toString.call(constructor.value) === Function.prototype.toString.call(Object);
    } catch { issue(path, 'reflection-failed'); return false; }
  };
  const isErrorObject = (value: object): boolean => {
    try {
      if (value instanceof Error) return true;
      let prototype = Object.getPrototypeOf(value);
      // Cross-realm built-in errors and their subclasses inherit a native
      // Error.prototype. Descriptors avoid constructor/toStringTag getters.
      const nativeError = Function.prototype.toString.call(Error);
      for (let depth = 0; prototype && depth < 32; depth++) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
        if (typeof constructor?.value === 'function' &&
          Function.prototype.toString.call(constructor.value) === nativeError) return true;
        prototype = Object.getPrototypeOf(prototype);
      }
      if (prototype) issue('error', 'prototype-depth');
    } catch { issue('error', 'reflection-failed'); }
    return false;
  };
  const text = (value: string, path: string): string => {
    let end = 0;
    let used = 0;
    while (end < value.length) {
      const c = value.charCodeAt(end);
      const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < value.length &&
        value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff;
      const size = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      if (used + size > bytes) break;
      used += size;
      end += pair ? 2 : 1;
    }
    bytes -= used;
    if (end < value.length) issue(path, 'truncated');
    return value.slice(0, end);
  };
  // Primary protocol fields and structured original frames bypass diagnostic
  // size/count limits. PayloadSanitize owns their final reject/split policy.
  // Safe reads, cycle protection and the depth guard still apply.
  const snapshot = (value: unknown, path: string, depth: number, primary = false): unknown => {
    if (!primary) {
      nodes--;
      // Sentinels are structural diagnostics, not captured string content.
      // Charge their node, but preserve them even after the content budget is
      // exhausted. Otherwise a second pass turns '[circular]' into '[c'.
      if (value === '[truncated]' || value === '[circular]' || value === '[unreadable]') return value;
      if (nodes < 0 || bytes <= 0) { issue(path, 'budget'); return '[truncated]'; }
    }
    if (typeof value === 'string') return primary ? value : text(value, path);
    if (!isObject(value)) {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      return primary ? primitive(value) : text(primitive(value), path);
    }
    if (seen.indexOf(value) !== -1) { issue(path, 'circular'); return '[circular]'; }
    if (depth >= 4) { issue(path, 'depth'); return '[truncated]'; }
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        const length = read(value, 'length', path + '.length');
        const validLength = typeof length === 'number' && length >= 0 && length <= 4294967295 && Math.floor(length) === length;
        if (!validLength) issue(path, 'invalid-length');
        const count = validLength ? (primary ? length : Math.min(length, 8)) : 0;
        if (!primary && typeof length === 'number' && length > 8) issue(path, 'items');
        const out: unknown[] = [];
        for (let i = 0; i < count; i++) out.push(snapshot(read(value, i, path + '[' + i + ']'), path + '[' + i + ']', depth + 1, primary));
        return out;
      }
      // Only enumerate plain objects. Error-like/host objects use fixed fields.
      const plain = isPlainObject(value, path);
      let keys = ['name', 'message', 'stack', 'code', 'cause', 'errors'];
      if (plain) {
        try { keys = Object.keys(value); } catch { issue(path, 'reflection-failed'); }
      }
      if (!primary && keys.length > 32) issue(path, 'properties');
      const out: Record<string, unknown> = {};
      for (const key of primary ? keys : keys.slice(0, 32)) {
        if (key === 'toJSON' || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (!primary && (bytes <= 0 || nodes <= 0)) { issue(path, 'budget'); break; }
        const field = read(value, key, path + '.' + key);
        if (field === undefined) continue;
        // Never emit a prefix as a different business key. If the complete key
        // cannot fit, omit this and subsequent fields with an explicit marker.
        if (!primary && text(key, path + '.' + key) !== key) { issue(path + '.' + key, 'key-budget'); break; }
        Object.defineProperty(out, key, {
          value: snapshot(field, path + '.' + key, depth + 1, primary), enumerable: true, writable: true, configurable: true,
        });
      }
      return out;
    } catch { issue(path, 'reflection-failed'); return '[unreadable]'; }
    finally { seen.pop(); }
  };

  const name = read(input, 'name', 'name');
  const message = read(input, 'message', 'message');
  const stack = read(input, 'stack', 'stack');
  const type = read(input, 'type', 'type');
  const value = read(input, 'value', 'value');
  const previous = read(input, 'evidence', 'evidence');
  const previousVersion = read(previous, 'schemaVersion', 'evidence.schemaVersion');
  const normalized = previousVersion === 1 && typeof type === 'string' && typeof value === 'string';
  const prior = (key: string): unknown => normalized ? read(previous, key, 'evidence.' + key) : undefined;
  const priorOrigin = prior('stackOrigin');
  let synthetic = options.synthetic === true || priorOrigin === 'capture-site';
  try {
    if (typeof Symbol !== 'undefined') synthetic = synthetic || read(input, Symbol.for('aemeath.syntheticStack'), 'syntheticStack') === true;
  } catch { issue('syntheticStack', 'read-failed'); }
  const originalStack = !synthetic && priorOrigin !== 'unavailable' && typeof stack === 'string' && stack.trim() ? stack : undefined;
  const capture = synthetic && typeof stack === 'string' && stack.trim() ? stack : prior('captureStack');
  const originalName = typeof name === 'string' ? name : prior('originalName');
  const output: ErrorInfo = {
    type: typeof type === 'string' ? type : typeof name === 'string' ? name : 'Error',
    value: typeof value === 'string' ? value : typeof message === 'string' ? message : options.message !== undefined ? options.message : primitive(input),
  };
  if (originalStack) output.stack = originalStack;
  const source = options.source;
  const line = options.line;
  const column = options.column;
  const priorChannel = prior('captureChannel');
  const priorPhase = prior('capturePhase');
  const occurrence = prior('occurrenceId');
  const reasonKind = prior('reasonKind');
  const evidence: ErrorEvidence = {
    schemaVersion: 1,
    captureChannel: options.channel || (typeof priorChannel === 'string' ? priorChannel : 'manual'),
    capturePhase: options.phase || (priorPhase === 'early' ? 'early' : 'runtime'),
    reasonKind: typeof reasonKind === 'string' ? reasonKind : input === null ? 'null' : typeof input,
    stackOrigin: originalStack ? 'original' : typeof capture === 'string' && capture ? 'capture-site' : 'unavailable',
    occurrenceId: typeof occurrence === 'string' && occurrence ? occurrence : 'err-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
    normalization: { issues },
  };
  if (typeof originalName === 'string' && (!synthetic || normalized)) evidence.originalName = originalName;
  if (typeof capture === 'string' && capture) evidence.captureStack = text(capture, 'captureStack');
  if (!originalStack) {
    const oldReason = prior('missingStackReason');
    evidence.missingStackReason = oldReason === 'browser-redacted' || oldReason === 'reason-without-stack' ? oldReason :
      evidence.captureChannel === 'global' && output.value === 'Script error.' && !source && !line && !column ? 'browser-redacted' : 'reason-without-stack';
  }
  if (source !== undefined || line !== undefined || column !== undefined) evidence.browserLocation = { source, line, column };
  else {
    const location = prior('browserLocation');
    if (isObject(location)) evidence.browserLocation = snapshot(location, 'browserLocation', 0, true) as ErrorEvidence['browserLocation'];
  }
  const objectId = prior('errorObjectId');
  if (typeof objectId === 'string') evidence.errorObjectId = objectId;
  if (normalized) {
    const oldIssues = read(prior('normalization'), 'issues', 'normalization.issues');
    try {
      if (Array.isArray(oldIssues)) {
        // Input arrays can override slice, species and iteration. Only inspect
        // bounded indexes through the same guarded, once-per-property reader.
        const length = read(oldIssues, 'length', 'normalization.issues.length');
        const count = typeof length === 'number' && length >= 0 && Math.floor(length) === length ? Math.min(length, 16) : 0;
        for (let i = 0; i < count; i++) {
          const item = read(oldIssues, i, 'normalization.issues[' + i + ']');
          if (typeof item === 'string' && issues.length < 16 && issues.indexOf(item) < 0) issues.push(item);
        }
      }
    }
    catch { issue('normalization', 'read-failed'); }
  }
  const protocolFields = ['source', 'filename', 'lineno', 'colno', 'earlyError', 'captureTimestamp',
    'device', 'tagName', 'src', 'outerHTML', '_isAemeathInternalError', 'stacktrace'];
  // Unlabelled object reasons have one canonical diagnostic graph. Copying
  // their fields to the root as well spends the same budget twice, including
  // when Logger normalizes again or an early snapshot crosses JSON transport.
  const objectReason = isObject(input) && typeof message !== 'string' &&
    typeof value !== 'string' && options.message === undefined && !isErrorObject(input);
  const skip = ['name', 'message', 'stack', 'type', 'value', 'evidence', 'toJSON', '__proto__', 'constructor', 'prototype'].concat(protocolFields);
  let keys = ['code', 'cause', 'errors'];
  if (isObject(input)) {
    // Error own extensions are a public compatibility surface. Do not enumerate
    // arbitrary host objects (DOM/Bridge); only plain and Error-like objects.
    try {
      if (!objectReason && (isPlainObject(input, 'error') || isErrorObject(input))) {
        keys = keys.concat(Object.getOwnPropertyNames(input).filter(k => keys.indexOf(k) < 0));
      }
    } catch { issue('error', 'reflection-failed'); }
    seen.push(input);
    // Read these independently of root property order/count as well as bytes.
    for (const key of protocolFields) {
      if (key === 'stacktrace' && synthetic) continue;
      const field = read(input, key, key);
      if (field !== undefined) output[key] = snapshot(field, key, 0, true);
    }
    // Protocol fields do not consume diagnostic extension slots, including
    // type/value/evidence added during a preceding normalization pass.
    keys = keys.filter(key => skip.indexOf(key) < 0);
    if (keys.length > 40) issue('error', 'properties');
    for (const key of objectReason ? [] : keys.slice(0, 40)) {
      const field = read(input, key, key);
      if (field !== undefined) output[key] = snapshot(field, key, 0);
    }
    seen.pop();
  }
  // Object reasons keep a safe representation instead of JSON.stringify(reason).
  if (objectReason) {
    const reason = snapshot(input, 'reason', 0);
    output.reason = reason;
    try { output.value = JSON.stringify(reason) || '[object]'; } catch { output.value = '[unreadable]'; }
  }
  output.evidence = evidence;
  return output;
}

const identities = new WeakMap<object, string>();
let nextIdentity = 0;
/** Identity links observations, never suppresses a repeated occurrence. */
export function normalizeCapturedError(input: unknown, options: ErrorEvidenceOptions = {}): ErrorInfo {
  const result = normalizeErrorEvidence(input, options);
  if (input !== null && (typeof input === 'object' || typeof input === 'function')) {
    const evidence = result.evidence as ErrorEvidence;
    if (!evidence.errorObjectId) {
      let id = identities.get(input);
      if (!id) { id = evidence.occurrenceId + '-' + (++nextIdentity); identities.set(input, id); }
      evidence.errorObjectId = id;
    }
  }
  return result;
}

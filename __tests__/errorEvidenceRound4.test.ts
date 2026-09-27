import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { normalizeErrorEvidence } from '../src/utils/errorEvidence';
import { errorEvidenceSource } from '../src/build-plugins/error-evidence.generated';
import { createMiniAppAdapter, SYNTHETIC_STACK, type MiniAppAPI } from '../src/platform/miniapp';
import { getCaptureDiagnostics } from '../src/utils/captureGuard';

const implementations: [string, typeof normalizeErrorEvidence][] = [
  ['runtime', normalizeErrorEvidence],
  ['ES5 embedded', runInNewContext(errorEvidenceSource)],
  ['ES5 without WeakMap', runInNewContext(errorEvidenceSource, { WeakMap: undefined })],
];

describe.each(implementations)('capture hardening: %s', (_name, normalize) => {
  it.each(['slice', 'iterator', 'species'])('does not invoke an input issues array %s hook', hook => {
    const input = normalize(new Error('original'));
    const issues = ['cause:depth'];
    const spy = vi.fn(() => { throw Error('input hook executed'); });
    if (hook === 'slice') Object.defineProperty(issues, 'slice', { value: spy });
    if (hook === 'iterator') Object.defineProperty(issues, Symbol.iterator, { value: spy });
    if (hook === 'species') Object.defineProperty(issues, 'constructor', { get: spy });
    input.evidence!.normalization.issues = issues;
    const result = normalize(input);
    expect(spy).not.toHaveBeenCalled();
    expect(result.evidence?.normalization.issues).toEqual(['cause:depth']);
  });

  it('continues past a throwing issue index, reading each index once and at most 16 entries', () => {
    const input = normalize(new Error('original'));
    const issues = Array.from({ length: 20 }, (_, i) => 'field' + i + ':depth');
    const bad = vi.fn(() => { throw Error('index failed'); });
    const good = vi.fn(() => 'cause:depth');
    const outside = vi.fn(() => { throw Error('must not read'); });
    Object.defineProperty(issues, 0, { get: bad });
    Object.defineProperty(issues, 1, { get: good });
    Object.defineProperty(issues, 16, { get: outside });
    input.evidence!.normalization.issues = issues;
    const result = normalize(input);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    expect(result.evidence?.normalization.issues).toContain('normalization.issues[0]:read-failed');
    expect(result.evidence?.normalization.issues).toContain('cause:depth');
    expect(result.evidence?.normalization.issues.length).toBeLessThanOrEqual(16);
  });

  it('retains primary frames and caches shared getter reads without mutating input', () => {
    const getLine = vi.fn(() => 42);
    const frame = Object.freeze({ filename: 'app.js', get lineno() { return getLine(); } });
    const frames = Object.freeze(Array.from({ length: 1500 }, () => frame));
    const input = Object.freeze({ type: 'Error', value: 'original', stacktrace: Object.freeze({ frames }) });
    const result = normalize(input);
    const copied = (result.stacktrace as { frames: unknown[] }).frames;
    expect(copied).toHaveLength(1500);
    expect(copied[1499]).toEqual({ filename: 'app.js', lineno: 42 });
    expect(getLine).toHaveBeenCalledTimes(1);
    expect(result.evidence?.normalization.issues).toEqual([]);
  });
});

describe('miniapp capture isolation', () => {
  it('isolates adapter Error construction failures and continues capturing subsequent errors', () => {
    let callback!: (message: string) => void;
    const api: MiniAppAPI = { getStorageSync: vi.fn(), setStorageSync: vi.fn(), removeStorageSync: vi.fn(),
      onError: (cb: typeof callback) => { callback = cb; } };
    const handler = vi.fn();
    createMiniAppAdapter('wechat', api).errorCapture!.onGlobalError!(handler);
    const before = getCaptureDiagnostics().failures;
    const invalid = { toString() { throw Error('bridge conversion failed'); } };
    expect(() => callback(invalid as unknown as string)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(getCaptureDiagnostics()).toEqual({ failures: before + 1, lastChannel: 'global' });
    callback('next native failure');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].error[SYNTHETIC_STACK]).toBe(true);
    expect(handler.mock.calls[0][0].message).toBe('next native failure');
  });
});

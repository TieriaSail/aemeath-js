import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient } from '../src/plugins/crash/WorkerClient';
import { PROTOCOL } from '../src/plugins/crash/types';

// Source-level fault injection into the callbacks installed by WorkerClient.
// Native Worker compatibility is accepted separately in isolated browser CI.
class WorkerStub {
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.get(type)?.delete(listener); }
  respond() {
    const req = this.postMessage.mock.calls[0]![0] as { id: number; session: string };
    for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data: { protocol: PROTOCOL, session: req.session, id: req.id, ok: true, data: 'ready' } }));
  }
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('owned crash worker request cleanup isolation', () => {
  it('continues close after a timer cancellation failure', async () => {
    const worker = new WorkerStub(), client = new WorkerClient(worker as unknown as Worker, 'session', vi.fn(), vi.fn());
    const result = client.request('init').catch(error => error.message);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => { throw Error('timer cancellation failed'); });
    expect(() => client.close()).not.toThrow();
    expect(await result).toBe('worker-stopped');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect([...worker.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });
  it('settles an installed response callback even when timer cancellation fails', async () => {
    const worker = new WorkerStub(), client = new WorkerClient(worker as unknown as Worker, 'session', vi.fn(), vi.fn());
    const result = client.request('init'); void result.catch(() => {});
    vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => { throw Error('timer cancellation failed'); });
    expect(() => worker.respond()).not.toThrow();
    expect(await result).toBe('ready'); client.close();
  });
  it('rejects a failed post without leaking its timer or a synchronous exception', async () => {
    const worker = new WorkerStub(), client = new WorkerClient(worker as unknown as Worker, 'session', vi.fn(), vi.fn());
    worker.postMessage.mockImplementationOnce(() => { throw new DOMException('uncloneable', 'DataCloneError'); });
    const result = client.request('beat').catch(error => error.message);
    expect(await result).toBe('worker-message-failed'); expect(vi.getTimerCount()).toBe(0);
    client.close(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('bounds pending requests and closes every accepted request', async () => {
    const worker = new WorkerStub(), client = new WorkerClient(worker as unknown as Worker, 'session', vi.fn(), vi.fn());
    const requests = Array.from({ length: 64 }, () => client.request('beat').catch(error => error.message));
    await expect(client.request('beat')).rejects.toThrow('worker-request-budget-exceeded');
    expect(worker.postMessage).toHaveBeenCalledTimes(64);
    client.close(); expect(await Promise.all(requests)).toEqual(Array(64).fill('worker-stopped'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a late response after timeout and still closes its owned worker', async () => {
    const worker = new WorkerStub(), fail = vi.fn(), client = new WorkerClient(worker as unknown as Worker, 'session', vi.fn(), fail);
    const result = client.request('claim').catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10_000); expect(await result).toBe('worker-timeout:claim');
    expect(() => worker.respond()).not.toThrow(); expect(fail).not.toHaveBeenCalled();
    client.close(); expect(vi.getTimerCount()).toBe(0); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

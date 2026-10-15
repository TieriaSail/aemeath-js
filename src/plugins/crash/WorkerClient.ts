import { PROTOCOL } from './types';
import type { CrashResponse } from './types';
function cancelRequestTimer(timer: ReturnType<typeof setTimeout>): void {
  try { clearTimeout(timer); } catch { /* cleanup failure cannot escape worker callbacks */ }
}
export class WorkerClient {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly message = (event: MessageEvent): void => {
    const value = event.data as CrashResponse & { type?: string };
    if (!value || value.protocol !== PROTOCOL || value.session !== this.session) return;
    if (value.type === 'tick') { this.tick(); return; }
    if (value.type === 'fatal') { this.fail(value.reason ?? 'worker-failed'); return; }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id); cancelRequestTimer(pending.timer);
    if (value.ok) pending.resolve(value.data); else pending.reject(new Error(value.reason ?? 'worker-failed'));
  };
  private readonly error = (event: Event): void => {
    // Only this SDK-owned Worker is handled here. Uncancelled runtime errors
    // would otherwise be reported again in the host Window's error handler.
    try { event.preventDefault(); } catch { /* still disable the monitor */ }
    this.fail('worker-execution-failed');
  };
  constructor(private readonly worker: Worker, private readonly session: string, private readonly tick: () => void, private readonly fail: (reason: string) => void) {
    try {
      worker.addEventListener('message', this.message);
      worker.addEventListener('error', this.error);
      worker.addEventListener('messageerror', this.error);
    } catch (error) { this.close(); throw error; }
  }
  request<T = unknown>(op: string, data: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('worker-stopped'));
    if (this.pending.size >= 64) return Promise.reject(new Error('worker-request-budget-exceeded'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`worker-timeout:${op}`)); }, 10_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.worker.postMessage({ protocol: PROTOCOL, session: this.session, id, op, data }); }
      catch { cancelRequestTimer(timer); this.pending.delete(id); reject(new Error('worker-message-failed')); }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const requests = Array.from(this.pending.values());
    this.pending.clear();
    for (const pending of requests) { cancelRequestTimer(pending.timer); pending.reject(new Error('worker-stopped')); }
    for (const [type, listener] of [['message', this.message], ['error', this.error], ['messageerror', this.error]] as const) {
      try { this.worker.removeEventListener(type, listener as EventListener); } catch { /* finish remaining teardown */ }
    }
    try { this.worker.terminate(); } catch { /* owned worker only */ }
  }
}

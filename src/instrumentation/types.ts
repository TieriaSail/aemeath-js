/**
 * Instrumentation layer — shared types
 *
 * This layer owns all monkey-patch logic for network request interception.
 * Each module (fetch, xhr, miniapp-request) is a self-contained singleton
 * that patches once and supports multiple subscribers.
 */

/**
 * Normalized network request event emitted by all instrumentation modules.
 */
export interface NetworkEvent {
  type: 'fetch' | 'xhr' | 'request';
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  duration: number;
  timestamp: number;
  error?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseCode?: number | string;
  responseMessage?: string;
}

/**
 * Options controlling what data the instrumentation captures.
 */
export interface InstrumentOptions {
  /** Return false to skip capturing a given URL (e.g. log upload endpoints). */
  shouldCapture: (url: string) => boolean;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  /** Truncate response body text beyond this byte length. */
  maxResponseBodySize: number;
}

/** Callback receiving captured network events. */
export type NetworkHandler = (event: NetworkEvent) => void;

/** Call to remove a subscriber. When the last subscriber is removed the patch is safely unwound. */
export type Unsubscribe = () => void;

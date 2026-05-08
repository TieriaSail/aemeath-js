/**
 * Instrumentation layer — shared types
 *
 * This layer owns all monkey-patch logic for network request interception.
 * Each module (fetch, xhr, miniapp-request) is a self-contained singleton
 * that patches once and supports multiple subscribers.
 */

/**
 * Low-cardinality error classification following OpenTelemetry `error.type`
 * semantic conventions. Designed for aggregation and alerting.
 */
export type NetworkErrorType =
  | 'network.offline'
  | 'network.timeout'
  | 'network.aborted'
  | 'network.connection_refused'
  | 'network.unknown';

/**
 * Structured diagnostic detail attached to failed network events.
 * Provides machine-readable evidence for root-cause analysis.
 */
export interface NetworkErrorDetail {
  /** navigator.onLine value at the time of failure */
  navigatorOnLine?: boolean;
  /** XHR readyState at the time of failure (0-4) */
  readyState?: number;
  /** HTTP status code if one was received (typically 0 for network errors) */
  statusCode?: number;
  /** Browser-original error message or exception toString */
  raw?: string;
}

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
  /** Human-readable error message (backward compatible) */
  error?: string;
  /** Low-cardinality error classification for aggregation */
  errorType?: NetworkErrorType;
  /** Structured diagnostic evidence for debugging */
  errorDetail?: NetworkErrorDetail;
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

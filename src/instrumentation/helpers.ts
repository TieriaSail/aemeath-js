/**
 * Shared helpers for the instrumentation layer.
 */

export function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
  } catch {
    return text;
  }
}

export function extractBusinessInfo(data: unknown): { code?: number | string; message?: string } {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  const rawMsg = obj['message'] ?? obj['msg'] ?? obj['error'];
  return {
    code: obj['code'] as number | string | undefined,
    message: typeof rawMsg === 'string' ? rawMsg : undefined,
  };
}

/**
 * Safely serialize a request body for logging.
 * Works for both Fetch BodyInit and XHR send() parameter types.
 */
export function captureRequestBody(body: unknown): unknown {
  if (body == null) return undefined;
  try {
    if (typeof body === 'string') return safeParseJSON(body);
    if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
    if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob size=${body.size}]`;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return `[ArrayBuffer size=${body.byteLength}]`;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[ReadableStream]';
    if (typeof Document !== 'undefined' && body instanceof Document) return '[Document]';
    return '[Non-string body]';
  } catch {
    return '[Unable to parse request body]';
  }
}

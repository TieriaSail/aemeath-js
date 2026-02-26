/**
 * Project Logger Configuration - Using New UploadPlugin
 *
 * This is an example of how to configure logger in your project
 * using the new callback-based UploadPlugin
 */

import {
  AemeathLogger,
  LogLevelEnum,
  UploadPlugin,
  ErrorCapturePlugin,
  EarlyErrorCapturePlugin,
} from 'aemeath-js';
import type { LogEntry } from 'aemeath-js';

// ==================== Create Logger ====================

export const logger = new AemeathLogger({
  enableConsole: process.env['NODE_ENV'] !== 'production',
});

// ==================== Add Plugins ====================

// 1. Error Capture
logger.use(new ErrorCapturePlugin());

// 2. Early Error Capture
logger.use(
  new EarlyErrorCapturePlugin({
    enabled: true,
  }),
);

// 3. Upload Plugin (NEW - Callback-based)
logger.use(
  new UploadPlugin({
    // Upload callback - complete control over how logs are uploaded
    onUpload: async (log) => {
      // Get auth token (from your auth system)
      const token = getAuthToken();

      // Upload to your API
      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
          'X-App-Version': '1.0.0',
        },
        body: JSON.stringify({
          ...log,
          // Add any additional fields
          userId: getCurrentUserId(),
          sessionId: getSessionId(),
          url: window.location.href,
        }),
      });

      if (!response.ok) {
        return { success: false, shouldRetry: true, error: `Upload failed: ${response.status}` };
      }
      return { success: true };
    },

    // Priority callback - define log priority
    getPriority: (log) => {
      let priority = 10;

      // Base priority by level
      switch (log.level) {
        case 'error':
          priority = 100;
          break;
        case 'warn':
          priority = 50;
          break;
        case 'info':
          priority = 20;
          break;
        case 'debug':
          priority = 10;
          break;
      }

      // Boost priority for critical modules
      if (log.tags?.module === 'payment') {
        priority = Math.min(100, priority + 20);
      }

      // Boost priority for urgent logs
      if (log.tags?.urgent) {
        priority = Math.min(100, priority + 30);
      }

      return priority;
    },

    // Queue configuration
    queue: {
      maxSize: 200,
      concurrency: 1, // Serial upload (recommended)
      maxRetries: 3,
      uploadInterval: 30000, // Upload every 30s
    },

    // Cache configuration
    cache: {
      enabled: true,
      key: '__app_logs_queue__',
    },

    saveOnUnload: true,
  }),
);

// ==================== Production Enhancements ====================

if (process.env['NODE_ENV'] === 'production') {
  // 1. Add global context
  logger.on('log', (entry: LogEntry) => {
    entry.context = {
      ...entry.context,
      env: process.env['NODE_ENV'],
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
    };
  });

  // 2. Error deduplication (avoid duplicate errors)
  const recentErrors = new Map<string, number>();
  const ERROR_COOLDOWN = 60000; // 1 minute

  logger.on('log', (entry: LogEntry) => {
    if (entry.level === LogLevelEnum.ERROR && entry.error) {
      const errorKey = `${entry.error.type}:${entry.message}:${entry.error.stack?.split('\n')[1]}`;
      const lastTime = recentErrors.get(errorKey);

      if (lastTime && Date.now() - lastTime < ERROR_COOLDOWN) {
        // Block duplicate log
        return;
      }

      recentErrors.set(errorKey, Date.now());

      // Clean up old entries
      if (recentErrors.size > 100) {
        const now = Date.now();
        for (const [key, time] of recentErrors.entries()) {
          if (now - time > ERROR_COOLDOWN) {
            recentErrors.delete(key);
          }
        }
      }
    }
  });
}

// ==================== Helper Functions ====================

function getAuthToken(): string {
  // Get token from your auth system
  return localStorage.getItem('auth_token') || '';
}

function getCurrentUserId(): string | undefined {
  // Get current user ID from your auth system
  const userStr = localStorage.getItem('user');
  if (userStr) {
    try {
      const user = JSON.parse(userStr);
      return user.id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getSessionId(): string {
  // Get or create session ID
  let sessionId = sessionStorage.getItem('session_id');
  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem('session_id', sessionId);
  }
  return sessionId;
}

// ==================== Utility Functions ====================

/**
 * Log API errors (auto-filters 4xx)
 */
export function logAPIError(
  endpoint: string,
  error: Error | Response,
  context?: Record<string, unknown>,
): void {
  if (error instanceof Response) {
    // Only log 5xx errors
    if (error.status >= 500) {
      logger.error('API server error', {
        tags: { endpoint },
        context: { status: error.status, statusText: error.statusText, ...context },
      });
    }
  } else {
    // Network error
    logger.error('API network error', {
      error,
      context: { endpoint, ...context },
    });
  }
}

/**
 * Log performance issues (only if exceeds threshold)
 */
export function logPerformanceIssue(
  operation: string,
  duration: number,
  threshold: number = 3000,
): void {
  if (duration > threshold) {
    logger.warn('Performance issue', {
      tags: { severity: duration > threshold * 2 ? 'critical' : 'warning' },
      context: { operation, duration, threshold },
    });
  }
}

/**
 * Log business flow errors
 */
export function logBusinessError(
  flow: string,
  step: string,
  error: Error,
  context?: Record<string, unknown>,
): void {
  logger.error(`Business flow failed: ${flow}`, {
    error,
    context: { flow, step, ...context },
  });
}

/**
 * Sanitize sensitive data before logging
 */
export function sanitizeData<T extends Record<string, unknown>>(
  data: T,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...data };
  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'creditCard',
    'ssn',
    'apiKey',
  ];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveFields.some((field) => key.toLowerCase().includes(field))) {
      sanitized[key] = '***REDACTED***';
    }
  }

  return sanitized;
}

// ==================== Export ====================

export default logger;

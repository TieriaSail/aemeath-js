/**
 * Platform abstraction layer — unified exports
 */

// Types
export type {
  PlatformType,
  MiniAppVendor,
  PlatformAdapter,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
  EarlyError,
} from './types';

// Detection & management
export { detectPlatform, setPlatform, resetPlatform } from './detect';

// Adapter factories
export { createBrowserAdapter } from './browser';
export { createMiniAppAdapter, type MiniAppAPI } from './miniapp';
export { createNoopAdapter } from './noop';

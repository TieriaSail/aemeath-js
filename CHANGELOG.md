# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-22

### Added

#### Browser Bundle (IIFE)
- **Browser Global Build** (`dist/browser.global.js`)
  - Direct `<script>` tag usage without build tools
  - Perfect for jQuery, vanilla JS, and static HTML projects
  - Global `AemeathJs` variable
  - Simple `AemeathJs.init()` API
  - Includes error capture and safeguard plugins
  - Minified size: ~24KB

#### Framework Integrations
- **React Integration** (`aemeath-js/react`)
  - `AemeathErrorBoundary` - React Error Boundary component with automatic error reporting
  - `useAemeath()` - Hook to get logger instance
  - `useErrorCapture()` - Hook for manual error capture
  - `withErrorBoundary()` - HOC for wrapping components

- **Vue 3 Integration** (`aemeath-js/vue`)
  - `createAemeathPlugin()` - Vue plugin with automatic errorHandler registration
  - `useAemeath(inject)` - Composition API support
  - `useErrorCapture(inject)` - Error capture utilities
  - Optional warning capture support

#### Build Tool Plugins
- **Vite SourceMap Upload** (`aemeath-js/build-plugins/vite-sourcemap`)
  - Automatic SourceMap upload after build
  - Optional deletion of .map files after upload

- **Webpack SourceMap Upload** (`aemeath-js/build-plugins/webpack-sourcemap`)
  - Automatic SourceMap upload via afterEmit hook
  - Compatible with Webpack 4+

#### Improvements
- **SourceMap Parser**: Added LRU cache with configurable `maxCacheSize` to prevent memory leaks
- **Route Matcher**: Extracted to shared utility (`utils/routeMatcher.ts`) for code reuse
- **Event Listeners**: Fixed `bind(this)` issue in SafeGuardPlugin and UploadPlugin that caused memory leaks

### Changed
- **UploadPlugin**: Renamed `uploadOnUnload` to `saveOnUnload` - now saves to localStorage instead of using sendBeacon
- **Build Plugins**: Reorganized into separate entry points for better tree-shaking
  - `aemeath-js/build-plugins/vite` - Vite early error plugin
  - `aemeath-js/build-plugins/vite-sourcemap` - Vite SourceMap upload
  - `aemeath-js/build-plugins/webpack` - Webpack early error plugin
  - `aemeath-js/build-plugins/webpack-sourcemap` - Webpack SourceMap upload
  - `aemeath-js/build-plugins/rsbuild` - Rsbuild early error plugin
  - `aemeath-js/build-plugins/rsbuild-sourcemap` - Rsbuild SourceMap upload

### Removed
- **sendBeacon upload**: Removed `beaconUrl` option from UploadPlugin due to limitations (no custom headers, no response handling)

### Compatibility
| Tool/Framework | Version Support |
|----------------|-----------------|
| Vite | 2.0+ ✅ |
| Webpack | 4.0+ ✅ (html-webpack-plugin optional) |
| Webpack | 3.x ❌ Not supported |
| Rsbuild | 1.0+ ✅ |
| React | 16.8+ ✅ |
| Vue | 3.0+ ✅ |
| Vanilla JS | ✅ Full support |

> **Webpack Note**: The plugin now works without `html-webpack-plugin`. Use `mode: 'file'` to output a standalone script file.

---

## [1.0.0] - 2026-02-01

### Added
- Initial release
- Core Logger with plugin architecture
- ErrorCapturePlugin - Automatic error capturing (window.onerror, unhandledrejection)
- EarlyErrorCapturePlugin - Capture errors before main bundle loads
- UploadPlugin - Upload logs to backend with batching and retry
- PerformancePlugin - Performance monitoring (Web Vitals, resource timing)
- SafeGuardPlugin - Protection against data loss
- NetworkPlugin - Network request logging
- SourceMap parser for production error stack trace resolution
- Build plugins for Webpack, Vite, and Rsbuild
- Singleton mode support
- Full TypeScript support


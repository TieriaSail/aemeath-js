# Module 3: Source Map Parser

## 🎯 Core Function

**Transform obfuscated error stack to readable source code location**

```
Obfuscated: at _0x3a2b (cdn.com/main.abc123.js:1:2345)
            ↓
Readable:   at calculateTotal (src/utils/cart.ts:23:15)
            > 23 |   return sum + item.price;
```

---

## 🚀 Quick Start

### Basic Usage

```typescript
import { createParser } from 'aemeath-js/parser';

// Business layer is responsible for constructing the full path (including env and version)
const parser = createParser({
  sourceMapBaseUrl: 'https://example.com/sourcemaps/dist-test/1.1.1',
  debug: true, // Optional: output debug logs
});

// Parse error stack
const result = await parser.parse(errorStack);

// Output parsed result
result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`${frame.original.fileName}:${frame.original.line}`);
    if (frame.original.source) {
      console.log(frame.original.source); // Source code snippet
    }
  }
});
```

---

## 📚 API

### createParser(config)

Create a SourceMap parser instance.

```typescript
interface SourceMapParserConfig {
  /**
   * SourceMap base URL (complete path including env and version)
   *
   * Example: https://example.com/sourcemaps/dist-test/1.1.3
   *
   * During parsing, only relative path is appended: {sourceMapBaseUrl}/{relativePath}.map
   */
  sourceMapBaseUrl: string;

  /**
   * Request timeout in milliseconds
   * @default 10000
   */
  timeout?: number;

  /**
   * Enable caching
   * @default true
   */
  enableCache?: boolean;

  /**
   * Max cache size (LRU eviction)
   * @default 50
   */
  maxCacheSize?: number;

  /**
   * Enable debug mode (output detailed logs)
   * @default false
   */
  debug?: boolean;
}
```

### parser.parse(stack)

Parse an error stack string.

```typescript
const result = await parser.parse(stack);

interface ParseResult {
  message: string; // Error message
  stack: string; // Original stack
  frames: ParsedStackFrame[]; // Parsed stack frames
  success: boolean; // Whether successful
  error?: string; // Error message if failed
}

interface ParsedStackFrame {
  raw: string; // Original line
  minified?: {
    // Minified position
    fileName: string;
    line: number;
    column: number;
    functionName?: string;
  };
  original?: {
    // Original position (after parsing)
    fileName: string;
    line: number;
    column: number;
    functionName: string | null;
    source?: string; // Source code snippet with context
  };
  resolved: boolean; // Whether successfully resolved
}
```

---

## 💡 Business Layer Wrapper Example

Wrap SourceMap parsing as a project-specific helper:

```typescript
// src/utils/sourcemap-helper.ts
import { createParser, SourceMapParser } from 'aemeath-js/parser';

const RESOURCE_BASE_URL =
  process.env.PUBLIC_RESOURCE_URL || 'https://example.com';
const SOURCEMAP_DIR = `${RESOURCE_BASE_URL}/sourcemaps`;
const DEBUG = process.env.PUBLIC_DEBUG === 'true';

// Cache parsers by env + version
const parserCache = new Map<string, SourceMapParser>();

function getParser(env: string, version: string): SourceMapParser {
  const cacheKey = `${env}/${version}`;

  if (!parserCache.has(cacheKey)) {
    // Business layer constructs the full path
    const sourceMapBaseUrl = `${SOURCEMAP_DIR}/${env}/${version}`;
    parserCache.set(
      cacheKey,
      createParser({
        sourceMapBaseUrl,
        debug: DEBUG,
      }),
    );
  }

  return parserCache.get(cacheKey)!;
}

/**
 * Parse error stack
 */
export async function parseStack(
  stack: string,
  environment: 'test' | 'production',
  version: string,
) {
  const env = environment === 'production' ? 'dist' : 'dist-test';
  const parser = getParser(env, version);
  return parser.parse(stack);
}
```

---

## 🔍 Parse Result

### Before (Obfuscated)

```
Error: Cannot read property 'price' of undefined
    at _0x3a2b (https://cdn.example.com/main.abc123.js:1:2345)
    at _0x4b3c (https://cdn.example.com/main.abc123.js:1:5678)
```

### After (Readable)

```
Error: Cannot read property 'price' of undefined
    at calculateTotal (src/utils/cart.ts:23:15)
    at updateCart (src/components/Cart.tsx:45:10)

Source code:
     21 | function calculateTotal(items) {
     22 |   return items.reduce((sum, item) => {
  >  23 |     return sum + item.price;  // ← Error location
     24 |   }, 0);
     25 | }
```

---

## 🔒 Security Recommendations

1. **Do not deploy SourceMap files to public CDN**
2. Upload SourceMaps to a separate private directory
3. Use `hidden-source-map` mode (no sourceMappingURL comment in code)
4. Only access SourceMaps in internal management systems

---

## Code Obfuscation

When using code obfuscation (e.g., `javascript-obfuscator` / `webpack-obfuscator`), the SourceMap pipeline requires extra configuration.

**Minification vs. Obfuscation**

| | Minification | Obfuscation |
|---|---|---|
| Purpose | Reduce file size | Protect code logic |
| Approach | Shorten names, remove whitespace | Control flow flattening, dead code injection |
| Tools | Terser / SWC / esbuild | javascript-obfuscator / webpack-obfuscator |
| SourceMap | Auto-generated by build tools | Requires explicit config to merge upstream SourceMap |

aemeath-js SourceMap parser supports both — as long as the final output has a correct SourceMap, it resolves back to the original source.

### Multi-Layer SourceMap Merging

When using minification + obfuscation together:

```
TypeScript Source
    ↓ [tsc / SWC / Babel]
JavaScript
    ↓ [Terser / SWC minify]     → SourceMap A
Minified Code
    ↓ [javascript-obfuscator]   → SourceMap B (merged with A)
Final Output + Final SourceMap
```

The obfuscator must correctly merge upstream SourceMaps. Otherwise the final `.map` file cannot map back to the original source.

### Build Configuration

#### Rsbuild + webpack-obfuscator

```typescript
// rsbuild.config.ts
import WebpackObfuscator from 'webpack-obfuscator';

// Inside tools.rspack callback (production only):
config.plugins?.push(
  new WebpackObfuscator(
    {
      rotateStringArray: true,
      stringArray: true,
      stringArrayThreshold: 0.75,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.3,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.1,
      identifierNamesGenerator: 'hexadecimal',
      sourceMap: true,           // Required
      sourceMapMode: 'separate', // Required
    },
    ['**/lib-logger*'],          // Exclude aemeath-js chunk
  ),
);
```

#### Webpack + webpack-obfuscator

```javascript
// webpack.config.js
new WebpackObfuscator(
  {
    rotateStringArray: true,
    stringArray: true,
    controlFlowFlattening: true,
    deadCodeInjection: true,
    identifierNamesGenerator: 'hexadecimal',
    sourceMap: true,
    sourceMapMode: 'separate',
  },
  ['**/lib-logger*'],
);
```

#### Vite + rollup-obfuscator

```typescript
// vite.config.ts
import obfuscatorPlugin from 'rollup-obfuscator';

export default defineConfig({
  build: { sourcemap: 'hidden' },
  plugins: [
    obfuscatorPlugin({
      rotateStringArray: true,
      stringArray: true,
      controlFlowFlattening: true,
      deadCodeInjection: true,
      identifierNamesGenerator: 'hexadecimal',
      sourceMap: true,
      sourceMapMode: 'separate',
    }),
  ],
});
```

### Exclude aemeath-js from Obfuscation

aemeath-js must not be obfuscated — obfuscation breaks its regex-based stack parsing and plugin system. Bundle it into a separate chunk and exclude it:

```typescript
// splitChunks config
optimization: {
  splitChunks: {
    cacheGroups: {
      logger: {
        test: /[\\/](node_modules[\\/]aemeath-js[\\/]|src[\\/]utils[\\/](logger-config|sourcemap-helper|logger\.ts))/,
        name: 'lib-logger',
        chunks: 'all',
        priority: 30,
      },
    },
  },
}

// Then exclude in obfuscator
new WebpackObfuscator({ /* ... */ }, ['**/lib-logger*']);
```

### Obfuscation Strength vs. Performance

| Configuration | Size Increase | Performance Impact |
|---|---|---|
| Identifier renaming only | ~5% | Negligible |
| + String array | ~15-20% | Slight |
| + Control flow flattening (0.3) | ~30-40% | Moderate |
| + Dead code injection (0.1) | ~10-15% | Slight |
| Everything maxed out | ~80-100% | Significant |

### Verify SourceMap After Build

```bash
# Check .map files exist
ls dist/static/js/*.map

# Verify sources field
cat dist/static/js/main.*.js.map | python3 -m json.tool | head -20
# Should contain paths like "src/utils/cart.ts"
```

Or verify programmatically with the parser:

```typescript
import { createParser } from 'aemeath-js/parser';

const parser = createParser({
  sourceMapBaseUrl: 'http://localhost:8080/sourcemaps/dist/1.0.0',
  debug: true,
});

const result = await parser.parse(capturedErrorStack);
result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`✅ ${frame.original.fileName}:${frame.original.line}`);
  } else {
    console.log(`❌ Unresolved: ${frame.raw}`);
  }
});
```

---

## 📖 More

- [Error Capture](./1-error-capture.md)
- [Early Error Capture](./2-early-error-capture.md)
- [Upload Plugin](./4-upload-plugin.md)

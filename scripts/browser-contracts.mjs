// Fixed release plan: a report cannot define or shrink its own acceptance set.
export const browserContracts = [
  ...['native', 'plugin-default', 'singleton-default', 'singleton-dependency-first', 'iife-default', 'reporter-failure']
    .map(mode => ({ title: `packed candidate preserves business startup: ${mode}`, file: 'host-startup.spec.ts' })),
  ...['vite', 'webpack', 'rsbuild'].map(builder => ({ title: `crash packed production consumer: ${builder}`, file: 'crash-detection.spec.ts' })),
  ...['crash recovery: visible stale record and hidden suppression',
    'crash delivery: prepared replay keeps identity and retry boundary',
    'crash compatibility: worker storage and CSP disable safely',
    'crash host isolation: reentry and destination switching',
    'crash admission: ordinary logs retain queue capacity',
    'crash worker error: monitoring failure stays isolated',
    'crash lifecycle: initialization and concurrent clear retain ordering',
    'crash delivery: cancellation and destination changes preserve business',
    'crash receipt: committed responses respect producer lifetime',
    'crash privacy: asynchronous hooks stay isolated',
    'crash coordination: two native workers share one event claim']
    .map(title => ({ title, file: 'crash-detection.spec.ts' })),
];

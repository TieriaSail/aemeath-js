# SDK development and release obligations

Read [.github/SDK_RELEASE_CONTRACT.md](.github/SDK_RELEASE_CONTRACT.md) before
changing runtime instrumentation, tests, CI, packaging or publishing.

- Host application behavior is the primary safety contract. Monitoring failure
  must not add synchronous failures to otherwise valid business operations.
  Preserve the original business callback exception and native invalid-call
  behavior. Do not swallow arbitrary native errors as a compatibility fix.
- Browser API hooks are high-risk changes even in patch releases. Review bare,
  extracted and explicit calls; undefined/null/invalid receivers; callback
  identity and receiver; native return/error semantics; add/remove symmetry;
  import order; stacked hooks and lifecycle. Use native-vs-instrumented results.
- Prove tests exercise installed hooks. Bound Vitest globals or source rebundles
  alone cannot establish native browser or npm artifact compatibility. A bug
  needs a failing reproduction before correction and passing regression after.
- Preserve both branches' existing configuration and public APIs. Shared fixes
  must be assessed in main and dev; dev-only platform/coordination architecture
  stays in dev. Do not make broad migrations while fixing a shared contract.
- Run applicable local verification. Never present test counts, a clean
  typecheck, or jsdom as a substitute for browser host-startup acceptance.
- Do not launch local Playwright/browser automation on this user's machine.
  Release browser checks run in isolated GitHub Actions runners. Missing,
  failed, skipped or timed-out required browser gates block release readiness.
- Publish only the immutable npm archive validated by the same workflow run,
  matching the tag commit/version/lockfile and manifest checksum. Never rebuild
  or switch archives after acceptance, bypass gates, or publish from a directory.
- Do not commit, push, tag, upgrade versions or publish without user authorization.
  Report precisely which validations ran and which remain pending.
- Keep incident evidence and the user's three project-external archives current;
  do not overwrite incident history with a later green result.

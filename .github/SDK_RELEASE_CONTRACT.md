# SDK development and release contract

The 2026-10-08 global event listener incident is a release-blocking host startup
regression. Monitoring runs inside another application: a valid application
operation must keep its native behavior when monitoring is enabled or fails.
All engineering and release decisions follow this contract in main and dev.

## Development before changing browser hooks

1. State what the host operation does natively before implementing an optimization.
   Enumerate bare/extracted/explicit calls, null/undefined/invalid receivers,
   callback object/function identity and this, arguments, return value and native
   exceptions. Cover registration/removal symmetry and conversion side effects.
2. Test SDK-before-dependency and dependency-before-SDK initialization, default
   options and old configurations, multiple instances, soft uninstall/reinstall,
   third-party delegation, and later application operations.
3. Preserve the business exception; isolate failures originating in reporting.
   A blanket catch around business API calls is not an acceptable safety fix.
4. Keep a minimal failing reproduction and demonstrate that the test actually
   enters the hook. Bound Vitest globals and source-only tests are insufficient.
5. Keep patches small and independently attributable. A change to all consumers'
   global prototypes is high risk regardless of a patch version or LOC count.
   Assess shared code in both branches without migrating dev-only architecture.

## Required acceptance layers

| Layer | Required observation | Blocking condition |
| --- | --- | --- |
| Source regression | Reproduction fails before fix; original behavior after | Missing/ineffective regression |
| Local verify | Unit tests, source/test/example/release-test types, build | Any failure |
| Packed artifact | ESM/CJS/IIFE default hooks and actual Dexie first import | Source-only validation or any failure |
| Host startup | Native vs SDK, Dexie CRUD/delete, React mount/click, fetch/XHR/timer | SDK prevents or changes valid business work |
| Observation control | Installed global hook sees intentional business error; business still sees original error | Hook silently skipped or reporter replaces error |
| Native browsers | Chromium, Firefox, WebKit; native IndexedDB; same npm archive | Missing, skipped, failed or timed-out check |
| Minimum runtime | Node16 imports actual packed root ESM/CJS entries | Incompatible entry point |
| Artifact identity | Commit, clean CI checkout, version, lockfile and sha256 | Missing, stale or corrupted evidence |

The local prerequisite deliberately uses jsdom/fake-indexeddb and emulated
business network responses. It does not certify browser compatibility. Browser
acceptance uses unmodified candidate modules in fresh pages and real browser APIs.
Expected control exceptions are narrowly observed; unexpected page errors fail.
Do not suppress all page errors, auto-skip browser cases, or retry failed acceptance
until it looks green. A reproducible failure requires a fix and a new candidate.

## Safe execution and publishing

- No local Playwright/browser launches on the user's computer. Disposable Linux
  GitHub-hosted runners execute headless browser acceptance; release config blocks
  local execution. Browser failures retain trace, screenshot and JUnit/JSON evidence.
  `verify-browser-results.mjs` requires all six planned contracts for each engine:
  no omitted/duplicate cases, skips, expected failures, retries or runner errors.
  Synthetic negative reports check this validator; they are not browser acceptance.
- CI and tag publishing call the same reusable validation workflow. All required
  jobs must succeed; publishing explicitly depends on that workflow.
- Node22 produces one candidate archive and manifest. Browser jobs and Node16
  test that archive. Publishing verifies and publishes those exact bytes via the
  existing GitHub Actions / npm Trusted Publishing / OIDC mechanism.
- Never rebuild after acceptance, switch candidates, bypass required jobs, or
  publish a directory. The publish job grants write/OIDC permissions only after
  validation. Failed environment setup counts as missing acceptance, not success.
- `verify-release-barriers.mjs` proves rejection of wrong commit/version/lockfile,
  corrupted bytes and missing manifest/archive using private copies.
- Local uncommitted candidates are diagnostic only. They cannot satisfy the clean
  CI checkout requirement or be declared release ready without browser results.
- A candidate changes whenever code, dependencies or package files change. Repeat
  acceptance for that candidate; previous branch/version results do not transfer.
- Preserve branch channel selection and tag/version checks. Never promote beta
  to latest or merge dev-only features into main as part of a shared hotfix.

## Incident handling and release statements

Treat monitoring-induced startup loss as critical: freeze unrelated changes,
identify affected published versions, preserve reproductions and offer a verified
temporary mitigation, then prepare a narrow fix and execute all acceptance layers.
Public deprecation/dist-tag changes, commits, releases and user communications
require the user's authorization; do not act on these while merely investigating.

Report separately: source fixed, local checks passed, native-browser acceptance
passed, and fixed package published. Never say an npm incident is resolved while
the registry still serves the defective version. Test count, repeated reviews and
byte equality are supporting facts, not host compatibility evidence.

Maintain the project's external incident archive, OPEN_SOURCE_GUIDE.md and
SESSION_SUMMARY.md. Keep precise execution evidence and unresolved validation
boundaries. No process can promise zero defects; every release must satisfy these
observable gates, and an unknown result must block a readiness claim.

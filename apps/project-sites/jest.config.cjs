/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  // Recycle a worker once it crosses this heap ceiling. Without it, the v8
  // coverage run over 400 suites accumulates memory in long-lived workers and
  // OOM-crashes one on the CI runner (less RAM than dev) — surfacing as a
  // spurious "Test suite failed to run" on whichever heavy suite loads next
  // (consistently route_malformed_json_boundary, which imports the full worker
  // via ../index). Passes locally, failed CI Unit Tests repeatedly. Recycling
  // keeps per-worker heap bounded so the heavy import always has headroom.
  workerIdleMemoryLimit: '512MB',
  // forceExit REMOVED (fire-306e → resolved): the flaky "a worker process has failed to exit
  // gracefully and has been force exited … Active timers … ensure .unref() was called"
  // force-exit — which passed 14562 tests / 0 fail but intermittently marked a suite
  // (platform_root_landings, just the last ../index-importing suite in the --runInBand run)
  // FAILED and blocked the TEST-GATED worker deploy (project-sites.yaml) — was NOT a teardown
  // gap in any suite. ROOT CAUSE: libs/features/system_status/service.ts `probeOne` cleared its
  // 5s abort `setTimeout` only on the fetch SUCCESS line, so the two reject-path unit tests
  // ("times out" / "network error as down") skipped the clear and leaked up to 5 dangling 5s
  // timers per probeAll call. Whether those were still pending at process exit depended on when
  // jest scheduled that suite in the ~46s run → the intermittent force-exit (reproduced locally
  // 2/5 runs with forceExit off). Fixed by moving the clearTimeout into a `finally` (the pattern
  // every sibling abort-timer already uses: import_crawler / credit_monitor / external_llm / api).
  // With that fix the full suite exits cleanly on its own (verified 6/6 local --runInBand runs,
  // 0 leak warnings), so forceExit is unnecessary AND its removal restores jest's open-handle
  // detection as a guard that will FAIL CI if a future change leaks a timer instead of masking it.
  // `.mjs` added so a `.test.ts` can import a pure sibling `scripts/*.mjs` module (e.g.
  // sanitize-manifest.mjs, imported by container-server.mjs) and exercise its LOGIC under
  // the primary `test:unit` gate — @swc/jest transcompiles the ESM `export` to CJS. No
  // existing test imports a `.mjs` (they readFileSync-source-read), so this is additive.
  transform: { '^.+\\.(t|j)sx?$': ['@swc/jest'], '^.+\\.mjs$': ['@swc/jest'] },
  // Transform @cloudflare/containers (shipped as ESM in dist/index.js). Jest
  // ignores node_modules for transforms by default, so any suite importing
  // ../index (which imports @cloudflare/containers) hit "Jest encountered an
  // unexpected token" on its ESM in CI — the real cause of the recurring
  // route_malformed_json_boundary "Test suite failed to run" (NOT OOM). @swc/jest
  // transcompiles it to CJS once it's in scope. Add other ESM-only deps here.
  // ESM-only deps that reach jest via the full-worker `../index` import chain must
  // be transformed (they ship `import` syntax): hono-openapi + @standard-community/*
  // arrive via the OpenAPI route. (partyserver/y-partyserver are stubbed instead —
  // see moduleNameMapper — because they are required from a .cjs shim transform skips.)
  transformIgnorePatterns: [
    '/node_modules/(?!(@cloudflare/containers|hono-openapi|@standard-community/[^/]+)/)',
  ],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  collectCoverageFrom: ['**/src/**/*.{ts,tsx}', '!**/src/**/index.ts'],
  coverageProvider: 'v8',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.wasm$': '<rootDir>/src/__tests__/__mocks__/wasm.js',
    // `cloudflare:workers` is a runtime-only virtual module; stub it so any suite
    // importing ../index (→ @cloudflare/containers → DurableObject) loads under Jest
    // instead of "Cannot find module 'cloudflare:workers'".
    '^cloudflare:workers$': '<rootDir>/src/__tests__/__mocks__/cloudflare-workers.js',
    // `y-partyserver`/`partyserver` ship untransformed ESM; stub the base class so
    // suites importing ../index (→ CollabRoomDO extends YServer) load under Jest.
    '^y-partyserver$': '<rootDir>/src/__tests__/__mocks__/y-partyserver.js',
  },
};

module.exports = config;

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

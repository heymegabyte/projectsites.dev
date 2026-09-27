# Project Sites — Testing Guide

## Test Stack

| Tool | Purpose | Config |
|------|---------|--------|
| Jest | Unit tests | `jest.config.cjs` (must be `.cjs` for ESM) |
| @swc/jest | TypeScript transform | Fast SWC-based compilation |
| Playwright | E2E tests | `playwright.config.ts` |

## Running Tests

### Shared Package (367 tests, 6 suites)
```bash
cd packages/shared
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
npm run check               # typecheck + lint + format + tests
```

### Worker Package (527 tests, 25 suites)
```bash
cd apps/project-sites
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
npm run check               # typecheck + lint + format + tests
```

### E2E Tests
```bash
cd apps/project-sites
npx playwright install chromium  # First time only
npx playwright test              # Run all E2E specs
npx playwright test --ui         # Interactive UI mode
```

## Jest Configuration

Both packages use identical Jest config patterns:

```javascript
// jest.config.cjs — MUST be .cjs (not .js or .ts) because packages use "type": "module"
/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': ['@swc/jest'],
  },
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  collectCoverageFrom: ['**/src/**/*.{ts,tsx}', '!**/src/**/index.ts'],
  coverageProvider: 'v8',
  // CRITICAL: This mapper resolves .js extensions in TypeScript imports
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

module.exports = config;
```

### Why `.cjs`?
Packages use `"type": "module"` in package.json, which makes `.js` files ESM by default.
Jest doesn't support ESM config natively, so the config must use `.cjs` extension.

### Why `moduleNameMapper`?
TypeScript source files import with `.js` extensions (e.g., `import { foo } from './utils.js'`).
This is correct for ESM output, but Jest needs to resolve to the actual `.ts` files.
The mapper strips `.js` → bare path, which SWC then resolves.

## Test Structure

### Worker Test Suites (25 files)

```
apps/project-sites/src/__tests__/
├── ai_workflows.test.ts              # AI pipeline + prompt orchestration
├── analytics.test.ts                 # PostHog event capture
├── audit.test.ts                     # Audit log writes
├── auth.test.ts                      # Magic link, Google OAuth, sessions
├── billing.test.ts                   # Stripe checkout, subscriptions, webhooks
├── db.test.ts                        # D1 query helpers
├── domains.test.ts                   # Custom hostname provisioning
├── error_handler.test.ts             # Error middleware unit tests
├── error_handler_integration.test.ts # Error middleware integration
├── health_route.test.ts              # /health endpoint
├── middleware.test.ts                # Auth, payload limit, request ID
├── prompt_eval.test.ts              # Prompt evaluation integration
├── prompt_observability.test.ts     # LLM call logging
├── prompt_parser.test.ts            # YAML/markdown parsing
├── prompt_registry.test.ts          # Version resolution, A/B variants
├── prompt_renderer.test.ts          # Template rendering
├── prompt_schemas.test.ts           # Prompt I/O validation
├── search_routes.test.ts            # Business search, site lookup
├── sentry.test.ts                   # Error tracking
├── service_error_paths.test.ts      # Service error handling paths
├── site_serving.test.ts             # Site resolution + serving
├── site_serving_full.test.ts        # Full site serving integration
├── webhook.test.ts                  # Stripe signature verification
├── webhook_route.test.ts            # Webhook route handler
└── webhook_storage.test.ts          # Webhook event storage
```

### Shared Test Suites (6 files)

```
packages/shared/src/__tests__/
├── schemas.test.ts                  # Base schema validation (slug, email, phone, etc.)
├── middleware.test.ts               # RBAC role hierarchy + permission matrix
├── utils.test.ts                    # Sanitization, errors, OTP generation
├── crypto-extended.test.ts          # SHA256, HMAC, random generation
├── edge-cases.test.ts              # Redaction, env validation, slug edge cases
└── schemas-extended.test.ts         # All domain entity schema validation
```

### E2E Test Specs (4-6 files)

```
apps/project-sites/e2e/
├── golden-path.spec.ts              # Full user journey (10 tests)
│   - Search → Select → Sign In (Google/Phone/Email) → Details → Build → Waiting
├── homepage.spec.ts                 # Homepage sections + auth screens (28 tests)
│   - Hero, search, sign-in, marketing sections, footer
├── health.spec.ts                   # Health, CORS, auth gates (15 tests)
│   - Health endpoint, marketing site, auth gates, tracing
├── site-serving.spec.ts            # Serving, security, webhooks (13 tests)
│   - Site serving, security headers, auth endpoints
├── ai-workflow.spec.ts              # AI workflow E2E (if present)
└── fixtures.ts                      # Shared test fixtures and helpers
```

## Writing Tests

### Test Patterns

**Service test with D1 mock:**
```typescript
import { dbQuery, dbInsert } from '../services/db.js';

describe('MyService', () => {
  const mockDb = {
    prepare: jest.fn().mockReturnThis(),
    bind: jest.fn().mockReturnThis(),
    all: jest.fn(),
    first: jest.fn(),
    run: jest.fn(),
  } as unknown as D1Database;

  beforeEach(() => jest.clearAllMocks());

  it('should create a record', async () => {
    mockDb.prepare().run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    const result = await dbInsert(mockDb, 'sites', { id: '...', business_name: 'Test' });
    expect(result.error).toBeNull();
  });
});
```

**Route test with Hono app:**
```typescript
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';

describe('GET /health', () => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  // Mount route handlers...

  it('should return 200', async () => {
    const res = await app.request('/health', {}, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
```

**Schema validation test:**
```typescript
import { siteSchema, createSiteSchema } from '../schemas/site.js';

describe('siteSchema', () => {
  it('should accept valid site', () => {
    const result = siteSchema.safeParse({
      id: crypto.randomUUID(),
      org_id: crypto.randomUUID(),
      slug: 'vitos-salon',
      business_name: "Vito's Mens Salon",
      status: 'published',
      // ... required fields
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid slug', () => {
    const result = createSiteSchema.safeParse({
      business_name: 'Test',
      slug: 'INVALID SLUG',
    });
    expect(result.success).toBe(false);
  });
});
```

## Test Business Data

For E2E and integration tests, use:

**Vito's Mens Salon**
- Address: 74 N Beverwyck Rd, Lake Hiawatha, NJ 07034
- Google Place ID: (use from actual search)
- Slug: `vitos-mens-salon`

## Coverage

```bash
# Generate coverage report
cd apps/project-sites && npm run test:coverage
cd packages/shared && npm run test:coverage

# Coverage reports are in coverage/ directory
# Open coverage/lcov-report/index.html for HTML report
```

## Playwright Configuration

```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node scripts/e2e_server.cjs',
    port: 8787,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

## Troubleshooting

### "Cannot use import statement outside a module"
- Ensure Jest config is `.cjs` not `.js`
- Check `moduleNameMapper` includes the `.js` → bare path mapping

### "SyntaxError: Unexpected token 'export'"
- Add the failing module to `transformIgnorePatterns` exception
- Or ensure `@swc/jest` transform covers the file pattern

### Playwright "browserType.launch: Executable doesn't exist"
- Run `npx playwright install chromium`
- Chromium path: `/root/.cache/ms-playwright/chromium-*/chrome-linux/chrome`

### Mock type errors
- Use `as unknown as D1Database` pattern for mock casting
- Create proper mock factories for repeated patterns

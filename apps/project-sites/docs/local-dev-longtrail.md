# Local Dev — Full Stack for Long-Trail E2E (worker + Angular + real test-login)

> The EXACT, verified recipe to bring up the **real** local stack — Cloudflare Worker (`:8787`,
> local D1/R2/KV) + Angular admin SPA (`:4200`) with a working `/api` proxy — so a browser-driven
> long-trail journey signs in as `brian@megabyte.space` through the REAL UI and hits the REAL API.
> A static shell (`e2e_server.cjs :4300`) or mock `page.route` stubs do NOT exercise this — they
> can't reach the worker. This recipe is what makes local E2E honest.
>
> Verified end-to-end 2026-09-29 (Long-Trail LIVE slice): `/health` 200 · `POST /api/auth/test-login`
> mints a real session · `GET /api/auth/me` → `brian@megabyte.space` (super-admin) · SPA→worker proxy
> live · real UI login lands on `/admin`.

## Prereqs

- `npm install --legacy-peer-deps` in BOTH `apps/project-sites` AND `apps/project-sites/frontend`
  (pnpm breaks on the electron-builder dep). In a worktree, install inside the worktree.
- `get-secret E2E_TEST_PASSWORD` returns a value (gates the test-login seam).
- `sqlite3` CLI on PATH (for the schema step).

## Step 1 — Local D1 schema (the sharp edge)

`wrangler d1 migrations apply --local` **fails on a fresh DB** at `0010_add_1337_features.sql`
(`no such table: builds` — `builds` is only CREATEd in `0504`, so the incremental chain has an
ordering dependency prod satisfied historically). Applying migrations one-by-one via `wrangler` is
also too slow (~3s × 184 migrations → 10min timeout). Apply the full schema **tolerantly** directly
to the miniflare sqlite with a short multi-pass script:

```bash
cd apps/project-sites
python3 - <<'PY'
import glob, os, sqlite3
d1dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
os.makedirs(d1dir, exist_ok=True)
# Stable miniflare filename for the `project-sites-db` binding (this account/worktree):
dbfile = os.path.join(d1dir, "fca4580c20ac42277d17d35569cc39d264918fce1ee6b97ab3f609c5084f84e0.sqlite")
con = sqlite3.connect(dbfile)
migs = sorted(glob.glob("migrations/*.sql"), key=lambda p: os.path.basename(p))
for _pass in range(4):            # multi-pass converges the ordering DAG
    for f in migs:
        try: con.executescript(open(f, encoding="utf-8").read()); con.commit()
        except Exception: pass     # ALTERs on not-yet-created tables retry next pass
con.commit()
tbl = lambda t: con.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
col = lambda t,c: con.execute(f"SELECT COUNT(*) FROM pragma_table_info('{t}') WHERE name='{c}'").fetchone()[0]
print("tables:", con.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0],
      "| users.is_super_admin:", col("users","is_super_admin"),
      "| audit_logs.message:", col("audit_logs","message"),
      "| feature_flags:", tbl("feature_flags"))
con.close()
PY
```

Expected: **~310 tables · users.is_super_admin=1 · audit_logs.message=1 · feature_flags=1.** A few
migrations (`builds`-dependent, some `feature_flags.key` seeds) legitimately never apply on a fresh
local DB — they are NOT on the auth/editor/serving paths and don't block the journey.

> If the miniflare hash differs (new binding/account), let `wrangler d1 execute project-sites-db
> --local --command "SELECT 1"` create the file once, then `find .wrangler -name '*.sqlite'` to get
> the real filename and use it in the script above.

## Step 2 — `.dev.vars` (local secrets — GIT-IGNORED, never committed)

`.dev.vars` is already in `.gitignore` (verify: `git check-ignore .dev.vars` → prints the path).

```bash
cd apps/project-sites
printf 'E2E_TEST_PASSWORD=%s\nENVIRONMENT=development\n' "$(get-secret E2E_TEST_PASSWORD)" > .dev.vars
```

`ENVIRONMENT=development` is load-bearing: it flips `parseEnv` (`src/lib/env.ts`) to the local-relaxed
schema so the 9 prod-required integration secrets (Stripe/Places/PostHog/CF-for-SaaS) are OPTIONAL
locally. Without it EVERY request 400s `VALIDATION_ERROR` and the whole stack is un-bootable (the RED
this slice fixed). Prod (`ENVIRONMENT=production`) stays fail-fast.

## Step 3 — Boot the worker (`:8787`, local bindings)

```bash
cd apps/project-sites
npx wrangler dev --local --port 8787 --var ENVIRONMENT:development
# Wait for: "Ready on http://localhost:8787"
```

Smoke it (no secrets printed):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/health            # → 200
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/test-login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"brian@megabyte.space\",\"password\":\"$(get-secret E2E_TEST_PASSWORD)\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
curl -s http://localhost:8787/api/auth/me -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# → { "data": { "email": "brian@megabyte.space", "org_id": "...", "is_super_admin": true, ... } }
```

## Step 4 — Angular SPA (`:4200`) with the `/api` → worker proxy

The proxy did NOT exist before this slice — `ng serve` had no way to reach the worker. It's now at
`frontend/proxy.conf.json` and wired into `angular.json` (`serve.options.proxyConfig`):

```bash
cd apps/project-sites/frontend
npm start                       # ng serve :4200, proxy.conf.json → http://localhost:8787
# Wait for: "Local: http://localhost:4200/"
```

Verify the SPA→worker bridge (proxy reaches the worker, NOT the SPA shell):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4200/health              # → 200 (via proxy)
curl -s http://localhost:4200/api/auth/me                                          # → 401 JSON (worker), not 200 HTML
```

## Step 5 — Real sign-in through the UI

Go to `http://localhost:4200/signin?test=1`. The **Test sign-in** panel renders (it's wired into the
SERVED `pages/auth/sign-in.component.ts` — the earlier `pages/signin/*` panel was orphaned). Enter
the `E2E_TEST_PASSWORD`, click **Sign in (test)** → lands on `/admin` as super-admin. The oracle is
`GET /api/auth/me` returning `brian@megabyte.space`, never the toast/redirect.

## Step 6 — Run the long-trail spec (from the WORKER package)

Both servers up, then (from `apps/project-sites`, which owns ONE `@playwright/test` — running from
`frontend` pulls a second copy and errors "did not expect test.describe()"):

```bash
cd apps/project-sites
E2E_TEST_PASSWORD="$(get-secret E2E_TEST_PASSWORD)" \
  npx playwright test e2e/long-trail/case-001-money-path.e2e.ts \
  --config e2e/long-trail/playwright.longtrail.config.ts
# Phase A → 3 passed, 5 skipped (Phases B–F are test.fixme until driven live).
```

## Gotchas (all hit + resolved during the LIVE slice)

- **`parseEnv` 400 on every request locally** → set `ENVIRONMENT=development` (Step 2); the schema
  relaxes the 9 integration secrets in dev only.
- **Migration chain breaks at `0010` (`builds`)** → use the tolerant multi-pass apply (Step 1), not
  `wrangler d1 migrations apply --local`.
- **`/api/auth/me` "User not found" after login** → the local DB was at an ancient migration level
  missing `users.is_super_admin`; the Step 1 multi-pass fixes it.
- **No `/api` in `ng serve`** → `proxy.conf.json` + `angular.json serve.options.proxyConfig` (Step 4).
- **`?test=1` panel absent** → it lived only in the unrouted `pages/signin/*`; now wired into the
  served `pages/auth/sign-in.component.ts`.
- **Playwright "did not expect test.describe()"** → run from `apps/project-sites`, not `frontend`
  (two `@playwright/test` copies otherwise).
- **`/api/auth/get-session` 404 in console** → benign; `better_auth` is dark locally. The spec's
  console-error gate allowlists exactly this one.

## Teardown

```bash
kill "$(cat /tmp/ltt-wrangler.pid)" "$(cat /tmp/ltt-ng.pid)" 2>/dev/null   # if you stashed PIDs
# or: pkill -f 'wrangler dev'; pkill -f 'ng serve'
rm -f apps/project-sites/.dev.vars                                          # drop local secret file
```

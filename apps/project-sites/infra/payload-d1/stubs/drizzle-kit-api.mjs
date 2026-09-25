// Build-only stub for `drizzle-kit/api`.
//
// drizzle-kit is MIGRATION tooling. It is used by `payload migrate` (the Node CLI at
// DEPLOY time) — NEVER at Cloudflare Worker runtime. But `@payloadcms/drizzle` references
// `require('drizzle-kit/api')`, which Turbopack pulls (and hashes) into the server graph,
// and OpenNext's esbuild then fails to resolve it (upstream bug payloadcms/payload#16470).
//
// Aliasing `drizzle-kit/api` → this stub ONLY in the Next/Turbopack (Worker) build keeps the
// real tooling out of the Worker bundle. If any of these are ever called at runtime they throw
// (they are not — migrations run out-of-band), so this is safe.
const unavailable = () => {
  throw new Error('drizzle-kit/api is deploy-time migration tooling and is not bundled into the Worker runtime');
};
export const generateSQLiteDrizzleJson = unavailable;
export const generateSQLiteMigration = unavailable;
export const pushSQLiteSchema = unavailable;
export const generateDrizzleJson = unavailable;
export const generateMigration = unavailable;
export const pushSchema = unavailable;
export const upPgSnapshot = unavailable;
export default {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  pushSQLiteSchema,
  generateDrizzleJson,
  generateMigration,
  pushSchema,
  upPgSnapshot,
};

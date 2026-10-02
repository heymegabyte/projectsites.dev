/**
 * @module storage-policy
 * @description
 * Barrel for the shared file-storage-routing policy (Cloudflare Artifacts
 * three-bucket architecture, Cycle 1). Re-exports the single routing authority
 * so every managed-file write boundary imports from one path:
 * `import { selectFileStorage, LARGE_FILE_THRESHOLD_BYTES } from '@bolt/shared'`.
 */
export * from './routing.js';

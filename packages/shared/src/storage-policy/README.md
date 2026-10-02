# storage-policy — shared file-storage-routing policy (Cloudflare Artifacts three-bucket arch, Cycle 1)

- The ONE server-enforced policy for which physical storage tier a managed file lands in. EVERY
  write boundary — uploads, Save/Save All, drag-and-drop, replacements, agent + MCP writes, remote
  imports, template copies, full-IDE sync, generated files, extracted archive members, build-output
  ingestion — MUST call `selectFileStorage(byteLength)` and never choose a tier any other way.
- **The rule:** a file strictly larger than `LARGE_FILE_THRESHOLD_BYTES` (30,000,000 decimal bytes,
  NOT 30 MiB) routes to the protected per-account **Media** R2 bucket, regardless of extension or MIME
  type. `<=` the threshold stays **ordinary** (the existing eligible Preview/Production source/draft/
  deployment path — NOT an unconditional Git write; binary policy + repo quota still apply upstream).
- **Route on ACTUAL uncompressed byte length** — never compressed Git size, multipart part size, or
  MIME type. The 30 MB routing rule is independent of the multipart part-size algorithm.
- **Trust boundary:** `selectFileStorage` throws `RangeError` on a non-negative-safe-integer size;
  `safeSelectFileStorage(unknown)` validates with `fileByteLengthSchema` and returns a discriminated
  result so a dishonest/invalid declared size is rejected rather than published to the wrong tier.
- **The client can never choose a tier or bypass the policy.** The server resolves the destination
  from the verified byte length at finalization; browser metadata is never trusted as proof.
- Files: `routing.ts` (threshold + `StorageRoleSchema` + `selectFileStorage` + `safeSelectFileStorage`
  + `fileByteLength` schema + `isMediaTier`/`isOrdinaryTier`).

Later Cycle-1+ slices build on this: `AccountStorage`/`ProjectStorage`/`AssetVersion`/`UploadSession`/
`ReleaseManifest` contracts, the `ArtifactsRepositoryProvider`, the versioned asset manifest, and the
per-account Media bucket provisioner. Tracked in `.claude/run-the-loop/DOWNLOADS-INTAKE-QUEUE.md`.

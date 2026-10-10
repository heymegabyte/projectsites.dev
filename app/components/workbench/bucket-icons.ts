/**
 * @file bucket-icons — the object-browser file-type icon map for the Buckets panel.
 *
 * Extracted from `BucketsPanel.tsx` (fire-B5) so BOTH the live panel AND the headless `/_preview`
 * gallery render the SAME, provably-distinct per-type glyphs from one source of truth. Keeping it a
 * dependency-free pure module (no React, no bridge) lets the gallery import it directly and lets the
 * Vitest suite assert the mapping in isolation.
 *
 * ICONS: Phosphor DUOTONE glyphs via UnoCSS `presetIcons` (`i-ph:<name>-duotone`). Every class below
 * is VERIFIED present in the installed `@iconify-json/ph` set — if a future glyph is removed upstream,
 * fall back to a generic (`i-ph:file-code-duotone` / `i-ph:file-duotone`) and note it here.
 *
 * ⚠ SAFELIST: `uno.config.ts` derives its panel-icon safelist by grepping `/i-ph:[a-z0-9-]+/g` across
 * the workbench components. Because this `.ts` module (not `.tsx`) is NOT matched by the default glob,
 * `bucket-icons.ts` is added explicitly to `PANEL_ICON_GLOBS` so these masks always generate. Add any
 * NEW glyph here and it is picked up automatically on the next build.
 */

/**
 * A distinct Phosphor duotone glyph class for an object by its key (extension or folder shape).
 *
 * A key ending in `/` is a bucket PREFIX (folder) → the folder glyph. Otherwise the lowercased
 * extension drives the mapping across ~18 distinct families (image / video / audio / pdf / markdown /
 * csv / spreadsheet / doc / slides / data / markup / ts / js / css / archive / text / font / sql).
 * Anything unrecognised falls back to the generic file glyph.
 *
 * @param key - The object key (e.g. `images/hero.webp`, `report.pdf`, or a prefix `images/`).
 * @returns A UnoCSS icon class, e.g. `i-ph:image-duotone`.
 */
export function iconForObject(key: string): string {
  // A prefix/folder (common-prefix row) — shape, not extension, decides.
  if (key.endsWith('/')) {
    return 'i-ph:folder-duotone';
  }

  const name = key.toLowerCase();

  // Images (previewable raster + vector).
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/.test(name)) {
    return 'i-ph:image-duotone';
  }

  // Video.
  if (/\.(mp4|mov|webm|mkv|avi|m4v|flv)$/.test(name)) {
    return 'i-ph:file-video-duotone';
  }

  // Audio.
  if (/\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(name)) {
    return 'i-ph:file-audio-duotone';
  }

  // PDF.
  if (/\.pdf$/.test(name)) {
    return 'i-ph:file-pdf-duotone';
  }

  // Markdown.
  if (/\.(md|mdx|markdown)$/.test(name)) {
    return 'i-ph:file-md-duotone';
  }

  // CSV / TSV (tabular text).
  if (/\.(csv|tsv)$/.test(name)) {
    return 'i-ph:file-csv-duotone';
  }

  // Spreadsheets.
  if (/\.(xls|xlsx|xlsm|ods)$/.test(name)) {
    return 'i-ph:file-xls-duotone';
  }

  // Word documents.
  if (/\.(doc|docx|odt|rtf)$/.test(name)) {
    return 'i-ph:file-doc-duotone';
  }

  // Slide decks.
  if (/\.(ppt|pptx|odp|key)$/.test(name)) {
    return 'i-ph:file-ppt-duotone';
  }

  // Structured-data configs (object/array shaped).
  if (/\.(json|jsonc|ya?ml|toml)$/.test(name)) {
    return 'i-ph:brackets-curly-duotone';
  }

  // Markup (XML/HTML family).
  if (/\.(html?|htm|xml|xhtml|svelte|vue)$/.test(name)) {
    return 'i-ph:file-html-duotone';
  }

  // TypeScript.
  if (/\.(ts|tsx|mts|cts)$/.test(name)) {
    return 'i-ph:file-ts-duotone';
  }

  // JavaScript.
  if (/\.(js|mjs|cjs|jsx)$/.test(name)) {
    return 'i-ph:file-js-duotone';
  }

  // Stylesheets.
  if (/\.(css|scss|sass|less|styl)$/.test(name)) {
    return 'i-ph:file-css-duotone';
  }

  // Archives.
  if (/\.(zip|tar|gz|tgz|rar|7z|bz2|xz)$/.test(name)) {
    return 'i-ph:file-zip-duotone';
  }

  // Fonts.
  if (/\.(woff2?|ttf|otf|eot)$/.test(name)) {
    return 'i-ph:text-aa-duotone';
  }

  // SQL / database dumps.
  if (/\.(sql|sqlite|db)$/.test(name)) {
    return 'i-ph:database-duotone';
  }

  // Plain text / logs.
  if (/\.(txt|log|text)$/.test(name)) {
    return 'i-ph:file-text-duotone';
  }

  // Unknown — generic file.
  return 'i-ph:file-duotone';
}

/**
 * True when an object key looks like a previewable image (drives inline thumbnails in grid view and
 * the row-level preview action). SVG is included — it renders as an `<img>` safely enough for a tile.
 *
 * @param key - The object key.
 * @returns Whether the key is a previewable image.
 */
export function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/i.test(key);
}

import { diffLines, type Change } from 'diff';
import type { FileHistory } from '~/types/actions';

export interface FileDiffStat {
  additions: number;
  deletions: number;
}

const ZERO: FileDiffStat = { additions: 0, deletions: 0 };

/**
 * Line-level additions/deletions between a file's AI-original baseline and its
 * latest tracked version.
 *
 * Hardened against partially-populated `FileHistory` entries: the inline-diff
 * baseline publishes `{ originalContent }` snapshots that legitimately carry NO
 * `versions` yet, so reading `versions[versions.length - 1]` directly throws
 * `Cannot read properties of undefined (reading 'length')` and crashed the
 * editor Workbench 101× on load (fire-73). "No tracked versions yet" means
 * "nothing to diff" → return 0/0, never throw.
 *
 * @param fileModifications the file's history entry, or undefined when untracked
 * @returns additions + deletions line counts (0/0 when there is no diff to show)
 * @example computeFileDiffStat({ originalContent: 'a' } as FileHistory) // { additions: 0, deletions: 0 }
 */
export function computeFileDiffStat(fileModifications: FileHistory | undefined): FileDiffStat {
  /*
   * No baseline, or no tracked version yet → nothing to diff against. The guard
   * on `versions?.length` is load-bearing: entries may omit `versions` entirely.
   */
  if (!fileModifications?.originalContent || !fileModifications.versions?.length) {
    return { ...ZERO };
  }

  const normalizedOriginal = fileModifications.originalContent.replace(/\r\n/g, '\n');
  const normalizedCurrent =
    fileModifications.versions[fileModifications.versions.length - 1]?.content.replace(/\r\n/g, '\n') || '';

  if (normalizedOriginal === normalizedCurrent) {
    return { ...ZERO };
  }

  const changes = diffLines(normalizedOriginal, normalizedCurrent, {
    newlineIsToken: false,
    ignoreWhitespace: true,
    ignoreCase: false,
  });

  return changes.reduce<FileDiffStat>(
    (acc, change: Change) => {
      if (change.added) {
        acc.additions += change.value.split('\n').length;
      }

      if (change.removed) {
        acc.deletions += change.value.split('\n').length;
      }

      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}

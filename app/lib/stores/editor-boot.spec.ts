import { describe, expect, it } from 'vitest';
import { EMPTY_CHAT_CONFIRM_TICKS, type BootReadinessInput, isBootReady } from './editor-boot';

const base: BootReadinessInput = {
  filesReady: false,
  isImport: false,
  fileCount: 0,
  chatReady: false,
  emptyTicks: 0,
};

describe('isBootReady', () => {
  it('dismisses the moment files are confirmed loaded (any mode)', () => {
    expect(isBootReady({ ...base, filesReady: true, isImport: true })).toBe(true);
    expect(isBootReady({ ...base, filesReady: true, isImport: false })).toBe(true);
  });

  it('never fades an import before its files arrive — even once the chat shell is ready', () => {
    // The exact race we must not lose: imported site, chat painted, still 0 files.
    expect(
      isBootReady({ ...base, isImport: true, chatReady: true, fileCount: 0, emptyTicks: 999 }),
    ).toBe(false);
  });

  it('dismisses a fresh, file-less chat once it is confirmed empty (chat ready + zero files, held)', () => {
    expect(
      isBootReady({ ...base, isImport: false, chatReady: true, fileCount: 0, emptyTicks: EMPTY_CHAT_CONFIRM_TICKS }),
    ).toBe(true);
  });

  it('waits out the confirm window before declaring a non-import chat empty', () => {
    expect(
      isBootReady({ ...base, isImport: false, chatReady: true, fileCount: 0, emptyTicks: EMPTY_CHAT_CONFIRM_TICKS - 1 }),
    ).toBe(false);
  });

  it('does not treat a not-yet-ready chat as empty', () => {
    expect(isBootReady({ ...base, isImport: false, chatReady: false, fileCount: 0, emptyTicks: 999 })).toBe(false);
  });

  it('leaves a non-import chat that already has files to the files-settled/atom path (not the empty path)', () => {
    // fileCount > 0 → the empty-chat branch cannot fire; readiness comes from filesReady.
    expect(isBootReady({ ...base, isImport: false, chatReady: true, fileCount: 5, emptyTicks: 999 })).toBe(false);
    expect(isBootReady({ ...base, isImport: false, fileCount: 5, filesReady: true })).toBe(true);
  });
});

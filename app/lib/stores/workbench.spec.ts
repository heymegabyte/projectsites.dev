// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { workbenchStore } from './workbench';

/**
 * REGRESSION SPEC — the abort/resume latch on the global execution queue.
 *
 * `addToExecutionQueue` chains every callback onto one promise and guards it
 * with a private `#aborted` latch. `abortAllActions()` sets the latch;
 * `resumeActions()` clears it. Historically `resumeActions()` had ZERO
 * callers, so a single abort PERMANENTLY silenced every later queued
 * callback — AI edits silently stopped landing in the editor with no error
 * thrown. `app/components/chat/Chat.client.tsx` now calls it at the start of
 * each stream.
 *
 * The store's constructor touches browser-ish globals via the WebContainer
 * singleton chain (`~/lib/webcontainer`), so those are stubbed minimally below
 * rather than mocking the world. `abortAllActions()` additionally calls
 * `resetAllFileModifications()`, which just delegates to the files store — it
 * is synchronous and side-effect-free with no files present.
 */

/*
 * Minimal browser-global stubs for the WebContainer / persistence chain. The
 * real UI (and its full hydration) is covered by the Playwright E2E suite.
 */
const memoryStorage = new Map<string, string>();
const storageStub = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memoryStorage.set(key, value);
  },
  removeItem: (key: string) => {
    memoryStorage.delete(key);
  },
  clear: () => {
    memoryStorage.clear();
  },
  key: () => null,
  get length() {
    return memoryStorage.size;
  },
};

const stubGlobals = globalThis as unknown as Record<string, unknown>;
stubGlobals.localStorage ??= storageStub;
stubGlobals.sessionStorage ??= storageStub;

// The WebContainer singleton probes these while booting; nothing here boots it.
if (!('webcontainerContext' in stubGlobals)) {
  stubGlobals.webcontainerContext = { loaded: false };
}

if (!('SharedArrayBuffer' in stubGlobals)) {
  stubGlobals.SharedArrayBuffer = ArrayBuffer;
}

if (!('crossOriginIsolated' in stubGlobals)) {
  stubGlobals.crossOriginIsolated = false;
}

stubGlobals.crypto ??= globalThis.crypto ?? {};
stubGlobals.navigator ??= { userAgent: 'vitest', language: 'en-US', languages: ['en-US'] };

/**
 * Flush the queue: `addToExecutionQueue` chains `.then()` (a microtask) and the
 * callback itself is async, so a macrotask hop is the reliable "everything that
 * was queued is now settled" boundary.
 */
const flushQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('workbenchStore execution queue — abort/resume latch', () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];

    /*
     * Defensive: the singleton is module-scoped, so a prior test's abort could
     * leak in. Clearing the latch here is setup hygiene, not the assertion.
     */
    workbenchStore.resumeActions();
  });

  it('runs a callback queued before any abort (baseline)', async () => {
    workbenchStore.addToExecutionQueue(async () => {
      calls.push('baseline');
    });

    await flushQueue();

    expect(calls).toEqual(['baseline']);
  });

  it('does NOT run a callback queued after abortAllActions()', async () => {
    workbenchStore.abortAllActions();

    workbenchStore.addToExecutionQueue(async () => {
      calls.push('after-abort');
    });

    await flushQueue();

    /*
     * The latch engaged: the callback is dropped, not merely deferred, and no
     * error is thrown — this silence is exactly what made the bug invisible.
     */
    expect(calls).toEqual([]);
  });

  it('runs a callback queued after resumeActions() clears the latch (regression)', async () => {
    workbenchStore.abortAllActions();

    // Fails if the `#aborted = false` line inside resumeActions() is deleted.
    workbenchStore.resumeActions();

    workbenchStore.addToExecutionQueue(async () => {
      calls.push('after-resume');
    });

    await flushQueue();

    expect(calls).toEqual(['after-resume']);
  });

  it('is safe to call resumeActions() when never aborted (idempotent, no throw)', () => {
    expect(() => {
      workbenchStore.resumeActions();
      workbenchStore.resumeActions();
    }).not.toThrow();
  });

  it('resumeActions() with no prior abort still lets queued work run', async () => {
    workbenchStore.resumeActions();

    workbenchStore.addToExecutionQueue(async () => {
      calls.push('resumed-without-abort');
    });

    await flushQueue();

    expect(calls).toEqual(['resumed-without-abort']);
  });
});

/**
 * Guard the import seam this spec depends on: the module must export a
 * singleton (not require per-test construction) that shares the one
 * WebContainer instance, so tests never boot a real container.
 */
describe('workbenchStore singleton seam', () => {
  it('exposes the abort/resume/queue methods the chat stream depends on', () => {
    expect(typeof workbenchStore.addToExecutionQueue).toBe('function');
    expect(typeof workbenchStore.abortAllActions).toBe('function');
    expect(typeof workbenchStore.resumeActions).toBe('function');
  });
});

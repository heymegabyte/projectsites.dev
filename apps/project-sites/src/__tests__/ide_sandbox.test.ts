/**
 * IDE Sandbox Tests — TDD RED-first
 * Verifies honest state, no fabrications
 */

import type { Env } from '../types/env';
import {
  spinUpSandbox,
  listMultiAgentRuns,
  getMultiAgentRunDetail,
  buildSwarmSseStream,
  buildProgressiveSseStream,
} from '../services/ide_sandbox';

const mockEnv = {
  DB: {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        run: jest.fn().mockResolvedValue({ success: true }),
        first: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue({ results: [] }),
      }),
    }),
  },
} as unknown as Env;

describe('ide_sandbox — honest state (RED)', () => {
  describe('spinUpSandbox', () => {
    it('should NOT return state:ready without backing', async () => {
      const result = await spinUpSandbox(mockEnv, { siteId: 'test', userId: 'user1' });
      // RED: current code returns state:'ready' immediately
      expect(result.state).not.toBe('ready');
    });

    it('should NOT have fabricated estimated_boot_ms:800', async () => {
      const result = await spinUpSandbox(mockEnv, { siteId: 'test', userId: 'user1' });
      // RED: hardcoded 800ms is never honest
      if (result.estimated_boot_ms) {
        expect(result.estimated_boot_ms).not.toBe(800);
      }
    });
  });

  describe('listMultiAgentRuns', () => {
    it('should NOT return getDemoRuns when DB is empty', async () => {
      const result = await listMultiAgentRuns(mockEnv, 'test-site');
      // RED: current code returns demo runs as fallback
      const hasDemoRun = result.some((r) => r.id === 'demo-run-1');
      expect(hasDemoRun).toBe(false);
    });
  });

  describe('getMultiAgentRunDetail', () => {
    it('should NOT return synthetic output_preview', async () => {
      const result = await getMultiAgentRunDetail(mockEnv, 'nonexistent');
      // RED: current code returns fake output_preview: '<section class="hero"...'
      if (result.output_preview) {
        expect(result.output_preview).not.toContain('<section');
      }
    });
  });

  describe('buildSwarmSseStream', () => {
    it('should NOT emit timer-driven fake progress events', async () => {
      const stream = buildSwarmSseStream(mockEnv, 'test-site', null);
      const reader = stream.getReader();

      // RED: current code emits fake agent_started/file_emitted/agent_done every 1.5s
      // Give it 2 seconds to emit fake events
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 2000);
      });

      const streamComplete = (async () => {
        let eventCount = 0;
        try {
          while (eventCount < 5) {
            const { done } = await reader.read();
            if (done) break;
            eventCount++;
          }
        } catch {}
        return eventCount > 0;
      })();

      const didEmitFakeEvents = await Promise.race([streamComplete, timeout]);
      expect(didEmitFakeEvents).toBe(false); // Should NOT emit fake events
      reader.cancel();
    });
  });

  describe('buildProgressiveSseStream', () => {
    it('should NOT emit timer-driven component_ready events', async () => {
      const stream = buildProgressiveSseStream(mockEnv, 'test-site');
      const reader = stream.getReader();

      // RED: current code emits 9 fake component_ready events every 4s
      let eventCount = 0;
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 1500);
      });

      await Promise.race([
        (async () => {
          try {
            while (eventCount < 5) {
              const { done } = await reader.read();
              if (done) break;
              eventCount++;
            }
          } catch {}
        })(),
        timeout,
      ]);

      expect(eventCount).toBe(0); // Should NOT emit fake events
      reader.cancel();
    });
  });
});

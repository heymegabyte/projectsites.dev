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
    it('should emit honest not_provisioned, not timer-driven fake progress', async () => {
      const stream = buildSwarmSseStream(mockEnv, 'test-site', null);
      const reader = stream.getReader();

      let eventCount = 0;
      let lastEventText = '';
      try {
        // Read all events from the stream (should be exactly 1, then close)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          eventCount++;
          lastEventText = new TextDecoder().decode(value);
        }
      } catch {}

      // HONEST: should emit exactly 1 honest event (not_provisioned), close immediately
      expect(eventCount).toBe(1);
      expect(lastEventText).toContain('not_provisioned');
      expect(lastEventText).not.toContain('agent_started');
      expect(lastEventText).not.toContain('file_emitted');
      reader.cancel();
    });
  });

  describe('buildProgressiveSseStream', () => {
    it('should emit honest not_provisioned, not timer-driven component_ready', async () => {
      const stream = buildProgressiveSseStream(mockEnv, 'test-site');
      const reader = stream.getReader();

      let eventCount = 0;
      let lastEventText = '';
      try {
        // Read all events from the stream (should be exactly 1, then close)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          eventCount++;
          lastEventText = new TextDecoder().decode(value);
        }
      } catch {}

      // HONEST: should emit exactly 1 honest event (not_provisioned), close immediately
      expect(eventCount).toBe(1);
      expect(lastEventText).toContain('not_provisioned');
      expect(lastEventText).not.toContain('component_ready');
      reader.cancel();
    });
  });
});

/**
 * ProjectSites AI provider — machine-principal auth contract (fire-56).
 *
 * The worker's `/api/bolt/chat/completions` gate requires an AUTHENTICATED
 * principal in production: the fork's server-side chat fetch authenticates as a
 * machine principal by sending the provisioned `PS_BOLT_SERVICE_TOKEN` as its
 * Bearer (the AI SDK emits `apiKey` as `Authorization: Bearer …`). The
 * `x-bolt-origin-check` marker stays as a dev-mode routing hint only — it must
 * never be the thing that grants access.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

/*
 * The real BaseProvider drags the full provider registry into the module graph
 * (circular under vitest); the ProjectSites provider only EXTENDS it and calls
 * no base methods inside getModelInstance, so a bare class stands in.
 */
vi.mock('~/lib/modules/llm/base-provider', () => ({
  BaseProvider: class {},
}));

import { createOpenAI } from '@ai-sdk/openai';
import ProjectsitesAiProvider from './projectsites-ai';

const mockCreateOpenAI = createOpenAI as unknown as ReturnType<typeof vi.fn>;

function getInstance(serverEnv?: Record<string, string>) {
  const provider = new ProjectsitesAiProvider();
  return provider.getModelInstance({
    model: 'deepseek-chat',
    serverEnv: serverEnv as unknown as Parameters<ProjectsitesAiProvider['getModelInstance']>[0]['serverEnv'],
  });
}

describe('ProjectsitesAiProvider auth wiring (fire-56)', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('sends the provisioned PS_BOLT_SERVICE_TOKEN as the Bearer apiKey (machine principal)', () => {
    getInstance({ PS_BOLT_SERVICE_TOKEN: 'svc-tok-9' });

    expect(mockCreateOpenAI).toHaveBeenCalledTimes(1);

    const config = mockCreateOpenAI.mock.calls[0][0] as {
      apiKey: string;
      headers: Record<string, string>;
    };
    expect(config.apiKey).toBe('svc-tok-9');

    // The marker stays as a routing hint for the worker's DEV allowance only.
    expect(config.headers['x-bolt-origin-check']).toBe('bolt-iframe');
  });

  it('falls back to the ps-internal placeholder when no token is provisioned (local dev)', () => {
    getInstance({});

    const config = mockCreateOpenAI.mock.calls[0][0] as { apiKey: string };
    expect(config.apiKey).toBe('ps-internal');
  });

  it('defaults the base URL to the workers.dev /api/bolt mount and honors PS_BOLT_AI_ENDPOINT', () => {
    getInstance({});
    expect((mockCreateOpenAI.mock.calls[0][0] as { baseURL: string }).baseURL).toBe(
      'https://project-sites.manhattan.workers.dev/api/bolt',
    );

    getInstance({ PS_BOLT_AI_ENDPOINT: 'https://override.example/api/bolt' });
    expect((mockCreateOpenAI.mock.calls[1][0] as { baseURL: string }).baseURL).toBe(
      'https://override.example/api/bolt',
    );
  });
});

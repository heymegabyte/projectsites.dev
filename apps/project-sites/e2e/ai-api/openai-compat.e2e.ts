/**
 * @file openai-compat.e2e.ts
 * @description OpenAI-compatible public API acceptance tests — campaign lane-4.
 *              Goes GREEN when §7 of CAMPAIGN-cf-native-ai.md ships.
 *              Prod-suite only (*.e2e.ts) — RED on main is the intended deliverable.
 *              Auth: E2E_API_KEY env (skip-with-message when unset).
 *              Target: ${PROD_URL ?? 'https://project-sites.manhattan.workers.dev'}
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://project-sites.manhattan.workers.dev';
const E2E_API_KEY = process.env.E2E_V1_API_KEY ?? process.env.E2E_API_KEY;

// Virtual model IDs that MUST appear in /v1/models per §7 campaign spec
const REQUIRED_MODEL_IDS = [
  'projectsites-auto',
  'projectsites-fast',
  'projectsites-balanced',
  'projectsites-premium',
] as const;

test.describe('OpenAI-compatible API (campaign lane-4, §7)', () => {
  test.beforeEach(({}, testInfo) => {
    if (!E2E_API_KEY) {
      testInfo.skip();
      console.log('E2E_API_KEY not set — skipping prod auth tests');
    }
  });

  // ─── 1. GET /v1/models ────────────────────────────────────────────────────

  test('GET /v1/models returns OpenAI-schema list with virtual model IDs', async ({ request }) => {
    const resp = await request.get(`${PROD_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${E2E_API_KEY}` },
    });

    expect(resp.status(), 'GET /v1/models should return 200').toBe(200);

    const body = await resp.json();

    // Top-level OpenAI shape
    expect(body).toHaveProperty('object', 'list');
    expect(Array.isArray(body.data), '`data` must be an array').toBe(true);

    // Every model entry must have required fields
    for (const model of body.data as Record<string, unknown>[]) {
      expect(typeof model.id, `model.id must be string (got ${JSON.stringify(model)})`).toBe('string');
      expect(model.object, `model.object must be "model"`).toBe('model');
    }

    // All four virtual IDs must be present
    const ids: string[] = body.data.map((m: { id: string }) => m.id);
    for (const required of REQUIRED_MODEL_IDS) {
      expect(ids, `Virtual model "${required}" must be in /v1/models`).toContain(required);
    }
  });

  // ─── 2. POST /v1/chat/completions (non-streamed) ─────────────────────────

  test('POST /v1/chat/completions (non-streamed) returns OpenAI chat.completion shape', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/chat/completions`, {
      headers: {
        Authorization: `Bearer ${E2E_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        stream: false,
      },
    });

    expect(resp.status(), 'non-streamed chat/completions should return 200').toBe(200);

    const body = await resp.json();

    // Top-level shape
    expect(typeof body.id, 'response must have string id').toBe('string');
    expect(body.id.length, 'response id must be non-empty').toBeGreaterThan(0);
    expect(body.object, 'object must be "chat.completion"').toBe('chat.completion');

    // choices array
    expect(Array.isArray(body.choices), 'choices must be an array').toBe(true);
    expect(body.choices.length, 'at least one choice').toBeGreaterThan(0);

    const choice = body.choices[0] as {
      message: { role: string; content: string };
      finish_reason: string;
    };
    expect(choice.message.role, 'choice.message.role must be "assistant"').toBe('assistant');
    expect(typeof choice.message.content, 'choice.message.content must be string').toBe('string');
    expect(choice.message.content.length, 'content must be non-empty').toBeGreaterThan(0);
    expect(typeof choice.finish_reason, 'finish_reason must be string').toBe('string');

    // usage block
    expect(body).toHaveProperty('usage');
    const usage = body.usage as {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    expect(typeof usage.prompt_tokens, 'usage.prompt_tokens must be number').toBe('number');
    expect(typeof usage.completion_tokens, 'usage.completion_tokens must be number').toBe('number');
    expect(typeof usage.total_tokens, 'usage.total_tokens must be number').toBe('number');
    expect(usage.total_tokens, 'total_tokens must equal prompt+completion').toBe(
      usage.prompt_tokens + usage.completion_tokens,
    );
  });

  // ─── 3. POST /v1/chat/completions (streamed) ─────────────────────────────

  test('POST /v1/chat/completions (streamed) returns SSE with consistent id and [DONE]', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/chat/completions`, {
      headers: {
        Authorization: `Bearer ${E2E_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      data: {
        model: 'projectsites-fast',
        messages: [{ role: 'user', content: 'Count to three, one number per word.' }],
        stream: true,
      },
    });

    expect(resp.status(), 'streamed chat/completions should return 200').toBe(200);

    const contentType = resp.headers()['content-type'] ?? '';
    expect(
      contentType.includes('text/event-stream'),
      `Content-Type must include text/event-stream (got: ${contentType})`,
    ).toBe(true);

    const body = await resp.text();
    const lines = body.split('\n');

    // Collect data: lines
    const dataLines = lines
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim());

    // Must contain at least one data line
    expect(dataLines.length, 'stream must emit at least one data: line').toBeGreaterThan(0);

    // Terminal [DONE] marker must be present
    const doneIndex = dataLines.indexOf('[DONE]');
    expect(doneIndex, 'stream must end with data: [DONE]').toBeGreaterThan(-1);
    expect(doneIndex, '[DONE] must be the LAST data line').toBe(dataLines.length - 1);

    // All non-DONE lines must be valid JSON chunks
    const chunkLines = dataLines.slice(0, doneIndex);
    expect(chunkLines.length, 'there must be at least one chunk before [DONE]').toBeGreaterThan(0);

    let firstId: string | undefined;
    for (const raw of chunkLines) {
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(raw);
      } catch {
        throw new Error(`Chunk is not valid JSON: ${raw}`);
      }

      // All chunks must have the same id (consistent streaming ID)
      expect(typeof chunk.id, 'chunk.id must be string').toBe('string');
      if (firstId === undefined) {
        firstId = chunk.id as string;
      } else {
        expect(chunk.id, 'all chunks must share the same id').toBe(firstId);
      }

      expect(chunk.object, 'chunk.object must be "chat.completion.chunk"').toBe(
        'chat.completion.chunk',
      );

      // choices array with delta
      expect(Array.isArray(chunk.choices), 'chunk.choices must be an array').toBe(true);
    }
  });

  // ─── 4. Invalid / missing API key → 401 OpenAI-shaped error ─────────────

  test('POST /v1/chat/completions with bad key returns 401 with OpenAI error shape', async ({
    request,
  }) => {
    const resp = await request.post(`${PROD_URL}/v1/chat/completions`, {
      headers: {
        Authorization: 'Bearer psk_totally_invalid_key_xxxxxxxxxxxxxxxxxxxxxx',
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(resp.status(), 'bad key must return 401').toBe(401);

    const body = await resp.json();
    // OpenAI error envelope: { error: { message, type, ... } }
    expect(body).toHaveProperty('error');
    const error = body.error as Record<string, unknown>;
    expect(typeof error.message, 'error.message must be a string').toBe('string');
    expect(error.message.length, 'error.message must be non-empty').toBeGreaterThan(0);
  });

  test('GET /v1/models with no Authorization header returns 401', async ({ request }) => {
    const resp = await request.get(`${PROD_URL}/v1/models`);
    expect(resp.status(), 'missing auth must return 401').toBe(401);

    const body = await resp.json();
    expect(body).toHaveProperty('error');
  });
});

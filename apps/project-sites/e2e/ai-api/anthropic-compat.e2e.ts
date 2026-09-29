/**
 * @file anthropic-compat.e2e.ts
 * @description Anthropic-compatible public API acceptance tests — campaign lane-4.
 *              Goes GREEN when §7 of CAMPAIGN-cf-native-ai.md ships.
 *              Prod-suite only (*.e2e.ts) — RED on main is the intended deliverable.
 *              Auth: E2E_API_KEY env (skip-with-message when unset).
 *              Target: ${PROD_URL ?? 'https://project-sites.manhattan.workers.dev'}
 */

import { test, expect } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://project-sites.manhattan.workers.dev';
const E2E_API_KEY = process.env.E2E_API_KEY;

// Minimum Anthropic version header required by protocol
const ANTHROPIC_VERSION = '2023-06-01';

test.describe('Anthropic-compatible API (campaign lane-4, §7)', () => {
  test.beforeEach(({}, testInfo) => {
    if (!E2E_API_KEY) {
      testInfo.skip();
      console.log('E2E_API_KEY not set — skipping prod auth tests');
    }
  });

  // ─── 1. POST /v1/messages (non-streamed) ─────────────────────────────────

  test('POST /v1/messages (non-streamed) returns Anthropic Message shape', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages`, {
      headers: {
        'x-api-key': E2E_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      },
    });

    expect(resp.status(), 'non-streamed /v1/messages should return 200').toBe(200);

    const body = await resp.json();

    // Top-level shape per Anthropic docs
    expect(typeof body.id, 'response must have string id').toBe('string');
    expect(body.id.length, 'id must be non-empty').toBeGreaterThan(0);
    expect(body.type, 'type must be "message"').toBe('message');
    expect(body.role, 'role must be "assistant"').toBe('assistant');

    // content block array
    expect(Array.isArray(body.content), 'content must be an array').toBe(true);
    expect(body.content.length, 'content must have at least one block').toBeGreaterThan(0);

    const block = body.content[0] as { type: string; text: string };
    expect(block.type, 'first content block must have type "text"').toBe('text');
    expect(typeof block.text, 'text block must have string text').toBe('string');
    expect(block.text.length, 'text must be non-empty').toBeGreaterThan(0);

    // stop_reason
    expect(typeof body.stop_reason, 'stop_reason must be string').toBe('string');
    expect(body.stop_reason.length, 'stop_reason must be non-empty').toBeGreaterThan(0);

    // usage block
    expect(body).toHaveProperty('usage');
    const usage = body.usage as { input_tokens: number; output_tokens: number };
    expect(typeof usage.input_tokens, 'usage.input_tokens must be number').toBe('number');
    expect(typeof usage.output_tokens, 'usage.output_tokens must be number').toBe('number');
    expect(usage.input_tokens, 'input_tokens must be positive').toBeGreaterThan(0);
    expect(usage.output_tokens, 'output_tokens must be positive').toBeGreaterThan(0);
  });

  // ─── 2. POST /v1/messages (streamed) ─────────────────────────────────────

  test('POST /v1/messages (streamed) emits named SSE events with one terminal stop', async ({
    request,
  }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages`, {
      headers: {
        'x-api-key': E2E_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      data: {
        model: 'projectsites-fast',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Count to three, one word per response.' }],
        stream: true,
      },
    });

    expect(resp.status(), 'streamed /v1/messages should return 200').toBe(200);

    const contentType = resp.headers()['content-type'] ?? '';
    expect(
      contentType.includes('text/event-stream'),
      `Content-Type must include text/event-stream (got: ${contentType})`,
    ).toBe(true);

    const body = await resp.text();
    const lines = body.split('\n');

    // Parse event: / data: pairs
    const events: Array<{ event: string; data: string }> = [];
    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        events.push({ event: currentEvent, data: line.slice(6).trim() });
        currentEvent = '';
      }
    }

    const eventNames = events.map((e) => e.event);

    // message_start MUST be first
    expect(eventNames[0], 'first event must be message_start').toBe('message_start');

    // At least one content_block_delta
    expect(
      eventNames.some((n) => n === 'content_block_delta'),
      'stream must contain content_block_delta events',
    ).toBe(true);

    // Exactly ONE message_stop (terminal — not duplicated)
    const stopCount = eventNames.filter((n) => n === 'message_stop').length;
    expect(stopCount, 'stream must have exactly one message_stop').toBe(1);

    // message_stop must be the last event
    const lastEventName = eventNames[eventNames.length - 1];
    expect(lastEventName, 'last event must be message_stop').toBe('message_stop');

    // All data: lines that are not empty must be valid JSON
    for (const ev of events) {
      if (ev.data && ev.data !== '') {
        try {
          JSON.parse(ev.data);
        } catch {
          throw new Error(`Non-JSON data in event "${ev.event}": ${ev.data}`);
        }
      }
    }

    // message_start data must contain an id
    const startEv = events.find((e) => e.event === 'message_start');
    if (startEv && startEv.data) {
      const startData = JSON.parse(startEv.data) as { message?: { id?: string } };
      const msgId = startData?.message?.id;
      expect(typeof msgId, 'message_start.message.id must be a string').toBe('string');
      expect((msgId as string).length, 'message_start id must be non-empty').toBeGreaterThan(0);
    }
  });

  // ─── 3. POST /v1/messages/count_tokens ───────────────────────────────────

  test('POST /v1/messages/count_tokens returns { input_tokens: number }', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages/count_tokens`, {
      headers: {
        'x-api-key': E2E_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        messages: [
          { role: 'user', content: 'How many tokens is this short message?' },
        ],
      },
    });

    expect(resp.status(), '/v1/messages/count_tokens should return 200').toBe(200);

    const body = await resp.json();
    expect(body).toHaveProperty('input_tokens');
    expect(typeof body.input_tokens, 'input_tokens must be a number').toBe('number');
    expect(body.input_tokens, 'input_tokens must be a positive integer').toBeGreaterThan(0);

    // Must NOT contain output_tokens (this is a count endpoint, not a generation)
    expect(body).not.toHaveProperty('output_tokens');
  });

  // ─── 4. Missing anthropic-version header → 400 ───────────────────────────

  test('POST /v1/messages without anthropic-version header returns 400', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages`, {
      headers: {
        'x-api-key': E2E_API_KEY!,
        // intentionally omitting anthropic-version
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    // Anthropic protocol: missing/invalid version → 400 Bad Request
    expect(
      resp.status(),
      'missing anthropic-version must return 400',
    ).toBe(400);

    const body = await resp.json();
    // Must return some error shape (type/message)
    const hasError =
      typeof body.type === 'string' || typeof body.error === 'object' || typeof body.message === 'string';
    expect(hasError, 'response body must contain an error indicator').toBe(true);
  });

  // ─── 5. Invalid / missing API key → 401 ──────────────────────────────────

  test('POST /v1/messages with bad x-api-key returns 401', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages`, {
      headers: {
        'x-api-key': 'psk_totally_invalid_key_xxxxxxxxxxxxxxxxxxxxxx',
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(resp.status(), 'bad key must return 401').toBe(401);

    const body = await resp.json();
    const hasError =
      typeof body.type === 'string' || typeof body.error === 'object' || typeof body.message === 'string';
    expect(hasError, 'response body must contain an error indicator').toBe(true);
  });

  test('POST /v1/messages/count_tokens with no auth returns 401', async ({ request }) => {
    const resp = await request.post(`${PROD_URL}/v1/messages/count_tokens`, {
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'projectsites-fast',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(resp.status(), 'unauthenticated count_tokens must return 401').toBe(401);
  });
});

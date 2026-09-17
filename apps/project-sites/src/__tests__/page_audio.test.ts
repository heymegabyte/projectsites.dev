import { getOrCreatePageAudio } from '../services/page_audio';
import type { Env } from '../types/env';

/**
 * page-audio resilience + observability contract. The "Listen to this page" pipeline
 * (summarize → MeloTTS WAV → R2) must NEVER throw to the caller (the widget degrades to on-device
 * speechSynthesis) AND must LOG a structured signal when it fails — the empty catch previously
 * swallowed a FLEET-WIDE Workers AI MeloTTS outage (`AiError 3043`) with zero observability.
 */

// Minimal fake env: R2 cache miss (head→null), AI.run behaviour supplied per test.
const makeEnv = (aiRun: (model: string, input: unknown) => unknown): Env =>
  ({
    AI: { run: (m: string, i: unknown) => Promise.resolve(aiRun(m, i)) },
    SITES_BUCKET: {
      head: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve({}),
    },
    DB: {},
  }) as unknown as Env;

const ARGS = {
  slug: 'demo-site',
  route: '/',
  text: 'A lovely neighborhood spot serving great food.',
};

describe('getOrCreatePageAudio — fail-soft + observable', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('TTS outage (MeloTTS throws) → fail-soft {audioUrl:null}, no throw, logs generate_failed', async () => {
    const env = makeEnv((model) => {
      if (model.includes('llama')) return { response: 'A warm spoken summary of the business.' };
      throw new Error('AiError: Internal server error (3043)'); // MeloTTS down
    });
    const r = await getOrCreatePageAudio(env, ARGS);
    expect(r.audioUrl).toBeNull();
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('page_audio.generate_failed');
    expect(logged).toContain('3043');
    expect(logged).toContain('demo-site');
  });

  it('empty summary → fail-soft {audioUrl:null}, logs summary_empty', async () => {
    const env = makeEnv((model) => (model.includes('llama') ? { response: '' } : { audio: 'x' }));
    const r = await getOrCreatePageAudio(env, ARGS);
    expect(r.audioUrl).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'page_audio.summary_empty',
    );
  });

  it('happy path (summary + WAV) → returns an audioUrl, no warn', async () => {
    const env = makeEnv((model) =>
      model.includes('llama')
        ? { response: 'A warm spoken summary.' }
        : { audio: Buffer.from('RIFFwav').toString('base64') },
    );
    const r = await getOrCreatePageAudio(env, ARGS);
    expect(r.audioUrl).toContain('/api/page-audio/demo-site/a/');
    expect(warn).not.toHaveBeenCalled();
  });
});

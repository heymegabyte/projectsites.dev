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

  it('ElevenLabs preferred when ELEVENLABS_API_KEY set → uses ElevenLabs, stores audio/mpeg, MeloTTS NOT called', async () => {
    // ElevenLabs returns MP3 bytes; MeloTTS (env.AI.run for the TTS model) must NOT be hit.
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(new Uint8Array(1024), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      );
    // Capture the content-type of the AUDIO object put (the `.wav` key), not the `.txt` sidecar.
    let audioContentType: string | undefined;
    const env = {
      AI: {
        run: (model: string) => {
          if (model.includes('llama')) return Promise.resolve({ response: 'A warm spoken summary.' });
          throw new Error('MeloTTS must not be called when ElevenLabs succeeds');
        },
      },
      ELEVENLABS_API_KEY: 'test-key',
      SITES_BUCKET: {
        head: () => Promise.resolve(null),
        get: () => Promise.resolve(null),
        put: (key: string, _v: unknown, opts?: { httpMetadata?: { contentType?: string } }) => {
          if (key.endsWith('.wav')) audioContentType = opts?.httpMetadata?.contentType;
          return Promise.resolve({});
        },
      },
      DB: {},
    } as unknown as Env;
    const r = await getOrCreatePageAudio(env, ARGS);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api.elevenlabs.io/v1/text-to-speech/'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(audioContentType).toBe('audio/mpeg');
    expect(r.audioUrl).toContain('/api/page-audio/demo-site/a/');
    fetchSpy.mockRestore();
  });

  it('ElevenLabs faults → falls back to MeloTTS (no throw, audio still produced)', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('rate limited', { status: 429 }));
    const env = {
      AI: {
        run: (model: string) =>
          Promise.resolve(
            model.includes('llama')
              ? { response: 'A warm spoken summary.' }
              : { audio: Buffer.from('RIFFwav').toString('base64') },
          ),
      },
      ELEVENLABS_API_KEY: 'test-key',
      SITES_BUCKET: {
        head: () => Promise.resolve(null),
        get: () => Promise.resolve(null),
        put: () => Promise.resolve({}),
      },
      DB: {},
    } as unknown as Env;
    const r = await getOrCreatePageAudio(env, ARGS);
    expect(r.audioUrl).toContain('/api/page-audio/demo-site/a/'); // MeloTTS fallback produced audio
    fetchSpy.mockRestore();
  });
});

import {
  redactStreamSecrets,
  stripControlChars,
  prepareBuildLogLines,
  isBuildLogNoise,
  detectBuildLlmDegraded,
  MAX_LINES_PER_CALL,
  MAX_LINE_CHARS,
} from '../services/build_log';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

describe('build_log — redactStreamSecrets', () => {
  it('masks KEY=value / KEY: value secret assignments', () => {
    expect(redactStreamSecrets('export OPENAI_API_KEY=sk-abcdef123456')).toBe(
      'export OPENAI_API_KEY=***REDACTED***',
    );
    expect(redactStreamSecrets('AUTH_TOKEN: deadbeefcafebabe')).toBe('AUTH_TOKEN: ***REDACTED***');
    expect(redactStreamSecrets('PASSWORD=hunter2')).toBe('PASSWORD=***REDACTED***');
  });

  it('masks provider key formats anywhere in the line', () => {
    expect(redactStreamSecrets('using sk-proj-ABCDEFGHIJ to call openai')).toContain(
      'sk-***REDACTED***',
    );
    expect(redactStreamSecrets('aws key AKIA1234567890ABCD found')).toContain('AKIA***REDACTED***');
    expect(redactStreamSecrets('posthog phc_0123456789abcdef0123')).toContain('phc_***REDACTED***');
    expect(redactStreamSecrets('resend re_0123456789ab')).toContain('re_***REDACTED***');
    expect(redactStreamSecrets('Authorization: Bearer abcdefghij12345')).toContain(
      'Bearer ***REDACTED***',
    );
  });

  it('leaves benign build output untouched', () => {
    const benign = 'writing src/components/Hero.tsx (2.4 KB)';
    expect(redactStreamSecrets(benign)).toBe(benign);
    expect(redactStreamSecrets('npm run build → 19 routes / 217 tokens')).toBe(
      'npm run build → 19 routes / 217 tokens',
    );
  });
});

describe('build_log — prepareBuildLogLines', () => {
  it('drops non-strings, blanks, and trims trailing whitespace', () => {
    expect(prepareBuildLogLines(['  writing App.tsx  ', '', 42, null, '   ', 'done'])).toEqual([
      'writing App.tsx',
      'done',
    ]);
  });

  it('redacts every line', () => {
    expect(prepareBuildLogLines(['TOKEN=sk-supersecret1', 'ok'])).toEqual([
      'TOKEN=***REDACTED***',
      'ok',
    ]);
  });

  it('returns [] for a non-array / empty payload (never throws)', () => {
    expect(prepareBuildLogLines(undefined)).toEqual([]);
    expect(prepareBuildLogLines('not an array')).toEqual([]);
    expect(prepareBuildLogLines({})).toEqual([]);
    expect(prepareBuildLogLines([])).toEqual([]);
  });

  it('caps the batch at MAX_LINES_PER_CALL (unbounded-write guard)', () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = prepareBuildLogLines(many);
    expect(out).toHaveLength(MAX_LINES_PER_CALL);
    expect(out[0]).toBe('line 0');
    expect(out[MAX_LINES_PER_CALL - 1]).toBe(`line ${MAX_LINES_PER_CALL - 1}`);
  });

  it('caps each line at MAX_LINE_CHARS', () => {
    const [line] = prepareBuildLogLines(['x'.repeat(5000)]);
    expect(line).toHaveLength(MAX_LINE_CHARS);
  });

  it('drops Claude Code control-plane + provider-transport NOISE (trust-building theater)', () => {
    // Ground truth 2026-09-16: 42/43 streamed rows were this exact noise (a dead DeepSeek
    // balance 402'd every build), so the /waiting terminal showed scary infra errors, not a
    // build. The filter keeps the theater clean: real narration passes, control-plane noise drops.
    const raw = [
      'API Error: 402 Insufficient Balance',
      '[claude-code:unrecognized_model] {"model":"deepseek-chat","query_source":"generate_session_title"}',
      '"deepseek-chat" isn\'t described by this version\'s model catalog; map it with behavesAs on a modelPicker row',
      'writing src/components/Hero.tsx (2.4 KB)', // real work — MUST survive
      'created 12 sections, running npm build', // real work — MUST survive
    ];
    expect(prepareBuildLogLines(raw)).toEqual([
      'writing src/components/Hero.tsx (2.4 KB)',
      'created 12 sections, running npm build',
    ]);
  });
});

describe('build_log — isBuildLogNoise', () => {
  it('flags Claude Code internal control-plane lines', () => {
    expect(isBuildLogNoise('[claude-code:unrecognized_model] {"model":"deepseek-chat"}')).toBe(
      true,
    );
    expect(isBuildLogNoise('foo unrecognized_model bar')).toBe(true);
    expect(isBuildLogNoise('query_source":"generate_session_title"')).toBe(true);
    expect(isBuildLogNoise("isn't described by this version's model catalog")).toBe(true);
    expect(isBuildLogNoise('map it with behavesAs on a modelPicker row')).toBe(true);
  });

  it('flags provider/transport error lines that would scare an owner', () => {
    expect(isBuildLogNoise('API Error: 402 Insufficient Balance')).toBe(true);
    expect(isBuildLogNoise('API Error: 429 Too Many Requests')).toBe(true);
    expect(isBuildLogNoise('the account has Insufficient Balance')).toBe(true);
  });

  it('does NOT flag real build narration or genuine build errors', () => {
    expect(isBuildLogNoise('writing src/components/Hero.tsx')).toBe(false);
    expect(isBuildLogNoise('npm run build → 19 routes')).toBe(false);
    // A REAL build error the owner benefits from (classifyLogLine colors it red) must survive.
    expect(isBuildLogNoise("Error: Cannot find module './Hero'")).toBe(false);
    expect(isBuildLogNoise('✓ created 12 sections')).toBe(false);
  });
});

describe('build_log — detectBuildLlmDegraded (make a dead build-LLM balance OBSERVABLE)', () => {
  // The EXACT strings ground truth showed in audit_logs on 2026-09-16 when DeepSeek's
  // balance was dead — every one is dropped as noise, so the ingest returns written:0.
  // detectBuildLlmDegraded scans the RAW (pre-filter) batch so the outage is logged, not
  // silently swallowed (graceful-degradation-hides-outages).
  it('flags the real production 402 / model-catalog failure strings with a stable signal', () => {
    expect(detectBuildLlmDegraded(['API Error: 402 Insufficient Balance'])).toEqual({
      degraded: true,
      signal: 'insufficient_balance',
    });
    expect(
      detectBuildLlmDegraded(['[claude-code:unrecognized_model] {"model":"deepseek-chat"}']),
    ).toEqual({
      degraded: true,
      signal: 'unrecognized_model',
    });
    expect(
      detectBuildLlmDegraded(['"deepseek-chat" isn\'t described by this version\'s model catalog']),
    ).toEqual({ degraded: true, signal: 'model_catalog' });
    expect(detectBuildLlmDegraded(['API Error: 429 Too Many Requests'])).toEqual({
      degraded: true,
      signal: 'api_429_rate_limited',
    });
  });

  it('returns the FIRST signal in a mixed batch (names the concrete cause)', () => {
    const raw = ['starting build', 'API Error: 402 Insufficient Balance', 'unrecognized_model'];
    expect(detectBuildLlmDegraded(raw)).toEqual({ degraded: true, signal: 'insufficient_balance' });
  });

  it('is NOT degraded for real narration, genuine build errors, or a non-array (fail-soft)', () => {
    expect(detectBuildLlmDegraded(['writing src/App.tsx', '✓ created 12 sections'])).toEqual({
      degraded: false,
    });
    // A genuine build error is NOT a build-LLM degradation — it must not mask as one.
    expect(detectBuildLlmDegraded(["Error: Cannot find module './Hero'"])).toEqual({
      degraded: false,
    });
    expect(detectBuildLlmDegraded(undefined)).toEqual({ degraded: false });
    expect(detectBuildLlmDegraded('not an array')).toEqual({ degraded: false });
    expect(detectBuildLlmDegraded([42, null, {}])).toEqual({ degraded: false });
  });

  it('every degraded line is ALSO dropped by isBuildLogNoise (owner never sees the scary error)', () => {
    for (const l of [
      'API Error: 402 Insufficient Balance',
      '[claude-code:unrecognized_model] {"model":"deepseek-chat"}',
      '"deepseek-chat" isn\'t described by this version\'s model catalog',
    ]) {
      // Both must hold: the owner never sees the scary line (isBuildLogNoise) AND we log
      // the outage (detectBuildLlmDegraded). Jest reports the array index on failure.
      expect({
        line: l,
        noise: isBuildLogNoise(l),
        degraded: detectBuildLlmDegraded([l]).degraded,
      }).toEqual({
        line: l,
        noise: true,
        degraded: true,
      });
    }
  });
});

describe('build_log — stripControlChars (ANSI / control-byte scrub for the /waiting terminal)', () => {
  it('strips ANSI colour + cursor escape sequences', () => {
    expect(stripControlChars(ESC + '[32m' + 'created Hero.tsx' + ESC + '[0m')).toBe('created Hero.tsx');
    expect(stripControlChars(ESC + '[2K' + ESC + '[1G' + 'installing deps')).toBe('installing deps');
  });

  it('collapses a carriage-return progress spinner to its final frame', () => {
    expect(stripControlChars('building' + CR + 'building.' + CR + 'built ok')).toBe('built ok');
  });

  it('keeps tabs + unicode, drops DEL and stray control bytes', () => {
    const TAB = String.fromCharCode(9);
    expect(stripControlChars('a' + TAB + 'b')).toBe('a' + TAB + 'b');
    expect(stripControlChars('rocket ' + String.fromCharCode(127) + 'go')).toBe('rocket go');
    expect(stripControlChars('plain clean line')).toBe('plain clean line');
  });
});

describe('build_log — prepareBuildLogLines strips ANSI BEFORE the noise filter', () => {
  it('renders a colour-wrapped build line as clean text', () => {
    expect(prepareBuildLogLines([ESC + '[36m' + 'writing src/App.tsx' + ESC + '[0m'])).toEqual([
      'writing src/App.tsx',
    ]);
  });

  it('still drops a colour-wrapped provider-transport error as noise (strip runs first)', () => {
    // ANSI-wrapped "API Error: 402" would EVADE the ^API Error noise regex if not stripped first.
    expect(
      prepareBuildLogLines([ESC + '[31m' + 'API Error: 402 Insufficient Balance' + ESC + '[0m']),
    ).toEqual([]);
  });
});

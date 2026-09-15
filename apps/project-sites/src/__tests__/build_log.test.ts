import {
  redactStreamSecrets,
  prepareBuildLogLines,
  MAX_LINES_PER_CALL,
  MAX_LINE_CHARS,
} from '../services/build_log';

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
    expect(redactStreamSecrets('posthog phc_0123456789abcdef0123')).toContain(
      'phc_***REDACTED***',
    );
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
    expect(
      prepareBuildLogLines(['  writing App.tsx  ', '', 42, null, '   ', 'done']),
    ).toEqual(['writing App.tsx', 'done']);
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
});

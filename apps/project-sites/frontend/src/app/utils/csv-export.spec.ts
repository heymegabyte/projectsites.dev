import { csvEscape, toCsv, downloadText } from './csv-export';

describe('csv-export util', () => {
  describe('csvEscape', () => {
    it('passes plain scalars through unquoted', () => {
      expect(csvEscape('pageview')).toBe('pageview');
      expect(csvEscape(42)).toBe('42');
      expect(csvEscape(0)).toBe('0');
      expect(csvEscape(false)).toBe('false');
    });

    it('renders null/undefined as an empty field (never the string "null")', () => {
      expect(csvEscape(null)).toBe('');
      expect(csvEscape(undefined)).toBe('');
    });

    it('quotes fields with comma / quote / newline and doubles inner quotes (RFC 4180)', () => {
      expect(csvEscape('a,b')).toBe('"a,b"');
      expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
      expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
      expect(csvEscape('c\rd')).toBe('"c\rd"');
    });

    it('serializes objects as compact JSON', () => {
      expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"'); // JSON has no comma here, but the quote triggers quoting
      expect(csvEscape({ a: 1, b: 2 })).toBe('"{""a"":1,""b"":2}"');
    });

    it('guards CSV formula injection (CWE-1236) on non-numeric leading = + - @', () => {
      expect(csvEscape('=1+1')).toBe("'=1+1");
      expect(csvEscape('+cmd')).toBe("'+cmd");
      expect(csvEscape('-cmd')).toBe("'-cmd");
      expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(csvEscape('=cmd,x')).toBe(`"'=cmd,x"`); // guarded THEN quoted for the comma
      // Plain numbers are data, not formulas — never munged into text.
      expect(csvEscape('-5')).toBe('-5');
      expect(csvEscape('+3.14')).toBe('+3.14');
      expect(csvEscape(-5)).toBe('-5');
    });
  });

  describe('toCsv', () => {
    it('emits a header row of the given columns, in order, then one row each', () => {
      const rows = [
        { event_type: 'pageview', path: '/', referrer: null },
        { event_type: 'click', path: '/pricing', referrer: 'https://google.com' },
      ];
      expect(toCsv(rows, ['event_type', 'path', 'referrer'])).toBe(
        'event_type,path,referrer\npageview,/,\nclick,/pricing,https://google.com\n',
      );
    });

    it('emits only the requested columns (ignores extra keys on the row)', () => {
      const rows = [{ a: 1, b: 2, secret: 'x' }];
      expect(toCsv(rows, ['a', 'b'])).toBe('a,b\n1,2\n');
    });

    it('returns the header alone (trailing newline) for empty rows', () => {
      expect(toCsv([], ['a', 'b'])).toBe('a,b\n');
    });

    it('escapes cells that would break the CSV grid', () => {
      const rows = [{ note: 'a,b', quote: 'he "said"' }];
      expect(toCsv(rows, ['note', 'quote'])).toBe('note,quote\n"a,b","he ""said"""\n');
    });
  });

  describe('downloadText', () => {
    it('is a no-op on empty text (never downloads a blank file)', () => {
      const createSpy = spyOn(URL, 'createObjectURL');
      downloadText('x.csv', '');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('builds a Blob + object URL + anchor, clicks it, then revokes the URL', () => {
      const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      const revokeSpy = spyOn(URL, 'revokeObjectURL');
      const anchor = document.createElement('a');
      const clickSpy = spyOn(anchor, 'click');
      spyOn(document, 'createElement').and.returnValue(anchor);

      downloadText('leads.csv', 'a,b\n1,2\n', 'text/csv;charset=utf-8');

      expect(createSpy).toHaveBeenCalled();
      expect(anchor.download).toBe('leads.csv');
      expect(anchor.href).toContain('blob:mock');
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
    });

    it('is a no-op when URL.createObjectURL is unavailable (SSR / non-DOM env)', () => {
      const orig = URL.createObjectURL;
      // Simulate a non-DOM env where createObjectURL isn't a function.
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = undefined;
      const createElSpy = spyOn(document, 'createElement');
      try {
        // Non-empty text would download if unguarded — the guard must return first.
        downloadText('x.csv', 'a,b\n1,2\n', 'text/csv;charset=utf-8');
        expect(createElSpy).not.toHaveBeenCalled();
      } finally {
        (URL as unknown as { createObjectURL: unknown }).createObjectURL = orig;
      }
    });
  });
});

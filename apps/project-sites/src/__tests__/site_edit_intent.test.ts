/**
 * Tests for the chat-to-edit intent core (flag `chat_to_edit`). Every case pins the embarrassingly-easy
 * contract (plain words → one confirmable typed edit) AND the safety contract (an edit can only target
 * an allowlisted surface; user content never becomes unsafe HTML/CSS).
 */
import {
  classifyEditRequest,
  validateLlmEditIntent,
  normalizeColor,
  type EditableSurface,
} from '../services/site_edit_intent.js';

const CAT: EditableSurface[] = [
  { key: 'contact.phone', kind: 'phone', label: 'Phone number' },
  { key: 'contact.email', kind: 'email', label: 'Email address' },
  { key: 'hours', kind: 'hours', label: 'Business hours' },
  { key: 'hero.headline', kind: 'text', label: 'Hero headline' },
  { key: 'theme.accent', kind: 'color', label: 'Accent color' },
  { key: 'hero.photo', kind: 'image', label: 'Hero photo' },
  { key: 'faq', kind: 'section', label: 'FAQ section' },
];

describe('normalizeColor', () => {
  it('accepts hex, functional, and allow-listed named colors', () => {
    expect(normalizeColor('#FF3366')).toBe('#ff3366');
    expect(normalizeColor('rgb(0, 229, 255)')).toBe('rgb(0, 229, 255)');
    expect(normalizeColor('Teal')).toBe('teal');
  });
  it('rejects anything that is not a real color (no arbitrary strings into CSS)', () => {
    expect(normalizeColor('javascript:alert(1)')).toBeNull();
    expect(normalizeColor('url(evil)')).toBeNull();
    expect(normalizeColor('')).toBeNull();
  });
});

describe('classifyEditRequest: fast-path matches', () => {
  it('phone', () => {
    const i = classifyEditRequest('Change my phone number to (212) 555-1212', CAT);
    expect(i.op).toBe('set_phone');
    expect(i.target).toBe('contact.phone');
    expect(i.value).toBe('(212) 555-1212');
    expect(i.reason).toBe('matched');
    expect(i.confirmPrompt).toMatch(/Phone number/);
  });
  it('email', () => {
    const i = classifyEditRequest('update the email to hi@shop.com', CAT);
    expect(i.op).toBe('set_email');
    expect(i.target).toBe('contact.email');
    expect(i.value).toBe('hi@shop.com');
  });
  it('headline text (strips wrapping quotes)', () => {
    const i = classifyEditRequest('make the headline say "Fresh Bread Daily"', CAT);
    expect(i.op).toBe('set_text');
    expect(i.target).toBe('hero.headline');
    expect(i.value).toBe('Fresh Bread Daily');
  });
  it('accent color — hex and named', () => {
    expect(classifyEditRequest('change my brand color to #ff3366', CAT).value).toBe('#ff3366');
    expect(classifyEditRequest('change my accent color to teal', CAT).value).toBe('teal');
  });
  it('swap image → needs the owner to upload (matched, needsClarification)', () => {
    const i = classifyEditRequest('swap the hero photo', CAT);
    expect(i.op).toBe('swap_image');
    expect(i.target).toBe('hero.photo');
    expect(i.value).toBeNull();
    expect(i.needsClarification).toBe(true);
    expect(i.reason).toBe('matched');
  });
  it('toggle section', () => {
    const i = classifyEditRequest('hide the FAQ section', CAT);
    expect(i.op).toBe('toggle_section');
    expect(i.target).toBe('faq');
  });
});

describe('classifyEditRequest: safety + clarification', () => {
  it('rejects HTML in a text value (no injection at the intent layer)', () => {
    const i = classifyEditRequest('make the headline say <script>alert(1)</script>', CAT);
    expect(i.reason).toBe('invalid_value');
    expect(i.value).toBeNull();
  });
  it('rejects a non-color color value', () => {
    expect(classifyEditRequest('change the accent color to javascript:void', CAT).reason).toBe('invalid_value');
  });
  it('empty input asks what to change', () => {
    const i = classifyEditRequest('   ', CAT);
    expect(i.reason).toBe('empty');
    expect(i.needsClarification).toBe(true);
  });
  it('unrecognized request offers examples', () => {
    const i = classifyEditRequest('asdf qwerty zzz', CAT);
    expect(i.op).toBe('unknown');
    expect(i.reason).toBe('unknown_op');
  });
  it('target_not_editable when the site exposes no surface of that kind', () => {
    const noColor = CAT.filter((s) => s.kind !== 'color');
    expect(classifyEditRequest('change the accent color to #fff', noColor).reason).toBe('target_not_editable');
  });
  it('ambiguous_target when two same-kind surfaces and no disambiguating keyword', () => {
    const twoText: EditableSurface[] = [
      { key: 'hero.headline', kind: 'text', label: 'Hero headline' },
      { key: 'about.body', kind: 'text', label: 'About body' },
    ];
    expect(classifyEditRequest('update the text to Hello there', twoText).reason).toBe('ambiguous_target');
  });
});

describe('validateLlmEditIntent: contract-first safety net', () => {
  it('accepts a well-formed proposal that targets an allowlisted surface', () => {
    const i = validateLlmEditIntent({ op: 'set_text', target: 'hero.headline', value: 'Hi there' }, CAT);
    expect(i.reason).toBe('matched');
    expect(i.value).toBe('Hi there');
  });
  it('rejects a target not in the catalog (never trust the model target)', () => {
    expect(validateLlmEditIntent({ op: 'set_text', target: 'hero.evil', value: 'x' }, CAT).reason).toBe('target_not_editable');
  });
  it('rejects an unknown/dangerous op', () => {
    expect(validateLlmEditIntent({ op: 'delete_everything', target: 'faq', value: null }, CAT).reason).toBe('unknown_op');
  });
  it('rejects an unsafe value even for a valid target', () => {
    expect(validateLlmEditIntent({ op: 'set_text', target: 'hero.headline', value: '<b>x</b>' }, CAT).reason).toBe('invalid_value');
    expect(validateLlmEditIntent({ op: 'set_color', target: 'theme.accent', value: '#zzz' }, CAT).reason).toBe('invalid_value');
  });
  it('tolerates malformed input without throwing', () => {
    expect(validateLlmEditIntent(null, CAT).reason).toBe('unknown_op');
    expect(validateLlmEditIntent({}, CAT).reason).toBe('unknown_op');
  });
});

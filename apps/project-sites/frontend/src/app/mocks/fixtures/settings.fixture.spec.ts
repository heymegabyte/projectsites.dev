import {
  aiSettingsFixture,
  teamFixture,
  orgEnvVarsFixture,
  orgSecurityFixture,
  type AiSettingsResponse,
  type TeamResponse,
  type OrgEnvVarsResponse,
  type OrgSecurityResponse,
} from './settings.fixture';
import { findFixture, toRegistryKey } from './index';

/**
 * settings.fixture — mock bodies for the admin Settings section's load-time reads. Each factory
 * is typed to the EXACT worker wire contract (traced to the handler) so the real endpoint is a
 * drop-in provider swap:
 *
 *   GET /sites/:id/ai-settings → { data: AiSettings }     (ai_settings/handlers.ts:80 — shared
 *                                                           with the Forms designer, fire-281 #34)
 *   GET /team                  → { data: { members, invites } } (ai_admin.ts:64)
 *   GET /env-vars              → { vars: EnvVar[] }        (env_vars.ts:152 — ?scope=org)
 *   GET /admin/security        → { data: OrgSecurityRow }  (org_security/handlers.ts:47)
 *
 * None are feature-flag-gated (membership-only), so the Settings section renders fully on
 * `?mock=1` with no flag flip. `state` variants: `empty` = the honest brand-new-project surface;
 * `populated`/`loading`/default = the rich believable set; `error` is handled by the interceptor.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('aiSettingsFixture (GET /sites/:id/ai-settings → { data: AiSettings })', () => {
  it('returns the worker envelope { data } with every field the three consumers read', () => {
    const res: AiSettingsResponse = aiSettingsFixture('populated', q());
    expect(res.data).toBeDefined();
    // Settings General reads these:
    expect('contact_email' in res.data).toBe(true);
    expect('reply_email' in res.data).toBe(true);
    expect('chat_system_prompt' in res.data).toBe(true);
    expect(typeof res.data.chat_system_prompt_default).toBe('string');
    expect(res.data.chat_system_prompt_default.length).toBeGreaterThan(0);
    expect(typeof res.data.allow_web_research).toBe('boolean');
    // AI-Chat tab reads enabled_mcps (always an array on the wire):
    expect(Array.isArray(res.data.enabled_mcps)).toBe(true);
    // Forms designer reads the router prompt + its default:
    expect('form_router_prompt' in res.data).toBe(true);
    expect(typeof res.data.form_router_prompt_default).toBe('string');
    expect(res.data.form_router_prompt_default.length).toBeGreaterThan(0);
  });

  it('populated → a configured persona (non-null prompts, a contact email, enabled MCPs)', () => {
    const { data } = aiSettingsFixture('populated', q());
    expect(data.chat_system_prompt).toBeTruthy();
    expect(data.contact_email).toBeTruthy();
    expect(data.enabled_mcps.length).toBeGreaterThan(0);
    expect(data.allow_web_research).toBe(true);
  });

  it('empty → the honest never-written surface (null prompts/email, defaults present, nothing enabled)', () => {
    const { data } = aiSettingsFixture('empty', q());
    expect(data.chat_system_prompt).toBeNull();
    expect(data.contact_email).toBeNull();
    expect(data.reply_email).toBeNull();
    expect(data.enabled_mcps).toEqual([]);
    expect(data.allow_web_research).toBe(false);
    // Defaults are STILL present even when unwritten (the "Improve with AI → load default" path).
    expect(data.chat_system_prompt_default.length).toBeGreaterThan(0);
    expect(data.form_router_prompt_default.length).toBeGreaterThan(0);
  });

  it('never aliases its mutable arrays/objects across calls (deep-copied per call)', () => {
    const a = aiSettingsFixture('populated', q());
    const b = aiSettingsFixture('populated', q());
    expect(a.data.enabled_mcps).not.toBe(b.data.enabled_mcps);
    a.data.enabled_mcps.push('tampered');
    expect(b.data.enabled_mcps).not.toContain('tampered');
  });

  it('is registered under the :param pattern GET /sites/:id/ai-settings (one body, every site id)', () => {
    const key = toRegistryKey('GET', '/api/sites/site-001/ai-settings').key;
    expect(key).toBe('GET /sites/site-001/ai-settings');
    const hit = findFixture(key);
    expect(hit).toBeDefined();
    // The shipped fixture resolves (has `data.chat_system_prompt_default`), and a DIFFERENT id too.
    const body = hit!('populated', q()) as AiSettingsResponse;
    expect(typeof body.data.chat_system_prompt_default).toBe('string');
    expect(findFixture(toRegistryKey('GET', '/api/sites/zzz/ai-settings').key)).toBeDefined();
  });
});

describe('teamFixture (GET /team → { data: { members, invites } })', () => {
  it('returns the worker envelope shape { data: { members, invites } }', () => {
    const res: TeamResponse = teamFixture('populated', q());
    expect(Array.isArray(res.data.members)).toBe(true);
    expect(Array.isArray(res.data.invites)).toBe(true);
  });

  it('populated → a multi-person team with exactly one owner + a pending invite', () => {
    const { members, invites } = teamFixture('populated', q()).data;
    expect(members.length).toBeGreaterThan(1);
    expect(members.filter((m) => m.role === 'owner').length).toBe(1);
    expect(invites.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(typeof m.email).toBe('string');
      expect(typeof m.role).toBe('string');
    }
  });

  it('empty → a lone owner + no invites (the honest brand-new-org surface)', () => {
    const { members, invites } = teamFixture('empty', q()).data;
    expect(members.length).toBe(1);
    expect(members[0].role).toBe('owner');
    expect(invites).toEqual([]);
  });

  it('is registered under the static key GET /team', () => {
    expect(toRegistryKey('GET', '/api/team').key).toBe('GET /team');
    expect(findFixture('GET /team')).toBeDefined();
  });
});

describe('orgEnvVarsFixture (GET /env-vars → { vars })', () => {
  it('returns the worker envelope shape { vars } (NOT { data })', () => {
    const res: OrgEnvVarsResponse = orgEnvVarsFixture('populated', q('scope=org'));
    expect(Array.isArray(res.vars)).toBe(true);
    // The component reads key + exposed_to_ai; both present + correctly typed on every row.
    for (const v of res.vars) {
      expect(typeof v.key).toBe('string');
      expect(typeof v.exposed_to_ai).toBe('boolean');
      expect(v.scope).toBe('org');
      // Plaintext is NEVER returned — only value_masked.
      expect('value' in v).toBe(false);
      expect(typeof v.value_masked).toBe('string');
    }
  });

  it('populated → a believable org set spanning secret + non-secret and exposed + withheld', () => {
    const { vars } = orgEnvVarsFixture('populated', q('scope=org'));
    expect(vars.length).toBeGreaterThan(1);
    expect(vars.some((v) => v.is_secret)).toBe(true);
    expect(vars.some((v) => !v.is_secret)).toBe(true);
    expect(vars.some((v) => v.exposed_to_ai)).toBe(true);
    expect(vars.some((v) => !v.exposed_to_ai)).toBe(true);
  });

  it('empty → { vars: [] } (the MCP tab renders its calm "no org AI vars yet" callout)', () => {
    expect(orgEnvVarsFixture('empty', q('scope=org')).vars).toEqual([]);
  });

  it('is registered under the static key GET /env-vars (query stripped before lookup)', () => {
    // The ?scope=org query is normalized away — the key is scope-agnostic.
    expect(toRegistryKey('GET', '/api/env-vars?scope=org').key).toBe('GET /env-vars');
    expect(findFixture('GET /env-vars')).toBeDefined();
  });
});

describe('orgSecurityFixture (GET /admin/security → { data: OrgSecurityRow })', () => {
  it('returns the worker envelope shape { data } with require_2fa as an INTEGER', () => {
    const res: OrgSecurityResponse = orgSecurityFixture('populated', q());
    expect(res.data).toBeDefined();
    // The wire carries 0/1 integers (the component coerces with !!).
    expect([0, 1]).toContain(res.data.require_2fa);
    expect(typeof res.data.session_hours).toBe('number');
    expect(typeof res.data.idle_minutes).toBe('number');
  });

  it('populated → a configured org (2FA required, a sign-in domain allowlist)', () => {
    const { data } = orgSecurityFixture('populated', q());
    expect(data.require_2fa).toBe(1);
    expect(data.allowed_domains).toBeTruthy();
  });

  it('empty → the worker DEFAULT row (session 168h, idle 60m, no allowlist, 2FA off)', () => {
    const { data } = orgSecurityFixture('empty', q());
    expect(data.session_hours).toBe(168);
    expect(data.idle_minutes).toBe(60);
    expect(data.allowed_domains).toBeNull();
    expect(data.require_2fa).toBe(0);
    expect(data.updated_at).toBeNull();
  });

  it('is registered under the static key GET /admin/security', () => {
    expect(toRegistryKey('GET', '/api/admin/security').key).toBe('GET /admin/security');
    expect(findFixture('GET /admin/security')).toBeDefined();
  });
});

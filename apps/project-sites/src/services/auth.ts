/**
 * @module auth
 * @description Passwordless authentication service for Project Sites.
 *
 * Supports two sign-in methods:
 *
 * | Method       | Flow                                        | Table          |
 * | ------------ | ------------------------------------------- | -------------- |
 * | Magic Link   | Email → click link → verify token hash      | `magic_links`  |
 * | Google OAuth | Redirect → consent → exchange code → user   | `oauth_states` |
 *
 * Sessions are stored in the `sessions` table with SHA-256 hashed tokens.
 * All database access uses Cloudflare D1 via parameterized SQL.
 *
 * @example
 * ```ts
 * import * as authService from '../services/auth.js';
 *
 * // Magic link flow
 * const { token, expires_at } = await authService.createMagicLink(env.DB, env, { email });
 * const { email } = await authService.verifyMagicLink(env.DB, { token });
 *
 * // Session management
 * const { token } = await authService.createSession(env.DB, userId);
 * const session = await authService.getSession(env.DB, token);
 * ```
 *
 * @packageDocumentation
 */

import {
  AUTH,
  DOMAINS,
  randomHex,
  sha256Hex,
  timingSafeEqual,
  type CreateMagicLink,
  type VerifyMagicLink,
  createMagicLinkSchema,
  verifyMagicLinkSchema,
  unauthorized,
  notFound,
  badRequest,
} from '@project-sites/shared';
import { z } from 'zod';
import { dbQuery, dbInsert, dbUpdate, dbExecute, dbQueryOne } from './db.js';
import { getEmailProvider } from '../platform/email-router.js';
import type { Env } from '../types/env.js';

/**
 * Send a transactional email via Amazon SES (primary), Listmonk, or SendGrid
 * (break-glass fallback). Resend was removed 2026-09-09 (Brian directive; SES is
 * the canonical provider).
 *
 * Rail order: SES (AWS creds + verified `SES_FROM_EMAIL`) → Listmonk → SendGrid.
 * Throws if no provider is configured.
 *
 * @param env  - Worker environment (needs SES creds, Listmonk, or `SENDGRID_API_KEY`).
 * @param opts - Email parameters (to, subject, html body).
 *
 * @example
 * ```ts
 * await sendEmail(env, {
 *   to: 'user@example.com',
 *   subject: 'Sign in to Project Sites',
 *   html: '<h1>Click here</h1>',
 * });
 * ```
 */
async function sendEmail(
  env: Env,
  opts: { to: string; subject: string; html: string },
): Promise<void> {
  // ADR-0019 Resend→SES migration: Amazon SES is the PRIMARY transactional rail
  // the moment it is configured (AWS creds + verified `SES_FROM_EMAIL`), routed
  // through the shared seam. Listmonk/SendGrid below remain the fallback rails
  // (Resend removed 2026-09-09) — progressive degradation by env presence, no flag.
  // Auth emails are sign-in/magic-link, so they route to SES (SES_KINDS).
  // try/catch for ADR-0019 parity with notifications.ts: an SES reject (sandbox
  // throttle, unverified recipient) must FALL THROUGH to the fallback rails —
  // the previous uncaught await aborted the whole chain and the magic-link
  // handler's fail-open catch turned it into a silent 200 with NO email sent.
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.SES_FROM_EMAIL) {
    try {
      await getEmailProvider(env).sendTransactional({
        kind: 'magic-link',
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      return;
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'auth',
          message: 'SES send failed, falling through to fallback rails',
          error: err instanceof Error ? err.message : String(err),
          to: opts.to,
        }),
      );
    }
  }

  // Listmonk fallback — self-hosted on CF, sends transactional via SMTP.
  if (env.LISTMONK_API_URL && env.LISTMONK_USERNAME && env.LISTMONK_PASSWORD) {
    try {
      const { ListmonkTransactionalProvider } = await import('./listmonk_email_provider.js');
      const provider = new ListmonkTransactionalProvider(
        env.LISTMONK_API_URL,
        env.LISTMONK_USERNAME,
        env.LISTMONK_PASSWORD,
      );
      await provider.sendTransactional({
        kind: 'magic-link',
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      return;
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'auth',
          message: 'Listmonk send failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  if (env.SENDGRID_API_KEY) {
    return sendViaSendGrid(env.SENDGRID_API_KEY, opts);
  }

  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'auth',
      message: 'No email provider configured (SES or SENDGRID_API_KEY)',
      to: opts.to,
    }),
  );
  throw badRequest('Email delivery is not configured. Please contact support.');
}

/** Send email via SendGrid v3 API. */
async function sendViaSendGrid(
  apiKey: string,
  opts: { to: string; subject: string; html: string },
): Promise<void> {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: 'noreply@projectsites.dev', name: 'Project Sites' },
      subject: opts.subject,
      content: [{ type: 'text/html', value: opts.html }],
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'auth',
        message: 'SendGrid API error',
        status: res.status,
        body: text.slice(0, 500),
        to: opts.to,
      }),
    );
    throw badRequest(`Failed to send email (status ${res.status}). Please try again.`);
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Email sent via SendGrid',
      to: opts.to,
    }),
  );
}

/**
 * Build styled HTML for the magic-link email.
 *
 * @param verifyUrl - Full URL the user clicks to verify (includes token).
 * @returns Complete HTML document string.
 */
function buildMagicLinkEmail(verifyUrl: string): string {
  const logoImg = 'https://public.megabyte.space/project-sites-logo.png';
  const year = new Date().getFullYear();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><meta name="x-apple-disable-message-reformatting"><title>Sign In</title></head>
<body style="margin:0;padding:0;background:transparent;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f0f4f8;-webkit-text-size-adjust:100%;line-height:1.6;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Sign in to Project Sites — your link expires in ${AUTH.MAGIC_LINK_EXPIRY_HOURS} hour(s).${'&nbsp;'.repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:transparent;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(160deg,#080820 0%,#0d0d2a 50%,#0a0a22 100%);border:1px solid rgba(0,212,255,0.08);border-radius:20px;max-width:600px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.5);">
<!-- Logo -->
<tr><td style="padding:32px 32px 0;text-align:center;">
  <a href="https://${DOMAINS.SITES_BASE}" style="text-decoration:none;">
    <img src="${logoImg}" alt="Project Sites" width="220" height="54" style="border:0;display:inline-block;max-width:220px;height:auto;" />
  </a>
</td></tr>
<!-- Divider -->
<tr><td style="padding:20px 32px 0;"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,0.2),rgba(124,58,237,0.15),transparent);"></div></td></tr>
<!-- Icon -->
<tr><td style="padding:28px 32px 0;text-align:center;">
  <div style="display:inline-block;width:56px;height:56px;background:linear-gradient(135deg,#00d4ff,#7c3aed);border-radius:16px;line-height:56px;text-align:center;">
    <span style="font-size:28px;color:#fff;">&#9889;</span>
  </div>
</td></tr>
<!-- Content -->
<tr><td style="padding:20px 32px;">
  <h1 style="color:#f0f4f8;font-size:22px;font-weight:800;text-align:center;margin:0 0 12px;letter-spacing:-0.3px;">Sign in to Project Sites</h1>
  <p style="color:#94a3b8;font-size:15px;text-align:center;line-height:1.7;margin:0 0 28px;">Click the button below to securely sign in. This link expires in <strong style="color:#e2e8f0;">${AUTH.MAGIC_LINK_EXPIRY_HOURS} hour(s)</strong>.</p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${verifyUrl}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#00d4ff 0%,#0ea5e9 50%,#7c3aed 100%);color:#fff;font-size:16px;font-weight:700;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(0,212,255,0.3);letter-spacing:0.3px;">Sign In Securely</a>
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(0,0,0,0.15);border-radius:12px;border:1px solid rgba(0,212,255,0.05);">
    <tr><td style="padding:14px 18px;">
      <p style="color:#64748b;font-size:12px;line-height:1.6;margin:0;">
        <strong style="color:#94a3b8;">Can't click the button?</strong> Copy and paste this URL into your browser:<br/>
        <a href="${verifyUrl}" style="color:#00d4ff;font-size:11px;word-break:break-all;text-decoration:none;">${verifyUrl}</a>
      </p>
    </td></tr>
  </table>
  <p style="color:#475569;font-size:12px;text-align:center;margin:20px 0 0;line-height:1.5;">If you didn't request this link, you can safely ignore this email. Your account is secure.</p>
</td></tr>
<!-- Footer -->
<tr><td style="padding:0 32px 28px;">
  <div style="padding-top:20px;border-top:1px solid rgba(0,212,255,0.06);text-align:center;">
    <span style="font-size:11px;color:rgba(148,163,184,0.3);">&copy; ${year} </span>
    <a href="https://megabyte.space" style="font-size:11px;color:rgba(148,163,184,0.4);text-decoration:none;">Megabyte Labs</a>
    <span style="font-size:11px;color:rgba(148,163,184,0.3);"> &middot; </span>
    <a href="https://${DOMAINS.SITES_BASE}" style="font-size:11px;color:#00d4ff;text-decoration:none;font-weight:600;">projectsites.dev</a>
  </div>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

/**
 * Create a magic link for passwordless email authentication.
 *
 * Generates a random token, stores its SHA-256 hash in D1, and sends the
 * plaintext token to the user's email via SendGrid.
 *
 * @param db    - D1Database binding.
 * @param env   - Worker environment.
 * @param input - Must include `email`; optionally `redirect_url`.
 * @returns The plaintext token (for tests) and expiry timestamp.
 *
 * @example
 * ```ts
 * const { expires_at } = await createMagicLink(env.DB, env, {
 *   email: 'brian@megabyte.space',
 *   redirect_url: 'https://projectsites.dev/',
 * });
 * ```
 */
export async function createMagicLink(
  db: D1Database,
  env: Env,
  input: CreateMagicLink,
): Promise<{ token: string; expires_at: string }> {
  const validated = createMagicLinkSchema.parse(input);

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(
    Date.now() + AUTH.MAGIC_LINK_EXPIRY_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // The magic_links row IS the credential — it MUST persist before we email a link
  // pointing at it. A bare await would IGNORE `{error}` and send a sign-in email whose
  // token has no DB row → the user clicks it, hits "invalid or expired link", and is
  // stuck. Throw on a dropped credential write (retryable 500) instead of mailing a
  // dead link. (The EMAIL send below is correctly best-effort — the row is the
  // credential; a failed email still leaves a usable row + the retry/E2E-peek seam.)
  const { error: linkError } = await dbInsert(db, 'magic_links', {
    id: crypto.randomUUID(),
    email: validated.email,
    token_hash: tokenHash,
    redirect_url: validated.redirect_url ?? null,
    expires_at: expiresAt,
    used: 0,
    deleted_at: null,
  });
  if (linkError) {
    throw new Error(`Failed to persist magic link for ${validated.email}: ${linkError}`);
  }

  // Build verify URL and send email
  const baseUrl = `https://${DOMAINS.SITES_BASE}`;
  const verifyUrl = `${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

  // Email is BEST-EFFORT (fail open) — the route + this fn's contract say so, but the
  // await was UNCAUGHT, so any provider error (SES sandbox reject, transient 5xx, an
  // unverified recipient) surfaced as a 500 on the login request. The magic_links row
  // is already persisted (it IS the credential), so on a send failure we log + fall
  // open: the caller still gets a 200 and can retry / the E2E peek seam still works.
  try {
    await sendEmail(env, {
      to: validated.email,
      subject: 'Sign in to Project Sites',
      html: buildMagicLinkEmail(verifyUrl),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'magic_link_email_send_failed',
        email: validated.email,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Magic link created',
      email: validated.email,
      expires_at: expiresAt,
    }),
  );
  return { token, expires_at: expiresAt };
}

/**
 * Verify a magic-link token.
 *
 * Hashes the incoming token, looks it up in D1, checks expiry, and marks
 * it as used. Returns the associated email and optional redirect URL.
 *
 * @param db    - D1Database binding.
 * @param input - Must include `token` (plaintext from email link).
 * @returns The email and redirect_url associated with the link.
 * @throws {unauthorized} If the token is invalid, expired, or already used.
 *
 * @example
 * ```ts
 * const { email, redirect_url } = await verifyMagicLink(env.DB, { token });
 * ```
 */
export async function verifyMagicLink(
  db: D1Database,
  input: VerifyMagicLink,
): Promise<{ email: string; redirect_url: string | null }> {
  const validated = verifyMagicLinkSchema.parse(input);
  const tokenHash = await sha256Hex(validated.token);

  const link = await dbQueryOne<{
    id: string;
    email: string;
    redirect_url: string | null;
    used: number;
    expires_at: string;
  }>(
    db,
    'SELECT id, email, redirect_url, used, expires_at FROM magic_links WHERE token_hash = ? AND used = 0',
    [tokenHash],
  );

  if (!link) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'Magic link verification failed: invalid or expired token',
      }),
    );
    throw unauthorized('Invalid or expired magic link');
  }

  if (new Date(link.expires_at) < new Date()) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'Magic link verification failed: expired',
        email: link.email,
      }),
    );
    throw unauthorized('Magic link has expired');
  }

  // Atomically CONSUME the single-use link — flip used 0→1 in one conditional write.
  // The old bare await swallowed `{error}` (a dropped write left the link `used=0` →
  // REPLAYABLE within its 24h expiry) AND the SELECT-`used=0`-then-UPDATE was a TOCTOU
  // race (two concurrent verifies both passed the SELECT before either marked it used
  // → two sessions from one link). The compare-and-swap (`WHERE id=? AND used=0` +
  // a changes check) makes consumption atomic + genuinely single-use.
  const { error: consumeError, changes } = await dbUpdate(
    db,
    'magic_links',
    { used: 1 },
    'id = ? AND used = 0',
    [link.id],
  );
  if (consumeError) {
    throw new Error(`Failed to consume magic link ${link.id}: ${consumeError}`);
  }
  if (changes === 0) {
    // A concurrent verify already consumed it (race/replay) — never mint a 2nd session.
    throw unauthorized('Magic link has already been used');
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Magic link verified',
      email: link.email,
    }),
  );
  return { email: link.email, redirect_url: link.redirect_url };
}

/**
 * Create a Google OAuth state token for CSRF protection.
 *
 * Generates a random state string, stores it in D1 with a 10-minute expiry,
 * and returns the full Google OAuth consent URL.
 *
 * @param db          - D1Database binding.
 * @param env         - Worker environment (needs `GOOGLE_CLIENT_ID`, `ENVIRONMENT`).
 * @param redirectUrl - Optional URL to redirect to after auth completes.
 * @returns The Google auth URL and the state token.
 *
 * @example
 * ```ts
 * const { authUrl, state } = await createGoogleOAuthState(env.DB, env);
 * return c.redirect(authUrl);
 * ```
 */
export async function createGoogleOAuthState(
  db: D1Database,
  env: Env,
  redirectUrl?: string,
): Promise<{ authUrl: string; state: string }> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw badRequest('Google OAuth is not configured. GOOGLE_CLIENT_ID secret is missing.');
  }

  const state = randomHex(32);

  // The state row is the CSRF credential the callback validates. A bare await would
  // IGNORE `{error}` and redirect the user to Google with a state that has no DB row →
  // they authenticate, return, and get "Invalid OAuth state" at the callback. Throw on
  // a dropped state write so the flow fails at initiation (retryable), not after login.
  const { error: stateError } = await dbInsert(db, 'oauth_states', {
    id: crypto.randomUUID(),
    state,
    provider: 'google',
    redirect_url: redirectUrl ?? null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    deleted_at: null,
  });
  if (stateError) {
    throw new Error(`Failed to persist Google OAuth state: ${stateError}`);
  }

  const callbackBase = `https://${DOMAINS.SITES_BASE}`;

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${callbackBase}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return {
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
  };
}

/**
 * Handle the Google OAuth callback.
 *
 * Validates the state token, exchanges the authorization code for an access
 * token, fetches the user's profile, and returns their info.
 *
 * @param db    - D1Database binding.
 * @param env   - Worker environment.
 * @param code  - Authorization code from Google.
 * @param state - State token for CSRF validation.
 * @returns User profile (email, display_name, avatar_url).
 * @throws {unauthorized} If state is invalid or expired.
 * @throws {badRequest} If token exchange or profile fetch fails.
 *
 * @example
 * ```ts
 * const { email, display_name, avatar_url } =
 *   await handleGoogleOAuthCallback(env.DB, env, code, state);
 * ```
 */
export async function handleGoogleOAuthCallback(
  db: D1Database,
  env: Env,
  code: string,
  state: string,
): Promise<{
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  redirect_url: string | null;
}> {
  // Verify state
  const stateRecord = await dbQueryOne<{
    id: string;
    state: string;
    redirect_url: string | null;
    expires_at: string;
  }>(
    db,
    'SELECT id, state, redirect_url, expires_at FROM oauth_states WHERE state = ? AND provider = ?',
    [state, 'google'],
  );

  if (!stateRecord) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'Google OAuth callback failed: invalid state',
      }),
    );
    throw unauthorized('Invalid OAuth state');
  }

  if (new Date(stateRecord.expires_at) < new Date()) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'Google OAuth callback failed: state expired',
      }),
    );
    throw unauthorized('OAuth state expired');
  }

  // Delete used state (one-time-use). Best-effort: the auth code is single-use at
  // Google, so a lingering state (expires in 10 min) is not exploitable — log a
  // failure rather than fail an otherwise-successful login on a cleanup blip.
  const { error: stateDeleteError } = await dbExecute(db, 'DELETE FROM oauth_states WHERE id = ?', [
    stateRecord.id,
  ]);
  if (stateDeleteError) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'oauth_state_delete_failed',
        provider: 'google',
        error: stateDeleteError,
      }),
    );
  }

  // Exchange code for tokens
  const callbackBase = `https://${DOMAINS.SITES_BASE}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${callbackBase}/api/auth/google/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'auth',
        message: 'Google OAuth token exchange failed',
        status: tokenResponse.status,
      }),
    );
    throw badRequest('Failed to exchange OAuth code');
  }

  const tokens = (await tokenResponse.json()) as { access_token: string };

  // Get user info
  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoResponse.ok) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'auth',
        message: 'Google userinfo fetch failed',
        status: userInfoResponse.status,
      }),
    );
    throw badRequest('Failed to fetch Google user info');
  }

  const userInfo = (await userInfoResponse.json()) as {
    email: string;
    name?: string;
    picture?: string;
  };

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Google OAuth callback success',
      email: userInfo.email,
    }),
  );
  return {
    email: userInfo.email,
    display_name: userInfo.name ?? null,
    avatar_url: userInfo.picture ?? null,
    redirect_url: stateRecord.redirect_url ?? null,
  };
}

// ─── GitHub OAuth ──────────────────────────────────────────

/**
 * Create a GitHub OAuth state and return the authorization URL.
 */
export async function createGitHubOAuthState(
  db: D1Database,
  env: Env,
  redirectUrl?: string,
): Promise<{ authUrl: string; state: string }> {
  if (!env.GITHUB_CLIENT_ID) {
    throw badRequest('GitHub OAuth is not configured. GITHUB_CLIENT_ID secret is missing.');
  }

  const state = randomHex(32);

  // Same CSRF-credential contract as Google: a dropped state write must not redirect
  // the user to GitHub with a state that can never validate (→ "Invalid OAuth state").
  const { error: stateError } = await dbInsert(db, 'oauth_states', {
    id: crypto.randomUUID(),
    state,
    provider: 'github',
    redirect_url: redirectUrl ?? null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    deleted_at: null,
  });
  if (stateError) {
    throw new Error(`Failed to persist GitHub OAuth state: ${stateError}`);
  }

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `https://${DOMAINS.SITES_BASE}/api/auth/github/callback`,
    scope: 'read:user user:email',
    state,
  });

  return {
    authUrl: `https://github.com/login/oauth/authorize?${params.toString()}`,
    state,
  };
}

/**
 * Handle the GitHub OAuth callback.
 */
export async function handleGitHubOAuthCallback(
  db: D1Database,
  env: Env,
  code: string,
  state: string,
): Promise<{
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  redirect_url: string | null;
}> {
  // Verify state
  const stateRecord = await dbQueryOne<{
    id: string;
    state: string;
    redirect_url: string | null;
    expires_at: string;
  }>(
    db,
    'SELECT id, state, redirect_url, expires_at FROM oauth_states WHERE state = ? AND provider = ?',
    [state, 'github'],
  );

  if (!stateRecord) {
    throw unauthorized('Invalid OAuth state');
  }

  if (new Date(stateRecord.expires_at) < new Date()) {
    throw unauthorized('OAuth state expired');
  }

  // Delete used state (one-time-use). Best-effort — see the Google callback note.
  const { error: stateDeleteError } = await dbExecute(db, 'DELETE FROM oauth_states WHERE id = ?', [
    stateRecord.id,
  ]);
  if (stateDeleteError) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'auth',
        message: 'oauth_state_delete_failed',
        provider: 'github',
        error: stateDeleteError,
      }),
    );
  }

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `https://${DOMAINS.SITES_BASE}/api/auth/github/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'auth',
        message: 'GitHub OAuth token exchange failed',
        status: tokenResponse.status,
      }),
    );
    throw badRequest('Failed to exchange GitHub OAuth code');
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string; error?: string };

  if (tokenData.error || !tokenData.access_token) {
    throw badRequest(`GitHub OAuth error: ${tokenData.error || 'no access token'}`);
  }

  // Get user info
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ProjectSites/1.0',
    },
  });

  if (!userResponse.ok) {
    throw badRequest('Failed to fetch GitHub user info');
  }

  const ghUser = (await userResponse.json()) as {
    email: string | null;
    name: string | null;
    avatar_url: string | null;
    login: string;
  };

  // GitHub may not return email in user profile — fetch from emails endpoint
  let email = ghUser.email;
  if (!email) {
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ProjectSites/1.0',
      },
    });

    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }

  if (!email) {
    throw badRequest(
      'GitHub account has no verified email. Please add a verified email to your GitHub account.',
    );
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'GitHub OAuth callback success',
      email,
      github_login: ghUser.login,
    }),
  );
  return {
    email,
    display_name: ghUser.name ?? ghUser.login,
    avatar_url: ghUser.avatar_url,
    redirect_url: stateRecord.redirect_url ?? null,
  };
}

/**
 * Create a session for an authenticated user.
 *
 * Generates a random token, stores its SHA-256 hash in D1. The plaintext
 * token is returned to the client (typically as a cookie or Bearer header).
 *
 * @param db         - D1Database binding.
 * @param userId     - Authenticated user's ID.
 * @param deviceInfo - Optional device/browser fingerprint.
 * @param ipAddress  - Optional client IP address.
 * @returns Plaintext token and expiry.
 *
 * @example
 * ```ts
 * const { token, expires_at } = await createSession(env.DB, user.id);
 * c.header('Set-Cookie', `session=${token}; HttpOnly; Secure; Path=/`);
 * ```
 */
export async function createSession(
  db: D1Database,
  userId: string,
  deviceInfo?: string,
  ipAddress?: string,
): Promise<{ token: string; expires_at: string }> {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(
    Date.now() + AUTH.SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // `dbInsert` RETURNS `{ error }` (it never throws). A bare await would IGNORE a
  // failed write and still return a valid-looking token for a session that was
  // NEVER persisted — the user "logs in" then 401s on every subsequent request
  // (a broken-token dead-end with no visible error). Auth is security-critical:
  // fail LOUDLY (the caller's error boundary returns a retryable 500) rather than
  // hand out a broken token, per fail-fast-build-fail-soft-prod.
  const { error } = await dbInsert(db, 'sessions', {
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: tokenHash,
    device_info: deviceInfo ?? null,
    ip_address: ipAddress ?? null,
    expires_at: expiresAt,
    last_active_at: new Date().toISOString(),
    deleted_at: null,
  });
  if (error) {
    throw new Error(`Failed to persist session for user ${userId}: ${error}`);
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Session created',
      user_id: userId,
      expires_at: expiresAt,
    }),
  );
  return { token, expires_at: expiresAt };
}

/**
 * Retrieve a session by its plaintext token.
 *
 * Hashes the token, looks it up, validates expiry, and bumps `last_active_at`.
 *
 * @param db    - D1Database binding.
 * @param token - Plaintext session token from the client.
 * @returns Session data or `null` if invalid/expired.
 *
 * @example
 * ```ts
 * const session = await getSession(env.DB, req.headers.get('Authorization'));
 * if (!session) return c.json({ error: 'Unauthorized' }, 401);
 * ```
 */
export async function getSession(
  db: D1Database,
  token: string,
): Promise<{
  id: string;
  user_id: string;
  expires_at: string;
} | null> {
  const tokenHash = await sha256Hex(token);

  const session = await dbQueryOne<{
    id: string;
    user_id: string;
    expires_at: string;
    last_active_at: string | null;
  }>(
    db,
    'SELECT id, user_id, expires_at, last_active_at FROM sessions WHERE token_hash = ? AND deleted_at IS NULL',
    [tokenHash],
  );

  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) {
    return null;
  }

  // Throttle the last_active_at write: it ran on EVERY authenticated request,
  // so a busy session paid a synchronous D1 write per call on the hot path.
  // Only refresh when the stamp is stale (>5 min) — a session making 100
  // requests in 5 min now does 1 write, not 100. Best-effort: never block auth.
  const STALE_MS = 5 * 60 * 1000;
  const lastActive = session.last_active_at ? new Date(session.last_active_at).getTime() : 0;
  if (Date.now() - lastActive > STALE_MS) {
    await dbUpdate(db, 'sessions', { last_active_at: new Date().toISOString() }, 'id = ?', [
      session.id,
    ]).catch(() => undefined);
  }

  return { id: session.id, user_id: session.user_id, expires_at: session.expires_at };
}

/**
 * Revoke (soft-delete) a session.
 *
 * @param db        - D1Database binding.
 * @param sessionId - The session ID to revoke.
 *
 * @example
 * ```ts
 * await revokeSession(env.DB, session.id);
 * ```
 */
export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  // A revoke that didn't persist must NOT claim success. A swallowed `{ error }`
  // would log "Session revoked" + return void while the session stays VALID — a
  // security lying-success (a failed logout, or a failed revoke of a compromised
  // session, both read as done). Throw so the caller surfaces it + can retry
  // (re-revoking a soft-deleted row is idempotent). `changes === 0` is NOT a
  // failure here — an already-revoked/absent row means the goal is already met.
  const { error } = await dbUpdate(
    db,
    'sessions',
    { deleted_at: new Date().toISOString() },
    'id = ?',
    [sessionId],
  );
  if (error) {
    throw new Error(`Failed to revoke session ${sessionId}: ${error}`);
  }
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Session revoked',
      session_id: sessionId,
    }),
  );
}

/** One active-session row for the /admin/user "Active sessions" panel. */
export interface UserSessionRow {
  id: string;
  device?: string;
  browser?: string;
  os?: string;
  location?: string;
  last_active_at?: string;
  current?: boolean;
}

/**
 * Best-effort parse of a stored `device_info` string into a friendly
 * device/browser/os triple. `device_info` is free-form (a UA string for real
 * browser logins, a label like `e2e-test-login` for programmatic ones, or
 * null). Never throws — an unrecognized value passes through as `device`.
 */
function parseDeviceInfo(info: string | null): { device?: string; browser?: string; os?: string } {
  if (!info) return {};
  const ua = info;
  // Only treat it as a UA if it looks like one (has a slash or "Mozilla").
  if (!/mozilla|applewebkit|\//i.test(ua)) return { device: info };
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /chrome\//i.test(ua)
      ? 'Chrome'
      : /firefox\//i.test(ua)
        ? 'Firefox'
        : /safari\//i.test(ua)
          ? 'Safari'
          : undefined;
  const os = /windows/i.test(ua)
    ? 'Windows'
    : /mac os|macintosh/i.test(ua)
      ? 'macOS'
      : /android/i.test(ua)
        ? 'Android'
        : /iphone|ipad|ios/i.test(ua)
          ? 'iOS'
          : /linux/i.test(ua)
            ? 'Linux'
            : undefined;
  const device = /mobile|iphone|android/i.test(ua) ? 'Mobile' : 'Desktop';
  return { browser, device, os };
}

/**
 * List a user's active (non-deleted, non-expired) sessions for the account
 * "Active sessions" panel, most-recently-active first. When `currentToken` is
 * supplied, the row whose `token_hash` matches it is flagged `current: true`.
 *
 * @param db - D1Database binding.
 * @param userId - The authenticated user's id (`c.get('userId')`).
 * @param currentToken - The caller's raw bearer token (to flag the current row).
 * @returns Friendly {@link UserSessionRow}s; empty array when the user has none.
 *
 * @example
 * const rows = await listUserSessions(env.DB, userId, bearerToken);
 * // → [{ id, device:'Desktop', browser:'Chrome', os:'macOS', current:true }, …]
 */
export async function listUserSessions(
  db: D1Database,
  userId: string,
  currentToken?: string,
): Promise<UserSessionRow[]> {
  const currentHash = currentToken ? await sha256Hex(currentToken) : null;
  const { data } = await dbQuery<{
    id: string;
    token_hash: string;
    device_info: string | null;
    ip_address: string | null;
    last_active_at: string | null;
  }>(
    db,
    `SELECT id, token_hash, device_info, ip_address, last_active_at
     FROM sessions
     WHERE user_id = ? AND deleted_at IS NULL AND expires_at > ?
     ORDER BY last_active_at DESC
     LIMIT 100`,
    [userId, new Date().toISOString()],
  );
  return data.map((s) => {
    const parsed = parseDeviceInfo(s.device_info);
    return {
      browser: parsed.browser,
      current: currentHash ? s.token_hash === currentHash : false,
      device: parsed.device,
      id: s.id,
      last_active_at: s.last_active_at ?? undefined,
      location: s.ip_address ?? undefined,
      os: parsed.os,
    };
  });
}

/**
 * Revoke one of a user's sessions, but ONLY if the session belongs to that
 * user (prevents revoking another user's session by id). Returns whether a row
 * was revoked.
 *
 * @param db - D1Database binding.
 * @param userId - The owner user id.
 * @param sessionId - The session id to revoke.
 * @returns `true` when a session owned by the user was revoked; `false` otherwise.
 */
export async function revokeUserSession(
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const owned = await dbQueryOne<{ id: string }>(
    db,
    'SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [sessionId, userId],
  );
  if (!owned) return false;
  await revokeSession(db, sessionId);
  return true;
}

/**
 * Revoke all of a user's sessions EXCEPT the current one (identified by the
 * caller's bearer token). Returns the number of sessions revoked.
 *
 * @param db - D1Database binding.
 * @param userId - The owner user id.
 * @param currentToken - The caller's raw bearer token (its session is kept).
 * @returns Count of other sessions revoked.
 */
export async function revokeOtherUserSessions(
  db: D1Database,
  userId: string,
  currentToken?: string,
): Promise<number> {
  const currentHash = currentToken ? await sha256Hex(currentToken) : null;
  const { data } = await dbQuery<{ id: string; token_hash: string }>(
    db,
    'SELECT id, token_hash FROM sessions WHERE user_id = ? AND deleted_at IS NULL',
    [userId],
  );
  const others = data.filter((s) => !currentHash || s.token_hash !== currentHash);
  // Revoke each independently so one transient D1 failure doesn't strand the rest
  // (revokeSession now throws on a failed write), and return the ACTUAL revoked
  // count — the old `return others.length` LIED (it reported the intended count
  // even when a revoke silently failed). If any failed, surface it so the caller
  // retries (re-revoking the already-done ones is idempotent).
  let revoked = 0;
  const failures: string[] = [];
  for (const s of others) {
    try {
      await revokeSession(db, s.id);
      revoked++;
    } catch (e) {
      failures.push(`${s.id}(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Revoked ${revoked}/${others.length} sessions; ${failures.length} failed: ${failures.join('; ')}`,
    );
  }
  return revoked;
}

/**
 * List all active (non-expired, non-deleted) sessions for a user.
 *
 * @param db     - D1Database binding.
 * @param userId - The user whose sessions to retrieve.
 * @returns Array of session summaries sorted by most recent activity.
 *
 * @example
 * ```ts
 * const sessions = await getUserSessions(env.DB, userId);
 * // [{ id, device_info, last_active_at, created_at }, ...]
 * ```
 */
export async function getUserSessions(
  db: D1Database,
  userId: string,
): Promise<
  Array<{ id: string; device_info: string | null; last_active_at: string; created_at: string }>
> {
  const now = new Date().toISOString();
  const { data } = await dbQuery<{
    id: string;
    device_info: string | null;
    last_active_at: string;
    created_at: string;
  }>(
    db,
    'SELECT id, device_info, last_active_at, created_at FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND expires_at > ? ORDER BY last_active_at DESC',
    [userId, now],
  );

  return data;
}

/**
 * Find an existing user by email or phone, or create a new user with an org and membership.
 *
 * When a new user is created, a personal org is provisioned automatically
 * with the user as `owner` and `billing_admin`.
 *
 * @param db   - D1Database binding.
 * @param opts - Lookup/creation parameters. `email` is required.
 * @returns The user's ID, org ID, and whether the user was newly created.
 *
 * @example
 * ```ts
 * const { user_id, org_id, is_new } = await findOrCreateUser(env.DB, {
 *   email: 'jane@example.com',
 *   display_name: 'Jane Doe',
 * });
 * ```
 */
export async function findOrCreateUser(
  db: D1Database,
  opts: { email?: string; display_name?: string; avatar_url?: string },
): Promise<{ user_id: string; org_id: string; is_new: boolean }> {
  // Look up existing user by email
  let existingUser: { id: string; email: string | null } | null = null;

  if (opts.email) {
    existingUser = await dbQueryOne<{ id: string; email: string | null }>(
      db,
      'SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL',
      [opts.email],
    );
  }

  if (existingUser) {
    // Find their org
    const membership = await dbQueryOne<{ org_id: string }>(
      db,
      'SELECT org_id FROM memberships WHERE user_id = ? AND deleted_at IS NULL LIMIT 1',
      [existingUser.id],
    );

    return {
      user_id: existingUser.id,
      org_id: membership?.org_id ?? '',
      is_new: false,
    };
  }

  // Create new user
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();

  const identifier = opts.email ?? 'user';
  const slugBase = opts.email
    ? opts.email
        .split('@')[0]!
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 63)
    : identifier
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 63);
  const randomSuffix = crypto.randomUUID().substring(0, 6);
  const slug = `${slugBase}-${randomSuffix}`;

  // Atomic 3-table account creation (users → orgs → memberships). These were THREE
  // sequential bare-await dbInsert calls that IGNORED `{error}`: a dropped `users`
  // insert still ran the orgs + memberships inserts (memberships FK-references a
  // now-absent user → cascade failure + an orphaned org) and the function returned a
  // `user_id` whose row never persisted → `createSession` then minted a session for a
  // PHANTOM user (401 on every request). `db.batch` is an implicit transaction — any
  // statement error rejects + rolls back the whole account, so first-login is
  // all-or-nothing (the iter 17-22 atomicity pattern). A reject propagates to the
  // login handler's error boundary → retryable 500 (never a half-created account).
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, phone, display_name, avatar_url, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        opts.email ?? null,
        null,
        opts.display_name ?? null,
        opts.avatar_url ?? null,
        null,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO orgs (id, name, slug, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(orgId, opts.email ?? 'Personal', slug, null, now, now),
    db
      .prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, billing_admin, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(membershipId, orgId, userId, 'owner', 1, null, now, now),
  ]);

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'New user created',
      user_id: userId,
      org_id: orgId,
      email: opts.email,
    }),
  );
  return { user_id: userId, org_id: orgId, is_new: true };
}

// ---------------------------------------------------------------------------
// E2E test sign-in seam
// ---------------------------------------------------------------------------

/**
 * The single account the test-login seam authenticates. Brian's owner account
 * already gets unlimited build quota (`build_limits`), so the E2E suite signs
 * in as this identity to exercise every paid/owner surface.
 */
export const TEST_LOGIN_EMAIL = 'brian@megabyte.space';

/** Zod contract for the test-login body — strict, rejects unknown keys. */
const testLoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(256),
  })
  .strict();

/**
 * Authenticate the `brian@megabyte.space` E2E test-login seam.
 *
 * @remarks
 * Secret-gated by `env.E2E_TEST_PASSWORD`. When that secret is UNSET the seam
 * is OFF and this throws {@link notFound} (404) so the route does not exist for
 * normal prod — it is never a live auth backdoor (per `ai-agent-security`).
 * When ON, it accepts ONLY the canonical {@link TEST_LOGIN_EMAIL} plus the
 * exact secret (constant-time compare of equal-length SHA-256 digests, so no
 * password length is leaked), then idempotently upserts the user/org/owner
 * membership via {@link findOrCreateUser} and mints a real {@link createSession}
 * — so Playwright signs in through the real UI and reaches a live session.
 *
 * @param db       - D1 binding.
 * @param env      - Needs only `E2E_TEST_PASSWORD`.
 * @param rawInput - Untrusted request body; validated against `testLoginSchema`.
 * @returns `{ token, email, user_id, org_id }` — a real bearer session.
 * @throws 404 when the seam is disabled; 401 on wrong email/password; 400 (ZodError) on a malformed body.
 *
 * @example
 * ```ts
 * const { token } = await authenticateTestLogin(env.DB, env, await c.req.json());
 * ```
 */
export async function authenticateTestLogin(
  db: D1Database,
  env: Pick<Env, 'E2E_TEST_PASSWORD'>,
  rawInput: unknown,
): Promise<{ token: string; email: string; user_id: string; org_id: string }> {
  const expected = env.E2E_TEST_PASSWORD;
  // Seam OFF unless the secret is provisioned — caller maps this to a 404.
  if (!expected) {
    throw notFound('Not found');
  }

  const input = testLoginSchema.parse(rawInput);
  const emailOk = input.email.toLowerCase() === TEST_LOGIN_EMAIL;
  // Constant-time over equal-length digests — avoids leaking the secret length.
  const passwordOk = timingSafeEqual(await sha256Hex(input.password), await sha256Hex(expected));
  if (!emailOk || !passwordOk) {
    throw unauthorized('Invalid test credentials');
  }

  const user = await findOrCreateUser(db, {
    email: TEST_LOGIN_EMAIL,
    display_name: 'Brian Zalewski',
  });
  const session = await createSession(db, user.user_id, 'e2e-test-login');

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'auth',
      message: 'Test-login seam authenticated',
      user_id: user.user_id,
      email: TEST_LOGIN_EMAIL,
    }),
  );

  return {
    token: session.token,
    email: TEST_LOGIN_EMAIL,
    user_id: user.user_id,
    org_id: user.org_id,
  };
}

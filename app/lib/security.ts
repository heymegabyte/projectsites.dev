import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';

// Rate limiting store (in-memory for serverless environments)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limit configuration
const RATE_LIMITS = {
  // General API endpoints
  '/api/*': { windowMs: 15 * 60 * 1000, maxRequests: 100 }, // 100 requests per 15 minutes

  // LLM API (more restrictive)
  '/api/llmcall': { windowMs: 60 * 1000, maxRequests: 10 }, // 10 requests per minute

  // GitHub API endpoints
  '/api/github-*': { windowMs: 60 * 1000, maxRequests: 30 }, // 30 requests per minute

  // Netlify API endpoints
  '/api/netlify-*': { windowMs: 60 * 1000, maxRequests: 20 }, // 20 requests per minute
};

/**
 * Rate limiting middleware
 */
export function checkRateLimit(request: Request, endpoint: string): { allowed: boolean; resetTime?: number } {
  const clientIP = getClientIP(request);
  const key = `${clientIP}:${endpoint}`;

  // Find matching rate limit rule
  const rule = Object.entries(RATE_LIMITS).find(([pattern]) => {
    if (pattern.endsWith('/*')) {
      const basePattern = pattern.slice(0, -2);
      return endpoint.startsWith(basePattern);
    }

    return endpoint === pattern;
  });

  if (!rule) {
    return { allowed: true }; // No rate limit for this endpoint
  }

  const [, config] = rule;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Clean up old entries
  for (const [storedKey, data] of rateLimitStore.entries()) {
    if (data.resetTime < windowStart) {
      rateLimitStore.delete(storedKey);
    }
  }

  // Get or create rate limit data
  const rateLimitData = rateLimitStore.get(key) || { count: 0, resetTime: now + config.windowMs };

  if (rateLimitData.count >= config.maxRequests) {
    return { allowed: false, resetTime: rateLimitData.resetTime };
  }

  // Update rate limit data
  rateLimitData.count++;
  rateLimitStore.set(key, rateLimitData);

  return { allowed: true };
}

/**
 * Get client IP address from request
 */
function getClientIP(request: Request): string {
  // Try various headers that might contain the real IP
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfConnectingIP = request.headers.get('cf-connecting-ip');

  // Return the first available IP or a fallback
  return cfConnectingIP || realIP || forwardedFor?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Security headers middleware
 */
export function createSecurityHeaders() {
  return {
    /*
     * Clickjacking — bolt.diy must be embeddable in the projectsites admin
     * shell (editor.projectsites.dev iframe inside projectsites.dev/admin).
     * Use CSP frame-ancestors (modern replacement for X-Frame-Options) so
     * only OUR origins can frame it.
     * X-Frame-Options is intentionally OMITTED — its `DENY` would override
     * frame-ancestors in older browsers and break the admin embed.
     */

    // Prevent MIME type sniffing
    'X-Content-Type-Options': 'nosniff',

    // Enable XSS protection
    'X-XSS-Protection': '1; mode=block',

    /*
     * Content Security Policy
     * - frame-src: allow WebContainer preview iframes (the bolt.diy Preview
     *   tab loads `https://*.local-credentialless.webcontainer-api.io`).
     *   `frame-src 'none'` blocks them outright — the user-visible symptom
     *   is a blank/blocked preview pane.
     * - frame-ancestors: only projectsites.dev (the admin shell) and the
     *   bolt.diy standalone origins are allowed to embed THIS document.
     *   Replaces the old `X-Frame-Options: DENY` which would block the
     *   admin iframe entirely.
     */
    'Content-Security-Policy': [
      "default-src 'self'",

      // static.cloudflareinsights.com: CF Web Analytics auto-injects its beacon.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com", // inline scripts for React
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline + Google Fonts CSS
      "img-src 'self' data: https: blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://api.github.com https://api.netlify.com https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io wss://*.webcontainer-api.io wss://*.local-credentialless.webcontainer-api.io https://cloudflareinsights.com",

      // bare stackblitz.com: root.tsx sets WEBCONTAINER_API_IFRAME_URL to it (no subdomain → *.stackblitz.com doesn't match).
      "frame-src 'self' blob: https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io https://stackblitz.com https://*.stackblitz.com",
      "child-src 'self' blob: https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io",
      "worker-src 'self' blob:",

      // localhost parents: the LOCAL admin/long-trail stack embeds the PROD editor
      "frame-ancestors 'self' https://projectsites.dev https://*.projectsites.dev https://bolt-diy-8jf.pages.dev https://bolt.megabyte.space http://localhost:4200 http://localhost:4300",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),

    // Referrer Policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Permissions Policy (formerly Feature Policy)
    'Permissions-Policy': ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()'].join(', '),

    // HSTS (HTTP Strict Transport Security) - only in production
    ...(process.env.NODE_ENV === 'production'
      ? {
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        }
      : {}),
  };
}

/**
 * Validate API key format (basic validation)
 */
export function validateApiKeyFormat(apiKey: string, provider: string): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }

  // Basic length checks for different providers
  const minLengths: Record<string, number> = {
    anthropic: 50,
    openai: 50,
    groq: 50,
    google: 30,
    github: 30,
    netlify: 30,
  };

  const minLength = minLengths[provider.toLowerCase()] || 20;

  return apiKey.length >= minLength && !apiKey.includes('your_') && !apiKey.includes('here');
}

/**
 * Sanitize error messages to prevent information leakage
 */
export function sanitizeErrorMessage(error: unknown, isDevelopment = false): string {
  if (isDevelopment) {
    // In development, show full error details
    return error instanceof Error ? error.message : String(error);
  }

  // In production, show generic messages to prevent information leakage
  if (error instanceof Error) {
    // Check for sensitive information in error messages
    if (error.message.includes('API key') || error.message.includes('token') || error.message.includes('secret')) {
      return 'Authentication failed';
    }

    if (error.message.includes('rate limit') || error.message.includes('429')) {
      return 'Rate limit exceeded. Please try again later.';
    }
  }

  return 'An unexpected error occurred';
}

/**
 * Security wrapper for API routes
 */
export function withSecurity<T extends (args: ActionFunctionArgs | LoaderFunctionArgs) => Promise<Response>>(
  handler: T,
  options: {
    requireAuth?: boolean;
    rateLimit?: boolean;
    allowedMethods?: string[];
  } = {},
) {
  return async (args: ActionFunctionArgs | LoaderFunctionArgs): Promise<Response> => {
    const { request } = args;
    const url = new URL(request.url);
    const endpoint = url.pathname;

    // Check allowed methods
    if (options.allowedMethods && !options.allowedMethods.includes(request.method)) {
      return new Response('Method not allowed', {
        status: 405,
        headers: createSecurityHeaders(),
      });
    }

    // Apply rate limiting
    if (options.rateLimit !== false) {
      const rateLimitResult = checkRateLimit(request, endpoint);

      if (!rateLimitResult.allowed) {
        return new Response('Rate limit exceeded', {
          status: 429,
          headers: {
            ...createSecurityHeaders(),
            'Retry-After': Math.ceil((rateLimitResult.resetTime! - Date.now()) / 1000).toString(),
            'X-RateLimit-Reset': rateLimitResult.resetTime!.toString(),
          },
        });
      }
    }

    try {
      // Execute the handler
      const response = await handler(args);

      // Add security headers to response
      const responseHeaders = new Headers(response.headers);
      Object.entries(createSecurityHeaders()).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('Security-wrapped handler error:', error);

      const errorMessage = sanitizeErrorMessage(error, process.env.NODE_ENV === 'development');

      return new Response(
        JSON.stringify({
          error: true,
          message: errorMessage,
        }),
        {
          status: 500,
          headers: {
            ...createSecurityHeaders(),
            'Content-Type': 'application/json',
          },
        },
      );
    }
  };
}

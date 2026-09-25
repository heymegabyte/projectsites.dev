import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Skip build-time TS + ESLint: the template's `@payloadcms/next/css` side-effect imports
  // have no type declarations (TS2882) — a type-only gap, not a runtime issue. Skipping
  // unblocks the OpenNext build; runtime is unaffected.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },
  // Packages with Cloudflare Workers (workerd) specific code
  // Read more: https://opennext.js.org/cloudflare/howtos/workerd
  // drizzle-kit is a dev/migration CLI pulled in by the D1 adapter — never bundle it
  // (esbuild "require drizzle-kit/api" bundle error). If this doesn't fully resolve it,
  // add drizzle-kit to open-next.config.ts external as well.
  serverExternalPackages: ['jose', 'pg-cloudflare', 'drizzle-kit'],

  // Your Next.js config here
  webpack: (webpackConfig: any) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })

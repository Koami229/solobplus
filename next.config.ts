import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './src/lib/core/security-headers';

const isProduction = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: buildSecurityHeaders(isProduction) }];
  },
};

export default nextConfig;

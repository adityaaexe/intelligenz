import type { NextConfig } from 'next';

/**
 * Scaffold configuration only. There is no `src/app` tree yet — the Overview
 * route is built in a later unit (contract §11 scopes the web app to Overview).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@intelligenz/contracts', '@intelligenz/design-system'],
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources; `bot-templates` is a value import (not a type).
  transpilePackages: ['@oantuti/protocol'],
  async rewrites() {
    const api = process.env.API_BASE ?? 'http://127.0.0.1:4301';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;

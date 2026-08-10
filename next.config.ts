import type { NextConfig } from 'next';

/**
 * Cloud Run 上で標準 Node.js サーバーとして動作させるため standalone 出力を使う。
 * NEXT_PUBLIC_* へのビルド時埋め込みは行わず、同一イメージをステージング／本番で再利用する。
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/admin/media': ['./node_modules/sharp/**'],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async headers() {
    const noStore = { key: 'Cache-Control', value: 'no-store, max-age=0' };
    const noReferrer = { key: 'Referrer-Policy', value: 'no-referrer' };
    const noIndex = { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' };

    return [
      {
        // 参加トークンを含む URL。解析タグ・Referer 経由の漏えいを防ぐ。
        source: '/j/:path*',
        headers: [noReferrer, noIndex, noStore],
      },
      {
        source: '/play/:path*',
        headers: [noReferrer, noIndex],
      },
      {
        source: '/present/:path*',
        headers: [noReferrer, noIndex],
      },
      {
        source: '/admin/:path*',
        headers: [noReferrer, noIndex],
      },
      {
        source: '/host/:path*',
        headers: [noReferrer, noIndex],
      },
      {
        source: '/api/:path*',
        headers: [noStore, noReferrer],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

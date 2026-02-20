//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/devtools-fullscreen-compiled/:path*',
        destination: 'https://www.browserbase.com/devtools-fullscreen-compiled/:path*',
      },
      {
        source: '/devtools-fullscreen/:path*',
        destination: 'https://www.browserbase.com/devtools-fullscreen/:path*',
      },
      {
        source: '/relay/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/relay/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/browserbase-proxy/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
        ],
      },
      {
        source: '/api/browserbase-proxy/:path*',
        headers: [
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ];
  },
};

// In Nx dev/build, apply withNx plugin. In packaged Electron, @nx/next isn't available.
try {
  const { composePlugins, withNx } = require('@nx/next');
  module.exports = composePlugins(withNx)(Object.assign(nextConfig, { nx: {} }));
} catch {
  module.exports = nextConfig;
}

//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
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

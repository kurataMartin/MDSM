/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pg", "pg-native"],

  // Hide the Next.js dev indicator (the triangle logo + rendering/compiling overlay)
  devIndicators: false,

  // Disable source maps in dev to avoid NTFS file-system-limitation error (665)
  productionBrowserSourceMaps: false,

  // Silence the "webpack config present but no turbopack config" warning in Next 16
  turbopack: {},

  webpack: (config, { isServer, dev }) => {
    // Disable source maps in development on Windows (prevents NTFS error 665)
    if (dev) {
      config.devtool = false;
    }

    if (!isServer) {
      config.resolve.fallback = {
        dns: false,
        net: false,
        tls: false,
        fs: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only packages that must not be bundled into the client.
  serverExternalPackages: ["pg", "pg-boss"],
  // Hide the floating Next.js dev badge; it sits on top of the sidebar's user avatar.
  // Compile and runtime errors still show their overlay.
  devIndicators: false,
};

export default nextConfig;

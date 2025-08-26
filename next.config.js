/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    UUID: process.env.UUID,
    MONGODB_URI: process.env.MONGODB_URI,
    YANDEX_KEY: process.env.YANDEX_KEY,
    NARODMON_UUID: process.env.NARODMON_UUID,
    NARODMON_KEY: process.env.NARODMON_KEY,
  },
  experimental: {
    esmExternals: false
  }
}

module.exports = nextConfig
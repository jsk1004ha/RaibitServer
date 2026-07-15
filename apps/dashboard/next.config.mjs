import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(dashboardDirectory, '../..'),
};

export default nextConfig;

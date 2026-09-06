import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));
const externalDistDir = process.env.RAIBITSERVER_NEXT_DIST_DIR;

if (externalDistDir && !path.isAbsolute(externalDistDir)) throw new Error('dashboard_next_dist_dir_must_be_absolute');

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(externalDistDir ? { distDir: externalDistDir } : {}),
  output: 'standalone',
  outputFileTracingRoot: path.resolve(dashboardDirectory, '../..'),
  images: { unoptimized: true },
};

export default nextConfig;

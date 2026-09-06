import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));
const externalDistDir = process.env.RAIBITSERVER_NEXT_DIST_DIR;

export function relativeExternalDistDir({ externalDistDir, dashboardDirectory: projectDirectory, pathApi = path }) {
  if (!pathApi.isAbsolute(externalDistDir)) throw new Error('dashboard_next_dist_dir_must_be_absolute');
  const target = pathApi.resolve(externalDistDir);
  const relative = pathApi.relative(projectDirectory, target);
  if (relative.length === 0 || pathApi.isAbsolute(relative) || pathApi.resolve(projectDirectory, relative) !== target) {
    throw new Error('dashboard_next_dist_dir_unrepresentable');
  }
  return relative;
}

const nextDistDir = externalDistDir ? relativeExternalDistDir({ externalDistDir, dashboardDirectory }) : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(nextDistDir ? { distDir: nextDistDir } : {}),
  output: 'standalone',
  outputFileTracingRoot: path.resolve(dashboardDirectory, '../..'),
  images: { unoptimized: true },
};

export default nextConfig;

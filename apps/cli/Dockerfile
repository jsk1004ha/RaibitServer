FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --frozen-lockfile
COPY apps/cli apps/cli
COPY packages/api-client packages/api-client
COPY packages/config packages/config
COPY packages/core packages/core
COPY packages/schemas packages/schemas
COPY scripts/build-cli-runtime.mjs scripts/build-cli-runtime.mjs
RUN pnpm --filter @raibitserver/cli deploy --legacy --prod /opt/raibitserver/cli
RUN node scripts/build-cli-runtime.mjs /opt/raibitserver/cli

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /opt/raibitserver/cli ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]

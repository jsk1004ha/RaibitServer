FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
ARG RAIBITSERVER_GIT_SHA=unknown
ARG RAIBITSERVER_GITHUB_REPOSITORY=jsk1004ha/RaibitServer
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV RAIBITSERVER_GIT_SHA=$RAIBITSERVER_GIT_SHA
ENV RAIBITSERVER_GITHUB_REPOSITORY=$RAIBITSERVER_GITHUB_REPOSITORY
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile
COPY apps/dashboard apps/dashboard
COPY packages/api-client packages/api-client
COPY packages/core packages/core
COPY packages/schemas packages/schemas
COPY packages/ui packages/ui
COPY packages/config packages/config
RUN pnpm --filter @raibitserver/dashboard build

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
ARG RAIBITSERVER_GIT_SHA=unknown
ARG RAIBITSERVER_GITHUB_REPOSITORY=jsk1004ha/RaibitServer
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV RAIBITSERVER_GIT_SHA=$RAIBITSERVER_GIT_SHA
ENV RAIBITSERVER_GITHUB_REPOSITORY=$RAIBITSERVER_GITHUB_REPOSITORY
COPY --from=build --chown=10001:10001 /workspace/apps/dashboard/.next/standalone ./
COPY --from=build --chown=10001:10001 /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=10001:10001 /workspace/apps/dashboard/public ./apps/dashboard/public
RUN chmod -R a+rX /app/apps/dashboard/public
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

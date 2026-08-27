FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/core packages/core
COPY packages/schemas packages/schemas
COPY packages/config packages/config
COPY prisma prisma
RUN DATABASE_URL=postgresql://raibitserver:raibitserver@localhost:5432/raibitserver \
    pnpm --filter @raibitserver/api exec prisma generate --schema ../../prisma/schema.prisma
RUN pnpm --filter @raibitserver/api exec tsc -p tsconfig.build.json
RUN pnpm --filter @raibitserver/api exec tsc -p ../../packages/core/tsconfig.json \
    --noEmit false --declaration false --incremental false \
    --rootDir ../../packages/core/src --outDir /opt/raibitserver/core-runtime \
    --rewriteRelativeImportExtensions true
RUN pnpm --filter @raibitserver/api deploy --legacy --prod /opt/raibitserver/api
RUN cp -R /workspace/prisma /opt/raibitserver/api/prisma && \
    cd /opt/raibitserver/api && \
    DATABASE_URL=postgresql://raibitserver:raibitserver@localhost:5432/raibitserver \
    ./node_modules/.bin/prisma generate --schema ./prisma/schema.prisma
RUN core_dir=/opt/raibitserver/api/node_modules/@raibitserver/core && \
    rm -rf "$core_dir/src" && \
    mkdir -p "$core_dir/dist" && \
    cp -R /opt/raibitserver/core-runtime/. "$core_dir/dist/" && \
    node -e 'const fs=require("node:fs"); const path="/opt/raibitserver/api/node_modules/@raibitserver/core/package.json"; const next=path+".runtime"; const pkg=JSON.parse(fs.readFileSync(path,"utf8")); pkg.main="./dist/index.js"; delete pkg.types; pkg.exports={".":"./dist/index.js","./execution":"./dist/execution.js"}; fs.writeFileSync(next, JSON.stringify(pkg,null,2)+"\n"); fs.renameSync(next,path)'

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=10001:10001 /opt/raibitserver/api ./
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/main.js"]

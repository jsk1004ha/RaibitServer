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
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/config/package.json packages/config/package.json
COPY scripts/build-cli-runtime.mjs scripts/build-cli-runtime.mjs
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/api-client packages/api-client
COPY packages/core packages/core
COPY packages/schemas packages/schemas
COPY packages/config packages/config
COPY prisma prisma
COPY examples/starters examples/starters
COPY test-fixtures/contracts/starter-catalog-v1.json test-fixtures/contracts/starter-catalog-v1.json
COPY test-fixtures/contracts/starter-catalog-v1.bundle.json test-fixtures/contracts/starter-catalog-v1.bundle.json
RUN DATABASE_URL=postgresql://raibitserver:raibitserver@localhost:5432/raibitserver \
    pnpm --filter @raibitserver/api exec prisma generate --schema ../../prisma/schema.prisma
RUN pnpm --filter @raibitserver/api exec tsc -p tsconfig.build.json
RUN pnpm --filter @raibitserver/api exec tsc -p ../../packages/core/tsconfig.json \
    --noEmit false --declaration false --incremental false \
    --rootDir ../../packages/core/src --outDir /opt/raibitserver/core-runtime \
    --rewriteRelativeImportExtensions true
RUN pnpm --filter @raibitserver/api deploy --legacy --prod /opt/raibitserver/api
RUN node scripts/build-cli-runtime.mjs --schemas-only /opt/raibitserver/api
RUN cp -R /workspace/prisma /opt/raibitserver/api/prisma && \
    cp -R /workspace/examples/starters /opt/raibitserver/api/starters && \
    cp /workspace/test-fixtures/contracts/starter-catalog-v1.json /opt/raibitserver/api/starter-catalog-v1.json && \
    cp /workspace/test-fixtures/contracts/starter-catalog-v1.bundle.json /opt/raibitserver/api/starter-catalog-v1.bundle.json && \
    cd /opt/raibitserver/api && \
    DATABASE_URL=postgresql://raibitserver:raibitserver@localhost:5432/raibitserver \
    ./node_modules/.bin/prisma generate --schema ./prisma/schema.prisma
# Preserve every public core subpath when replacing TypeScript with runtime JS.
RUN core_dir=/opt/raibitserver/api/node_modules/@raibitserver/core && \
    rm -rf "$core_dir/src" && \
    mkdir -p "$core_dir/dist" && \
    cp -R /opt/raibitserver/core-runtime/. "$core_dir/dist/" && \
    node -e 'const fs=require("node:fs"); const path="/opt/raibitserver/api/node_modules/@raibitserver/core/package.json"; const next=path+".runtime"; const pkg=JSON.parse(fs.readFileSync(path,"utf8")); pkg.main="./dist/index.js"; delete pkg.types; pkg.exports=Object.fromEntries(Object.entries(pkg.exports).map(([key,target])=>{if(typeof target!=="string" || !target.startsWith("./src/") || !target.endsWith(".ts")) throw new Error("Unsupported core export: "+key); return [key,target.replace("./src/","./dist/").replace(/\.ts$/,".js")];})); if(pkg.exports["."]!=="./dist/index.js") throw new Error("Missing core root export"); fs.writeFileSync(next, JSON.stringify(pkg,null,2)+"\n"); fs.renameSync(next,path)'
# Import from the deployed package (not workspace sources) to catch missing exports.
RUN cd /opt/raibitserver/api && \
    node --input-type=module -e 'import fs from "node:fs"; const pkg=JSON.parse(fs.readFileSync("node_modules/@raibitserver/core/package.json","utf8")); for (const key of Object.keys(pkg.exports)) await import(pkg.name+(key==="."?"":key.slice(1))); console.log("core runtime exports: ok")'

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

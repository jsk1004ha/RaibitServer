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
RUN pnpm --filter @raibitserver/cli exec tsc -p tsconfig.json \
    --noEmit false --declaration false --incremental false \
    --rootDir src --outDir /opt/raibitserver/cli-runtime \
    --rewriteRelativeImportExtensions true
RUN pnpm --filter @raibitserver/cli exec tsc ../../packages/api-client/src/index.ts \
    --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck \
    --declaration false --rootDir ../../packages/api-client/src \
    --outDir /opt/raibitserver/api-client-runtime
RUN pnpm --filter @raibitserver/cli deploy --legacy --prod /opt/raibitserver/cli
RUN cli_dir=/opt/raibitserver/cli && \
    api_client_dir="$cli_dir/node_modules/@raibitserver/api-client" && \
    mkdir -p "$cli_dir/dist" "$api_client_dir/dist" && \
    cp -R /opt/raibitserver/cli-runtime/. "$cli_dir/dist/" && \
    rm -rf "$api_client_dir/src" && \
    cp -R /opt/raibitserver/api-client-runtime/. "$api_client_dir/dist/" && \
    node -e 'const fs=require("node:fs"); const replace=(path,value)=>{const next=path+".runtime"; fs.writeFileSync(next,JSON.stringify(value,null,2)+"\n"); fs.renameSync(next,path)}; const cliPath="/opt/raibitserver/cli/package.json"; const cli=JSON.parse(fs.readFileSync(cliPath,"utf8")); cli.main="./dist/index.js"; cli.bin={raibitserver:"dist/index.js"}; replace(cliPath,cli); const clientPath="/opt/raibitserver/cli/node_modules/@raibitserver/api-client/package.json"; const client=JSON.parse(fs.readFileSync(clientPath,"utf8")); client.main="./dist/index.js"; delete client.types; client.exports={".":"./dist/index.js"}; replace(clientPath,client)'

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /opt/raibitserver/cli ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]

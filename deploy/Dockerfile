FROM docker:29.7.2-cli AS docker-client

FROM node:24.13.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/operations/package.json packages/operations/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:services && pnpm sdk:build && pnpm --filter @platform/console build
RUN node scripts/bundle.mjs /bundles

FROM node:24.13.0-bookworm-slim AS control-plane
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4110
COPY --from=build --chown=node:node /bundles/control-plane/ ./
USER node
EXPOSE 4110
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4110/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM node:24.13.0-bookworm-slim AS runtime
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production RUNTIME_HOST=0.0.0.0 RUNTIME_PORT=4112
COPY --from=build --chown=node:node /bundles/runtime/ ./
USER node
EXPOSE 4112
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4112/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM nginx:1.28.0-alpine AS console
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/console/dist /usr/share/nginx/html
EXPOSE 8080

# Build this target with --output type=local,dest=... for Linux native service bundles.
FROM scratch AS linux-bundles
COPY --from=build /bundles/ /

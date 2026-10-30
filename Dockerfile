# Ranger API + durable worker on one Machine. Trace is the pinned sibling
# bundle, never a fetched remote. Host caches, git checkouts, and secrets
# stay out of the build context.
FROM node:24-trixie-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY contracts ./contracts
COPY config ./config
RUN npm ci

COPY .fly-build/trace.bundle /tmp/trace.bundle
RUN git clone /tmp/trace.bundle /app/trace \
  && git -C /app/trace checkout --detach bd7f255339a45a5bf41bcdc2be650626c497e2b2 \
  && rm /tmp/trace.bundle

RUN npm install -g pnpm@12.14.0 \
  && pnpm --dir /app/trace install --frozen-lockfile \
  && pnpm --dir /app/trace build

RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904 --version \
  && npm install -g pnpm@12.14.0

WORKDIR /app/ranger
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/migrations ./migrations
COPY --from=build /src/contracts ./contracts
COPY --from=build /src/config ./config
COPY --from=build /app/trace /app/trace
COPY deploy/fly/start.mjs deploy/fly/prefetch-trace-model.mjs /app/ranger/deploy/fly/
COPY scripts/migrate-instabox-ledger.mjs /app/ranger/scripts/
COPY scripts/remove-prototype-limits.mjs /app/ranger/scripts/

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node", "deploy/fly/start.mjs"]

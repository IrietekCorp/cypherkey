# Build stage: install dependencies with a lockfile, nothing else.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Runtime stage. A-15 budgets a single compiled binary in a distroless image;
# that lands in M1-19. This is the honest interim: Bun, the source, no dev deps.
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Never root. The volume is chowned so a self-hosted SQLite file is writable.
RUN addgroup -S cypherkey && adduser -S -G cypherkey cypherkey \
 && mkdir -p /data && chown -R cypherkey:cypherkey /data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY core ./core
COPY server ./server

USER cypherkey
ENV PORT=3000
ENV DATABASE_URL=sqlite:///data/cypherkey.db
EXPOSE 3000

# JWT_SECRET is deliberately not defaulted: the server refuses to start without
# one (A-13), and baking a fallback into an image would be the worst possible
# place to put a secret.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "process.exit((await fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/healthz')).ok?0:1)"

CMD ["bun", "server/src/index.ts"]

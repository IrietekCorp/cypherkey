# Build the server as one self-contained binary (A-15). Built on the Bun image so the
# binary is linked against the same glibc the runtime stage provides.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY core ./core
COPY server ./server
RUN bun build --compile --minify --target=bun server/src/index.ts --outfile /app/cypherkey \
 && mkdir -p /empty-data

# Distroless: no shell, no package manager, no Bun — just the binary and libc.
# `cc` rather than `base` because the Bun runtime needs libstdc++ and libgcc.
FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=build /app/cypherkey /usr/local/bin/cypherkey

# distroless has no shell to `mkdir` with, so the (empty) data directory is created in
# the build stage and copied in owned by `nonroot` (uid 65532), which the self-host
# SQLite path needs to be able to write.
COPY --from=build --chown=65532:65532 /empty-data /data
USER nonroot:nonroot

ENV PORT=3000
ENV DATABASE_URL=sqlite:///data/cypherkey.db
EXPOSE 3000

# No HEALTHCHECK: there is no shell or curl in a distroless image to run one. The
# orchestrator probes GET /healthz instead — Cloud Run and compose both do.
#
# JWT_SECRET is deliberately absent. The server refuses to start without one (A-13),
# and an image is the worst possible place to bake a fallback.
#
# Migrations do not run at boot (A-15 cold-start budget); `bun run db:migrate` is a
# separate deploy job, and it needs the repo rather than this image.
ENTRYPOINT ["/usr/local/bin/cypherkey"]

# warden-docs → Nitro's self-contained `.output` on a slim Bun image, run by the same command as
# the `start` script. No workspace node_modules ships: Nitro bundles the server, and the one
# runtime-resolved package, `@delacournz/otel-start`, is vendored as a single bundle (below).
#
# Build context: repo root (the service's `dockerfilePath` in delacour-monorepo's
# apps/warden/infra/railway.ts, trimmed by the root .dockerignore).
FROM oven/bun:1.4.3 AS build
WORKDIR /repo
COPY . .
# The classic `read:packages` PAT bunfig.toml installs `@delacournz/*` with. Railway passes a
# service variable to a Dockerfile build only when it is an ARG. Optional, exactly as for a local
# install: without it the otel packages are skipped and the site runs untraced
# (src/server/otel.ts). Build stage only: the runtime stage below never sees it.
ARG NPM_TOKEN
RUN bun install --frozen-lockfile
# Vite inlines these into the client bundle (src/lib/analytics), so each is an ARG: a Dockerfile
# build sees only declared variables. Unset, the site renders no analytics. Declared after the
# install so changing one rebuilds the app, not the dependency layer.
#
# DEPLOY_ENV is the image-reuse guard, not a build input: Railway's skipped builds ignore
# variables, so one commit could ship staging's inlined token to production. Railway sets it
# (delacour-monorepo `apps/warden/infra/railway.ts`); a local `docker build` without it still works.
ARG DEPLOY_ENV
ARG VITE_POSTHOG_HOST
ARG VITE_POSTHOG_TOKEN
RUN echo "building warden-docs for ${DEPLOY_ENV:-local}" \
	&& NODE_ENV=production bun run --filter=@delacour/warden-docs build
# `start`'s preload and src/server.ts both load `@delacournz/otel-start` by a computed specifier, so
# neither Vite nor Nitro bundles it; Bun resolves it from node_modules at runtime. Vendor it as one
# self-contained bundle (its two entries share a chunk, so one copy of the OpenTelemetry API) at
# /app/node_modules, and bundle the preload itself, so nothing else needs installing. When the
# install skipped it, /vendor stays empty and the site runs untraced.
RUN OTEL=node_modules/@delacournz/otel-start && mkdir -p /vendor/node_modules \
	&& if [ -d "$OTEL" ]; then \
		mkdir -p /vendor/$OTEL \
		&& bun build $OTEL/dist/index.js $OTEL/dist/preload.js --target bun --splitting --outdir /vendor/$OTEL/dist \
		&& cp $OTEL/package.json /vendor/$OTEL/; \
	fi \
	&& bun build apps/docs/src/server/otel-preload.ts --target bun --outfile /vendor/otel-preload.js

FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY --from=build --chown=bun:bun /vendor/node_modules ./node_modules
COPY --from=build --chown=bun:bun /vendor/otel-preload.js ./otel-preload.js
COPY --from=build --chown=bun:bun /repo/apps/docs/.output ./.output
USER bun
ENV NODE_ENV=production
CMD ["bun", "--preload", "./otel-preload.js", ".output/server/index.mjs"]

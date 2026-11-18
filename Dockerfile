# Production image of Aplication_server (Render web service, docs/DEPLOY.md).
# Build from the repository root: `docker build -t aplication-server .`
#
# Three stages: `deps` installs only production dependencies, `build` installs
# everything and runs `next build` (not `pnpm build`, which also runs the build
# tests), and the final stage gets the build output, the production
# node_modules and the folders `pnpm db:migrate` and `pnpm admin:stvori` need.
# Configuration comes only from the environment at run time (DATABASE_URL,
# INSTITUTION_SERVER_URL, DUCTURA_PROVISIONING_TOKEN, DUCTURA_ADMIN_TOKEN_SECRET);
# the image holds no value of them and no secret. Same Node base as
# Institution_server infra/web/Dockerfile, pinned by digest.
FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS deps
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

FROM mirror.gcr.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
WORKDIR /app
# production: the ductura_admin cookie gets Secure (README, Administrator platforme).
# PORT is a default only; Render sets its own PORT and `next start` follows it.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3110
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/package.json /src/next.config.mjs ./
COPY --from=build /src/.next ./.next
COPY --from=build /src/admin ./admin
COPY --from=build /src/institutions ./institutions
COPY --from=build /src/lib ./lib
EXPOSE 3110
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??3110)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# No -p: next start reads PORT, so the same image runs on 3110 locally and on
# Render's PORT. -H 0.0.0.0: reachable from outside the container.
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0"]

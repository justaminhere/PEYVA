# PEYVA public MVP image (PEYVA_PUBLIC=1). One process: web app + monitoring worker. See docs/DEPLOY_MVP.md.
# Secrets are never baked in: the platform passes them as environment variables at run time.

FROM oven/bun:1.4.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY experiments/travel-mcp-spike/package.json experiments/travel-mcp-spike/bun.lock experiments/travel-mcp-spike/
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY web web
COPY src src
RUN bun run web:build

FROM oven/bun:1.4.5 AS run
# MrBilit's MCP server is a pinned Python package started with uvx (read-only flight and hotel search).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV NODE_ENV=production PEYVA_PUBLIC=1 UV_NO_PROGRESS=1
WORKDIR /app
RUN chown bun:bun /app
USER bun
# Pre-install the pinned package (and a Python for it) into the bun user's cache, so the first search does not wait.
RUN uvx --from mrbilit-mcp==0.5.2 python -c "print('mrbilit-mcp ready')"
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun experiments/travel-mcp-spike/package.json experiments/travel-mcp-spike/bun.lock experiments/travel-mcp-spike/
RUN bun install --frozen-lockfile --production \
 && cd experiments/travel-mcp-spike && bun install --frozen-lockfile --production
COPY --chown=bun:bun experiments/travel-mcp-spike/src experiments/travel-mcp-spike/src
COPY --chown=bun:bun drizzle drizzle
COPY --chown=bun:bun src src
COPY --from=build --chown=bun:bun /app/web/dist web/dist
EXPOSE 10000
CMD ["bun", "run", "src/web/server.ts"]

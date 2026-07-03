# Backend image (launch — Workstream F). Multi-stage: build with full deps (SWC
# nest build + copy:assets), then ship a slim runtime with prod deps only.
# One image serves all three roles via the compose `command`:
#   - web    : node dist/main  (PROCESS_ROLE=web)
#   - worker : node dist/main  (PROCESS_ROLE=worker)
#   - migrate: node dist/migrate.js  (the fail-closed one-shot gate)

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Drop devDependencies in place so the runtime stage copies a prod-only tree.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
# Run as a non-root user.
RUN useradd --system --uid 10001 --create-home appuser
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER appuser
EXPOSE 3000

# Container healthcheck hits the liveness endpoint (dependency-free, always 200
# when the process is up). Node one-liner so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Default = HTTP/web role; compose overrides command for worker + migrate.
CMD ["node", "dist/main"]

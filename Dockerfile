# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# better-sqlite3 builds its native addon for each target architecture.
RUN apk add --no-cache python3 make g++
RUN npm ci --no-audit --no-fund

COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:worker

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
ENV LIBRARY_DATA_DIR=/data
ENV LIBRARY_MEDIA_DIR=/media

# 非 root 用户
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 nextjs -G nodejs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data /media && chown nextjs:nodejs /data /media

USER nextjs

EXPOSE 8080
CMD ["node", "server.js"]

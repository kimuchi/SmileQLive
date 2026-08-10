# syntax=docker/dockerfile:1
# =============================================================================
# SmileQ Live - Cloud Run 向けマルチステージイメージ
# Next.js standalone output を使い、非 root で 0.0.0.0:$PORT を待ち受ける。
# ローカル Docker は必須ではない (gcloud run deploy --source . が Cloud Build 上で使用する)。
# =============================================================================

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable
WORKDIR /app

# -----------------------------------------------------------------------------
# 依存関係の解決
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# ビルド
# -----------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# ビルド時に公開キーを埋め込まない。すべて実行時環境変数から読む。
RUN pnpm build

# -----------------------------------------------------------------------------
# 実行
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]

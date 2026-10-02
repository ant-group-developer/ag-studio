# syntax=docker/dockerfile:1.7
#
# AG Studio: một image cho api + worker (target `app`) và web tĩnh (target `web`).
#
# ag-studio trỏ tới các package của ag-farm bằng `link:../../../ag-farm/packages/*`, nên build cần
# checkout ag-farm làm build context phụ tên `agfarm` (docker-compose.yml: additional_contexts):
#   docker build --build-context agfarm=../ag-farm --target app .
# Trong image, hai repo nằm cạnh nhau như trên máy dev: /src/ag-farm và /src/ag-studio.

FROM node:22-bookworm-slim AS deps
ENV COREPACK_HOME=/tmp/corepack
RUN corepack enable

# ---- ag-farm: chỉ lấy file cần để build @ag-farm/protocol và @ag-farm/owner-client (không lấy .env) ----
WORKDIR /src/ag-farm
COPY --from=agfarm package.json yarn.lock tsconfig.base.json ./
COPY --from=agfarm packages ./packages
COPY --from=agfarm apps/api/package.json ./apps/api/package.json
COPY --from=agfarm apps/web/package.json ./apps/web/package.json
RUN corepack prepare yarn@1.22.22 --activate \
  && yarn install --frozen-lockfile \
  && yarn workspace @ag-farm/protocol build \
  && yarn workspace @ag-farm/owner-client build

# ---- ag-studio ----
WORKDIR /src/ag-studio
COPY . .
RUN corepack pnpm install --frozen-lockfile

FROM deps AS build
RUN corepack pnpm --filter "@ag-studio/api..." --filter "@ag-studio/worker..." run build

# ---- api + worker ----
FROM build AS app
# ffmpeg: kiểm loudness bản render final, cắt khung và vẽ chữ thumbnail. fonts-liberation2: font của chữ thumbnail
# (fontconfig đổi Arial sang Liberation Sans: cùng số đo, đủ dấu tiếng Việt). Claude Code CLI: các stage Claude chạy
# `claude -p` bằng CLAUDE_CODE_OAUTH_TOKEN (gói subscription).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-liberation2 fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && claude --version
ENV NODE_ENV=production \
    HARNESS_ROOT=/src/ag-studio \
    STUDIO_DB_PATH=/data/studio.db \
    STUDIO_DATA_ROOT=/data/harness \
    STUDIO_FFMPEG_PATH=/usr/bin/ffmpeg \
    PORT=3100
VOLUME /data
EXPOSE 3100
CMD ["node", "apps/api/dist/main.js"]

# ---- web ----
# builds on `build`: the editor imports core's layout (and so @harness/contracts) by alias, not as a dependency
FROM build AS web-build
# Rỗng = gọi API cùng domain (nginx của web chuyển /api sang container api).
ARG VITE_STUDIO_API_URL=""
ARG VITE_AG_GO_API_URL
ARG VITE_AUTH0_DOMAIN
ARG VITE_AUTH0_CLIENT_ID
ARG VITE_AUTH0_AUDIENCE
ENV VITE_STUDIO_API_URL=${VITE_STUDIO_API_URL} \
    VITE_AG_GO_API_URL=${VITE_AG_GO_API_URL} \
    VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN} \
    VITE_AUTH0_CLIENT_ID=${VITE_AUTH0_CLIENT_ID} \
    VITE_AUTH0_AUDIENCE=${VITE_AUTH0_AUDIENCE}
RUN corepack pnpm --filter "@ag-studio/web..." run build

FROM nginx:1.27-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /src/ag-studio/apps/web/dist /usr/share/nginx/html
EXPOSE 80

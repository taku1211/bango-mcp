# Glama などのディレクトリがサーバーを起動してツール一覧を読むためのイメージ。
# 通常の利用は `npx -y bango-mcp` で足りる。
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
# BANGO_API_KEY は実行時に環境変数で渡す（未設定でも起動し、ツール一覧は返せる）
ENTRYPOINT ["node", "dist/index.js"]

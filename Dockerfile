# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN npm install -g pnpm@12.11.2
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# O build não precisa de banco nem de segredos.
RUN pnpm build

# Alvo usado pelo serviço "migrate" do compose: aplica as migrações SQL versionadas e termina.
FROM build AS migrate
CMD ["pnpm", "db:migrate"]

FROM node:24-alpine AS runner
# UV_THREADPOOL_SIZE: DNS e fs dividem as threads do libuv com o driver do banco.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]

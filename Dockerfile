FROM node:20-alpine

# Prisma 需要 OpenSSL
RUN apk add --no-cache openssl

WORKDIR /app

# 依赖层（含 Prisma CLI 用于 generate + db push）
COPY package.json package-lock.json ./
RUN npm ci

# Prisma schema（MySQL）
COPY prisma ./prisma
RUN npx prisma generate

# 源码
COPY server.js .

# 容器配置
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

# 启动：MYSQL_URL → DATABASE_URL → 数据库迁移 → 启动服务
CMD ["sh", "-c", "export DATABASE_URL=${MYSQL_URL:-$DATABASE_URL} && npx prisma db push --accept-data-loss && node server.js"]

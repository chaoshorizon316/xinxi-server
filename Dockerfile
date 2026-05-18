FROM node:20-alpine

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

# 启动：数据库迁移 → 启动服务
# DATABASE_URL 由云托管自动注入（MYSQL_URL → DATABASE_URL 映射在 server.js 中处理）
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node server.js"]

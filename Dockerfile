FROM node:20-slim

# 安装 better-sqlite3 编译依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存
COPY package*.json ./
RUN npm ci --production

# 复制应用代码
COPY . .

# 创建数据持久化目录
RUN mkdir -p /data

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:${PORT:-3000}/api/health || exit 1

# 支持多平台端口
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

# Railway 部署指南

## 前置条件

1. GitHub 账号
2. Railway 账号 (https://railway.com/dashboard)

---

## 第一步：创建 GitHub 仓库并推送代码

### 1.1 在 GitHub 上创建仓库
- 访问 https://github.com/new
- 仓库名：`sewage-manager`（或你喜欢的名字）
- 类型：Public（Private 也可以，但需要配置 Railway 的访问权限）
- **不要**勾选 "Initialize this repository with a README"

### 1.2 本地配置并推送

```bash
# 设置 git 用户信息（如未设置）
git config user.name "你的名字"
git config user.email "你的邮箱"

# 添加远程仓库（替换 YOUR_USERNAME 为你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USERNAME/sewage-manager.git

# 推送代码
git branch -M main
git push -u origin main
```

---

## 第二步：Railway 部署

### 2.1 创建项目
1. 登录 https://railway.com/dashboard
2. 点击 "New Project"
3. 选择 "Deploy from GitHub repo"
4. 选择你的 `sewage-manager` 仓库

### 2.2 配置环境变量
进入项目 → 选择服务 → Variables → New Variable：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `DB_PATH` | `/data/sewage_data.db` | SQLite 数据库路径（Volume 挂载点） |
| `JWT_SECRET` | （随机字符串） | 建议设置一个长随机字符串增强安全性 |

### 2.3 挂载持久化 Volume（关键！）
1. 进入服务设置
2. 找到 "Volumes" 或 "Storage"
3. 点击 "New Volume"
4. Mount Path 填写：`/data`
5. 确认挂载

> ⚠️ **重要**：如果不挂载 Volume，SQLite 数据库会在每次部署时丢失！

### 2.4 部署
Railway 会自动检测 Dockerfile 并构建。构建完成后会生成公网 URL。

---

## 第三步：访问应用

部署成功后，Railway 会提供一个类似 `https://sewage-manager-production.up.railway.app` 的域名。

默认登录账号：
- 用户名：`admin`
- 密码：`admin123`
- 角色：厂长（最高权限）

---

## 技术细节

### 双数据库驱动
- **Railway 环境**：使用 `better-sqlite3`（原生 C++ 绑定，高性能）
- **本地开发**：如果 better-sqlite3 编译失败，自动回退到 `sql.js`（纯 JS 实现）

### 数据持久化
- Railway 文件系统是临时的（每次部署重置）
- 通过 Volume 挂载 `/data` 目录实现持久化
- SQLite 数据库文件保存在 `/data/sewage_data.db`

### 端口
- 容器内监听 `3000`
- Railway 自动映射到公网 `80/443`

---

## 常见问题

### Q: 构建失败，better-sqlite3 编译报错？
A: Dockerfile 已安装 `python3 make g++`，Railway 的 Linux 环境会自动编译。如果仍失败，检查 node 版本是否 ≥18。

### Q: 数据库数据丢失了？
A: 检查 Volume 是否正确挂载到 `/data`。如果挂载路径错误，数据库会写在容器临时文件系统中。

### Q: 如何更新部署？
A: 本地修改代码 → `git push origin main` → Railway 自动重新构建部署。

### Q: 如何查看日志？
A: Railway 控制台 → 你的服务 → Deployments → 查看最新部署日志。

---

## 文件说明

| 文件 | 作用 |
|------|------|
| `Dockerfile` | Railway 构建镜像的配置 |
| `railway.toml` | Railway 服务配置（启动命令、重启策略） |
| `server.js` | 主服务端（Node.js + Express + SQLite） |
| `public/` | 前端静态文件（HTML/CSS/JS） |

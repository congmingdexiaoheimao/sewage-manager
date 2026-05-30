# 🚀 污水厂管理系统 - 多平台部署指南

> 当前版本: v4.4 | 支持: 电脑网页 + 手机APP + 微信小程序

---

## 📋 平台对比（2026年6月最新）

| 平台 | 免费 | 不休眠 | HTTPS | 国内速度 | 需信用卡 | 推荐度 |
|------|------|--------|-------|---------|---------|--------|
| **Koyeb** | ✅ 1个Nano | ✅ | ✅ | 🟡 法国节点 | ⚠️ 可能需要$1预授 | ⭐⭐⭐⭐⭐ |
| **Render** | ✅ 750h/月 | ❌ 15min休眠 | ✅ | 🟡 美国节点 | ⚠️ 需要绑卡 | ⭐⭐⭐⭐ |
| **HF Spaces** | ✅ 永久 | ❌ 48h休眠 | ✅ | 🟡 可访问 | ❌ 不需要 | ⭐⭐⭐ |
| **Railway** | ⚠️ $5一次性 | ✅ | ✅ | 🔴 慢 | ❌ 不需要 | ⭐⭐ (不稳定) |

---

## 方案一：Koyeb 部署（推荐 - 不休眠）

### 步骤 1：注册 Koyeb
1. 访问 https://www.koyeb.com/
2. 点击 **Sign Up** → 用 **GitHub 账号** 登录（最方便）
3. 部分用户可能需要验证信用卡（预授权$1，会退还）

### 步骤 2：创建服务
1. 进入 Dashboard → 点击 **Create Service**
2. 选择 **GitHub** → 授权并选择 `sewage-manager` 仓库
3. 配置：
   - **Service Name**: `sewage-manager`
   - **Instance Type**: `Nano` (免费)
   - **Region**: `Paris` (免费区域)
   - **Port**: `3000`
   - **Health Check Path**: `/api/health`
4. 环境变量（如需要）：
   - `DB_PATH` = `/data/sewage_data.db`（持久化存储路径）
5. 点击 **Deploy**

### 步骤 3：等待部署
- 大约 2-5 分钟完成
- 部署成功后会得到一个域名：`xxx-koyeb.app`
- 访问该域名即可使用系统

### 持久化存储（重要！）
Koyeb 免费版**没有持久化存储卷**，每次重启数据库会丢失。解决方案：
- 系统已内置自动 seed 数据生成，重启后自动恢复模拟数据
- 实际使用建议定期导出数据备份

---

## 方案二：Render 部署（备选 - 需保活）

### 步骤 1：注册 Render
1. 访问 https://render.com/
2. 用 **GitHub 账号** 登录
3. 需要绑定信用卡（$1 预授权，会退还）

### 步骤 2：创建 Web Service
1. Dashboard → **New** → **Web Service**
2. 连接 GitHub 仓库 `sewage-manager`
3. 配置：
   - **Name**: `sewage-manager`
   - **Environment**: `Docker`
   - **Instance Type**: `Free`
   - **Health Check Path**: `/api/health`
4. 点击 **Create Web Service**

### 保活方案（防止休眠）
Render 免费版 15 分钟无流量会休眠。用 UptimeRobot 免费保活：
1. 注册 https://uptimerobot.com/
2. 添加监控：类型=HTTP(s)，URL=你的Render域名+/api/health
3. 间隔设为 5 分钟
4. 这样服务就不会休眠了

---

## 方案三：HuggingFace Spaces（无需信用卡）

### 步骤 1：注册 HF
1. 访问 https://huggingface.co/
2. 用 **GitHub 账号** 登录

### 步骤 2：创建 Space
1. 点击右上角头像 → **New Space**
2. 配置：
   - **Space Name**: `sewage-manager`
   - **SDK**: 选择 `Docker`
   - **Visibility**: `Public`
3. 点击 **Create Space**

### 步骤 3：上传代码
方式A：通过 Git 推送
```bash
git clone https://huggingface.co/spaces/你的用户名/sewage-manager
cd sewage-manager
# 复制项目文件（使用 Dockerfile.hf）
cp Dockerfile.hf Dockerfile
cp -r ../sewage-manager-main/* .
git add .
git commit -m "deploy"
git push
```

方式B：通过网页上传文件
1. 在 Space 页面点击 **Files**
2. 逐个上传所有项目文件
3. 确保 `Dockerfile` 使用 HF 版本（端口 7860）

### 步骤 4：等待构建
- 大约 3-10 分钟完成
- 访问地址：`https://你的用户名-sewage-manager.hf.space`

### 注意事项
- HF Spaces 48小时无活动会休眠
- 可用 UptimeRobot 保活（同 Render 方案）
- 免费资源：2 vCPU / 16GB RAM / 50GB 磁盘

---

## 📱 微信小程序适配（后续步骤）

### 前置要求（必须满足）
1. ✅ **企业主体小程序** — 个人主体不支持 web-view
   - 需要营业执照（个体工商户即可，注册资金0元）
   - 去微信公众平台注册：https://mp.weixin.qq.com/
   - 选择"企业"主体，上传营业执照
   
2. ✅ **ICP 备案域名** — web-view 业务域名必须备案
   - 购买域名：腾讯云/阿里云 .cn 域名约 29元/年
   - ICP 备案：通过云服务商提交，约 7-15 个工作日
   - 将域名解析到部署平台

3. ✅ **域名校验文件** — 微信要求验证域名所有权
   - 在小程序后台获取校验文件（如 `WX_verify_xxx.txt`）
   - 将文件放在项目的 `public/` 目录下
   - 部署后访问 `https://域名/WX_verify_xxx.txt` 能看到内容即可

### 小程序代码
项目已包含小程序代码模板，使用 web-view 嵌套：
```xml
<!-- pages/index/index.wxml -->
<web-view src="https://你的备案域名/"></web-view>
```

### 最快路径
1. 办理个体工商户（1-3天，可线上办理）
2. 购买 .cn 域名（即时生效）
3. ICP 备案（7-15天）
4. 注册企业小程序 + 配置业务域名
5. 打包发布小程序

---

## 🔧 常见问题

### Q: 部署后数据丢失怎么办？
A: 系统已内置自动 seed 数据生成，重启后自动恢复30天模拟数据。真实数据请定期导出备份。

### Q: 域名访问不了？
A: 检查部署日志是否成功，确认端口配置正确（Koyeb/Render 用 3000，HF Spaces 用 7860）。

### Q: 国内访问慢？
A: 海外平台在国内可能较慢。解决方案：使用 ICP 备案域名 + CDN 加速。

### Q: 需要修改代码吗？
A: 不需要！所有平台的部署都是零代码修改，只改部署配置。

# 轻量个人知识库

一个自己部署的极简知识库：把链接分享或粘贴进来，自动抓取正文和图片，再由 AI（默认 DeepSeek）整理成带标题、来源、作者、摘要和标签的 Markdown 笔记。小红书这类图文笔记会先用视觉模型（通义千问 qwen3-vl-plus）识别图片里的文字，再交给 DeepSeek 去掉水印、引流等杂质，整理成好读的笔记。也可以直接写笔记、全文搜索。

- **PWA 网页应用**：手机、电脑浏览器都能用，安卓上可安装到桌面并出现在系统分享菜单里
- **复制链接也能收藏**：小红书、微信这类不走系统分享的 App，复制链接后打开知识库，点「📋 粘贴链接收藏」或顶部的剪贴板提示即可
- **进度可见**：整理时笔记页顶部显示进度卡片（抓取正文 → 识别图片文字 → AI 整理）和已用秒数，完成后自动刷新
- **数据可迁移**：SQLite 数据库 + 每篇笔记一份 `.md` 文件 + 图片原文件，随时打包带走
- **AI 可替换**：任何 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、OpenAI…）改三行配置即可
- **每日自动备份**：本地保留 14 份，可选同步到阿里云 OSS

---

## 一、准备工作

1. **服务器**：你的阿里云香港服务器（1 核 1G 就够），系统 Ubuntu / Debian / Alibaba Cloud Linux 均可。
2. **域名解析**：在域名控制台加一条 **A 记录**，例如主机记录 `kb`，记录值填服务器公网 IP。之后访问地址就是 `https://kb.你的域名`。
3. **安全组**：阿里云控制台 → ECS → 安全组，放行入方向 **TCP 80 和 443**（80 用于申请证书，必须开）。
4. **DeepSeek API Key**：在 platform.deepseek.com 创建，形如 `sk-...`。

## 二、部署（约 5 分钟）

把整个项目文件夹传到服务器，例如在自己电脑上执行：

```bash
scp -r kb root@服务器IP:/opt/kb
```

然后登录服务器：

```bash
cd /opt/kb
sudo bash deploy.sh
```

脚本会自动安装 Docker，询问 **域名、登录密码、DeepSeek Key**，然后构建并启动。HTTPS 证书由 Caddy 自动向 Let's Encrypt 免费申请、自动续期，不需要手动操作。

完成后用手机 Chrome 打开 `https://你的域名`，输入密码登录。

> 首次构建会下载 Python 镜像和 OCR 语言包，香港服务器一般 2~3 分钟。

**也可以先在自己电脑上填好配置**：照 `.env.example` 写一份 `config.txt`，上传到服务器存成 `/opt/kb/.env`（`scp config.txt root@服务器IP:/opt/kb/.env`），再执行 `deploy.sh`。这时脚本不会再提问。注意 `SECRET_KEY` 必须有值（`openssl rand -hex 32` 生成），空着程序会启动失败。`config.txt` 里有密码和 Key，已写进 `.gitignore`，不要提交到 Git。

## 三、安装到安卓手机（关键一步）

只有「安装」后，知识库才会出现在系统分享菜单里：

1. 用 **Chrome** 打开你的网址并登录。
2. 右上角菜单 → **「添加到主屏幕」/「安装应用」** → 安装。
3. 之后在任何 App 里点「分享」，就能看到「知识库」。

> 华为、小米等自带浏览器多数不支持把网页安装为可分享的应用，请用 Chrome（没有应用商店可以去 Chrome 官网下载 APK）。

## 四、日常使用

| 场景 | 做法 |
|---|---|
| 网页文章（Chrome 等） | 分享 → 知识库。几秒到几十秒后自动整理完成 |
| 公众号 | 「···」→「复制链接」，打开知识库点「📋 粘贴链接收藏」。正文和配图都会保存 |
| 小红书 | 分享面板里没有系统分享，同样「复制链接」→ 打开知识库 → 粘贴收藏。配图里的文字会被识别并整理，笔记不存原图，末尾有「查看原文」链接回到小红书 |
| 知乎 | 知乎会拒绝服务器抓取（403），请对回答**截图**后分享给知识库 |
| 抓取失败（被反爬） | 笔记标题会显示「××链接（未能抓取正文）」并给出原因；对帖子**截图**，把截图分享给知识库（或在「＋收藏」里上传），会自动识别文字再整理 |
| 自己写 | 点「写笔记」，支持 Markdown 和插图 |
| 搜索 | 顶部搜索框，支持中文；`#标签` 只按标签筛选 |
| 不满意 AI 整理结果 | 笔记页点「重新整理」，或直接「编辑」 |

**关于图片文字识别**：截图、小红书配图都会先识别文字。DeepSeek 不支持看图，所以识别这一步交给视觉模型，推荐阿里云百炼的通义千问 VL，在 `.env` 填：

```
VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_API_KEY=sk-xxx
VISION_MODEL=qwen3-vl-plus
```

不配视觉模型时用服务器本地的 OCR（tesseract），效果一般。识别出的文字会交给 DeepSeek 整理：保留观点、步骤、清单等有用内容（清单条目全部保留），去掉水印、页码、"关注/点赞收藏"、推广引流等杂质。图片多的笔记一般 30 秒到 1 分钟整理完。

**离线/未登录时分享**：分享内容会先暂存在手机上，下次打开知识库（登录后）自动提交，不会丢。

## 五、配置说明（`.env`）

| 变量 | 说明 |
|---|---|
| `DOMAIN` | 你的域名 |
| `ADMIN_PASSWORD` | 登录密码。连续输错 5 次会锁定该 IP 15 分钟 |
| `SECRET_KEY` | 会话签名密钥，必须有值（deploy.sh 自动生成，手动准备 `.env` 时自己填）；改了会让所有设备重新登录 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | AI 接口。换服务商只改这三行。不填则不做 AI 整理，只保存抓取结果 |
| `VISION_*` | 可选的视觉模型，用于识别截图和小红书配图里的文字 |
| `BACKUP_HOUR` / `BACKUP_KEEP` | 每天几点备份（北京时间）、本地保留几份 |
| `OSS_*` | 可选，备份同步到阿里云 OSS |

改完 `.env` 后执行 `docker compose up -d` 生效。

**换 AI 服务商示例**（通义千问）：

```
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=qwen-plus
```

## 六、备份与恢复

- 每天凌晨 4 点自动打包到 `backups/kb-日期.tar.gz`，内含 `kb.db`、`notes/*.md`、`media/` 图片。
- **同步到 OSS（推荐）**：在 OSS 控制台建一个私有 Bucket（香港地域），创建一个只有该 Bucket 写权限的 RAM 子账号 AccessKey，填进 `.env`：
  ```
  OSS_ENDPOINT=https://oss-cn-hongkong-internal.aliyuncs.com   # 同地域内网，免流量费
  OSS_BUCKET=你的bucket名
  OSS_ACCESS_KEY_ID=...
  OSS_ACCESS_KEY_SECRET=...
  ```
- **手动导出**：浏览器打开 `https://你的域名/api/export`（需已登录）即可下载一份完整备份。
- **恢复**：
  ```bash
  docker compose down
  mkdir -p data && tar xzf backups/kb-xxxx.tar.gz -C data
  docker compose up -d
  ```
- **迁走**：`data/notes/` 里就是标准 Markdown 文件（带 front matter），图片在 `data/media/`，可直接拷到 Obsidian 等工具。

## 七、更新与运维

```bash
cd /opt/kb
# 用新代码覆盖（保留 .env、data、backups），然后：
sudo bash deploy.sh          # 重新构建并重启
docker compose logs -f app   # 查看日志
docker compose restart app   # 重启
```

## 八、目录结构

```
kb/
├── app/
│   ├── main.py        # 接口、登录、页面
│   ├── capture.py     # 抓取：短链展开、正文/图片、小红书解析、图片文字识别、失败提示
│   ├── llm.py         # OpenAI 兼容的 AI 调用（整理 + 视觉识别）
│   ├── db.py          # SQLite + 全文搜索 + Markdown 镜像
│   ├── backup.py      # 每日备份 / OSS
│   └── static/        # 前端 PWA（无构建步骤，原生 JS）
├── Dockerfile
├── docker-compose.yml # app + Caddy(自动 HTTPS)
├── Caddyfile
├── deploy.sh          # 一键部署/更新
└── .env.example
```

## 安全提示

- 整个站点（包括图片）都需要登录才能访问；会话有效期 180 天。
- 密码尽量长一些；`.env`、`config.txt`、服务器私钥（`*.pem`）不要上传到 Git 仓库，`.gitignore` 里已经排除。
- 服务器上可以只开放 22/80/443 端口。

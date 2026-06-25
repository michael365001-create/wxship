# 物流查询系统 - 项目配置备份

> 此文件用于跨设备恢复项目上下文。换电脑后克隆此仓库，AI助手读取此文件即可继续开发。

## 核心架构

| 组件 | 文件 | 说明 |
|------|------|------|
| 客户查询页 | index.html | 只读查询，输入手机后4位尾号 |
| 管理后台 | panel_m7Kx9.html | 密码保护 + 随机文件名防猜测 |
| 数据存储 | 腾讯云 COS | orders.json，**私有ACL**，仅Worker可访问 |
| 安全代理 | Cloudflare Worker | 签名认证COS，密钥存在Worker环境变量中 |
| 网页托管 | GitHub Pages | 永久免费，不过期 |

## 安全架构（Cloudflare Worker 代理）

```
客户查询页 (公开) → Worker GET /api/orders → COS (私有，签名读取)
管理后台 (公开) → Worker PUT /api/orders → COS (私有，签名写入，需密码)
管理后台 (公开) → Worker GET /api/verify → 验证管理密码
```

**密钥安全**: 腾讯云密钥存储在 Cloudflare Worker 环境变量中，前端代码中**无任何密钥**。

## 访问地址

| 页面 | URL |
|------|-----|
| 客户查询页 | https://michael365001-create.github.io/wxship/ |
| 管理后台 | https://michael365001-create.github.io/wxship/panel_m7Kx9.html |
| Worker API | https://wxship-proxy.michael365001.workers.dev/api/orders |
| COS 数据文件 | 已设为私有，直接访问返回403 |

## Cloudflare Worker 配置

| 项目 | 值 |
|------|-----|
| Worker 名称 | wxship-proxy |
| Worker 地址 | https://wxship-proxy.michael365001.workers.dev |
| 管理密码 | 存储在 Worker 环境变量 ADMIN_PASSWORD 中 |
| 腾讯云密钥 | 存储在 Worker 环境变量 SECRET_ID / SECRET_KEY 中 |

**Worker 代码**: 见仓库 `worker.js` 文件

## 腾讯云 COS 配置

| 项目 | 值 |
|------|-----|
| Bucket | wxship-1319668533 |
| Region | ap-guangzhou |
| APPID | 1319668533 |
| 数据文件 ACL | **private**（已关闭公开访问） |
| 防盗链 | 白名单模式（github.io / localhost） |

**密钥获取方式**: 密钥存储在 Cloudflare Worker 环境变量中，不在任何前端代码里。登录 Cloudflare Dashboard → Workers → wxship-proxy → Settings → Variables and Secrets 可查看。

## GitHub 配置

| 项目 | 值 |
|------|-----|
| 用户名 | michael365001-create |
| 仓库 | https://github.com/michael365001-create/wxship |
| 构建方式 | GitHub Actions workflow (build_type=workflow) |
| 部署文件 | .github/workflows/static.yml |

## 数据结构 (orders.json)

每个订单对象包含以下字段：

```json
{
  "id": "唯一ID (Date.now()+random)",
  "phone": "11位手机号",
  "name": "收件人姓名",
  "trackNo": "快递单号(可后补，空则待发货)",
  "product": "产品名称(可选)",
  "status": "pending|shipped|delivered|problem",
  "createdAt": "ISO日期字符串"
}
```

## 去重策略

- 有快递单号 → 以单号为唯一标识（同一单号不重复新增）
- 无快递单号（待发货） → 以手机号去重（同一客户不重复新增）
- 重复导入时自动合并更新，提示「新增X条/更新X条」

## 技术要点

- 客户页: fetch GET Worker API → Worker签名读取COS
- 管理后台: fetch PUT Worker API (带X-Admin-Password头) → Worker签名写入COS
- 前端代码中**无任何密钥**，密钥只存在于 Worker 环境变量
- COS 数据文件 ACL 为 private，直接访问返回 403
- COS 已配置 Referer 防盗链（白名单模式，双保险）
- 每次查询加 ?t=Date.now() 防止缓存
- 文件导入使用 SheetJS (xlsx.full.min.js) CDN
- Worker 使用 COS SHA1 签名算法（crypto.subtle），无需额外依赖

## 已知限制

- COS 2024年1月后新建存储桶默认域名强制下载 (Content-Disposition:attachment)，无法关闭
- 2022年5月后COS不再支持新增默认CDN加速域名
- 因此使用 GitHub Pages 托管页面，COS仅存数据

## 自定义域名

- 域名: alibaba-ag.com (已购买)
- 待ICP备案完成后可绑定到COS + CDN加速
- 备案需要云服务器资源（轻量应用服务器约38元/年）

## 修改代码流程

1. 本地修改 HTML 文件
2. 复制到 GitHub 仓库目录: `cp 文件 /tmp/wxship/`
3. 提交推送: `cd /tmp/wxship && git add . && git commit -m "说明" && git push`
4. GitHub Actions 自动部署到 Pages (约1-2分钟生效)
5. 数据变更通过管理后台操作，自动写入COS

## 迁移历史

- CloudStudio + localStorage → MantleDB (跨设备共享)
- MantleDB → 腾讯云 COS (永久存储+无条数限制)
- CloudStudio (会过期) → 腾讯云 COS 静态网站 (永久)
- COS默认域名强制下载 → GitHub Pages (永久免费)
- 密钥暴露在前端 → Cloudflare Worker 代理 (密钥移至后端，COS设为私有)

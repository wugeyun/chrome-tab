# 武哥新标签页 · 同步 Worker

匿名密文同步服务，部署到 Cloudflare Workers + KV，对外域名：`https://tab.wuge.xyz`。

## 免费额度

Cloudflare Workers / KV 免费档对个人扩展用量通常足够，无需付费。

## 一次性部署

```bash
cd sync-worker
npm install
npx wrangler login
npx wrangler kv namespace create SYNC_KV
```

把输出的 `id` 填进 [`wrangler.toml`](./wrangler.toml) 的 `[[kv_namespaces]].id`。

```bash
npx wrangler deploy
```

### 绑定自定义域名

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → `wuge-newtab-sync`
2. Domains & Routes → **Custom Domains** → 添加 `tab.wuge.xyz`
3. 确认 `wuge.xyz` 已在同一账号托管 DNS

也可在 `wrangler.toml` 中配置 zone route 后重新 deploy。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/sync/:id` | 取密文；不存在时 `revision: 0`、`ciphertext: null` |
| `PUT` | `/v1/sync/:id` | 写密文；需 `If-Match: "<revision>"` 或 body.`revision`；冲突返回 `409` |

`:id` 为 24 位小写 hex（12 字节）。服务端不解密、不存同步码。

## 本地调试

```bash
npx wrangler kv namespace create SYNC_KV --preview
# 把 preview_id 写入 wrangler.toml 后：
npx wrangler dev
```

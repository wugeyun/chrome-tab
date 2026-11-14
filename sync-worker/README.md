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

改动 Worker 代码后需重新 `npx wrangler deploy` 才会生效（扩展侧 `shared.js` 随扩展发布即可）。

### 绑定自定义域名

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → `wuge-newtab-sync`
2. Domains & Routes → **Custom Domains** → 添加 `tab.wuge.xyz`
3. 确认 `wuge.xyz` 已在同一账号托管 DNS

也可在 `wrangler.toml` 中配置 zone route 后重新 deploy。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/sync/:id` | 取密文；不存在时 `revision: 0`、`ciphertext: null`；已作废返回 `410` |
| `PUT` | `/v1/sync/:id` | 写密文；需 `If-Match: "<revision>"` 或 body.`revision`；冲突 `409`；已作废 `410`；**新建空槽**需 `X-PoW` |
| `DELETE` | `/v1/sync/:id` | 作废槽位：删除密文并标记 `revoked`，禁止再用旧码写回 |

`:id` 为 24 位小写 hex（12 字节）。服务端不解密、不存同步码。

## 防滥用

| 措施 | 说明 |
|------|------|
| 分方法限流 | 按 IP：`GET` 约 60/分钟，`PUT`/`DELETE` 约 20/分钟 |
| 新建槽 PoW | 空槽首次 `PUT` 需请求头 `X-PoW: <nonce>`，满足 `SHA-256(id + ":" + nonce)` 前 18 bit 为 0 |
| KV TTL | 成功写入后条目保留 90 天；每次写入刷新。长期未同步的密文自动删除；同步码本身仍有效，再次同步会重建槽位 |

日常同步（已有槽位）不要求 PoW；仅创建/轮换/云端过期后重建时计算一次。

## 本地调试

```bash
npx wrangler kv namespace create SYNC_KV --preview
# 把 preview_id 写入 wrangler.toml 后：
npx wrangler dev
```

# Haochi 号池系统设计与交付说明

## 1. 目标

在现有 `jimeng-api` 的 OpenAI 兼容接口之上，补出一套可直接部署的 Dreamina 号池系统：

- 管理员登录后才能编辑
- 前端 WebUI 管理账号与 API Key
- 账号密码自动登录 Dreamina，自动获取 SessionID
- Session 到期前自动续期
- 外部调用方使用独立 API Key
- `/v1/images/*`、`/v1/videos/*`、`/v1/chat/*` 自动从健康账号池里取号
- 当账号失效或积分耗尽时自动拉黑并切换下一个账号
- 支持 Docker 部署

## 2. 当前实现结构

### 2.1 后端模块

- `src/haochi/storage/state-store.ts`
  - 用 JSON 持久化状态，默认路径 `data/haochi/state.json`
  - 持久化管理员、账号池、API Key、调度配置
  - 显式设置的 `HAOCHI_*` 调度环境变量会在启动时覆盖同名旧配置并回写
- `src/haochi/services/admin-auth-service.ts`
  - 管理员登录、Cookie 会话、改密
  - 默认初始化管理员：`admin / ChangeMe123!`
- `src/haochi/services/login-provider.ts`
  - `DreaminaLoginProvider`：参考 `jimengdl` 的登录/取 Cookie 逻辑
  - 支持按账号启动独立浏览器实例，并在登录阶段注入账号代理
  - `MockLoginProvider`：用于自动化测试
- `src/haochi/services/account-pool-service.ts`
  - 账号 CRUD / API Key CRUD
  - 账号批量导入
  - Session 刷新、校验、黑名单
  - 并发租约计数
  - 外部 API Key 自动路由与失败切换
  - 调用上游接口时自动把账号代理拼接进请求 token
- `src/api/routes/haochi-admin.ts`
  - 管理后台接口
- `src/api/routes/haochi-web.ts`
  - `/admin` 管理页面和静态资源
- `src/haochi/services/admin-log-service.ts`
  - 读取当日日志文件中的 `[OUTBOUND]` 外部调用日志，供后台 UI 查看

### 2.2 前端 WebUI

- `public/admin/index.html`
- `public/admin/styles.css`
- `public/admin/app.js`

提供：

- 登录页
- 实时总览
- 账号池 CRUD
- 账号批量导入
- 账号代理配置
- 手动刷新 Session / 校验 Session / 拉黑 / 解除拉黑
- API Key CRUD / 重置 / 常显复制
- 管理员密码修改
- 最近动作日志与新签发密钥回显
- 后端真实外部调用日志查看与手动刷新

### 2.3 旧接口接入方式

以下原有接口已接入号池调度：

- `POST /v1/images/generations`
- `POST /v1/images/compositions`
- `POST /v1/videos/generations`
- `POST /v1/chat/completions`

调用凭据支持两种模式：

1. 兼容旧模式
   - `Authorization: Bearer <sessionid[,sessionid2...]>`
2. 新号池模式
   - `X-API-Key: <haochi_xxx>`
   - 或 `Authorization: Bearer <haochi_xxx>`

当请求命中新号池模式时：

1. 解析外部 API Key
2. 校验该 Key 是否有对应能力权限
3. 从健康账号中挑选最合适的账号
4. 若 Session 过期或即将过期，先自动刷新
5. 执行上游请求
6. 若命中“失效 / 积分不足(1006) / 当日生成额度耗尽(121101)”则自动拉黑该账号并切换下一个账号

账号如果配置了代理：

1. 登录 Dreamina 时浏览器会带上该代理
2. 调用 Dreamina 接口时也会复用同一代理

## 3. 数据模型

### 3.1 管理员

- `username`
- `passwordHash`
- `needsPasswordChange`
- `lastLoginAt`

### 3.2 账号

- `email`
- `password`
  - 若配置了 `HAOCHI_ACCOUNT_SECRET`，会以 AES-GCM 加密后落盘
- `proxy`
  - 支持 `http/https/socks5`
  - 登录和上游调用都会复用该代理
- `sessionTokens`
  - 主要使用 `sessionid`
- `notes`
- `status`
  - `idle / healthy / refreshing / expired / invalid / insufficient_credit / blacklisted / disabled / error`
- `blacklistedReason`
- `blacklistReleaseAt`
  - 仅当账号因积分不足或当日生成额度耗尽被临时拉黑时写入
  - 当前按 `Asia/Shanghai` 的次日 00:00 自动解除拉黑
- `maxConcurrency`
- `successCount / failureCount`
- `lastLoginAt / lastValidatedAt / sessionExpiresAt`

### 3.3 API Key

- `name`
- `description`
- `allowedAbilities`
- `secretHash`
- `secretValue`
  - 用于后台常显和复制 API Key 原文
  - 若配置了 `HAOCHI_ACCOUNT_SECRET`，会以 AES-GCM 加密后落盘
- `keyPreview`
- `rawKey / rawKeyLocked`
  - 管理后台返回值中的原文字段和是否可解密标记
- `lastUsedAt`

## 4. 调度策略

### 4.1 选号

优先级：

1. 当前租约占用更低
2. 状态更健康
3. 最近使用时间更早

### 4.2 自动刷新

默认配置：

- `sessionTtlMinutes=360`
- `sessionRefreshBufferMinutes=30`
- `maintenanceIntervalSeconds=180`

逻辑：

- 请求进来时先判断 Session 是否缺失或即将过期
- 请求执行中若命中 `session/token` 失效，会优先自动刷新当前账号并重试
- 后台维护定时器也会周期性刷新即将过期、已失效或已过期的账号

### 4.3 自动拉黑

以下情况会自动拉黑当前账号：

- 积分不足，包括错误信息含 `1006`
- 当日生成额度耗尽，包括错误信息含 `121101` 或 `daily generation limit`

拉黑后：

- 当前请求自动切换下一个账号重试
- 管理后台可手动解除拉黑
- 若是积分不足或当日生成额度耗尽导致的临时拉黑，会在 `Asia/Shanghai` 次日 00:00 自动解除

说明：

- 登录失效 / Token 失效不再直接拉黑，而是优先自动刷新 Session 并恢复上线

## 5. 管理接口

### 5.1 认证

- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`
- `GET /api/admin/auth/me`
- `POST /api/admin/auth/change-password`

### 5.2 账号池

- `GET /api/admin/accounts`
- `GET /api/admin/accounts/export`
- `POST /api/admin/accounts`
- `POST /api/admin/accounts/batch/update`
- `POST /api/admin/accounts/batch/delete`
- `POST /api/admin/accounts/batch/refresh-invalid-session`
- `POST /api/admin/accounts/batch/validate-session`
- `POST /api/admin/accounts/import`
- `PUT /api/admin/accounts/:id`
- `DELETE /api/admin/accounts/:id`
- `POST /api/admin/accounts/:id/refresh-session`
- `POST /api/admin/accounts/:id/validate-session`
- `POST /api/admin/accounts/:id/blacklist`
- `POST /api/admin/accounts/:id/unblacklist`

账号列表接口支持分页参数：

- `page`
  - 页码，从 `1` 开始
- `pageSize` / `page_size`
  - 每页条数，范围 `1-100`
- `status`
  - 可选：`all` / `healthy` / `invalid` / `blacklisted`
  - `invalid` 会同时包含 `expired` 与 `invalid` 两种失效状态

返回结构：

- `items`
- `page`
- `pageSize`
- `total`
- `totalPages`

账号对象补充字段：

- `region`
  - 由 `sessionid/sessionid_ss/sid_tt` 前缀推断
  - `jp-` / `us-` / `hk-` / `sg-` 分别表示日本 / 美国 / 香港 / 新加坡
  - 没有前缀时兼容按中国区处理

账号导出接口：

- `GET /api/admin/accounts/export`
  - 支持和列表一致的 `status=all|healthy|invalid|blacklisted` 筛选参数；不传时导出全部账号
  - 返回 `fileName`、`content`、`matchedCount`、`exportedCount`、`skippedCount`
  - `content` 为可直接回贴到“批量导入账号”的文本；注释行以 `#` 开头，现有导入器会自动忽略
  - 若某账号同时缺少密码和 SessionID，会在导出文本里写成注释说明，并计入 `skippedCount`

批量导入请求体支持：

- `text`
  - 每行一个账号，格式为 `邮箱----密码----代理(可选)----备注(可选)----SessionID(可选)`
  - 也支持 `邮箱----密码----Sessionid=xxx`，第三段会直接按 SessionID 解析
  - 也兼容制表符、`|`、`,` 分隔
- `defaultProxy`
- `defaultRegion`
  - 可选，写入导入账号的 SessionID 前缀
- `enabled`
- `autoRefresh`
- `maxConcurrency`
- `overwriteExisting`
  - 默认 `true`

批量管理接口：

- `POST /api/admin/accounts/batch/update`
  - 请求体支持 `ids` 或 `applyToAll=true`
  - 可同时传 `proxy` 和 `region`
  - `proxy=""` 表示清空代理
  - `region` 仍然通过 SessionID 前缀生效；没有 Session 的账号会跳过地区写回
- `POST /api/admin/accounts/batch/delete`
  - 请求体支持 `ids` 或 `applyToAll=true`
- `POST /api/admin/accounts/batch/refresh-invalid-session`
  - 一键刷新当前所有失效账号的 Session
  - 只处理未拉黑且状态为 `expired` / `invalid` 的账号
  - 返回 `matchedCount` / `refreshedCount` / `failedCount`
- `POST /api/admin/accounts/batch/validate-session`
  - 一键校验全部账号
  - 返回 `matchedCount` / `validCount` / `invalidCount` / `failedCount`

### 5.3 API Key

- `GET /api/admin/api-keys`
- `POST /api/admin/api-keys`
- `PUT /api/admin/api-keys/:id`
- `DELETE /api/admin/api-keys/:id`
- `POST /api/admin/api-keys/:id/rotate`

接口返回会额外携带：

- `rawKey`
- `rawKeyLocked`

说明：

- 新建和重置 API Key 时会直接持久化原文，后台列表可随时显示和复制
- 老数据若历史上只存了 hash，没有原文，则在该 key 首次成功调用受管接口后自动回填原文

### 5.4 总览

- `GET /api/admin/overview`

说明：

- 返回实时统计、设置和 API Key 列表
- `counts.totalCapacity` 表示当前账号池总并发承载
- 不再返回全量 `accounts`，避免后台首页在账号过多时一次性拉取整张账号表

## 6. Docker 部署

### 6.1 直接启动

```bash
docker compose up -d --build
```

### 6.2 首次访问

- 管理后台：`http://<host>:5100/admin`
- 健康检查：`http://<host>:5100/ping`

默认管理员：

- 用户名：`admin`
- 密码：`ChangeMe123!`

如果直接使用仓库里的 `docker-compose.yml`，示例环境变量也使用这组默认值。

首次登录后应立即修改：

- 后台右侧“管理员密码”表单
- 或在部署时通过环境变量覆盖

注意：

- `HAOCHI_ADMIN_USERNAME` / `HAOCHI_ADMIN_PASSWORD` 只会在 `admins` 为空时初始化一次
- 如果 `data/haochi/state.json` 已存在，容器重启或改环境变量不会覆盖旧密码
- 但显式设置的 `HAOCHI_SESSION_*`、`HAOCHI_MAINTENANCE_INTERVAL_SECONDS`、
  `HAOCHI_PROXY_MAX_CONCURRENCY`、`HAOCHI_MAX_REQUEST_RETRIES`、
  `HAOCHI_ALLOW_LEGACY_AUTHORIZATION`、`HAOCHI_LOGIN_PROVIDER`
  会在启动时覆盖 `state.json` 里的同名旧设置
- Docker 挂载了旧数据卷时，请优先使用历史密码登录，或在确认影响范围后删除状态文件重新初始化

### 6.3 关键环境变量

- `HAOCHI_ADMIN_USERNAME`
- `HAOCHI_ADMIN_PASSWORD`
- `HAOCHI_ACCOUNT_SECRET`
- `HAOCHI_STATE_PATH`
- `HAOCHI_LOGIN_PROVIDER`
  - 生产：`dreamina`
  - 测试：`mock`
- `HAOCHI_LOGIN_HEADLESS`
  - Docker 默认 `1`
  - 若首登遇到验证码，建议本地临时改 `0` 人工辅助一次
- `HAOCHI_PROXY_MAX_CONCURRENCY`
  - 默认 `0`，表示不限制同一代理出口的并发
  - 如果多个账号共用同一条代理，建议先从 `1` 或 `2` 开始，减少上游排队和代理拒连
  - 如果账号已经分散到多条代理，这个值可以帮助调度优先把请求摊到不同出口
- `PUPPETEER_EXECUTABLE_PATH`
  - Docker 默认 `/usr/bin/chromium-browser`

## 7. 外部调用示例

### 7.1 图片生成

```bash
curl http://127.0.0.1:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "X-API-Key: haochi_xxx" \
  -d '{
    "model": "jimeng-4.0",
    "prompt": "一只坐在窗边的橘猫，电影感，清晨光线"
  }'
```

### 7.2 视频生成

```bash
curl http://127.0.0.1:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "X-API-Key: haochi_xxx" \
  -d '{
    "model": "jimeng-video",
    "prompt": "海边慢镜头，胶片颗粒感"
  }'
```

### 7.3 Chat 兼容调用

```bash
curl http://127.0.0.1:5100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: haochi_xxx" \
  -d '{
    "model": "jimeng-4.0",
    "messages": [
      { "role": "user", "content": "请生成一张赛博朋克城市夜景" }
    ]
  }'
```

## 8. 测试与验证

当前仓库已补自动化测试：

- `tests/haochi-admin-http.test.ts`
  - 验证后台登录、账号 CRUD、批量导入、Session 刷新、Session 校验、API Key CRUD
- `tests/haochi-pool-rotation.test.ts`
  - 验证失效自动切换与拉黑
  - 验证积分不足自动切换与拉黑
  - 验证批量导入后的代理在调度请求时会自动透传

本地验证命令：

```bash
npm run type-check
npm run build
npm test
```

## 9. 现实约束

### 9.1 已自动化覆盖的部分

- 管理后台
- 账号池调度
- Session 持久化
- API Key 鉴权
- 自动切换 / 自动拉黑
- Docker 镜像构建链路

### 9.2 需要真实账号才能做最终验收的部分

- Dreamina 真站自动登录是否触发验证码
- 真正的 Session 有效期和风控行为
- 真图/真视频生成的上游稳定性

现有代码已经把这些链路接好；自动化测试使用 `mock` 登录提供器做闭环验证，真实环境请导入实际账号做最终联调。

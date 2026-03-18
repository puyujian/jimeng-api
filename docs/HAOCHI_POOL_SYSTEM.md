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
- `src/haochi/services/admin-auth-service.ts`
  - 管理员登录、Cookie 会话、改密
  - 默认初始化管理员：`admin / ChangeMe123!`
- `src/haochi/services/login-provider.ts`
  - `DreaminaLoginProvider`：参考 `jimengdl` 的登录/取 Cookie 逻辑
  - `MockLoginProvider`：用于自动化测试
- `src/haochi/services/account-pool-service.ts`
  - 账号 CRUD / API Key CRUD
  - Session 刷新、校验、黑名单
  - 并发租约计数
  - 外部 API Key 自动路由与失败切换
- `src/api/routes/haochi-admin.ts`
  - 管理后台接口
- `src/api/routes/haochi-web.ts`
  - `/admin` 管理页面和静态资源

### 2.2 前端 WebUI

- `public/admin/index.html`
- `public/admin/styles.css`
- `public/admin/app.js`

提供：

- 登录页
- 实时总览
- 账号池 CRUD
- 手动刷新 Session / 校验 Session / 拉黑 / 解除拉黑
- API Key CRUD / 重置
- 管理员密码修改
- 最近动作日志与新签发密钥回显

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
6. 若命中“失效 / 积分不足(1006)”则自动拉黑该账号并切换下一个账号

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
- `sessionTokens`
  - 主要使用 `sessionid`
- `status`
  - `idle / healthy / refreshing / expired / invalid / insufficient_credit / blacklisted / disabled / error`
- `blacklistedReason`
- `maxConcurrency`
- `successCount / failureCount`
- `lastLoginAt / lastValidatedAt / sessionExpiresAt`

### 3.3 API Key

- `name`
- `description`
- `allowedAbilities`
- `secretHash`
- `keyPreview`
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
- 后台维护定时器也会周期性刷新即将过期的账号

### 4.3 自动拉黑

以下情况会自动拉黑当前账号：

- 登录失效 / Token 失效
- 积分不足，包括错误信息含 `1006`

拉黑后：

- 当前请求自动切换下一个账号重试
- 管理后台可手动解除拉黑

## 5. 管理接口

### 5.1 认证

- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`
- `GET /api/admin/auth/me`
- `POST /api/admin/auth/change-password`

### 5.2 账号池

- `GET /api/admin/accounts`
- `POST /api/admin/accounts`
- `PUT /api/admin/accounts/:id`
- `DELETE /api/admin/accounts/:id`
- `POST /api/admin/accounts/:id/refresh-session`
- `POST /api/admin/accounts/:id/validate-session`
- `POST /api/admin/accounts/:id/blacklist`
- `POST /api/admin/accounts/:id/unblacklist`

### 5.3 API Key

- `GET /api/admin/api-keys`
- `POST /api/admin/api-keys`
- `PUT /api/admin/api-keys/:id`
- `DELETE /api/admin/api-keys/:id`
- `POST /api/admin/api-keys/:id/rotate`

### 5.4 总览

- `GET /api/admin/overview`

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

首次登录后应立即修改：

- 后台右侧“管理员密码”表单
- 或在部署时通过环境变量覆盖

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
  - 验证后台登录、账号 CRUD、Session 刷新、Session 校验、API Key CRUD
- `tests/haochi-pool-rotation.test.ts`
  - 验证失效自动切换与拉黑
  - 验证积分不足自动切换与拉黑

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

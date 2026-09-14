# @arcaneorion/dsh-tavily-web

DSH 的 Tavily 检索 + 网页抓取能力层（host 半，profile bundle）。注册两个模型可见工具，并把自身作为
**唯一的 fetch provider** 挂进宿主 `web` 注册表。

- **`tavily_search`** —— Tavily 检索，返回 `{ sources: [{url, title, snippet, publishedAt}], truncated, content? }`。
  **多 key 轮询池**：单账号额度耗尽不再等于工具失效。
- **`web_fetch`** —— 经 shell seam 的 `curl` 抓单页，返回 HTTP 状态 + 去标签正文。不依赖 Tavily，无 key 需求。

检索**不**注册为 `web.search()` 的 provider：旁边已有出厂的 DeepSeek 检索 provider，再挂一个可用
provider 会让 `web.search()` 的选择变歧义。检索只以模型可见工具的形式存在。

## 文件

| 文件 | 说明 |
|---|---|
| `src/tavily-web.ts` | 全部实现：配置 schema、key 池、检索、抓取、工具注册 |
| `cordis.patch.yml` | bundle 声明（行 id `tavily-web`），已挂载进 `web` profile |
| `tests/pool.test.cjs` | 池行为离线用例（脚本化 shell，不联网、不消耗额度） |
| `tests/live-pool-check.cjs` | 真实密钥 + 真实网络的端到端探针 |

## key 池

Tavily 的额度是**按 key 计**的，一个账号用尽不该把整个工具带走。池按引用名轮询，并按 key 的健康状况退避：

| 情况 | 处理 |
|---|---|
| HTTP 200 | 该 key 解除退避；游标前移，下次调用从下一把开始（轮询铺开） |
| 401 | 判为**常驻失效**（密钥本身被拒），本轮及后续跳过 |
| 403 / 429 / 432 | 退避 `cooldownSeconds`，到期自动回池 |
| 400 / 5xx / 传输失败 | **立即抛出，不烧池**——这类失败换 key 也救不回来，试下去只会掩盖真问题 |

三个设计要点：

1. **按引用名寻址，缓存 key 值。** credentials 服务要求"每次操作重新 resolve"（改过的凭据必须在下一次调用生效，
   无需重启），所以池只保存引用名；每次调用现取现用。
2. **指纹而非密钥。** 池为每个条目存一个 FNV-1a 指纹，用来识别*同一个引用名下换了一把新密钥*——指纹变了就立刻
   解除退避。因此"把 `TAVILY_API_KEY` 的值改成一个新账号"会即时生效，而不会被旧的退避状态挡住。
3. **最后一轮兜底重试。** 所有健康 key 都失败后，被退避的 key 会再试一次。配额重置后无需重启即可自动恢复，
   且失败时报的是 API 原话，而不是含糊的"所有 key 都在退避中"。

全池失败时错误里逐把列出原因，便于直接定位：

```
tavily search: all 8 key(s) in the pool failed
  - TAVILY_API_KEY: HTTP 432 — This request exceeds your plan's set usage limit. (retry after 2026-09-14T04:59:52Z)
  - TAVILY_API_KEY_2: not configured
  ...
```

## 为什么默认池是 8 个名字

credentials 服务**故意不提供引用枚举**（"the reference half, which has no enumeration"）——配置面是从 schema
得知存在哪些引用的，而不是从服务。所以池成员必须预先声明。于是默认值直接写成
`TAVILY_API_KEY`、`TAVILY_API_KEY_2` … `TAVILY_API_KEY_8` 整个家族：未配置的名字 resolve 回来是 `undefined`，
被池直接跳过、零成本、零报错。

**因此加第二把 key 不需要改任何 composition**，只要：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  TAVILY_API_KEY: tvly-dev-...
  TAVILY_API_KEY_2: tvly-dev-...
```

## 配置

全部可选，默认值即上文的家族。要覆盖时改用户层
`~/.dsh/profiles/<profile>/cordis.patch.yml`（在所有 bundle 层之后应用），而不是改本包自带的 patch：

```yaml
- id: tavily-web
  config:
    keyRefs: [TAVILY_API_KEY, TAVILY_WORK_KEY]   # 整体替换默认家族
    apiKeys: []                                  # 字面量 key，排在 keyRefs 之后；密钥更该放 seam
    cooldownSeconds: 900                         # 403/429/432 后的退避秒数
```

`keyRefs` 与代码共用一个 `DEFAULT_KEY_REFS` 常量，避免"schema 声明的默认"与"运行时实际生效的默认"漂移。

## 加载/验证

```bash
node tests/pool.test.cjs        # 离线用例；VERIFY_TAVILY_KEY=<key> 时额外跑一项真实网络用例
node tests/live-pool-check.cjs  # 真实凭据 + 真实网络，打印每次调用实际用了哪把 key

# 改了包源后：host 插件不走热重载，必须重启 dsh --profile web
# 启动日志出现 (key pool: N ref(s), cooldown 900s) 即表示新代码已加载
```

## 踩坑：curl 的错误体是合法 JSON

Tavily 的报错体（如 432 的 `{"detail":{"error":"..."}}`）是**合法 JSON**，而 `curl` 遇到 HTTP 错误
**退出码仍是 0**。于是"不检查状态码"的写法会一路顺利走完：退出码 0 → `JSON.parse` 成功 → `data.results`
为 `undefined` → 返回 `{sources: [], truncated: false}`。

**任何** API 错误（401/429/432）都长得像"搜到 0 条结果"，无法自证。因此检索的 `curl` 必须带
`-w '%{http_code}'` 取回状态码并在解析前判定；这也是本插件唯一处对 curl 的硬性要求。

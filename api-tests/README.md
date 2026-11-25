# api-tests（链路脚本）

`api-tests/script/*.http` 是用 IntelliJ HTTP Client 的 DSL 写的**真实 HTTP 链路断言**：起一个只在本机监听、
把 `lib/` 整套真实实现装起来的 harness，然后让脚本按真实协议打过去。断言逻辑全在脚本里，所以换执行器
（`ijhttp` 或仓内的 `test/api-script-runner.mjs`）得到的是同一个结论。

| 脚本                                  | 覆盖                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `script/provider-registry-chain.http` | provider 列举 / 状态投影 / 账号与连接器分组 / 面板扁平路由 / 参数校验 |
| `script/connector-oauth-chain.http`   | 连接器授权三段式、poll 落盘、copy-config 不写宿主、remove 与磁盘对账  |

## 怎么跑

三步，缺一步就会红出「假问题」（变量没解析、装配漏件、端口没起）。

```bash
# 1) 起 harness（真实装配、出网被钉死、临时 profile 用后即删）
node test/api-http-server.mjs
# -> API_HARNESS_READY port=39320 dataDir=<临时目录>

# 2) 跑脚本（另开一个终端）
ijhttp api-tests/script/provider-registry-chain.http \
  -v api-tests/http-client.env.json -e bce4b8
ijhttp api-tests/script/connector-oauth-chain.http \
  -v api-tests/http-client.env.json -e bce4b8

# 3) 收尾：Ctrl+C 关 harness（会连带删掉它自己建的临时 profile）
```

`-v` 与 `-e` 两个都要给：`ijhttp` 只在**脚本同目录**里找 `http-client.env.json`，本仓把它放在
`api-tests/` 下统一管，所以必须显式指路并点环境名。期望输出：

```
11 requests completed, 0 have failed tests
RUN SUCCESSFUL
```

`connector-oauth-chain.http` 同理，期望 `17 requests completed, 0 have failed tests`。

没装 `ijhttp` 时用仓内执行器（同一份 env、同样的退出码语义）：

```bash
node test/api-script-runner.mjs api-tests/script/provider-registry-chain.http
# -> requests=11 tests=11 failed=0
```

## 回归入口

`npm test` 里的 `test/api-http-chain.test.mjs` 会自己起 harness（0 端口，不占 39320）、跑上面两条脚本，
并带两条反向控制：**塞一条必然失败的断言必须被计数**、**整块消失时请求块数必须对不上**。所以「脚本全绿」
不再是手工证据，而是每次跑用例都会重新验一遍的结论。

## 加一条链路时

1. 在 `script/` 下加脚本，断言直接打到真实应答上（不要在 harness 里塞返回值假数据）。
2. 在 `test/api-http-chain.test.mjs` 的 `CHAINS` 里登记脚本与该脚本的**请求块数**——块数是对账锚点，
   少一块会立刻红。
3. harness 只允许暴露 `/__test/*` 这类明确标注的夹具端点（模拟上游回调、读落盘快照），生产路由一律走
   `lib/` 的真实注册函数；新增依赖也照此装配，不要用返回值空壳顶上。

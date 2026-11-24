# 最小可用 provider（契约活样例）

这份样例只做一件事：证明 provider 契约**真的能被注册、列举、按域派发**。
它读同目录的 `data/experts.json`，不联网、不登录、不写盘。

- 不随包发布：`package.json` 的 `files` 不含 `examples`。
- 不进 `lib/`：样例是给人抄的，改它不该影响宿主行为，也不该被宿主的测试当作实现。
- 只声明 `expertMarket`：其余四域在派发层统一回 `BAZAAR_CAPABILITY_UNDECLARED`——这是「声明面决定可用域」的活样例。

## 跑一遍

```bash
node examples/minimal-provider/index.mjs
```

期望输出四行（顺序固定）：

```
register: true
list: ["minimal-example"]
listExperts: {"ok":true,"items":[…],"total":3,"source":"local-json"}
未声明域被拦: {"ok":false,"code":"BAZAAR_CAPABILITY_UNDECLARED",…}
```

自检走的是宿主的真实注册表与派发层（`lib/provider/registry.js`、`lib/provider/dispatch.js`），
不是样例自己写的模拟。所以这四行同时也是契约的最小回归。

## 抄它的时候注意三件事

1. **只声明你真的实现了的域**。声明了却没给方法，注册期就会以 `BAZAAR_PROVIDER_IMPL_MISSING` 被拒——
   失败的 id 不占位，界面上也不会出现一个点进去就报错的页签。
2. **失败返回 `{ok:false, code, message}`，不要 throw**。域方法抛出的异常会被边界层折成
   `BAZAAR_PROVIDER_THROWN`，那一条日志等于承认「我违约了」。
3. **成功返回领域结构本身**（`{items,total,source}` / `{item}`），不套 `{ok:true}`。
   外层信封由注册表与派发层加，自己再加会得到两层壳。

## 文件

| 文件                | 作用                                          |
| ------------------- | --------------------------------------------- |
| `index.mjs`         | 契约对象 `createMinimalProvider()` + 自检入口 |
| `data/experts.json` | 三条示例专家记录（离线数据源）                |

数据的形状（`experts.json`）：

```json
{
  "version": 1,
  "experts": [
    {
      "id": "demo-writer",
      "name": "…",
      "summary": "…",
      "categoryId": "writing",
      "category": "写作",
      "tags": ["…"],
      "prompt": "…"
    }
  ]
}
```

字段说明：`id` 在库内唯一（`getExpert` 按它查）；`categoryId` 是稳定的机器键（`listExperts` 的
`categoryId` 参数按它过滤），`category` 是给人看的显示名；`prompt` 是该专家的系统提示词。

完整契约（五域方法签名、返回形状、错误码表、`allowHosts` 与回环例外、`credentialRef` 推导）见
[`docs/provider-integration.md`](../../docs/provider-integration.md)。

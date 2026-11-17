# whale-plugin/ — 鲸鲸 Api 3 消息插件

**可安装包已编译并通过规则校验：** `dist/whale-dsh-router-0.1.0.zip`（4 KB，2 个文件）。
**但从未在鲸鲸里试装过。** 这是本文件里最重要的一句话。

## 为什么必须走 WASM

`src/services/messagePlugins.js` 24–50 行：鲸鲸用独立 Node 子进程加载 **WebAssembly 模块**，只注入 `whale.input_size / input_byte / output_byte`。没有网络、没有文件、没有 `require`。所以插件只能做一件事：**在 `chat.prompt` 环节改写 system 字符串**。这正好够写路由信封。

## 目录

| 文件 | 作用 |
|---|---|
| `reference.mjs` | 可读、可测的算法参考（审查对象） |
| `build/as/index.ts` | AssemblyScript 源（实际编译对象） |
| `build/package.json` | 仅构建期依赖 `assemblyscript@0.27.31` |
| `dist/plugin.wasm` | 编译产物，8.9 KB |
| `dist/plugin.json` | 清单 |
| `dist/whale-dsh-router-0.1.0.zip` | 可安装包 |

## 构建

```powershell
# 在 whale-plugin/build 下
node node_modules/assemblyscript/bin/asc.js as/index.ts -o ../dist/plugin.wasm `
  --runtime stub --optimize --noAssert --use abort=

# 校验（根目录校验 + 导入白名单 + 大小上限）
node ../../scripts/verify-plugin-package.mjs ../dist/whale-dsh-router-0.1.0.zip
```

## 算法（两个钩子）

**`chat.prompt`** → 在 system 头部写信封：

```json
{ "system": "[[WHALE-BRIDGE v1]]{...}[[/WHALE-BRIDGE]]\n<原 system>",
  "state": { "seq": 2 } }
```

1. 缺 `platform/chatType/chatId/senderId` 任一 → pass（不猜身份）。
2. `chatType` 不是 `private` → pass。
3. `messageId` 用 `state.seq` 自增（`s0`、`s1`…）——`pluginContext` 没有 `msgId`。
4. system 严格 ≤ 16000 字符：先截断原 system，**绝不截断信封**。
5. 控制字符与双向标记替换为空格（否则宿主判 `invalid_system`，整个插件失效 30 秒）。
6. 原 system 里出现的信封标记一律剥掉——**输出里永远只有一个信封，且在 offset 0**。

**`chat.dispatched`** → 记下"上一条到底有没有交出去"：

```json
{ "state": { "seq": 3, "last": { "messageId": "s2", "ok": true, "local": true } } }
```

下一条 `chat.prompt` 会把 `last` 塞进信封的 `lastDelivery` 字段，桥接据此把上一条升级为 `submitted_local` / `failed` 等（见 `docs/receipts.md`）。**读完即清空**，不会重复上报。

## 已通过的验证（21 项）

- 导入列表恰好是 `whale.{input_size,input_byte,output_byte}` —— `invalid_import` 能过。
- 与 `reference.mjs` 在 11 组边界用例上逐字节一致。
- 输出通过**复刻的宿主校验器**（键白名单 / 16000 长度 / UNSAFE_TEXT / state 大小）。
- 恶意 system 里塞伪造信封 → 被剥掉，头部完好。
- 回执：dispatched 记录 → 下条 prompt 带回 → 状态映射正确；`ok:false` 永远不变成"已送达"；脏 `last` 被丢弃。
- 包规则：两个文件、`Api:3`、`Kind:message`、`Hooks:["chat.prompt","chat.dispatched"]`、`Permissions:["model.prompt"]`、wasm 9 KB。

## 还差的一步

**在鲸鲸「插件市场 → 从本地安装」试装。**

安装前先做两件事：

1. 用本地假网关发一条消息（不接真实微信），确认代理收到信封。
2. 确认清单键名大小写。鲸鲸内部用 `id/api/hooks/permissions` 小写，公开文档写 `Id/Api/Hooks/Permissions`；**本地安装时宿主怎么读，我没有实测**，这是唯一可能一装就报错的地方。

## 一个已知妥协

`state.seq` 只在单个会话状态文件里单调。鲸鲸重启后 seq 归零，同一会话可能重复 `messageId`。

后果：桥接按重复消息处理，**返回缓存结果、不会重复发送**，但那一轮可能是旧回答。这是「没有 `msgId`」的必然代价，不是 bug。

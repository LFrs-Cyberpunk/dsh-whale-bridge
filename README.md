# dsh-whale-bridge v1.0.0

让鲸鲸继续做「收发端」，由 DSH 做「处理端」。

**一句话现状：微信私聊 → 鲸鲸 → 本插件 → 一个隔离的 DSH 宿主 → 真实大模型 → 回复回到微信，全链路已跑通。人格可以跟随 DSH（自动读取你 DSH 里的人格，不依赖具体用了哪个插件）。**

## 功能简介

- 能把微信消息转给本机正在运行的 DSH，用 DSH 的回复代替鲸鲸自己的模型。
- 能选择使用 DSH 中已经培养好的人格、鲸鲸内配置的人格、自己写一张人格卡。
- 能整理私聊或群聊会话中的喜好记忆来丰富自己的人格，其它人格生长功能待后续开放。
- DSH 里装的插件会被继承，所以 DSH 能调用已有插件以帮助更好地回复微信消息。
- 能自动收集所有聊天产生的文本信息作为语料学习，为后期聊天能力的自我训练功能的开放做铺垫。
- 目前只有私聊功能自动使用 DSH 进行回复，群聊功能尚未开放，群聊会自动使用鲸鲸的 API 进行回复。

## 安装

本插件跑在 **DSH 桌面端 / dsh web** 上，Windows 环境，需要 Node ≥22。

### 方式一：从 Git 安装（推荐）

```powershell
dsh plugin add git+https://github.com/<你的用户名>/dsh-whale-bridge.git
```

装完重启 DSH，左侧栏会出现「鲸鲸桥接」入口。

### 方式二：手动安装

把这整个目录放进你的 profile 的 `node_modules` 下：

```powershell
# 以 desktop profile 为例
xcopy /E /I dsh-whale-bridge "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-bridge"
```

然后在 profile 的 `package.json` 里登记（两处都要有）：

```json
{
  "dependencies": { "dsh-whale-bridge": "*" },
  "dsh": { "profile": { "bundles": ["dsh-whale-bridge"] } }
}
```

### 装完之后

1. 打开左侧栏「鲸鲸桥接」，填你的模型 Key（DeepSeek 或兼容 OpenAI 的中转）
2. 选人格来源：**跟随 DSH** / 跟随鲸鲸 / 自定义
3. 打开启用开关，私聊发一条消息试

> 还需要**鲸鲸侧插件**（`whale-dsh-bridge-1.0.0.zip`）装进鲸鲸，两边都装好才能通。鲸鲸侧插件单独分发。

### 它不会做什么

- **不会碰你的日常 DSH 配置**。它启动的是独立的 `DSH_HOME`（默认 `%USERPROFILE%\.whale-dsh-bridge\dsh`），日常 profile 一个字节都不写。
- 群聊不支持，只处理文字私聊。
- 你的 API Key 只存在本机 `%USERPROFILE%\.whale-dsh-bridge\`，进隔离宿主时走环境变量，不写进配置文件的明文。

## 常用命令

```powershell
npm test          # 208 项测试（含 plugin/tests）
npm run selfcheck # 27 项结构与安全自检；失败会写日志并弹窗
npm run probe:acp # 在隔离 DSH_HOME 起一次真实 ACP 回合（自建自清，不碰日常 profile）
npm run probe:e2e # 全链路：鲸鲸请求形状 → 代理 → engine → 真实 DSH(ACP) → 回复
npm run grow      # 从已有对话里提炼人格层（偶尔跑，不是每轮）
npm run make:flow # 生成鲸鲸运行时真正读取的 .flow.json + .flow-grant.json
npm run install:whale # 预演把插件放进鲸鲸（默认不写，加 --apply 才装）
npm run verify    # 按市场规则校验插件包
npm start         # 启动桥接（mock 后端），会打印地址和令牌
```

> `npm` 需要 Node ≥22 在 PATH 里。没有的话用
> DSH 自带的 node：`<你的 DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，或双击 `start-bridge.cmd`。

## 能证明什么

- `npm test`：**208 项**通过，0 失败。覆盖身份校验、会话隔离、防重、**失败可重试且成功仍去重**、队列与并发上限、缓存淘汰、三种人格模式（原生不注入 / 注入 / 空设定不拼装）、**结构化人格拼装与预算**、**记忆三层与注入上限**、**ACP 握手与方法名**、**ACP 通知流组装**（思考不外泄、空回合计错、超时）、ACP 后端（人设只发首条、失败重试仍带人设、会话上限、工具白名单硬拒）、信封编解码、代理分流、**流式 SSE 输出符合鲸鲸解析规则**、**发送回执闭环**、鲸鲸插件算法与 wasm 逐字节一致、宿主校验规则兼容、**端到端影子运行**、设置页客户端加载与注册、自检接线、整链路组合、插件包规则（两种清单大小写）。
- `npm run probe:acp`：隔离 `DSH_HOME` 里起真实 DSH（`--profile acp`），完成握手、建会话、一个回合、取回正文。用本地桩模型，零凭据、零外网。
- `npm run probe:e2e`：把鲸鲸的真实请求形状（`stream:true` + 信封 system）打进代理，一路走到隔离 DSH 再回来，按鲸鲸的解析规则还原出 22 字回复。
- `npm run selfcheck`：**27 项**结构与环境自检全过，`mockOnly: true`；同一份代码也挂在设置页的「运行自检」按钮后面。

### 自检失败时会响

开发阶段的规矩是「出故障就弹窗，然后自己写日志自己读」：

- **只有失败才弹**。通过时一声不响，不训练你忽略弹窗。
- 弹窗列出每一条失败的检查名和原因码。
- 同时写 `logs/selfcheck-<时间戳>.log`（完整报告 + 失败清单），只保留最近 20 份。
- 静默开关：`WHALE_SELFCHECK_NO_POPUP=1` 或 `node scripts/selfcheck.mjs --quiet`（脚本/CI 用）。
- 弹窗是 Windows 消息框，`detached` 启动，不会挡住自检进程退出。

`tests/selfcheck-alert.test.mjs` 6 项盯着这几条规则：通过不弹、失败必记、抛异常也留档、日志轮转、摘要只列失败项。
- 备份：`../鲸鲸桥接备份/pre-development-20261113-145501-48bb6f90/backup-manifest.json`（37 文件，SHA-256 校验）。

## 还没做到的（别当成已完成）

1. **人格不会自己成长。** 自定义人格靠手写，桥接不会让它变长。
2. **语料学习不是训练。** 只做统计（句长/标点/表情比例），不注入他人原句，做不到真正「学会说话」。
3. **群聊不支持。** 只处理文字私聊；群聊消息一律拒收，鲸鲸会回退到它自己的模型。

## 链路

```
微信 ──► 鲸鲸（WASM 插件写信封）──► 本地代理（本仓库）
                                        │
                                        ├─ 有信封 → engine → 隔离 DSH（ACP）
                                        └─ 无信封 → 透传上游模型（后台任务）
```

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容入口；`stream:true` 出 SSE |
| POST | `/chat/completions` | 同上（鲸鲸填 baseUrl 不带 `/v1` 时走这条） |
| — | `token` | 每次启动随机生成并打印 |

## 目录

| 路径 | 作用 |
|---|---|
| `src/core.mjs` | engine：身份校验、去重、队列、并发、超时、三条人格模式 |
| `src/proxy.mjs` | 本地 OpenAI 兼容端点，分流信封 / 透传 |
| `src/envelope.mjs` | 信封编解码与回执判定 |
| `src/persona.mjs` | 结构化人格 → 注入文本（含预算与整块取舍） |
| `src/persona-profile.mjs` | 把日常 profile 的插件配置复刻到隔离宿主（人格跟随） |
| `src/settings-store.mjs` | 设置落盘（JSON，无 BOM，原子替换） |
| `src/memory.mjs` | 三层记忆、按需检索、注入硬上限 |
| `src/isolation.mjs` | 拒绝日常 DSH_HOME，剥离子进程凭据 |
| `src/adapters/acp.mjs` | ACP 客户端（握手、通知流、权限拒绝） |
| `src/adapters/acp-backend.mjs` | 会话映射、人设首条、按需记忆注入 |
| `src/adapters/mock.mjs` | 回声后端 |
| `plugin/` | DSH 设置页插件（宿主半边 + 浏览器半边） |
| `whale-plugin/` | 鲸鲸 WASM 插件与两个发布 ZIP |
| `scripts/` | 自检、探针、包校验、启动器 |
| `tests/` | 单元测试与假服务 |
| `docs/` | 使用说明、回执语义、契约对照 |
| `SAFETY.md` | DSH 安全红线 |

## 三个人格模式

| 模式 | 桥接做什么 | 前提 |
|---|---|---|
| 跟随 DSH | 把日常 profile 的插件配置整体复刻到隔离宿主，人格由隔离 DSH 自己装配 | 无 |
| 跟随鲸鲸 | 把她请求里的 system 作首条背景 | 隔离宿主不挂 DSH 人设 |
| 自定义 | 用结构化字段拼出的文本 | 同上 |

「跟随 DSH」不是「把人格文本塞进去」，而是复刻配置让它自己长出来。所以无论你用哪个插件养人格都能跟随，桥接里没有任何人格插件白名单。

`session/new` 确实没有 system 参数——桥接不碰它，走的是配置同步这条路。

## 人格设定的成本模型（决定所有上限）

这段文字**不是 system prompt**，它作为会话第一条用户消息里的一段送进去。

模型无状态：之后每一轮都要重发整段历史，所以**这段文字按轮计费**。成本 = 字数 × 轮数。

| 情况 | 每轮 | 100 轮累计 |
|---|---|---|
| 300 字（只填必填） | ~330 token | ~3.3 万 |
| 1200 字（上限） | ~1320 token | ~13 万 |

它同时永久占用上下文预算，会加速会话压缩——越早写的越早被摘要掉。

所以：总上限 1200 字，单栏 150–300 字，超预算时**整块丢弃**（先丢场景、再看对方，最后才动「渴望」和「红线」，绝不切半句）。设置页直接显示每轮和累计 token 数。

## 记忆：三层，注入是事件不是习惯

鲸鲸的记忆是**红线级隔离**：`personCard.js:6-7` 要求 `card.chatId === source.chatId`，跨会话写入直接抛 `MEMORY_CHAT_MISMATCH`（`store.js:302` 注释写明「隔离红线」）。人物卡按 `(chatId, uid)` 存，所以同一个人在不同群是不同的卡。

**我们不覆盖它**，也不改它的文件。两套并存：

| 走哪条路 | 人格 | 记忆 |
|---|---|---|
| 跟随 DSH | DSH 自己的 | 本模块（`src/memory.mjs`） |
| 跟随鲸鲸 | 她的 `persona.json` | 她的 `memory/`，只读 |
| 自定义 | 我们写的 | 本模块 |

本模块的三层：

1. **人格层** ≤320 字，每轮带。
2. **情节层** 按会话分桶存原文（append-only，不压缩），**平时不注入**。
3. **跨会话** 只读别人会话里标为 `shareable` 的条目，命中才注入 ≤420 字。

**为什么按需而不是每轮**：任何经 prompt 送进去的东西都会变成历史，而历史每轮重发。每轮注入 = 成本比对话本身涨得还快。所以每轮都做本地检索（免费），但只有消息里出现「还记得 / 上次 / 之前」这类回溯信号时才注入。整块硬上限 700 字。

**隐私规则**（保守优先）：关于「我」的（我喜欢 / 我怕）→ 可跨会话；别人告诉我的（他说 / 秘密 / 别告诉）→ 永久私密；判断不了 → 私密。跨会话的条目带「（别处）」标记。

**语料采集只做统计，不做模仿**：`styleProfile()` 只统计平均句长、短句比例、无标点比例、表情使用率，输出两行。**绝不注入他人原句** —— 那会变成扮演某个具体的人。

### 人格层怎么长大

设置页「记忆」区块里有个「整理人格层」按钮，背后是 `npm run grow`，同一个实现。

它会扫所有会话，只挑**第一人称**、且被判定为 `shareable` 的陈述，去掉近重复，硬截到 320 字，写进 `memory/persona.md`。

- 不调用模型，纯规则 —— 省掉一次额外请求。
- 只认「我喜欢 / 我怕 / 我讨厌」这类关于自己的话；「他说…」「秘密」永远进不去。
- **要偶尔跑，不要每轮跑**（建议每天一次或每几十轮一次）。这是唯一允许"成长"的入口。

## 鲸鲸侧的四条硬事实（读过源码才确认）

### 0. 运行时只读 `.flow.json`，不读 `plugin.json`

鲸鲸扫描 `<dataDir>/plugins` 里的 `<id>.flow.json`，并配一个 `<id>.flow-grant.json`（`messagePlugins.js:121-136`）。授权 hash 是 `sha256(JSON.stringify(flow))`，改一个字就失效。**整个 `src` 里没有 ZIP 安装器**，`data/plugins` 现在是空的。

所以真正的交付物是 `npm run make:flow` 生成的两个 JSON 文件，目标目录 `<鲸鲸数据目录>/plugins/`。两个 ZIP 保留作市场分发参考，但运行时不吃它们。

1. **主聊天链路是流式的。** `src/pipeline/chat.js:1575` 走 `for await (const piece of this.llm.stream(...))`，所以代理必须回 `text/event-stream`。测试里直接复刻了她的 `parseSseLines` 与 `pickText`，并确保**不混入任何 reasoning 字段**。
2. **鉴权头是 `Authorization: Bearer <apiKey>`**，apiKey 为空时**根本不发**这个头。所以配置时 key 必须填桥接令牌。
3. **请求超时默认 45 秒**，失败后她用**同一个 messageId 重试**。所以桥接 `timeoutMs` 设 40 秒先失败，并且**失败的回合绝不缓存**。
4. **后台任务不走 `chat.prompt`。** 记忆抽取等调用没有信封，代理一律透传上游。

## ACP 侧的三个硬事实（读过真实实现 + 实测）

方法名与协议版本来自 `@agentclientprotocol/sdk`：`initialize`、`session/new`、`session/prompt`、`session/close`，`PROTOCOL_VERSION = 1`。

1. **必须先 `initialize`。** 客户端握手时只声明零能力（无 fs、无 terminal）。
2. **`session/prompt` 不返回助手文本**，只返回 `{ stopReason }`。正文由 `session/update` 通知逐块送来，只拼接 `agent_message_chunk`。
3. **`session/new` 只接受 `{ cwd, mcpServers }`**，没有人设参数。人设只能作首条消息的背景。

### 实测踩到的四个坑

1. **CLI 入口在 `app.asar` 内**，`fs.existsSync` 判断为不存在。只能通过 `dsh.cmd` 启动。
2. **`--profile acp` 是内置模板**，不在 `$DSH_HOME/profiles` 里；首次启动自动创建。
3. **ACP 会话用的模型配置在 `id: acp` 条目**（`provider` / `model`），不在 `agent-default-model`。改错地方会一直报「no API key for provider route "deepseek-official"」。
4. **`dsh-agent-md` 依赖 `webServer` 服务**，纯 ACP 宿主不提供该服务，它永远停在 pending。人格跟随不能靠它单独撑。

## 三条硬边界

1. 不连接 `http://127.0.0.1:<当前端口>`，不复用日常 DSH 的 storage。
2. 测试宿主必须在独立目录内新建 `DSH_HOME`；`assertIsolatedHome` 拒绝日常 DSH 的 HOME。
3. 外部聊天进入的处理上下文，工具白名单恒为 `[]`，权限请求一律 `reject`。

## 信封的安全性

**没有签名，也不要签名。** 插件 ZIP 公开，内置密钥等于公开。信封只承担「这是哪个会话」，绝不承担「这个人有什么权限」。

四层防护：

1. 只解析 **offset 0** 的块；插件还会把正文里出现的信封标记剥掉，输出永远只有一个信封。
2. 用户文本走 `user` 消息，天然进不了 system 头部。
3. 字段白名单 + 字符集限制（`[\w.:@-]`，≤200）。
4. 权限与工具白名单由 `engine` 硬编码，与信封内容无关。

## 已知的接口缺口

1. 鲸鲸 `buildPayload` 不带 chatId/senderId（`src/llm/client.js` 547–598），所以需要插件写信封。
2. 后台/记忆提取请求不带标记 → 只能透传或明确拒绝。
3. `chat.dispatched` 的 `delivery` 形状是假设，未观测。
4. `state.seq` 重启归零 → `messageId` 复用会退化成陈旧回答。
5. proxy 必须支持 SSE，否则主聊天链路不通。
6. 鲸鲸侧收到非 200 只会回固定话术，桥接的真实错误码传不到用户面前。

## 下一步

1. 在别的机器上验证「跟随 DSH」，确认不依赖具体人格插件。
2. 群聊支持（当前明确不支持，只回退）。
3. 鲸鲸侧插件暴露桥接的真实错误码，替换现在固定的话术。
4. `enabled` 开关目前存在两份（`config.json` 与 `service.json`），该合并成一个。

# 发送回执：为什么现在还不能说「已送达」

`delivery` 目前恒为 `generated`，这不是漏做，是刻意不撒谎。

## 鲸鲸给的信号

`chat.dispatched` 钩子的输入带 `delivery`：

| 字段 | 含义 | 能否当「已送达」 |
|---|---|---|
| `ok` | 网关提交结果 | **不能** |
| `local: true` | 交给了本地桥接 | **不能**：只是交接，不是送达 |
| `dryRun: true` | 宿主模拟或本地接管 | **不能** |

> 官方文档原话：「local=true 表示交给本地桥接，dryRun=true 表示由宿主模拟或本地接管，均不能据此认定微信已送达。」

鲸鲸源码也会把「根本没到微信」和「发送失败」记成 `failed` / `blocked` 事件——也就是说**它自己承认「提交成功」不等于「送达」**。

## 所以分成五个状态

| 状态 | 谁来确定 | 现在的实现 |
|---|---|---|
| `generated` | 桥接 | ✅ 有 |
| `queued` | 桥接 | ✅ 有（pending 计数） |
| `submitted` | 鲸鲸 `chat.dispatched` 收到 `local/ok` | ⬜ 未接 |
| `failed` | 鲸鲸回 `ok:false` | ⬜ 未接 |
| `delivered` | **只有微信侧确认才算** | ❌ 鲸鲸当前没有这个信号 |

**`delivered` 这一格，靠现有 Api 3 接口填不上。** 插件只能观察到「交给网关」，看不到「对方收到了」。

## 现在已经做到的版本（已测试）

1. 桥接返回 `generated`，绝不写成 `delivered`。
2. **插件加了 `chat.dispatched` 钩子**：把 `delivery.ok/local/dryRun` 记进 `state.last`，下一条消息的 `chat.prompt` 把它塞进信封的 `lastDelivery` 字段，桥接读回后映射成状态（`src/envelope.mjs` 的 `deliveryState`）。
3. 映射规则（不越级）：

| transport 报的 | 桥接记成 | 能不能说「已送达」 |
|---|---|---|
| `ok: false` | `failed` | 不能，明确是失败 |
| `dryRun: true` | `dry_run` | 不能 |
| `local: true` | `submitted_local` | 不能 |
| `ok: true` 其余情况 | `submitted` | 不能，只证明交给了网关 |

4. `last` 读完即清空，同一条回执不会被报两次。
5. 回执里的 `messageId` 非法就整条丢弃，不让脏数据污染信封。

## 界面文案（按这个写，别自己升格）

- `generated` → **已生成，等待发送**
- `submitted_local` → **已交给收发程序**
- `submitted` → **收发程序已接收**
- `failed` → **发送失败**
- `delivered` → **只有拿到微信侧凭据时才显示，当前没有这个信号，所以永远不显示**

## 不做的事

- 不用「HTTP 200」冒充送达。
- 不在超时后自动重发（可能发两条）。
- 不把 `local: true` 翻译成「已发送」。

## 需要鲸鲸开放的东西

`delivered` 这一格靠现有 Api 3 填不上：插件能观察到「交给网关」，观察不到「对方收到了」。若将来鲸鲸提供发送完成回调（哪怕是网关返回 `sent_id`），这一格才能闭环。

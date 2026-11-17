# plugin/ — DSH 设置分区草稿

**未挂载。** 没有写进任何 `cordis.patch.yml`，当前日常 DSH 不知道它存在。

## 结构

- `index.js`：宿主半边。`apply()` 是空的——加载时不做任何事，不注册服务、不建路由、不启动进程。
- `client.js`：设置页「鲸鲸桥接」分区。人格三选一 + 自定义框 + 启停 + 自检 + 错误列表。
- `tests/adapter.test.mjs`：6 项测试，含「保存失败不得改动运行中配置」。

## 接线方式（将来真正挂载时）

```js
import { createHostAdapter } from './plugin/index.js';
const host = createHostAdapter({ bridge, diagnostics, selfcheck, store });
// host.routes.config / status / selfcheck / errors
// host.handle(method, path, body)
```

`bridge` 由宿主提供，必须实现 `configure(cfg)` 与 `status()`，并暴露当前 `config`。
`store.save(cfg)` 可选；若提供，**先保存成功再 configure**，保存失败时运行中的配置保持原样。

## 为什么 `apply()` 是空的

DSH 启动时会加载这个包。任何在 import/apply 阶段产生的副作用（监听端口、连 DSH、写文件）都可能在你只是打开设置页时就把桥接拉起来。空 `apply` 意味着：**没有显式接线，它对系统零影响。**

## 未验收项

- 没有在真实 DSH 中加载过（`window.__ModuleLoader__` 的注册时机、`ctx.slots` 注入是否与 `dsh-pet-settings` 完全一致，未实测）。
- 客户端与宿主的 HTTP 路径只在适配器测试中验证过，未经过真实 Web 服务。
- 自定义人格的保存时机用 `onBlur`，未做防抖与并发写入保护。

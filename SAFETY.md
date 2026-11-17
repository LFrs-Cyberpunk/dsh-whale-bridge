# 安全红线（不可协商）

凌霜的原话：**「无论如何都要确保现在运行的 DSH 的安全，不能死了。」**

鲸鲸挂了能重装，DSH 挂了会拖住他所有工作。所以本项目的默认状态是「对 DSH 零影响」，一切便利都要给这条让路。

## 一、绝对禁止

| 禁止项 | 原因 |
|---|---|
| 修改 `app.asar` / 安装目录任何文件 | 改坏了无法自恢复，且升级即丢 |
| 修改 `I:\DSH-Data\dsh\profiles\desktop\package.json`、`cordis.patch.yml` 等配置文件 | 一次写错就起不来，回档工具也可能救不回全部 |
| 挂载、启用、停用任何现有插件 | 用户当前环境是「调教很久才顺手」的状态 |
| 连接 `http://127.0.0.1:<当前端口>` 或复用当前 `DSH_HOME` 的 storage | 会污染正在跑的会话与记忆 |
| 自动重启、关闭、托盘退出 DSH | 未保存的工作会丢 |
| 写 JSON 时用带 BOM 的 UTF-8 | 会让 `dsh plugin install` 的 `JSON.parse` 崩（历史踩坑） |

## 二、允许的做法

1. **只在 `I:\DeepSeek Harness工作区\程序开发\whale-dsh-bridge\` 内写代码与测试。**
2. 测试用 `MockAdapter`，不联网、不启服务。
3. 需要真实宿主时，**新建独立 `DSH_HOME`**（项目目录内），`assertIsolatedHome` 会拒绝 `C:\Users\Administrator\.dsh`、`I:\DSH-Data\dsh`。
4. 子进程环境只保留 `SystemRoot/WINDIR/TEMP/TMP/PATH/PATHEXT` + 独立的 `DSH_HOME/DSH_AGENTS_HOME/DSH_PROFILE`，不透传任何 `*_KEY/TOKEN/SECRET`。
5. 本地代理只绑 `127.0.0.1`，必须带 ≥24 字符 Bearer 令牌，否则拒绝启动。

## 三、真要挂载到日常 DSH 之前，必须依次完成

1. 先跑 `E:\桌面\DSH回档\` 手动存一份（他唯一认的回档工具）。
2. 再跑一次 `undo_snapshot`，确认快照确实覆盖 desktop profile。
3. 确认 `plugins/` 里没有任何目录与本次新增冲突。
4. 确认能**不依赖 GUI** 撤回：删掉目录 + 还原配置文件即可恢复。
5. 挂载后立刻看 DSH 能否启动；起不来就恢复，不做第二次尝试。

**以上任何一条没做到，都不许挂载。**

## 四、当前状态（每轮更新）

- 日常 DSH：**未被修改**。7 个进程正常运行（19:04 启动），端口连通。
- `profiles/desktop` 根目录近 6 小时无文件改动。
- 备份：`鲸鲸桥接备份/pre-development-20261113-145501-48bb6f90`（37 文件，SHA-256 已核）。
- 项目内的三个流程（`npm test` / `selfcheck` / `verify-plugin-package`）**全部不接触真实 DSH**。

# dsh-plugin-nextstep

Next-step prediction for DeepSeek Harness（输入框「下一步建议」）——Codex Composer Predictions 的最小可用形态 A。

每轮回复结束后，Host 侧用**一次辅助模型调用**（复用当前会话路由和上下文前缀，不写 surface 消息、不进主对话）生成一条「用户下一句可能会输入的话」，通过 log-only 插件记录 + 会话投影送到浏览器；浏览器把它作为**输入框内联灰字（ghost text）**显示在光标起始处，并临时隐藏 placeholder。**Tab 把建议放进草稿，但绝不自动发送**。输入框一旦有内容、或新一轮开始、或接受后，灰字隐藏。

## 能力

- 触发：`turn/end` 之后（可配 `minTurn`、`sampleRate`）。
- 上下文：`session.deriveMessages()` 的系统消息 + 最近 `contextMessages` 条，按 `maxContextChars` 裁剪；工具消息（tool role / tool-call 块）被过滤掉，只保留文本，避免 provider 因缺 tool schema 拒绝请求。
- 路由：默认沿用当前会话 `request/header` 的 provider / model / reasoningEffort；也可用 `provider` + `model` 显式指定。
- 请求：`ctx.llm.prepareCall()` → `call.stream()`，`maxTokens` 默认 512，`timeoutMs` 默认 60000，取消/竞态用 `AbortController` + `AbortSignal.any`。
- 结果：`sanitize()` 只保留第一行、去引号/前缀、限制 200 字符；失败或超时写 `text: null` 清空灰字。
- 日志：只 append `plugin:nextstep/suggestion`（插件记录，带 `ignorable: true`，无 `surfaceOp`），不会出现在会话记录/模型历史里。
- 投影：`nextstep` 会话投影的 wire 视图 `{ text, turn, status, model, updatedAt }`，客户端只读。
- 接受：`InputActions.captureInsertion()` + `insertText(text, span)`，一次可撤销编辑，不发送。
- 快捷键：在 `[data-composer-input]` 上捕获 Tab（无修饰键、建议可见、草稿为空时），`preventDefault` 后插入；不影响触发菜单、焦点遍历、IME。
- 计费：辅助调用会消耗 provider token；本插件把这次调用的 usage 放进投影（当前内联灰字没有 tooltip，usage 仍可在会话日志/投影里读到）；不写 `assistant/message`，所以不影响主对话 token 统计。

## 日志兼容性（重要）

会话日志的读取路径**拒绝**含有「未知事件类型且未标记 `ignorable`」的事件——整个历史都会加载失败，报错形如：

```
failed to observe session "...": session "..." contains event type "nextstep/suggestion" (seq 22)
unknown to this harness and not marked ignorable; refusing to interpret the log
```

- `session.append(type, data)` **无法**设置 `ignorable` 标记。因此用 `session.append()` 写自定义事件类型（例如早期的 `nextstep/suggestion`）会让日志永久不可读。
- 唯一正确写法是**插件记录**：类型用 `plugin:` 命名空间（`plugin:nextstep/suggestion`），由 `appendPluginRecord(session, type, data)` 写入，它会带上 `ignorable: true`。不认识该类型的读取方会**保留并跳过**这条记录，而不是拒绝整个日志。
- `pluginRecordOf(event)` 把事件读回为记录；投影的 `apply` 同时识别新类型和旧的 `nextstep/suggestion`，所以修复过的旧日志也能正常折叠出建议。

### 修复被旧版本污染的日志

旧版本写过不带标记的 `nextstep/suggestion`。修复方式是把该事件改名为 `plugin:nextstep/suggestion` 并补上 `ignorable: true`，其余字段与其它事件一律不动。`.asar-tools/repair-now.mjs` 完成这件事（默认演练，加 `--apply` 才写入，并自动留带时间戳的 `.bak-repair-*` 备份），改完用 `.asar-tools/verify-all.mjs` 复核全部日志都能加载。

工作区根目录的 `fix-nextstep-logs.cmd` 是同一件事的一键入口。**修复后必须重启 DSH Desktop**（或从侧边栏重新打开会话）让网关重新读取日志。注意：如果修复时旧版 DSH 进程还在运行，它会在每个回合结束时继续写入旧的 `nextstep/suggestion`，修好的日志会被再次污染；因此修复前应先退出 DSH，修完再启动（修复脚本本身不依赖 DSH）。

> 上面的修复脚本只放在本工作区，不在 npm 发布包里；从 npm/GitHub 安装的用户不会遇到旧版本写坏日志的问题。

## 安装

### 通过 Web「添加插件」（npm 一键安装，推荐）

发布到 npm 后：

1. 侧栏 → **插件** → **添加插件** → **安装第三方插件**
2. 输入包名 `dsh-plugin-nextstep`（或 `dsh-plugin-nextstep@0.1.0`），选择安装源（默认 npm 官方源；中国大陆可切 npmmirror），点 **安装**
3. 安装完成后按提示**立即启用**，或重启 DSH Desktop

等价的 CLI 命令（先完全退出 DSH Desktop）：

```powershell
dsh plugin --profile desktop add dsh-plugin-nextstep
```

> 发布到 npm 只会让「添加插件」能按包名安装，不会自动出现在**发现**标签页；发现页需要另外配置插件市场索引 URL。

### 从 GitHub 安装（尚未发布 npm 时）

```powershell
dsh plugin --profile desktop add github:HZZ2Z/dsh_nextStep
```

或在 Web 的**添加插件**里填 `github:HZZ2Z/dsh_nextStep`。Host 会先做 `git ls-remote` 连通性检查；中国大陆访问 GitHub 不稳定时，优先用 npm。

### 本地目录开发

```powershell
# 1) 安装依赖（只需 zod）
cd C:\Users\22516\Desktop\dsh_nextStep\plugin
& "C:\Users\22516\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install

# 2) 把插件装进 desktop profile（二选一）
#    a. 手动：在 ~/.dsh/profiles/desktop/package.json 的 dependencies 加
#       "dsh-plugin-nextstep": "link:C:/Users/22516/Desktop/dsh_nextStep/plugin"
#       并在 dsh.profile.bundles 里追加 "dsh-plugin-nextstep"，然后在 profile 目录 pnpm install
#    b. 有 dsh CLI 时：dsh plugin --profile desktop add ./plugin

# 3) 重启 DSH Desktop，在输入框里看到内联灰字建议（Tab 接受）
```

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` / `model` | `''` | 空 = 沿用当前会话路由；非空 = 显式指定预测模型 |
| `contextMessages` | `12` | 上下文里保留的最近消息条数 |
| `maxContextChars` | `24000` | 上下文总字符预算 |
| `maxTokens` | `512` | 预测输出上限 |
| `temperature` | `0` | 采样温度 |
| `timeoutMs` | `60000` | 端到端超时 |
| `sampleRate` | `1` | 每轮触发概率（0–1，`1` = 每轮都跑） |
| `minTurn` | `1` | 从第几轮开始预测 |

## 限制

- 灰字是「输入框内联」显示，但实现方式是在 `conversation.input.overlay` 里按输入框首行坐标绝对定位一个 ghost span（空草稿时光标就在首行），并临时隐藏 placeholder；它**不是** Lexical 原生 decorator，所以多行/滚动时光标跟随需要核心提供扩展点。
- Tab 通过 DOM capture 抢键；若未来核心提供预测仲裁扩展点，应改用它。
- 工具消息会被过滤出预测上下文，避免 provider 因缺 tool schema 拒绝请求；这会牺牲一部分工具结果上下文。
- 建议是单条、整句；多候选、换一条、接受率埋点属于形态 B/C。
- 客户端类型来自 npm 的 `@deepseek-ai/dsh-client-ui-*@0.2.1-rc.3`；本包不依赖构建期类型。

## 变更记录

- `0.1.1`：修复 ghost 在窗口 resize、新建议替换旧建议或切换 session 后跳到输入框上方的问题。定位改为相对 `data-composer-overlay` 锚点测量，输入框限定在 `data-composer-card` 内查找，并用 `ResizeObserver` 跟随 composer 布局变化。
- `0.1.0`：首个可用版本。

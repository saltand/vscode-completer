# SPEC.md — VS Code「补全压力测试」扩展

## 0. 背景 & 目标

* **背景**：已有一个（第三方）VS Code 代码补全扩展，无法接触其源码。需要做一个**独立运行**的测试扩展，**黑盒**地持续触发、接受并回滚补全，以评估稳定性/可用性。
* **目标**：实现一个 VS Code 扩展，能在窗口最小化/后台时持续运行以下循环：
  **模拟输入 → 等待补全出现 → 接受补全（优先行内，其次列表）→ 恢复文本/删除 → 重复**。
  同时提供**编辑器标题栏**的“开始/停止”按钮，并以固定参数运行。

> **非目标**：
>
> * 不调用或依赖目标扩展的私有 API。
> * 不对补全项目进行“窥探式读取”（如直接拉取 CompletionList 断言具体项）。
> * 不在 CI 模式下无头启动 VS Code（该扩展面向正常 VS Code 运行实例；如需 CI，无头执行可另行编排）。

---

## 1. 用户故事

1. 作为测试者，我希望点击编辑器右上角“开始”按钮，扩展便持续执行“触发并接受补全”，以便观察另一扩展在长时间运行中的表现。
2. 作为测试者，我希望在“开始”后，即使我把 VS Code 最小化，循环仍继续进行，且在“停止”前不会退出。
3. 作为测试者，我希望扩展自行准备测试环境并以固定参数运行，无需额外配置。

---

## 2. 关键功能需求（Functional Requirements）

### 2.1 命令

* `completions-tester.start`：启动循环。
* `completions-tester.stop`：停止循环并清理状态。

### 2.2 UI 按钮（编辑器标题栏）

* 在 **editor/title** 区域投放两个按钮（图标分别为 `$(play)`、`$(debug-stop)`）。
* **显隐规则**（通过 `setContext` 控制）：

  * 未运行：显示“开始”按钮；运行中：显示“停止”按钮。
  * 默认要求 `editorTextFocus`（可通过设置关闭该限制）。
  * 可选：限制仅在某些语言下显示（如 `editorLangId == javascript`）。

### 2.3 循环流程（黑盒）

每轮执行以下步骤（针对活动编辑器）：

1. **获取文档快照**（文本内容）。
2. **插入预设输入种子**到当前光标处（或文末），循环使用固定种子数组。
3. **行内补全（Inline）尝试**：

   * 执行命令：`editor.action.inlineSuggest.trigger`
   * 等待 `inlineTimeout` 毫秒
   * 执行命令：`editor.action.inlineSuggest.commit`（等价 Tab 接受）
   * 检查文档内容是否变化（长度差 `deltaBytes` ≠ 0）。
4. **若行内未生效**，**列表补全（Suggest）尝试**：

   * 执行命令：`editor.action.triggerSuggest`
   * 等待 `suggestTimeout` 毫秒
   * 执行命令：`acceptSelectedSuggestion`
   * 再次检查文档是否变化。
5. **恢复文档到快照**（等价“删除补全 + 删除输入”），确保不会污染用户文件。
6. 等待 `loopDelay` 毫秒进入下一轮。
7. 重复，直至手动停止。

> 说明：不直接读取补全条目；仅以**文本变化**判断是否“出现并被接受”。此方式兼容大多数 AI 行内补全与传统列表补全。

### 2.4 运行场景

* **前台/后台/最小化**：循环不依赖用户交互，窗口最小化时仍能运行。
* **测试文档**：点击“开始”时总是创建（或重新创建）一个未保存的临时文件，并在整个循环中使用该文件。
* **预设参数**：语言固定为 `javascript`（临时文件需显式设置 `languageId = 'javascript'`），seed 列表固定为 `["conso", "arr.ma", "func", "impor"]`，循环无上限（需手动停止）。

### 2.5 配置项（Settings）

命名空间：`completionsTester.*`

* `mode`: `"both" | "inline" | "suggest"`（默认 `"both"`）
* `inlineTimeout`: `number` 行内补全等待毫秒（默认 `1200`）
* `suggestTimeout`: `number` 列表补全等待毫秒（默认 `800`）
* `loopDelay`: `number` 每轮结束后间隔毫秒（默认 `300`）
* `showTitleButtonsWithoutFocus`: `boolean` 标题栏按钮是否在无焦点时也显示（默认 `false`）
* `pauseOnUserTyping`: `boolean` 用户键入时自动暂停循环（默认 `true`）

### 2.6 安全/保守策略

* 所有修改均在**快照回滚**后结束，避免污染用户代码。
* 默认开启 `pauseOnUserTyping`：监测 `onDidChangeTextEditorSelection`/`onDidChangeTextDocument`，用户主动操作时**暂停**循环，避免抢焦点/干扰。
* 若临时文件被外部关闭或失焦，应自动重新创建并继续测试。

---

## 3. 非功能需求（NFR）

* **稳定性**：长时间运行（≥ 1 小时）无未捕获异常；发生错误应捕获并自动继续下一轮（或退避重试）。
* **性能**：默认配置下每分钟不超过 \~120 次“触发”组合；可通过 `loopDelay` 控制频率，避免触发速率过高。
* **兼容性**：VS Code 1.85+；Windows/macOS/Linux。针对联网补全可能的冷启动延迟，通过 `inlineTimeout/suggestTimeout` 适配。
* **可维护性**：模块化（Runner/EditorOps/UI/Config）。

---

## 4. 交互与可视化

### 4.1 标题栏按钮（必需）

* **Commands**：

  * `completions-tester.start`：`icon: $(play)`；`when: !completionsTesterRunning && (editorTextFocus || showTitleButtonsWithoutFocus)`
  * `completions-tester.stop`：`icon: $(debug-stop)`；`when: completionsTesterRunning && (editorTextFocus || showTitleButtonsWithoutFocus)`
* **上下文键**：`completionsTesterRunning`（布尔），用 `setContext` 在 start/stop 时切换。

### 4.2 状态栏（可选）

* 左侧显示 `$(play) Tester` 或 `$(debug-stop) Tester`，点击等同于开始/停止。

---

## 5. 模块划分与主要接口

```
src/
  extension.ts        // activate/deactivate、命令注册、上下文键
  core/runner.ts      // 主循环（start/stop、迭代、超时、回滚、暂停）
  core/editorOps.ts   // 文档/光标操作：ensureDoc、insert、snapshot/restore
  core/trigger.ts     // tryInline()/trySuggest()（封装 VS Code 命令与等待）
  core/config.ts      // 读取/监听设置变更
  ui/titleButtons.ts  // （可选拆分）菜单/状态栏元素创建
```

### 5.1 Runner 伪代码

```ts
const seeds = PRESET_SEEDS

async function loop() {
  let i = 0
  while (running) {
    await waitIfUserTyping() // pauseOnUserTyping
    const snap = getSnapshot(doc)
    placeCursorToEnd(doc)
    const seed = seeds[i % seeds.length]
    insert(seed)

    let delta = 0

    if (mode in ['both', 'inline'])
      delta = await tryInline(inlineTimeout)
    if (delta === 0 && mode in ['both', 'suggest'])
      delta = await trySuggest(suggestTimeout)

    await restoreSnapshot(doc, snap) // 回滚
    await sleep(loopDelay)
    i++
  }
}
```

### 5.2 触发命令（必须使用）

* 行内：`editor.action.inlineSuggest.trigger` → 等待 → `editor.action.inlineSuggest.commit`
* 列表：`editor.action.triggerSuggest` → 等待 → `acceptSelectedSuggestion`

> 成功判定：**提交后文档字符数变化（字节）`deltaBytes != 0`**。为防抖，可在提交后 `sleep(50ms)` 再读取文本。

---

## 6. 配置清单（`package.json` 贡献片段）

* **commands**：如上两条。
* **menus.editor/title**：两条按钮项，`group: "navigation@10"`。
* **configuration**：见 2.5 全量字段（类型/默认值/描述）。

---

## 7. 错误处理与边界情况

* 目标扩展未安装或未激活 → 首轮允许“空跑”，记录 `delta=0`；可在输出信息中提示“可能未提供补全”。
* 网络/鉴权未就绪（AI 扩展常见）→ 通过较大的 `inlineTimeout/suggestTimeout` 与**指数退避**（可选）降低噪音。
* 用户切换文件/关闭编辑器 → `ensureDoc()` 需在每次开始前保证有可写编辑器；若无则自动创建临时文档。
* 跨平台换行（CRLF/LF）→ 快照/回滚统一处理，避免误差。
* 文档过大/历史过深 → 仅针对测试专用文档操作；不在用户实际业务文件运行。

---

## 8. 验收标准（Acceptance Criteria）

1. 安装扩展并打开任意文件，标题栏出现“开始”按钮。
2. 点击“开始”后按钮切换为“停止”，循环持续运行；最小化 VS Code 后仍能继续执行。
3. 在默认参数下，能看到行内或列表补全至少在部分轮次产生 `delta > 0`。
4. 点击“停止”后循环结束，按钮恢复为“开始”。
5. 每次开始时都会打开一个未保存的临时文件，循环过程结束后该文件可被关闭而不产生残留。
6. 开启 `pauseOnUserTyping` 后，用户手动输入时循环暂停，并在停止输入后自动恢复。

---

## 9. 开发与发布

* 语言：TypeScript。
* 目标 VS Code 版本：`"engines": { "vscode": "^1.85.0" }`（或更高）。
* 打包：`vsce package`；发布前确保无 `capability` 要求超出默认权限。
* 最低依赖：仅 VS Code API（不引入外部服务）。
* 代码风格：严格模式、无未捕获 Promise、模块划分见第 5 节。

---

## 10. 可选增强（非必须）

* 导出 CSV/JSON 统计（命中率、平均 delta、P95 时间）。
* “场景集”（可配置多组 seeds + language 组合，轮流跑）。
* UI 面板（Webview）展示实时指标与历史曲线。
* 与目标扩展的“软协同”开关（例如在开始前尝试激活 `extensions.getExtension(id)?.activate()`，但不做强依赖）。

---

## 11. 清单（Definition of Done）

* [ ] 提供 `start/stop` 两命令与标题栏按钮，显隐随运行状态切换。
* [ ] 循环逻辑按 2.3 实现，默认 `mode="both"`，基于文本差异判断成功。
* [ ] 支持所有列出的配置项，并在变更后下轮生效。
* [ ] 默认不污染用户文件；循环在未保存的临时文件上进行并回滚。
* [ ] 在 macOS/Windows/Linux 下运行通过基本手测（最小化时仍工作）。

---

### 附：实现要点速记

* `setContext('completionsTesterRunning', true/false)` 切换按钮显隐。
* 触发行内：`editor.action.inlineSuggest.trigger` → wait → `editor.action.inlineSuggest.commit`。
* 触发列表：`editor.action.triggerSuggest` → wait → `acceptSelectedSuggestion`。
* 文本对比：提交后 `sleep(50)` 再 `doc.getText()`，`delta = byteLen(after) - byteLen(before)`。
* 快照回滚：用 `WorkspaceEdit.replace(fullRange, snapshot)`。

> 以上规范即为实现依据；如需偏离，请在实现文档中注明理由与替代方案。

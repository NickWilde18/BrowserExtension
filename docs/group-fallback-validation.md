# 原生分组回退验证

## 症状与根因

用户提供的 macOS Arc 探针：`tabs.create OK`、`tabs.group 超过 3 秒未返回`；`debugger.attach`、`Page.enable`、`Runtime.enable`、`Network.enable`、`Log.enable`、`Page.getFrameTree`、`Fetch.enable`、`debugger.detach` 和 `tabs.remove` 均 OK。本机没有操作该 Mac，探针未证明分组永不返回，也未测到后续组命名。

| 假设 | 证据 | 结论 |
|---|---|---|
| 本次探针无法创建标签 | 用户探针 `tabs.create OK` | 排除 |
| 本次探针无法附着或运行已列出的 CDP 初始化 | 用户探针中这些调用均 OK | 排除已测调用的能力缺失 |
| 分组是导航强制前置，迟迟不返回会阻塞整个新页流程 | 基线 `44eaa58` 的 `src/browser/tabs.ts:175–188`：先 create，再无界 await group/title，之后才登记返回；`src/actions/navigation.ts:30–35` 在返回后才 attach/navigate | 确认 |

唯一已确认的阻塞根因是将可选分组能力作为导航的无界等待前置。没有完整 Mac `browser_open` trace，不能扩大到全部动作。

## 最终行为与边界

沿用用户已选 A：在实际新建页上尝试分组，分组与组命名共用 1 秒总预算。分组接口缺失、拒绝、超时则该页回退为普通标签；分组已成功而命名失败或超时时，仅放弃组名，保留真实原生组与拖出撤权。每次新建页重新尝试，不按品牌/UA 判断，不持久化能力缓存。此阈值为工程参数，不是用户指定值。

`open` 与 `tabs new` 都传递 `ctx.signal`；取消与动作超时可以早于分组预算结束。尚未登记的创建受本次操作控制；迟到的创建只关闭自己的新页，迟到的分组只对自己的新页解组，不重写登记、不继续命名或导航，不解散整个组。解组也有有限等待，原生 API 的底层操作本身无法被取消；浏览器不响应清理时不能保证立即改变视觉分组。

同一对话可混合原生组标签和普通标签。现有 `storage.session` 的对话记录增加可选 `ungrouped: number[]`，只存稳定标签 ID；旧记录缺省为空。关闭/替换同步更新。没有新增配置、第三方 URL、网络帧或数据库迁移。

| 用户/平台入口 | 实际效果 |
|---|---|
| 原生组标签拖出 AI 组 | 移除该页归属并断开该页附着 |
| 普通标签关闭 | `onTabRemoved` 移除该页归属并断开附着；普通标签无拖出组撤权入口 |
| 用户共享页的「取消共享」 | `unshare` 移除共享，断开该页附着，保留页面 |
| 工具栏「停止」/调试提示条「取消」 | `stopAll` 中止操作、`detachAll` 断开全部附着；保留归属，恢复后可复用 |
| 整轮 `release` | 取消该轮操作，仅断开该轮持有的附着；保留页面归属，不影响新轮/其他对话 |
| `browser_close` | 清该对话归属；默认关 AI 页，`keep_tabs: true` 保留网页并解组；共享页不关 |
| 换账号 `forgetAll` | 清所有归属、共享目标和待共享，保留网页、解组并断开附着 |

## 先红后绿

先添加三项针对未修行为的回归，再运行基线实现：

```text
 ❯ test/unit/tab-fallback.test.ts (3 tests | 3 failed) 11ms
     × 分组拒绝时仍登记并返回自己创建的标签 5ms
     × 分组超过等待上限时返回普通标签，迟到成功不改变归属 4ms
     × 组命名不返回也不会阻塞创建，失败时清理已创建的组 1ms

Error: unsupported
 ❯ TabRegistry.createTab src/browser/tabs.ts:176:36

AssertionError: expected false to be true // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

应用修复后，同一回归的原始通过输出：

```text
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

完整原文在 `evidence/group-fallback/unit-red.txt` 与 `unit-green.txt`。扩大单测后：

```text
 Test Files  11 passed (11)
      Tests  119 passed (119)
```

新增单测覆盖取消、原生创建迟到、release/forgetAll/关闭/替换期间分组未完成、混合标签与后台重启、会话隔离、创建失败、总等待预算，以及清理不影响其他对话。原生组既有测试保留。

## 提交前审查的生命周期回归

只读审查后，在本线程补测试亲自复现，再应用修复：

| 症状 | 初稿根因与确认输出 | 最终处理位置 |
|---|---|---|
| 写 storage.session 期间取消，创建仍成功返回 | 初稿只在登记前检查 signal，save 后未校验；`expected 'resolved' to be 'rejected'` | `tabs.ts` 的 cancelCreated 同步移除临时归属，save 串行写入撤回，并在 save 后校验 |
| create 回调前关闭/替换，旧 ID 仍登记 | 初稿 pending ID 只在 create 返回后赋值，早到事件无法匹配；removed/replaced 两项均 `expected 'resolved' to be 'rejected'` | pending.lost 记录早到事件，返回后中止，不登记失效 ID |
| 分组成功但命名与解组失败，拖出未撤权 | 初稿把命名失败也标为普通页，忽略之后的组变化；`expected null to be 'A'` | 命名失败保留真实分组；不依赖解组成功来恢复撤权语义 |
| 回退页替换后，迟到清理仍用旧 ID | 初稿迟到闭包捕获旧 tabId；`expected [20]`，实际调用 `[10]` | groupingTabs 跟随替换，只清理该新页当前 ID，关闭后失效 |

前三个根因的四项回归，先跑初稿得到：

```text
 ❯ test/unit/tab-lifecycle.test.ts (4 tests | 4 failed) 163ms
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

修复后的同一四项：

```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

替换与迟到清理交错另行先红：

```text
AssertionError: expected "vi.fn()" to be called with arguments: [ 20 ]
Received:
  [
-   20,
+   10,
  ]
 Test Files  1 failed (1)
      Tests  1 failed | 4 skipped (5)
```

随后同一目标回归：

```text
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
```

这里 4 skipped 来自 `-t` 目标筛选，最终完整单测没有跳过。完整原文为 `lifecycle-red.txt`、`lifecycle-green.txt`、`late-replace-red.txt`、`late-replace-green.txt`。最初命名不返回回归的“不得阻塞”断言保留；审查后将其“清理组”断言修正为“保留真实组并支持拖出撤权”，这是为了避免解组失败造成权限语义与视觉分组不一致。另新增真实 Chromium 的拖出撤权 E2E。

## 集成接触点清单

| 接触点 | 实际验证 |
|---|---|
| `open` / `tabs new` 调用方 | grep 全部 `createTab` 调用；两个生产调用都接入 signal；类型检查通过 |
| 原生 `tabs.group` / `tabGroups.update` | Chromium 扩展中注入接口缺失、拒绝、不返回、命名不返回；新 E2E 验证导航、读取、开页、关闭；正常原生组由原 actions 套件覆盖 |
| 取消、动作超时、迟到完成 | 新单测与真实 Chromium 扩展 E2E；迟到真实 group 调用完成后页仍可读、只解组自己的页 |
| 轮终态与附着管理 | 原 turn-release E2E 验证完整释放、迟到旧轮不影响新轮、确认中停止后下一轮可用；sessions/scheduler 单测通过 |
| 会话与账号隔离 | 普通页跨会话访问隔离、新建页期间 release 只取消目标对话、forgetAll 取消待创建；真实传输换账号用例通过 |
| keepTabs / forgetAll / unshare / 停止入口 | grep 实际调用并读 background/popup；普通页 keepTabs 单测和 E2E、原生组关闭与停止 E2E、共享与换账号既有测试通过 |
| 关闭与替换事件 | 新单测覆盖待创建与已登记普通页；原生替换 E2E 在 Xvfb 下单独通过 |
| 类型、存储与序列化 | `ConversationTabs` 全引用检索，`ungrouped` 只在本地现有会话登记；后台重建单测通过；无网络/schema 变化 |
| 确认、下载、脚本等下游动作 | 完整 E2E 扩大验证，结果见下面；站点授权规则未改变 |
| 文案、构建与安装包 | 中英 `intro1`、README 更新；生产构建自检通过；新 ZIP 根目录 manifest、完整性、无 `__bxTest`/假传输检查通过 |
| Mac Arc 真实运行 | **未验证**；需要用户安装新包，在该 Mac 上复测 open/read、取消和后续轮次；Linux 故障注入不替代真机 |

## 扩大 E2E 的实际结果

首轮完整套件为 `63 passed / 1 failed / 1 skipped / 11 did not run`。失败是传输上传返回 `The files could not be fetched because the browser is not connected.`；原因尚未收敛，没有为它修改生产实现。独立重跑完整传输套件为 `14 passed (10.8s)`。需区分重跑通过与根因修复。

另一次早期目标测试中四项保留页断言失败，原因是新测试误用内部参数 `keepTabs`；协议参数为 `keep_tabs`，纠正测试后新回退 E2E 七项均通过。该测试修正未改生产协议。

随后 `xvfb-run -a pnpm exec playwright test` 的完整带显示环境重跑结果：

```text
  77 passed (1.7m)
```

这一次包含标签替换与全部传输用例，没有跳过。首跑传输失败未收敛到单一根因，保留原始失败记录；若再次出现，需要补录连接状态变更、stream 关闭原因与上传授权确认前后的时间线。所有原始结果保存在同目录的 `evidence/group-fallback/`。

## 安装包

新包另存于本 worktree `dist/browser-extension-group-fallback.zip`，未覆盖原试用包。版本沿用 `0.1.0`，包含 17 文件，manifest 位于 ZIP 根目录，138947 字节，SHA256：

```text
c57c4c0d0b225e4f0595527774e09c5dce7b83fa0d81c667066a347c37a21cae
```

平台来源沿用原试用包公开入口；包不含测试入口。旧试用服务、旧 ZIP、旧工作区与其他仓未改动。此 ZIP 尚未经 Mac 真机加载。

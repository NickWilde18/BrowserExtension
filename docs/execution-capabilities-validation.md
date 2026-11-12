# 执行能力与确认超时分段验证

本段落实已选能力契约：hello.capabilities.actions 使用既有通用动作名；未声明动作在本地拒绝。保留原调试执行层，新增只声明 read 的基础 DOM 原型，不新增插件审计数据库。

## 契约与安全边界

- HelloFrame.capabilities 可选。Identity.hello() 不传参时保留旧帧；传 [] 必须发空数组。运行期总是传当前执行层动作表。旧服务器忽略声明时，本地仍优先返回 unsupported_action，不触碰页面、归属或授权；该判断早于停止与接管。
- 原调试执行层保留 22 个动作。基础 DOM 执行层要求实际 scripting.executeScript、tabs.get、permissions.contains，只声明 read；安全读取前置不足时声明 []。使用原生 API 命名空间，不根据品牌或 UA 选择执行层。
- DOM read 只读取明确共享、已授权且有原生来源权限的 http(s) 当前单文档。隔离世界静态注入 dom-agent.js，复用固定快照实现，不运行动态 eval/Function。校验 origin 与文档令牌，拒绝导航/同 URL 重载后的迟到结果。iframe、零视口与受限页整页拒绝，不输出删减快照。
- 未声明动作返回 unsupported_action；已声明动作在停止/接管中返回 user_stopped。恢复后成功 read 前写动作返回 action_failed。
- 站点、密码、自输完成、脚本、上传、跨站确认超时返回 approval_timeout；明确拒绝、关闭、Esc 保持 user_denied。自输与跨站消息明确已发生效果不能撤销，先读、不自动重试。
- 下载保留动作已发生的 ok：明确拒绝 download_denied=true；确认超时同时有 download_timed_out=true，不把下载拒绝伪装为整个动作未发生。
- 仅平台连接 origin 本地保存沿用已选例外，不扩大到第三方网页 URL。共享与接管沿用稳定 tab/conversation ID 和 storage.session，无审计数据库或时间戳协议。

## 根因证据与先红后绿

原始输出保存在 docs/evidence/execution-capabilities/，按发生顺序保留，未用成功重跑覆盖失败。

| 症状 / 假设 | 证据 | 唯一根因 / 结论 |
|---|---|---|
| 未声明 read 仍访问标签，回 no_tab | capabilities-red.txt；src/actions/index.ts 的 executeRequest 原先直接进入 stopped/touch/动作表 | 缺少执行前能力门禁，已补最前检查 |
| 确认超时回 user_denied，下载缺 timeout 标志 | approval-timeout-red.txt、approval-paths-red.txt；src/actions/context.ts、operate.ts、script.ts、files.ts、navigation.ts | 原确认消费路径没有把 timeout 与明确拒绝映射为不同结果，已逐入口修正 |
| 对话先 read 无页，随后 share 后 active 仍 null | shared-active-red.txt；src/browser/tabs.ts 的已有对话 share 分支 | 仅登记 shared，未在 active 为空时补当前页，已补；已有当前页不切换 |
| clear 后仍出现旧 always grant | site-lifecycle-red.txt；src/policy/sites.ts 原 grant 读改写不受 clear 约束 | 清理未使 pending grant 失效，已用代数栅栏与串行队列约束 |
| 已取消请求的迟到 allow 仍通过 | site-lifecycle-red.txt；src/actions/context.ts authorizeSite 原授权确认后不检查取消 | grant 前后缺少取消检查，已补，并检查请求入口 touch/adopt 授权边界 |
| 并发撤销两站点后第一项残留 | revoke-concurrent-red.txt；src/policy/sites.ts update 的旧代跳过也作用于 revoke | 新栅栏错误跳过旧撤权，已使撤权/清理逐项执行，仅跳过失效授权写入 |

未声明动作，修复前原始失败节选：

```text
-   "code": "unsupported_action",
+   "code": "no_tab",
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

同一目标测试修复后：

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

六条确认路径，修复前原始输出节选：

```text
-   "code": "approval_timeout",
+   "code": "user_denied",
```

同一六条路径加关窗、Esc、站点超时复核：

```text
  9 passed (17.6s)
```

共享页激活，修复前：

```text
AssertionError: expected null to be 77 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 15 skipped (16)
```

授权清理，修复前：

```text
AssertionError: expected [ 'https://old.test' ] to deeply equal []
AssertionError: expected 'allowed' to be 'blocked' // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

并发撤权，修复前：

```text
-   "always": [],
+   "always": [
+     "https://one.test",
+   ],
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

三项授权清理回归，同测通过：

```text
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

共享页激活、能力门禁与授权清理均在完整单测内通过：

```text
 Test Files  17 passed (17)
      Tests  144 passed (144)
```

以上为当次原始输出；后续新测试计数以最终输出为准。

## 最终回归发现的首个滚轮丢失

完整回归初次为 90 passed、1 failed；原 scroll 用例单独重复 5 次均失败（期望 scrollY>400，实得 0）。坐标正确、视口 1200×800、页面高度 3066、命中 DIV；提前等待 1 秒、移除控制条并阻断渲染、提前移动鼠标均不能恢复。实际 Input.dispatchMouseEvent 参数正确且原生返回成功，但页面未收到 wheel。没有将后续追加原生命令后的成功计为修复。

保持 lifecycle、隔离世界、尺寸结果及滚轮参数相同的单变量实验（scroll-bootstrap-comparison.txt）：完整 bootstrap 首发丢失；只提供 viewportSize 的最小代理首发到达；完整 bootstrap 只跳过 _setupHitTargetInterceptors 首发也到达。上游固定 InjectedScript 源码逻辑行 7890–7900 显示该初始化安装 capture:true/passive:false 输入监听器；其事件集合不含 wheel，不能声称 JavaScript 直接拦截 wheel。可确认的根因是 src/browser/tab-session.ts 的 ensureViewport 为读尺寸初始化整个交互代理，触发了导致首发输入丢失的初始化副作用。

修复把视口检查改为在同一隔离世界直接读取尺寸，完整代理与元素安全检查在实际需要时保留。没有重试输入、关闭安全拦截器或延长固定等待。新回归检查首次且唯一可信 wheel、实际滚动及后续 ref 滚动。

修复前同测原文：

```text
Expected: 1
Received: 0

  1 failed
```

修复后同测重复五次：

```text
  5 passed (5.6s)
```

最终 typecheck 通过，完整单元及 Xvfb 浏览器输出：

```text
 Test Files  17 passed (17)
      Tests  145 passed (145)

  91 passed (2.5m)
```

后台丢弃页恢复、iframe、所有输入动作、真实 fetch、轮释放、切服与接管均在最终完整回归中实际运行通过。

## 跨引擎真实探针

Firefox 使用缓存二进制 155.0，固定 web-ext 8.9.0，默认新临时 profile，dom/event 模式加载真实临时扩展。没有关闭沙箱或改权限。启动版本探测曾输出 user namespace EPERM 警告，后续正常启动路径确实安装并执行了临时扩展。

1. dom-event-result.json：首次 passed=false，framesRejected=false。实际扩展加载、read/ref、能力声明、无调试权限与未声明动作拒绝均通过；首轮 iframe 失败原因未收敛，不倒推归因。
2. dom-event-observed.json：只加观测后 passed=true。frameUpdate/frameWait 仍是 /form.html complete，但 frameResult 为 unsupported_page，读取后实际为 /iframe.html、frames=2。此结果揭示旧等待条件能接受旧文档，不能据此证明首次失败根因。
3. dom-event-target-ready.json：要求 tabs URL 为目标且 DOM readyState=complete、frames>=2 后再 read，passed=true。frameDocumentBeforeRead 确认为 /iframe.html、complete、frames=2；结果 unsupported_page 且无 snapshot。执行层未按首轮失败猜测改动。

三份 JSON 和对应 runner 日志均保留。传输明确为 fake，页面授权为 test-harness，不能表述为真实平台鉴权或用户授权流程通过。最终一次进程检查没有发现本任务 dom-event-probe 路径的 Firefox 残留。

探针类型检查曾失败 TS18046（request 的 wait 推导为 unknown），导致同一复合命令中的 Vitest 被跳过，虽然末尾探针 exit0。已显式指定 ResultFrame，独立重跑 typecheck 和完整单测通过；没有以复合命令退出码代替逐项检查。

## 集成接触点清单

| 接触点 | 实际验证 | 状态 |
|---|---|---|
| 协议 schema / Identity / Runtime hello / fetch 序列化 | 单测门禁、hello 缺省/空数组/read 测试；transport E2E 实际收到完整 22 动作 hello | 最终重跑通过 |
| 执行调度 / 停止 / 对话接管 | src/runtime.ts 在 controls.begin 前门禁，原调试执行表保留；控制条及 release E2E | 最终完整回归内通过 |
| 站点/密码/自输/脚本/上传/跨站/下载确认 | 六条 timeout E2E、站点超时、关窗与 Esc、下载允许/拒绝 | 最终完整回归内通过 |
| 切服、同名账号、账号变化、ScopedKV | server-settings、server-switch、transport、runtime-lifecycle 与 SiteStore 单测 | 最终完整回归内通过；新并发撤权单测通过 |
| DOM read / 页面元数据 / ref / 文档变化 / 权限 / iframe | Chromium dom-backend E2E、Firefox 三轮真实扩展探针 | 基础原型通过，平台鉴权未验 |
| API 命名空间 / worker 与 event manifest / 打包资源 / 许可 | 自动调试 worker、DOM worker、DOM event 三个生产构建；19 文件 ZIP 与实测目录逐文件比较、无测试入口、最小权限及许可检查 | 全部通过；event 仍是原型 |
| Popup 状态类型 / 中英文文案 / README | typecheck、真实 popup E2E、源码与全部引用核对 | 通过；原生跨主机权限弹窗人工允许/拒绝未验 |
| 既有动作输入与快照 | 首个 wheel 回归先红后绿；最终完整 Xvfb E2E 91 passed，含后台丢弃页恢复和原调试 iframe | 通过 |
| 数据持久化/迁移/下游 | 新能力不持久化；连接 origin 例外、稳定 ID 与 session 生命周期不变；Chat/UI 由协调会话处理 | 插件源码核对；跨仓部署未验 |
| Safari 与 Firefox 平台连接 | 当前 Chat 来源仅接受 chrome-extension://；本机 Linux 无 Safari | 未设计/未验，不声明产品支持 |

## 新生产候选包与保留项

新包为 dist/browser-extension-capabilities-trial.zip，版本 0.1.0、19 文件、219629 字节，SHA256 为 1a268485c0de9a287f49831a664fb42ffb5490a83c61e2a984d5c1313ed06bab。保持固定开发扩展 key。指定试用目标的编译 origin 与主机权限均匹配；无测试入口/假传输，许可与静态注入资源齐全，ZIP 与真实加载目录逐文件一致。

独立 Chromium 临时 profile 加载此生产目录，合成登录后 waiting_login/unauthenticated → connected，指定目标 stream POST 401 → 200，自建浏览器已关闭。这只证明插件新包与当前试用平台能握手，不替代尚未部署的 Chat/UI 新能力筛选及审计联调。

验收脚本首次误报 target_origin_matches=false：esbuild 将配置合并成 var EXECUTION_BACKEND = "auto", PLATFORM_ORIGIN = …;，旧正则要求常量紧跟 var。实查唯一赋值且目标相同后修正声明解析，同一已有 ZIP 重验全部通过，文件 SHA 未变化；初次失败 JSON 与修正脚本保留。

旧分组通用包 c57c4c… 和正确试用包 1ceb4c… 的 SHA256 均实际复核未变。原服务和下载入口没有替换，新包仅作为协调会话待发布候选。Safari、Firefox 平台鉴权、Mac 真机与人工跨主机权限弹窗仍按清单明确未验。

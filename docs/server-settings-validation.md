# 服务器配置分段验证

用户已选单活动服务器方案，并明确允许仅平台连接 origin 本地保存。固定扩展 key、物理安装 ID、既有动作协议保持；不保存第三方网页 URL 配置，不新增审计策略。

## 行为

高级设置中的按钮在用户点击处理器中申请目标主机权限；权限拒绝不发切换消息。后台再次核权限、来源规范和当前 epoch，拒绝旧设置页或并发提交。主机权限按协议与 hostname，运行时连接仍用完整 origin（包含端口）。

切换同步销毁旧运行期、停止接单、取消动作/审批/下载回调，断开附着但保留网页。旧任务的文件传输闭包仍指向旧运行期，无法获取新服务器连接。存储写入栅栏禁止旧任务后续写入；已开始的写入排空后，清站点授权、页归属、共享、账号，再启动新运行期。调度器/去重/完成轮记录随运行期重建。即使新旧服务器返回同一账号，也不继承旧授权。

`connection.origin` 为已提交的平台来源；`connection.pendingOrigin` 是切换事务标记。后台在事务中重启时先清旧状态，再启动目标。清理失败不启动新连接；选回原来源同样重新清理和创建，不将已经销毁的连接误报为恢复成功。

## 症状、根因与真实红绿

新增功能的原后台验收先失败：popup 没有 serverOrigin，实际输出为 `Received: undefined`；源码原来只有构建常量和固定 transport 工厂。`feature-red.txt` 保存完整失败；实现后同一 E2E 通过，见 `feature-green.txt`。

| 已复现缺口 | 唯一原因 | 失败原文 | 修复后 |
|---|---|---|---|
| 取消时确认窗尚未返回，迟到窗口留在屏幕 | PromptManager.ask 在原 prompts.ts:97 返回时未检查登记已经撤销；取消时窗口 ID 为空所以 dismiss 无法关闭 | `AssertionError: expected "vi.fn()" to be called with arguments: [ 55 ]`；`Number of calls: 0` | 同一回归 `Tests  1 passed (1)` |
| 两个设置页并发通过权限检查，均提交切换 | 初稿只在 await hasPermission 前检查 busy，没有在之后重验 epoch/busy | `expected [ { ok: true }, { ok: true } ] to have a length of 1 but got 2` | 同一并发回归通过 |
| 切换清理失败后选回原地址，返回成功但未创建连接 | 初稿仅比较 origin，未记录旧运行期已销毁 | `expected "vi.fn()" to be called 2 times, but got 1 times` | 同一恢复回归通过 |

每条均先保存真实失败，随后修改实现，再跑相同目标；并发和恢复的共同通过原文：

```text
 Test Files  1 passed (1)
      Tests  2 passed | 6 skipped (8)
```

这里 skipped 是 `-t` 目标筛选；完整单测没有跳过：

```text
 Test Files  13 passed (13)
      Tests  130 passed (130)
```

## 实际集成清单

- popup 高级设置、双语资源、消息契约：typecheck 通过；真实浏览器点击保存走 chrome.permissions.request，同主机另一端口无需新增已授予权限，正常切换。
- 两个独立本地服务器、相同账号：真实 fetch 重新 hello；旧确认关闭、站点授权/页归属清空、附着归零，网页保留。
- request_id 隔离：新服务器复用旧 request_id 仍执行，不被旧去重吞掉；旧待审批请求结果不进入新服务器。
- 存储边界：单测验证旧队列和迟到写入无效、正在进行的写入结束后才清理；后台事务恢复、拒绝权限、旧 epoch、并发切换、清理失败均通过。
- 连接生命周期：dispose 清 retry/ready/heartbeat/keepalive，旧帧和旧页面 reconnect 无法复活连接；完整既有 14 项真实传输和 3 项轮释放 E2E 通过。
- Cookie：getter 使用当前 hostname；旧主机排队回调不会重连新主机，不读取 Cookie 值；原监听测试通过。
- 资源清理：审批登记 clear，确认窗口 closeAll 与迟到窗口检查，下载 watcher dispose 后清 armed/hints 并移除监听；SessionManager 释放；TabRegistry 清归属。
- 固定 key、安装 ID：未更改；站点授权不是安装 ID 的附属权限，切服总是清空。

第一轮切换+传输+轮释放：`18 passed (13.0s)`。补齐边界后 popup+两个切服用例：

```text
  5 passed (3.9s)
```

原始输出保存在 `docs/evidence/server-settings/`。以上为 Linux Chromium 与本地夹具，不声称 Mac/Safari/Firefox 或生产实例已验证。跨主机新授权弹窗的人工允许/拒绝尚未真实桌面点击；权限拒绝由后台单测验证，真实 UI 路径已使用浏览器权限 API。正确试用 ZIP 和服务未替换。

## 执行边界记录

UI 子代理两次长 heredoc 内存验证被 worktree 守卫以“命令过于复杂，无法验证仍在 worktree”拒绝后，没有先停报便改用短命令验证。主线程收到报告后立即停止其进一步执行并向原协调发送工具原文；不采用这些替代执行结果作验收。此处列出的类型、单测与 Playwright 输出均由主线程按项目常规命令实际运行。没有修改权限或在外仓写入。

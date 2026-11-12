# 对话接管分段验证

用户已选网页控制条与显式对话级接管，并确认可信 popup 逐对话恢复是必要出口。本段没有人活动自动识别，没有新审计数据库。

## 控制与信任边界

控制条由 `scripting.executeScript` 注入，不依赖 CDP 附着。manifest 增加 scripting；来源权限通过 popup 点击处理器申请，只对已登记/明确共享页面的顶层 frame 注入。站点授权给助手与浏览器授予注入权限是两件事；缺少后者时不注入。浏览器受限页或无权限页仍可用可信 popup。

后台绑定 tabId、frameId=0、documentId、运行期 epoch 和每次注入的随机令牌。每条控制命令重新检查归属和浏览器来源权限；旧 document、旧 epoch、错误令牌、别的扩展/标签/子 frame 均不接受。页面不承载站点、密码、脚本、上传或下载的授权确认。关闭的 ShadowDOM 只减少网页样式和页面快照干扰，不是授权信任边界。

只显示 conversation_title 和固定 action 名称，纯文本渲染，不显示提问全文、网址或账号。折叠按钮明确表示“不停止操作”，不把页面移除组件或普通键鼠活动认作接管。

接管先阻止本对话后续动作，取消执行/排队请求，并等待本对话全部附着释放，之后才显示已接管。其它对话不受影响。期间收到动作返回 user_stopped，消息明确要求用户点击网页或 popup 的 Let the assistant continue，不要重试。

恢复只进入 observing：成功 read 前，写操作回 action_failed；tabs list 可查看现状，无页时可先新开一页，再 read。不重放已取消动作；已发出的浏览器操作无法撤销，结果未知时不能自动重试。

最后一页关闭仍保留接管。可信 popup 展示受控对话列表，仅标题或短稳定 ID，逐项恢复走同一后台路径。全局恢复只清 global stopped，不连带恢复这些对话。

模式存于 storage.session 的 `control.conversations`，只含稳定对话 ID 与模式。service worker 重启保留；taking_over 重启时先补做释放，再确认 user。浏览器整体重启时，与页归属一起清除；旧页面不再归助手。换服务器或账号按硬清理同时删除列表和状态。

## 先红后绿

未实现控制条时的真实浏览器失败：

```text
Locator: locator('#browser-assistant-controls')
Expected: visible
Timeout: 2000ms
Error: element(s) not found
1 failed
```

同一核心流程实现后：

```text
  1 passed (2.2s)
```

补后台恢复回归，发现初稿 `control.ts` 将 taking_over 与 user 均保存成 user；内存虽等待释放，重启却会提前声称完成。真实失败：

```text
AssertionError: expected { A: 'user' } to deeply equal { A: 'taking_over' }
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

修复状态映射及恢复释放流程后，目标控制状态/消息校验套件：

```text
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

最后一页关闭后的可信恢复入口，在添加前真实失败：

```text
Locator: locator('#controlledConversations li')
Expected: 1
Received: 0
1 failed
```

添加后，含此用例的真实浏览器控制条套件：

```text
  4 passed (4.0s)
```

完整单测：

```text
 Test Files  15 passed (15)
      Tests  137 passed (137)
```

## 实际集成验证

- 注入权限、顶层目标、伪造消息、未登记页和未授予注入权限的来源：单测与真实 Chromium E2E。
- 归属关闭/替换/解组、撤销共享、保留网页清归属、切服/换账号：事件处理引用核对；保留网页清归属控制条移除经 E2E。
- 释放确认、对话隔离：真实鼠标点击关闭 shadow root 中的主按钮；接管后本对话附着释放，另一对话继续；新请求准确回 user_stopped。
- 恢复与取消：新写操作在成功 read 前被拒，不复播旧动作；迟到旧 read 不能解除新接管，单测通过。
- 恢复出口：关闭最后一页、全局 stop/resume 后仍保持对话接管，再由可信 popup 指定恢复，E2E 通过。
- 后台生命周期：storage.session 模式恢复、释放中重启补清理、旧 epoch/旧 document 消息拒绝，单测通过。
- 类型、资源与打包：typecheck 和测试构建通过；controlbar.js 为独立注入资源，无网页端连接来源或账号。

原始输出见 `docs/evidence/control-bar/`。这些是 Linux Chromium 和模拟边界的结果，不是 Mac/Safari/Firefox 真机结果。浏览器整体重启不会重新接回旧页面；需要用户新请求和新的归属/共享。正确试用 ZIP 和服务仍未替换。

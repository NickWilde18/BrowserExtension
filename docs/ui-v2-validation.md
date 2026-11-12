# 界面第二版：结构、命名与验证

Tark#528 拍板 rev 531（2026-11-12）：结构定为 A（标签页），设置用一列入口加二级页；沿用设计状态集 07 的校徽、紫色语义色、
360×600 弹窗与系统明暗主题，保留背景校徽水印。只针对 Chromium 和 Firefox，Safari 不在本轮范围（已有的 Safari 构建代码未动）。
本轮只改界面层：协议帧、权限、后台消息与状态（`PopupState`、`PageMessage`、`PanelRender`）都没有变。

## 结构

| 界面 | 第二版 |
| --- | --- |
| 弹窗页头 | 校徽 + 「大学 AI 服务平台 / 浏览器助手」（英文 AI Service / Browser Assistant）+ 状态胶囊；不再写学校名，去掉「浏览器扩展」大标题 |
| 已连接 | 标签「当前页 / 站点 / 对话 / 设置」，站点与已接管对话的数量写在标签上；底部整宽「停止操作网页」，停止后同一位置是「恢复操作网页」，当前页顶部出现停止横幅 |
| 设置标签 | 一列入口：此浏览器（重命名）、使用范围与隐私、高级设置（切换平台）、帮助与关于；下面是「退出插件登录」。二级页仍在「设置」标签下，用「‹ 设置 / …」面包屑返回 |
| 未连接 | 一页：校徽、标题、说明、「连接平台账号」（登录中是「中止并重新连接」）、「打开平台」；底部一行小字链接进同样的二级页（面包屑写「返回」） |
| 确认窗 | 页头是校徽 + 「需要你的确认 / 浏览器助手」+ 关闭（=拒绝）；窗口标题带平台名；拒绝 / 允许等宽并排，和键盘说明一起固定在底部，长脚本在上方内容区滚动 |
| 网页控制条 | 校徽 + 状态 + 带文字的「⌄ 收起」（悬停：收起控制条，助手继续操作）；第二行「在做什么 · 对话标题」；说明与「手动接管」同一行。收起后是带转圈外环的校徽圆钮，左边胶囊写状态 |

## 命名

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `extName` | 大学 AI 服务平台浏览器助手 | AI Service Browser Assistant |
| `extShortName` | 大学 AI 浏览器助手 | AI Service Browser |
| `brandName` / `controlBrand` | 大学 AI 服务平台 | AI Service |
| `login` / `restartLogin` | 连接平台账号 / 中止并重新连接 | Connect account / Cancel and start over |
| `stop` / `resume` | 停止操作网页 / 恢复操作网页 | Stop web actions / Resume web actions |
| `controlTakeOver` | 手动接管 | Take over |

中文文案不再出现英文平台名 AI Service（单测 `locales.test.ts` 锁住）。全称只用在插件名和未登录标题「连接到大学 AI 服务平台」。

## 集成接触点

| 接触点 | 验证 |
| --- | --- |
| `PopupState` → 弹窗（标签 / 二级页 / 登录页） | 只改可见性与文案，后台消息不变；新增 `popup-layout.spec.ts`，原有用例改为先切到对应标签 |
| 弹窗 → `popup:*` 消息 | 停止、恢复、共享、取消共享、移除站点、逐对话继续、退出、切服、重命名的元素 id 保持；对应 e2e 全部通过 |
| 确认窗 `page.ts` ↔ `approval.html` | 只换页头与底部操作区的位置，元素 id 不变；`approvals.spec.ts` 20 条通过（含长脚本时按钮可达、窄窗不横向溢出） |
| 控制条 closed shadow root | DOM 与样式重排，消息绑定（epoch、token、isTrusted）不变；`control-bar.spec.ts` 通过，`clickPanelButton` 改为同时点中间与偏右（主按钮在说明右侧） |
| 文案 `_locales` ↔ 源码 / 页面引用 | `locales.test.ts`：中英键一致、引用的键都存在、拍板命名 |
| 构建产物 | 生产构建 Chromium / Firefox 通过；manifest 名称取 `__MSG_extName__` / `__MSG_extShortName__` |
| Firefox | 用 Firefox 生产构建的页面在 Playwright Firefox 里渲染（chrome.* 换成内存桩、合成数据），中英 × 明暗都没有横向溢出；未在真实 Firefox 加载临时扩展点按 |

## 回归证据

`docs/evidence/ui-v2/` 下：`locales-red.txt` / `locales-green.txt` 是文案用例的先红后绿；`popup-e2e-red.txt` 是界面用例对着改前代码跑出的红
（11 条失败），`popup-e2e-green.txt` 是改后全套 e2e 的结果。

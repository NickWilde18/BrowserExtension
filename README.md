# 浏览器插件

让平台对话里的 Agent 在用户授权过的站点上操作用户本机的 Chrome / Edge（Manifest V3）。需求见 Tark#528，
插件与平台之间的契约（帧、22 个动作、错误码、两边各自的边界）在 Chat 仓的 `docs/BROWSER_EXTENSION.md`。

> **传输层待定**（Tark#528 计划第 9 节第 11 条）：本仓库只有传输接口 `src/connection/transport.ts` 和一个内存
> 假传输（测试用）。生产构建现在连不上平台，弹窗显示「这个版本还不能连接平台」。

## 构建

```bash
pnpm install
PLATFORM_ORIGIN=https://<平台对外地址> pnpm build        # 产物在 dist/
```

- `PLATFORM_ORIGIN` 是用户地址栏里的那个平台地址，manifest 的主机权限由它生成。插件里只有这一个地址。
- 构建时从 `playwright-core`（版本钉死 1.62.1）取出页面注入脚本，许可（Apache-2.0）随产物放在
  `dist/third_party/playwright/`。换版本时 `scripts/extract-injected.mjs` 的结构断言会先失败。
- 生产构建检查产物里不含测试用的假传输与测试入口。

## 开发者模式安装

`chrome://extensions`（Edge 是 `edge://extensions`）打开「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/`。
manifest 里的 `key` 固定了开发者模式的插件 id：**`agagklnjfndomhambbpfhenaoclcbpmo`**，平台的
`browserExtension.allowedExtensionIds` 要登记它（商店上架后商店会给另外的 id，也要登记）。对应的私钥不在仓库里。

权限：`debugger`、`tabs`、`tabGroups`、`storage`、`downloads`，以及平台地址的主机权限。不申请 `cookies`、
`proxy`、`management`，不声明 `externally_connectable`，不注册内容脚本。安装时浏览器会提示「读取和更改所有网站上的
数据」，来自 `debugger` 权限。

## 测试

```bash
pnpm typecheck
pnpm test                       # vitest 单测
xvfb-run -a pnpm e2e            # Playwright 端到端（不带 xvfb-run 时，要有界面的那个用例会跳过）
```

端到端测试加载测试构建（`dist-test/`，`--test-hooks`）：连接换成内存假传输，测试代码扮演 Chat 收发帧，在本地夹具
站点（`test/e2e/fixtures/server.mjs`，`127.0.0.1` 与 `localhost` 两个来源）上真跑动作、点确认小窗。

`test/probe/` 是实测用的常驻探测进程（有界面的浏览器 + 本机控制端口 + XTest 点击），用来测调试提示条这类要
「看一眼屏幕再点」的项目。

## 页面快照格式

`read` 输出与云浏览器、Playwright MCP 相同：Playwright 注入脚本 `ariaSnapshotWithRefs(body, {mode: 'ai'})` 的
YAML 形态，可交互的元素带 `[ref=e12]`。iframe 的内容缩进拼在 `- iframe [ref=…]:` 下面，编号带框架前缀
（`f1e3`），拼法与 Playwright 服务端的 `ariaSnapshotForFrame` 一致。注入脚本与插件自己的页面代理
（`src/browser/page-agent.ts`）装在每个框架的**隔离世界**里，页面自己的脚本看不到。

```
- generic [active] [ref=e1]:
  - heading "Sign up" [level=1] [ref=e2]
  - textbox "Name" [ref=e5]
  - combobox "Color" [ref=e11]:
    - option "Red" [selected]
  - iframe [ref=e30]:
    - button "Count" [ref=f2e3]
```

## 目录

| 位置 | 内容 |
|---|---|
| `src/protocol/` | 帧与 22 个动作的参数校验、错误码 |
| `src/connection/` | 传输接口、连接状态机（ready、心跳、退避重连、保活）、内存假传输 |
| `src/scheduler.ts` | 同一对话串行、不同对话并行、排队上限、去重、恰好一个结果 |
| `src/approval/` | 审批帧接收规则、确认小窗、先问审查再问用户的流程 |
| `src/policy/` | 网址可开范围、站点授权记录、凭据头去除 |
| `src/browser/` | 调试接口封装、标签页会话（框架、子会话、对话框、日志）、页面代理、输入、AI 标签组、导航拦截、下载拦截 |
| `src/actions/` | 22 个动作 |
| `src/popup/`、`src/approval/page.ts`、`static/`、`_locales/` | 弹窗、确认小窗、中英文 |

## 实测结论（Tark#528 计划第 7 节，2026-11-05，Chrome for Testing 154，Linux）

- **第 2 项 后台标签**：AI 的标签开在后台（不抢用户正在看的标签），快照、点击、截图都正常。浏览器省内存时**丢弃**
  后台标签会换掉标签 id（`tabs.onReplaced`），调试附着以 `target_closed` 断开；插件按新 id 接着用，附着前先重新
  加载。丢弃后在后台重新加载的标签视口是 0×0（拿不到编号、截图为空），插件按窗口尺寸临时给它一个视口，标签切到
  前台时撤掉。被**冻结**的页面：读页面正常，点击、截图会一直不返回；插件附着时先解冻，动作超时后断开这一页的
  附着、下次换新会话，不会把对话的请求队列堵死。
- **第 3 项 快照复用**：Playwright 注入脚本经调试接口在隔离世界里跑起来，输出与云浏览器同格式；跨源 iframe 走
  调试接口的子会话，快照与点击都通。
- **第 4 项 调试提示条**：「"<插件名>" started debugging this browser [Cancel] [×]」出现在工具栏下方，**整个窗口
  都有**（用户自己没被附着的标签上也有），把当前显示的标签页往下推 56 像素（后台标签不受影响，截图不包含它）。
  点「Cancel」和点「×」效果相同：调试接口以 `canceled_by_user` 断开插件的**全部**附着；插件置为已停止，不重新
  附着，之后的请求回 `user_stopped`，直到用户在弹窗里点「恢复」。
- **第 5 项 分发**：没测。eb 不在校园网，测不了 Edge 加载项商店在校园网的可达性；开发者模式安装见上。
- **第 6 项 文件、iframe、对话框**：上传在页面里构造 `File` 放进文件框，页面的 `change` 监听收到正确内容（含藏在按钮
  后面的文件框：插件拦下文件选择框拿到背后的文件框）。下载两条路都要：导航类下载（附件链接、跨源的文件地址、表单
  POST 导出）在**响应阶段截下**，`<a download>` 这类不经导航的下载**在页面里带登录态重新取**；两种都不落进下载
  目录。alert / confirm / prompt 能稳定拦到并处理。
- **跨站拦截**：拦下的导航本地回 204，页面留在原处；用 `failRequest` 的话 Chrome 会提交一个「被扩展程序屏蔽」的
  错误页。同站链接 302 到别的站点，第二跳同样被拦，被拒的站点一个请求都没收到。

## 已知限制

- 传输层未实现（见上）。
- AI 点了 `target=_blank` 链接新开的标签：导航不经插件的跨站拦截（拦截挂在 AI 的标签上），新标签不归 AI。
- 下载在动作结束之后才开始的（页面延迟触发），不拦，按浏览器自己的下载处理。
- Edge 未实测（同为 Chromium，接口相同）。

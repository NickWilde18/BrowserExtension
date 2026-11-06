# 浏览器插件

让平台对话里的 Agent 在用户授权过的站点上操作用户本机的 Chrome / Edge（Manifest V3）。需求见 Tark#528，
插件与平台之间的契约（帧、22 个动作、错误码、两边各自的边界）在 Chat 仓的 `docs/BROWSER_EXTENSION.md`。

## 连接平台

fetch 双向通道（计划第 9 节第 11 条定为 A2，契约第 2 节，`src/connection/fetch-transport.ts`）：四个接口都在
`<平台对外地址>/chat-service/browser/` 下，一律 POST、带浏览器里的平台会话 Cookie（`credentials: "include"`），
**不带 `X-Service` 头**（网关按路径选服务名）。

| 接口 | 用途 |
|---|---|
| `stream` | 请求体是 hello，响应是 NDJSON 下行流（一行一帧，块边界可能切在半行里） |
| `frames` | 上行帧 `{"install_id", "frame"}`：result、progress、approval_request；成功是 200 `{}`，按 2xx 判 |
| `uploads` | 凭请求里的令牌取上传文件的原始字节；读到的字节数与 `Content-Length` 不符就当没取到，不放进页面 |
| `files` | 下载、存 PDF 的内容 multipart 送回，拿 `file_id` |

`install_id` 只用规范形态的 UUID（小写带连字符，Chat 对不是的回 400）；本地存储里的值不合规时换一个新的。

插件发起的 WebSocket 握手带不上 `SameSite=Lax` 的会话 Cookie，fetch 带得上（计划 7.1 实测），所以不用 WebSocket。

## 构建

```bash
pnpm install
PLATFORM_ORIGIN=https://<平台对外地址> pnpm build        # 产物在 dist/；也可以写 pnpm build --platform-origin https://…
```

- 平台对外地址是用户地址栏里的那个，manifest 的主机权限由它生成，真实传输连它。插件里只有这一个地址。
- 构建时从 `playwright-core`（版本钉死 1.62.1）取出页面注入脚本，许可（Apache-2.0）随产物放在
  `dist/third_party/playwright/`。换版本时 `scripts/extract-injected.mjs` 的结构断言会先失败。
- 生产构建检查产物：不含测试用的假传输与测试入口，含真实传输，不出现 `X-Service`。`--fake-transport` 只能和
  `--test-hooks` 一起用。

## 开发者模式安装

`chrome://extensions`（Edge 是 `edge://extensions`）打开「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/`。
manifest 里的 `key` 固定了开发者模式的插件 id：**`agagklnjfndomhambbpfhenaoclcbpmo`**，平台的
`browserExtension.allowedExtensionIds` 要登记它（商店上架后商店会给另外的 id，也要登记）。对应的私钥不在仓库里。

权限：`debugger`、`tabs`、`tabGroups`、`storage`、`downloads`、`cookies`，以及平台地址的主机权限。`cookies` 只用来
监听平台站点会话 Cookie 的变化：同一台浏览器上退出登录、换人登录时一变就断开重连（`src/connection/cookie-watch.ts`），
不读写 Cookie，构建后会检查产物里没有读写 Cookie 的调用；Chrome 只把主机权限覆盖的站点的 Cookie 事件交给插件，插件的
主机权限只有平台地址。不申请 `proxy`、`management`，不声明 `externally_connectable`，不注册内容脚本。安装时浏览器会
提示「读取和更改所有网站上的数据」，来自 `debugger` 权限。

收会话 Cookie 的变化事件有两个前提（实测）：平台地址不带端口（Chrome 按 `<协议>://<域>/` 判主机权限，主机权限里带了
端口就一条都收不到）；平台是 https 时网关下发的会话 Cookie 要带 Secure（事件网址的协议看 Cookie 有没有 Secure）。
本机联调要用带端口的地址时，按不带端口的主机名构建（如 `--platform-origin http://chat.test`），再给 Chromium 加
`--host-resolver-rules="MAP chat.test 127.0.0.1:<端口>"`。

## 测试

```bash
pnpm typecheck
pnpm test                       # vitest 单测
xvfb-run -a pnpm e2e            # Playwright 端到端（不带 xvfb-run 时，要有界面的那个用例会跳过）
```

`pnpm e2e` 先构建两个测试版（`pnpm build:test`），再在本地夹具站点（`test/e2e/fixtures/server.mjs`，`127.0.0.1` 与
`localhost` 两个来源）上真跑动作、点确认小窗：

- `dist-test/`（`--test-hooks --fake-transport`）：连接换成内存假传输，测试代码扮演 Chat 收发帧；
- `dist-test-fetch/`（`--test-hooks`）：真实传输，平台地址是仿 Chat 服务（`test/e2e/fixtures/chat-server.mjs`，
  `127.0.0.1:18963`）。它下发与网关同属性的会话 Cookie（`HttpOnly; SameSite=Lax`），校验 Cookie 与 `Origin`，
  被拒时的响应体与 Chat 一致；`transport.spec.ts` 测连上、动作结果、上传、下载、轮换、断线、401、403、413、
  轮换后到达的审查结论、换账号，以及每个请求只走这四个路径、不带 `X-Service`。

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
| `src/connection/` | 传输接口、真实传输（fetch 双向通道）、连接状态机（ready、心跳、退避重连、轮换、保活）、账号变化、内存假传输 |
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
- **新开标签**：AI 标签打开的弹出标签，调试接口在它发出请求前接不到（标签页级的自动附着收不到 popup），所以 AI 动作
  期间，会新开标签的导航留在本标签：`target=_blank` 的链接与表单、带修饰键或中键的链接点击、`window.open(http(s))`
  都改成本标签的顶层导航，走同一套跨站拦截（`src/browser/newtab-guard.ts`，页面主世界里先于页面脚本装上，只在
  动作期间生效）。实测三种情况被拒时目标站点 0 个请求、不多开标签；允许后在本 AI 标签里打开。用户自己在 AI 标签里
  点的照常开新标签，插件不附着它。

## 行为说明

- AI 动作期间会新开标签的链接、表单、`window.open`，在当前 AI 标签里打开（原来的页面在历史里，可以后退）。
- AI 自己开的标签里，动作之外（页面延迟触发、用户自己点）的下载会被取消，不落进下载目录，并在这个对话的下一个结果的
  `message` 里告诉模型文件名与站点。用户共享进来的页面、AI 标签之外的标签里的下载照常。
- 用户允许了下载、文件却没取回来（链接只能用一次、站点要求重新登录、浏览器断线、送回平台失败）：动作本身已经生效，
  结果仍是 `ok`，`payload.download_failed` 为 `true`，`message` 写原因并写明不要重做。文件超过平台的文件上限时回
  `file_too_large`（`files` 回 413 也一样）。
- 弹窗「共享此页」下面写明会共享给谁：「将共享给：<对话标题>」（标题来自请求的 `conversation_title`，按纯文本
  显示）；最近用过浏览器的对话标题为空时「将共享给最近使用浏览器的对话」，还没有对话用过时「将共享给下一个使用
  浏览器的对话」。
- 连接：`rotate`（连接到了 5 分钟寿命）与 `server_shutdown` 立刻重连；断线、404、429 按 1 秒起翻倍、封顶 60 秒、
  带抖动的退避重连；401 时弹窗提示在平台网页上登录，之后按退避重试；`stream` 上 403（平台没登记这个插件）停住、
  弹窗提示，点「重新连接」再试；`protocol_unsupported` 提示升级、不重连。轮换、重连之后，旧连接上开始的请求，它的
  取消与审查结论从新连接来，照认。
- 换了平台账号（`ready.account` 与上次连上时不同，上次的账号记在本地存储）：新连接可用之前，先中止排队与在跑的
  请求、清掉站点授权（含「总是允许」）、对话到标签组的对应与「将共享给」、待共享的标签，断开调试附着；AI 标签不关，
  只解散标签组。上一个账号的请求的结果不再发出（平台那边按超时收尾）。清理失败时这条连接不用，按退避重连再清。

## 已知限制

- 结果帧 8 MiB 的上限按 JSON 的字符数估算，页面以中文等非 ASCII 字符为主时实际字节会更多；超过 `frames` 的
  9 MiB 时平台回 413，插件改发一条 `action_failed`（「The result was too large to send.」）。
- 新开标签的守卫跑在页面主世界里，页面自己的脚本能绕过它（比如从新建的 iframe 里拿原生的 `window.open`）。页面脚本
  本来就能直接请求外站，不在这条防线的范围内（计划第 10 节）；动作期间万一还是冒出了新标签，后台立即关掉它并告诉
  模型，但挡不住它已经发出的请求。
- AI 标签没附着时（空闲超过 5 分钟断开），动作之外的下载按来源页网址认：打开同一网址的标签里有用户自己的标签时，
  不认作 AI 标签的下载，照常下载。
- Edge 未实测（同为 Chromium，接口相同）。

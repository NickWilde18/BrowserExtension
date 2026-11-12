# 浏览器插件

让平台对话里的 Agent 在用户授权过的站点上操作用户本机的 Chrome / Edge（Manifest V3）。需求见 Tark#528，
插件与平台之间的契约（帧、22 个动作、错误码、两边各自的边界）在 Chat 仓的 `docs/BROWSER_EXTENSION.md`。

## 连接平台

fetch 双向通道（计划第 9 节第 11 条定为 A2，契约第 2 节，`src/connection/fetch-transport.ts`）：四个接口都在
`<平台对外地址>/chat-service/browser/` 下，一律 POST、`Authorization: Bearer <安装凭据>`、`credentials: "omit"`，
**不带 `X-Service` 头**（网关按路径选服务名）。网关每个请求向 Chat 同步校验凭据，不缓存，不以平台 Cookie 或插件 Origin 白名单认证。

| 接口 | 用途 |
|---|---|
| `stream` | 请求体是 hello，响应是 NDJSON 下行流（一行一帧，块边界可能切在半行里） |
| `frames` | 上行帧 `{"install_id", "frame"}`：result、progress、approval_request、released；成功是 200 `{}`，按 2xx 判 |
| `uploads` | 凭请求里的令牌取上传文件的原始字节；读到的字节数与 `Content-Length` 不符就当没取到，不放进页面 |
| `files` | 下载、存 PDF 的内容 multipart 送回，拿 `file_id` |

`install_id` 由安装公钥算出：首次运行用 WebCrypto 生成 ECDSA P-256 密钥对（私钥不可导出），CryptoKeyPair 存进插件的 IndexedDB；`install_id` = SHA-256(raw 公钥) 前 16 字节，置 UUIDv8 版本位与 RFC 9562 变体位，排成小写带连字符的规范形态。当前使用的 `install_id` 存在 `storage.local` 的 `identity.installId`，启动时不拿密钥核对：密钥丢了或和缓存对不上，照旧用缓存的 id 和凭据。只在换凭据时发现私钥不可用，才重新生成密钥和 id（等于重装，Chat 按新设备认），换凭据成功后改用新 id。从随机 UUID 的旧版本升级后，照旧用原来的 id 和凭据；下一次换凭据（退出后重新登录、凭据被撤销或失效）时才换成由公钥算出的 id。

### 独立登录与退出

工具栏弹窗点击“连接平台账号”后打开 `<平台>/chat/browser-extension/authorize`。参数为 `install_id`、`browser`（chromium/firefox/safari）、`display_name`、`code_challenge`（43 字符）、`code_challenge_method=S256`、`state`；Chromium/Firefox 另带 `identity.getRedirectURL()` 返回的 `redirect_uri`，用 `identity.launchWebAuthFlow` 等待回调。重复点击复用进行中的登录。

Safari 没有 identity 接口时打开平台授权标签页，只接受该标签页导航到同源 `/chat/browser-extension/callback`；核对 state 后交换凭据，再关闭该授权页。关页、拒绝、state 不符均不保存凭据。校验串和授权过程仅保存在运行期内存；若后台或浏览器退出导致登录中断，重新点击“连接平台账号”即可。

平台授权页向 `POST /chat/browser/authorize/` 提交确认，返回一次性 code 与已经校验的 redirect_uri（由 UI 实现）。插件向 `POST /chat-service/browser/token` 发送 `{code, code_verifier, install_id, redirect_uri, install_key, install_proof}`，Safari 的 `redirect_uri` 为 `""`，交换请求不发送 browser。`install_key` 是 raw 公钥（65 字节未压缩点），`install_proof` 是安装私钥对 `chat-browser-install-proof/v1\n<install_id>\n<code>`（UTF-8，末尾无换行）的 ECDSA/SHA-256 签名（IEEE P1363，64 字节），两者都是无填充 base64url；Chat 据此确认请求方持有这份安装。浏览器真签样本见 `test/fixtures/install-proof/samples.json`（`node test/probe/install-proof-samples.mjs` 生成），Chromium / Firefox 的密钥持久性实测脚本是 `test/probe/install-key.mjs`（Safari 需在 macOS 上手测）。成功响应直接是 `{credential, account}`。凭据保存在 `storage.local`，绑定当前平台 origin 和安装 ID，不轮换、撤销前有效。旧安装没有凭据时需要独立登录，网页登录或退出不会改变插件登录。

401 或 `closed.revoked` 清除本机凭据、站点授权、对话/共享/接管状态，停止重连并等待重新授权；保留用户网页。退出登录向 `POST /chat-service/browser/logout` 发送 `{install_id}`，同样带 Bearer、omit，同时清理本机授权。网络失败仍退出本机并提示在平台移除设备，不能据此声称服务端已撤销。

切换平台只表示保存地址、确认原生主机权限和清理旧运行期。新平台没有匹配凭据时停在等待登录，不发匿名 stream、不验证该地址是否为可达平台；完成独立授权后才建立连接。凭据不会发送给其他 origin。

## 构建

```bash
pnpm install
PLATFORM_ORIGIN=https://<平台对外地址> pnpm build        # 产物在 dist/；也可以写 pnpm build --platform-origin https://…
```

- 平台对外地址是用户地址栏里的那个，manifest 的初始主机权限由它生成。弹窗「设置 → 高级设置」可切换单个活动服务器；只保存平台连接 origin，不保存第三方网页 URL。切换需要用户手势申请对应来源权限，旧请求、授权、页归属、接管与连接清理完成后才连接新服务器。
- 构建时从 `playwright-core`（版本钉死 1.62.1）取出页面注入脚本，许可（Apache-2.0）随产物放在
  `dist/third_party/playwright/`。换版本时 `scripts/extract-injected.mjs` 的结构断言会先失败。
- 生产构建检查产物：不含测试用的假传输与测试入口，含真实传输，不出现 `X-Service`。`--fake-transport` 只能和
  `--test-hooks` 一起用。

## 开发者模式安装

`chrome://extensions`（Edge 是 `edge://extensions`）打开「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/`。
manifest 里的 `key` 固定开发者模式插件 id：**`agagklnjfndomhambbpfhenaoclcbpmo`**，对应私钥不在仓库里。安装身份由用户授权和 PKCE 验证，不再登记插件 Origin 白名单。

默认构建权限：`debugger`、`tabs`、`tabGroups`、`storage`、`downloads`、`scripting`、`identity`，以及平台地址的主机权限。没有 `cookies` 权限或 Cookie 事件监听，生产构建检查产物不含 Cookie API。DOM 构建保留 `tabs`、`storage`、`scripting` 和 `identity`；`--browser safari` 省略 Safari 不支持的 `identity` 权限，配合既有 DOM/event 模式构建。

可选 http(s) 来源权限仅在用户点击切换服务器或显示控制条时按具体来源申请。不申请 `proxy`、`management`，不声明 `externally_connectable`，不注册自动内容脚本。原调试执行层的安装提示来自 `debugger` 权限。主机权限按浏览器匹配规则不带端口，实际 fetch 请求保留完整平台来源。

## 测试

```bash
pnpm typecheck
pnpm test                       # vitest 单测
xvfb-run -a pnpm e2e            # Playwright 端到端（不带 xvfb-run 时，要有界面的那个用例会跳过）
```

`pnpm e2e` 先构建三个测试版（`pnpm build:test`），再在本地夹具站点（`test/e2e/fixtures/server.mjs`，`127.0.0.1` 与
`localhost` 两个来源）上真跑动作、点确认小窗：

- `dist-test/`（`--test-hooks --fake-transport`）：连接换成内存假传输，测试代码扮演 Chat 收发帧；
- `dist-test-fetch/`（`--test-hooks`）：真实传输，平台地址是仿 Chat 服务（`test/e2e/fixtures/chat-server.mjs`，
  `127.0.0.1:18963`）。它提供合成授权页与 PKCE 交换接口，每个通道请求都校验独立安装凭据，不读取真实平台数据。
  `authentication.spec.ts` 验证真实 Chromium identity 登录、拒绝、state 不符、并发复用及 Cookie 变化不影响登录；`transport.spec.ts` 验证四通道 Bearer/无 Cookie、动作结果、上传下载、轮换、断线、401、403、413、撤销、退出与账号状态清理。

- `dist-test-dom/`（`--test-hooks --fake-transport --execution-backend dom`）：真实扩展只读执行层，验证共享页读取、ref/depth/boxes、隔离世界、来源权限及 iframe 整页拒绝。

`test/probe/` 包含实测用的常驻探测进程（有界面的浏览器 + 本机控制端口 + XTest 点击），用来测调试提示条这类要
「看一眼屏幕再点」的项目。

## 执行能力与只读原型

hello 可携带 `capabilities: { actions: [...] }`，动作名采用既有协议名。缺字段兼容旧版 22 动作，空数组表示没有可执行动作。客户端优先拒绝所有未声明动作，返回 `unsupported_action`，即使服务器忽略能力字段或设备处于停止/接管状态也如此。

默认 `--execution-backend auto` 根据实际调试 API 选择原执行层；没有完整调试 API、但具备安全读取前置 API 时只声明 `read`，前置不足则声明空数组。可以显式构建只读原型：

```bash
pnpm build --platform-origin https://example.edu --execution-backend dom --out dist-dom
# 事件后台原型；event 必须与 dom 一起使用
pnpm build --platform-origin https://example.edu --execution-backend dom --background-mode event --out dist-dom-event
```

只读原型仅读取明确共享且浏览器授予来源权限的当前页；共享后通过「授予网页权限并显示控制条」申请原生页面访问权限。只支持单文档的快照/ref/depth/boxes；存在 iframe、受限页面或零视口时整页拒绝，不返回删减快照。不提供导航、写入、上传下载或调试近似执行。切换当前读取页可先取消原当前页共享，再共享新页。

Linux Chromium 已验证只读原型和独立登录的本地真实扩展 E2E。Firefox 既有临时扩展探针验证基础 API 与合成页面；本轮 Firefox identity 与 Safari 标签回调另有单元契约测试。Firefox 独立登录真机联调、Safari 真机加载/执行及跨仓真实服务联调尚未验证；Linux WebKit 不作为 Safari 扩展验证。事件后台产物仍是原型，不表示这些浏览器已经具备完整执行能力。

## 网页控制与确认结果

已归属/共享的页面可从可信工具栏申请当前来源权限并显示顶层控制条。控制条与调试附着独立，只显示对话标题和动作。点击接管会取消本对话请求并等待释放；完成后显示已接管，其它对话继续。恢复只进入重新观察状态，成功 `read` 前禁止写入，不重放取消动作。最后一页关闭后仍能在工具栏逐对话恢复；全局「恢复操作网页」不解除对话接管。普通键鼠活动不自动触发接管。

弹窗底部「停止操作网页」取消当前操作并释放附着，保留网页；它不是可从中间继续的暂停。站点、密码、自输完成、脚本、上传、跨站确认超时返回 `approval_timeout`；明确拒绝、关窗、Esc 仍返回 `user_denied`。操作此前可能已经产生效果，不能自动重试。下载沿用动作已生效的结果：明确拒绝返回 `ok` 和 `payload.download_denied=true`；确认超时另加 `payload.download_timed_out=true`。

结果帧可附 `approvals`，按顺序记录本次逐次确认的种类、来源和结论，不带站点、文件名或脚本内容。缺字段表示未记录，空数组表示执行期间无需确认；Chat 将它原样放入操作记录详情。到时未确认的窗口保留过期说明，用户关闭后清理。

界面第二版（标签页结构、命名与验证）见 `docs/ui-v2-validation.md`；设计状态集 07 的界面实施、回归证据和受阻项见 `docs/ui-redesign-validation.md`。历史分段证据见 `docs/server-settings-validation.md`、`docs/control-bar-validation.md` 与 `docs/execution-capabilities-validation.md`。本轮不增加插件审计数据库。

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
| `src/connection/` | 独立 PKCE 登录、凭据保存与撤销、fetch 双向通道、连接状态机（ready、心跳、退避重连、轮换、保活）、账号变化、内存假传输 |
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
  附着，之后的请求回 `user_stopped`，直到用户在弹窗里点「恢复操作网页」。
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

- 创建 AI 标签时实际尝试原生分组，分组与组命名共用 1 秒等待预算；分组接口缺失、拒绝或超过预算时，该页作为普通标签继续使用。
  分组已成功而命名失败或超时时，保留真实分组和拖出撤权，只放弃组名。每次新建页重新尝试，不按品牌或 UA 判断，不持久化浏览器能力结论。
  超时仅表示本次未及时完成，不表示浏览器永不支持。
- 两种模式都只控制本对话创建的页和用户明确共享的页。分组页拖出 AI 组会撤销该页控制；普通页没有这一拖出入口，关闭该页会从登记中移除。
  弹窗「停止操作网页」与浏览器调试提示条「取消」停止当前操作并断开全部调试附着，保留标签归属；恢复后仍可复用。整轮 `release` 只释放该轮附着。
  `browser_close` 清除该对话标签归属，`keep_tabs: true` 时保留网页；换账号清除全部归属和共享，保留网页。用户共享页还可通过工具栏「取消共享」退出。
- 页面读取（DOM 读取后端）进行中时，取消共享、关闭或结束本对话的标签、撤销或清除站点授权、在浏览器里移除该站点权限，都会让这次读取立即以撤销错误返回，迟到的页面内容被丢弃；
  只作废同一对话、同一标签、同一站点的读取，其他站点和对话不受影响。撤销后再授权只对新的读取生效。
- 创建中的请求取消、超时、关闭或换账号后，迟到的创建/分组结果不会恢复登记或继续导航；迟到分组仅按本次新建标签解组，不解散其他页。
  普通页 ID 记录在现有 `storage.session` 对话登记的可选 `ungrouped` 数组中；旧登记缺省为空，无数据库迁移、无新增配置或网络契约。

- 同一轮回答中的连续动作复用调试附着。正常结束、停止、失败或超时时，平台发送带 `turn_id` 与 `conversation` 的
  `release`；插件取消该轮仍在执行或排队的动作，只释放该轮持有的附着，保留网页与平台连接，然后回 `released`。
  平台保存未确认释放并在重连或心跳时补投；重复或迟到的旧轮释放不影响新轮及其他对话，已结束轮的迟到动作不执行。
  旧服务没有 `turn_id` 的请求沿用原有空闲回收。
- 确认使用独立窗口，页头显示校徽、「需要你的确认」与「浏览器助手」，正文是动作和站点；窗口标题带平台名；请求带有真实对话标题时显示来源，没有则隐藏。
  窗口标题同步动作与助手名称，按内容调整高度；长脚本可聚焦后用键盘滚动，操作按钮留在底部，支持浅色与深色主题。
  初始焦点在「拒绝」。页内「关闭」、Esc 和原生窗口关闭都只拒绝当前请求；浏览器调试提示条的「取消」仍表示全局停止。
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
  带抖动的退避重连；401 或 `closed.revoked` 清理凭据和本机授权、等待独立登录，不自动重连；`stream` 上 403 停住，
  弹窗提示检查设备授权，点“重新连接”再试；`protocol_unsupported` 提示升级、不重连。轮换、重连之后，旧连接上开始的请求，它的
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

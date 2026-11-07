// manifest 的唯一来源：权限、主机权限、入口都在这里定。
//
// 权限按计划 4.5：debugger、tabs、tabGroups、storage、downloads、cookies，加平台对外地址的主机权限。
// cookies 只用来监听平台站点会话 Cookie 的变化、一变就断开重连（计划第 9 节第 17 条，src/connection/cookie-watch.ts），
// 不读写 Cookie：Chrome 只把主机权限覆盖的站点的 Cookie 事件交给插件，插件的主机权限只有平台地址；构建后检查产物里没有
// 读写 Cookie 的调用（scripts/build.mjs）。
// 不申请 proxy、management；不声明 externally_connectable（网页不能给插件发消息）；
// 不注册内容脚本（页面里的代码只经调试接口按需注入，见 src/browser/frames.ts）。

/**
 * 开发者模式安装用的固定公钥（manifest 的 key），对应插件 id `agagklnjfndomhambbpfhenaoclcbpmo`。
 * 私钥不在仓库里；商店上架时商店会给另一个 id，两边都要登记进平台的 allowedExtensionIds。
 */
export const DEV_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EXFLdKt5OLAC2mOeSlsbuawIXBWPbOpZ5OAIC3bFgxF6UsIPAZuo0jknj8MZFg7' +
  'zM482uN6PNrO+LMfWpKy/0sYpGao/DgYCPqIaA3GbKdHHlHnHcEmdBw4GpKczqLB/Q9iyT++ZYNWTIR4GbEDal3XPhh6YvpkrF9Fl3VwJq5L' +
  'aQHUbD9lF4Hw0Uh0cWfm6Lm9CKqDTFXU3Hpvt/L6OZV1zLY3+PJWJjQ0ujdhn+hzfU/kZDCuEc1dqnPCtsHjuUkT1w/vF9hZ1t30l6q+1kKPA' +
  '/Qr28srbsmEdtVVzMZbeNmG7dIuUyHBSWED++WpgPt/xATcuJ2Znslp232tOQIDAQAB';

export const DEV_EXTENSION_ID = 'agagklnjfndomhambbpfhenaoclcbpmo';

export function buildManifest({ version, platformOrigin, key }) {
  // Cookie 变化事件按协议与主机匹配，不带端口；实际请求仍使用完整平台来源。
  const platform = new URL(platformOrigin);
  const hostPermission = `${platform.protocol}//${platform.hostname}/*`;
  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    version,
    default_locale: 'en',
    // chrome.debugger 的子会话（DebuggerSession.sessionId，跨源 iframe 要用）从 125 起可用。
    minimum_chrome_version: '125',
    key,
    background: { service_worker: 'background.js', type: 'module' },
    icons: {
      16: 'icons/browser-assistant-16.png',
      32: 'icons/browser-assistant-32.png',
      48: 'icons/browser-assistant-48.png',
      128: 'icons/browser-assistant-128.png',
    },
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_extName__',
      default_icon: { 16: 'icons/browser-assistant-16.png', 32: 'icons/browser-assistant-32.png' },
    },
    permissions: ['debugger', 'tabs', 'tabGroups', 'storage', 'downloads', 'cookies'],
    host_permissions: [hostPermission],
    // 只在用户明确保存平台来源或开启网页控制条时申请对应来源，不在安装时授予全站。
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  };
}

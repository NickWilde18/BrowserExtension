// manifest 的唯一来源：权限、主机权限、入口都在这里定。
//
// 权限包含执行层所需能力和 identity（浏览器管理的登录回调），不申请 cookies。
// Safari 没有 identity 接口，构建时通过 --browser safari 省略该权限，使用平台同源标签页回调。
// 不申请 proxy、management；不声明 externally_connectable（网页不能给插件发消息）；
// 不注册内容脚本（页面里的代码只经调试接口按需注入，见 src/browser/frames.ts）。

/**
 * 开发者模式安装用的固定公钥（manifest 的 key），对应插件 id `agagklnjfndomhambbpfhenaoclcbpmo`。
 * 私钥不在仓库里。该公钥固定开发安装 ID；身份认证由用户授权和 PKCE 完成。
 */
export const DEV_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EXFLdKt5OLAC2mOeSlsbuawIXBWPbOpZ5OAIC3bFgxF6UsIPAZuo0jknj8MZFg7' +
  'zM482uN6PNrO+LMfWpKy/0sYpGao/DgYCPqIaA3GbKdHHlHnHcEmdBw4GpKczqLB/Q9iyT++ZYNWTIR4GbEDal3XPhh6YvpkrF9Fl3VwJq5L' +
  'aQHUbD9lF4Hw0Uh0cWfm6Lm9CKqDTFXU3Hpvt/L6OZV1zLY3+PJWJjQ0ujdhn+hzfU/kZDCuEc1dqnPCtsHjuUkT1w/vF9hZ1t30l6q+1kKPA' +
  '/Qr28srbsmEdtVVzMZbeNmG7dIuUyHBSWED++WpgPt/xATcuJ2Znslp232tOQIDAQAB';

export const DEV_EXTENSION_ID = 'agagklnjfndomhambbpfhenaoclcbpmo';

export function buildManifest({ version, platformOrigin, key, executionBackend = 'auto', backgroundMode = 'worker', browser = 'chromium' }) {
  // 主机权限匹配不带端口；实际请求仍使用完整平台来源。
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
    ...(backgroundMode === 'worker' ? { minimum_chrome_version: '125' } : {}),
    key,
    background: backgroundMode === 'event'
      ? { scripts: ['background.js'], type: 'module', persistent: false }
      : { service_worker: 'background.js', type: 'module' },
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
    permissions: [
      ...(executionBackend === 'dom' ? ['tabs', 'storage', 'scripting'] : ['debugger', 'tabs', 'tabGroups', 'storage', 'downloads', 'scripting']),
      ...(browser === 'safari' ? [] : ['identity']),
    ],
    host_permissions: [hostPermission],
    // 只在用户明确保存平台来源或开启网页控制条时申请对应来源，不在安装时授予全站。
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  };
}

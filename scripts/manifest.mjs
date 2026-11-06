// manifest 的唯一来源：权限、主机权限、入口都在这里定。
//
// 权限按计划 4.5：debugger、tabs、tabGroups、storage、downloads，加平台对外地址的主机权限。
// 不申请 cookies、proxy、management；不声明 externally_connectable（网页不能给插件发消息）；
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
    action: { default_popup: 'popup.html', default_title: '__MSG_extName__' },
    permissions: ['debugger', 'tabs', 'tabGroups', 'storage', 'downloads'],
    host_permissions: [`${platformOrigin}/*`],
  };
}

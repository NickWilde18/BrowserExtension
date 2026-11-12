// browser_network 返回前去掉凭据类请求头、响应头（契约 4.2、计划 4.6）。
//
// 读出来的值会进对话记录、发给用户选的模型；用户点「允许此站点」时并不知道自己交出去的是凭据。

const EXACT = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);

const SUBSTRINGS = ['token', 'session', 'csrf', 'xsrf', 'auth'];

/** 这个头名是不是凭据类（大小写不敏感）。 */
export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return EXACT.has(lower) || SUBSTRINGS.some((s) => lower.includes(s));
}

/** 去掉凭据类的头，其余原样保留。 */
export function stripCredentialHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) {
      out[name] = value;
    }
  }

  return out;
}

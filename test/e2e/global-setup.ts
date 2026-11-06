// 起夹具站点与仿 Chat 服务；测试进程退出时一起结束。
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PORT = Number(process.env.BX_FIXTURE_PORT ?? 18961);

/** 仿 Chat 服务的端口；真实传输的测试构建（dist-test-fetch）的平台地址就是它。 */
export const CHAT_PORT = Number(process.env.BX_CHAT_PORT ?? 18963);

function start(script: string, port: number): Promise<ChildProcess> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(dir, 'fixtures', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });

  return new Promise<ChildProcess>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 10_000);
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('"ready":true')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => reject(new Error(`${script} exited ${code}`)));
  });
}

export default async function globalSetup(): Promise<() => void> {
  const children = [await start('server.mjs', FIXTURE_PORT), await start('chat-server.mjs', CHAT_PORT)];

  return () => {
    for (const c of children) {
      c.kill();
    }
  };
}

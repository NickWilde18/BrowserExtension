// 起夹具站点；测试进程退出时一起结束。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PORT = Number(process.env.BX_FIXTURE_PORT ?? 18961);

export default async function globalSetup(): Promise<() => void> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(dir, 'fixtures', 'server.mjs'), String(FIXTURE_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 10_000);
    child.stdout.on('data', (b: Buffer) => {
      if (b.toString().includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`fixture server exited ${code}`)));
  });

  return () => {
    child.kill();
  };
}

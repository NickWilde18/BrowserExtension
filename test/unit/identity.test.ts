// 安装密钥与 install_id（设计稿 539-INST 2.1–2.3）：由公钥推导、跨重启稳定、签名 64 字节 P1363 且能被 Chat 侧同一判据验过。
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { Identity, MemoryKeyStore, deriveInstallId, installProofMessage } from '../../src/identity';
import { MemoryKV } from '../../src/storage';

const SPKI_P256_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 与 Chat 侧同一判据：raw 公钥 + SHA-256 + IEEE P1363（r‖s），不是 DER。 */
function chatVerifies(installKey: string, installId: string, code: string, proof: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_P256_PREFIX, Buffer.from(installKey, 'base64url')]), format: 'der', type: 'spki' });
  return verify('sha256', installProofMessage(installId, code), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
}

describe('install_id 推导', () => {
  it('取 SHA-256(raw 公钥) 前 16 字节，置 UUIDv8 版本位与 RFC 9562 变体位', async () => {
    // 期望值由 Python hashlib 按设计稿 2.1 独立算出，不复用实现。
    const raw = new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
    expect(await deriveInstallId(raw)).toBe('0ed3a6ab-957f-86f5-9a96-30a473d31a7d');
  });

  it('签名内容是三行、\\n 连接、末尾无换行', () => {
    expect(new TextDecoder().decode(installProofMessage('0ed3a6ab-957f-86f5-9a96-30a473d31a7d', 'c0de')))
      .toBe('chat-browser-install-proof/v1\n0ed3a6ab-957f-86f5-9a96-30a473d31a7d\nc0de');
  });
});

describe('安装密钥', () => {
  it('首次生成不可导出的 P-256 私钥，install_id 由公钥算出并缓存进 storage.local', async () => {
    const local = new MemoryKV();
    const keys = new MemoryKeyStore();
    const identity = new Identity(local, keys);
    const id = await identity.installId();
    expect(id).toMatch(UUID_V8);
    const { privateKey, publicKey } = keys.pair!;
    expect(privateKey.extractable).toBe(false);
    expect(privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(privateKey.usages).toEqual(['sign']);
    await expect(crypto.subtle.exportKey('pkcs8', privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', privateKey)).rejects.toThrow();
    expect(await deriveInstallId(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)))).toBe(id);
    expect(await local.get('identity.installId')).toBe(id);
  });

  it('换凭据证明：install_key 87 字符/65 字节，install_proof 86 字符/64 字节，按 P1363 验过', async () => {
    const identity = new Identity(new MemoryKV(), new MemoryKeyStore());
    const proof = await identity.prove('synthetic-code');
    expect(proof.install_id).toBe(await identity.installId());
    expect(proof.install_key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(proof.install_proof).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(Buffer.from(proof.install_key, 'base64url')).toHaveLength(65);
    expect(Buffer.from(proof.install_key, 'base64url')[0]).toBe(4);
    expect(Buffer.from(proof.install_proof, 'base64url')).toHaveLength(64);
    expect(chatVerifies(proof.install_key, proof.install_id, 'synthetic-code', proof.install_proof)).toBe(true);
    // 换一个授权码或别的 install_id，同一签名都验不过。
    expect(chatVerifies(proof.install_key, proof.install_id, 'other-code', proof.install_proof)).toBe(false);
    expect(chatVerifies(proof.install_key, '0ed3a6ab-957f-86f5-9a96-30a473d31a7d', 'synthetic-code', proof.install_proof)).toBe(false);
  });

  it('重启（新运行期、同一密钥库）：install_id 不变，签名格式不变且仍能验过', async () => {
    const local = new MemoryKV();
    const keys = new MemoryKeyStore();
    const before = await new Identity(local, keys).prove('code-1');
    const after = await new Identity(local, keys).prove('code-2');
    expect(after.install_id).toBe(before.install_id);
    expect(after.install_key).toBe(before.install_key);
    expect(Buffer.from(after.install_proof, 'base64url')).toHaveLength(64);
    expect(chatVerifies(after.install_key, after.install_id, 'code-2', after.install_proof)).toBe(true);
  });

  it('旧版本存的随机 UUID 被由密钥算出的 id 替换', async () => {
    const local = new MemoryKV();
    await local.set('identity.installId', '66666666-7777-4888-9999-aaaaaaaaaaaa');
    const id = await new Identity(local, new MemoryKeyStore()).installId();
    expect(id).not.toBe('66666666-7777-4888-9999-aaaaaaaaaaaa');
    expect(await local.get('identity.installId')).toBe(id);
  });

  it('密钥丢了或坏了：重新生成（等于重装一次），id 随之变化', async () => {
    const local = new MemoryKV();
    const keys = new MemoryKeyStore();
    const first = await new Identity(local, keys).installId();
    keys.pair = undefined;
    const lost = await new Identity(local, keys).installId();
    expect(lost).not.toBe(first);
    keys.pair = { privateKey: 'junk', publicKey: 'junk' } as unknown as CryptoKeyPair;
    const broken = await new Identity(local, keys).installId();
    expect(broken).not.toBe(lost);
    expect(keys.pair!.privateKey).toBeInstanceOf(CryptoKey);
  });

  it('并发取 id 只生成一把密钥；存储失败不缓存，下次重试', async () => {
    const keys = new MemoryKeyStore();
    const put = vi.spyOn(keys, 'put');
    const identity = new Identity(new MemoryKV(), keys);
    const [a, b, c] = await Promise.all([identity.installId(), identity.installId(), identity.prove('x').then((p) => p.install_id)]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);

    const failing = new MemoryKeyStore();
    vi.spyOn(failing, 'put').mockRejectedValueOnce(new Error('quota'));
    const retry = new Identity(new MemoryKV(), failing);
    await expect(retry.installId()).rejects.toThrow('quota');
    expect(await retry.installId()).toMatch(UUID_V8);
  });
});

describe('浏览器真签样本（给 Chat 侧回归测试用的固定数据）', () => {
  const samples = JSON.parse(readFileSync(new URL('../fixtures/install-proof/samples.json', import.meta.url), 'utf8')) as {
    samples: Array<{ browser: string; install_key: string; install_id: string; code: string; install_proof: string }>;
  };
  it.each(samples.samples.map((s) => [s.browser, s] as const))('%s：install_id 由公钥算出，签名按 P1363 验过', async (_, s) => {
    expect(await deriveInstallId(new Uint8Array(Buffer.from(s.install_key, 'base64url')))).toBe(s.install_id);
    expect(Buffer.from(s.install_proof, 'base64url')).toHaveLength(64);
    expect(chatVerifies(s.install_key, s.install_id, s.code, s.install_proof)).toBe(true);
  });
});

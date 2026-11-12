import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIONS } from '../../src/protocol/frames';

const root = path.resolve(__dirname, '../..');
const load = (locale: string): Record<string, { message: string }> =>
  JSON.parse(readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
const zh = load('zh_CN');
const en = load('en');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, ext) : ext.test(name) ? [full] : [];
  });
}

/** 源码里按字面量取的文案键：t('键') / text('键')、页面的 data-i18n、控制条按状态查表的值。 */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of files(path.join(root, 'src'), /\.ts$/)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\b(?:t|text)\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]!);
    for (const m of source.matchAll(/:\s*'(control(?:State|Action|Mini)[A-Za-z_]+)'/g)) keys.add(m[1]!);
    // 按钮表（label / busyLabel / labelKey）与确认窗的标题正文表。
    for (const m of source.matchAll(/\b(?:label|busyLabel|labelKey)\s*:\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]!);
    for (const m of source.matchAll(/'(approval[A-Z][A-Za-z0-9_]*)'/g)) keys.add(m[1]!);
  }
  for (const file of files(path.join(root, 'static'), /\.html$/)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) keys.add(m[1]!);
  }
  return keys;
}

describe('界面文案', () => {
  it('中英文的键一致，且都有内容', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(value.message.trim(), key).not.toBe('');
    }
  });

  it('网页控制条为每个动作都写了正在做什么', () => {
    for (const action of ACTIONS) {
      expect(zh[`controlAction_${action}`], action).toBeDefined();
    }
  });

  it('源码与页面引用的文案键都存在', () => {
    const missing = [...referencedKeys()].filter((key) => !(key in zh));
    expect(missing).toEqual([]);
  });

  it('中文文案用平台中文名「大学 AI 服务平台」，不出现英文平台名 AI Service（Tark#528 第二版）', () => {
    const hits = Object.entries(zh).filter(([, v]) => v.message.includes('AI Service')).map(([k]) => k);
    expect(hits).toEqual([]);
    expect(zh.extName!.message).toBe('大学 AI 服务平台浏览器助手');
    expect(zh.brandName!.message).toBe('大学 AI 服务平台');
    expect(zh.controlBrand!.message).toBe('大学 AI 服务平台');
  });

  it('按钮名按拍板改：连接平台账号、停止 / 恢复操作网页、手动接管', () => {
    expect([zh.login!.message, en.login!.message]).toEqual(['连接平台账号', 'Connect account']);
    expect([zh.stop!.message, en.stop!.message]).toEqual(['停止操作网页', 'Stop web actions']);
    expect([zh.resume!.message, en.resume!.message]).toEqual(['恢复操作网页', 'Resume web actions']);
    expect([zh.controlTakeOver!.message, en.controlTakeOver!.message]).toEqual(['手动接管', 'Take over']);
    expect([zh.brandName!.message, en.brandName!.message]).toEqual(['大学 AI 服务平台', 'AI Service']);
  });
});

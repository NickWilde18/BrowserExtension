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
});

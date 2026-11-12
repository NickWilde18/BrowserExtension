// press_key 的按键解析：`Enter`、`Escape`、`Control+A`、`Shift+Tab`……转成调试接口 Input.dispatchKeyEvent
// 要的字段（美式键盘布局）。

import { ActionError } from '../protocol/errors';

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** 产生的字符（可打印键），没有时为空。 */
  text: string;
  location?: number;
}

export interface KeyChord {
  /** Alt=1 Control=2 Meta=4 Shift=8（调试接口的 modifiers 位）。 */
  modifiers: number;
  modifierKeys: KeyDef[];
  key: KeyDef;
}

const NAMED: Record<string, Omit<KeyDef, 'key'>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '' },
  Escape: { code: 'Escape', keyCode: 27, text: '' },
  Backspace: { code: 'Backspace', keyCode: 8, text: '' },
  Delete: { code: 'Delete', keyCode: 46, text: '' },
  Insert: { code: 'Insert', keyCode: 45, text: '' },
  Home: { code: 'Home', keyCode: 36, text: '' },
  End: { code: 'End', keyCode: 35, text: '' },
  PageUp: { code: 'PageUp', keyCode: 33, text: '' },
  PageDown: { code: 'PageDown', keyCode: 34, text: '' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37, text: '' },
  ArrowRight: { code: 'ArrowRight', keyCode: 39, text: '' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  Alt: { code: 'AltLeft', keyCode: 18, text: '', location: 1 },
  Control: { code: 'ControlLeft', keyCode: 17, text: '', location: 1 },
  Meta: { code: 'MetaLeft', keyCode: 91, text: '', location: 1 },
  Shift: { code: 'ShiftLeft', keyCode: 16, text: '', location: 1 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93, text: '' },
};

for (let i = 1; i <= 12; i++) {
  NAMED[`F${i}`] = { code: `F${i}`, keyCode: 111 + i, text: '' };
}

const ALIASES: Record<string, string> = {
  Esc: 'Escape',
  Return: 'Enter',
  Ctrl: 'Control',
  Cmd: 'Meta',
  Command: 'Meta',
  Option: 'Alt',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Del: 'Delete',
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** 美式布局里需要 Shift 才打得出的符号 → 对应的键。 */
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

const PUNCT: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 }, '=': { code: 'Equal', keyCode: 187 }, '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 }, '\\': { code: 'Backslash', keyCode: 220 }, ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 }, ',': { code: 'Comma', keyCode: 188 }, '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 }, '`': { code: 'Backquote', keyCode: 192 },
};

/** 一个按键名或单个字符 → 按键定义。认不出时返回 null。 */
export function keyDef(name: string): KeyDef | null {
  const canonical = ALIASES[name] ?? name;
  const named = NAMED[canonical];
  if (named) {
    return { key: canonical === 'Space' ? ' ' : canonical, ...named };
  }

  const chars = [...name];
  if (chars.length !== 1) {
    return null;
  }

  const ch = name;
  if (/^[a-z]$/i.test(ch)) {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  }

  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  }

  const base = SHIFTED[ch];
  if (base !== undefined) {
    const def = /^[0-9]$/.test(base) ? { code: `Digit${base}`, keyCode: base.charCodeAt(0) } : PUNCT[base];
    if (def) {
      return { key: ch, code: def.code, keyCode: def.keyCode, text: ch };
    }
  }

  const punct = PUNCT[ch];
  if (punct) {
    return { key: ch, code: punct.code, keyCode: punct.keyCode, text: ch };
  }

  // 其他字符（中文等）：没有对应的物理键，只能当文字输入。
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/** 解析 `Control+Shift+A` 这类组合。 */
export function parseChord(spec: string): KeyChord {
  let parts: string[];
  let keyName: string;
  if (spec === '+') {
    parts = [];
    keyName = '+';
  } else if (spec.endsWith('++')) {
    // 「Control++」是 Control 加 + 键。
    parts = spec.slice(0, -2).split('+');
    keyName = '+';
  } else {
    parts = spec.split('+');
    keyName = parts.pop() ?? '';
  }

  if (keyName === '' || parts.some((p) => p === '')) {
    throw new ActionError('invalid_args', `Unknown key "${spec}".`);
  }

  let modifiers = 0;
  const modifierKeys: KeyDef[] = [];
  for (const raw of parts) {
    const m = ALIASES[raw] ?? raw;
    const bit = MODIFIER_BITS[m];
    const def = keyDef(m);
    if (bit === undefined || !def) {
      throw new ActionError('invalid_args', `Unknown modifier "${raw}" in "${spec}"; use Alt, Control, Meta or Shift.`);
    }

    modifiers |= bit;
    modifierKeys.push(def);
  }

  // 组合键里的字母按物理键盘处理：Control+A 的 key 是 a，加了 Shift 才是 A。
  const letter = /^[a-z]$/i.test(keyName) && parts.length > 0 ? ((modifiers & 8) ? keyName.toUpperCase() : keyName.toLowerCase()) : keyName;
  const key = keyDef(letter);
  if (!key) {
    throw new ActionError('invalid_args', `Unknown key "${keyName}".`);
  }

  return { modifiers, modifierKeys, key };
}

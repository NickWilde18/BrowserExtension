// 鼠标与键盘：经调试接口 Input.dispatch* 发浏览器认可的可信事件（计划 4.5「执行」）。
// 坐标都是顶层框架视口里的 CSS 像素（调试接口 Input.dispatchMouseEvent 的约定）。

import type { Modifier } from '../protocol/args';
import { parseChord } from './keys';
import type { KeyDef } from './keys';
import type { TabSession } from './tab-session';

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(mods: readonly Modifier[]): number {
  return mods.reduce((m, k) => m | MODIFIER_BITS[k], 0);
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

export async function mouseMove(s: TabSession, x: number, y: number, modifiers = 0, buttons = 0): Promise<void> {
  await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, buttons, button: buttons ? 'left' : 'none' });
}

/** 点一下（count 次连击，clickCount 递增，与真实双击一致）。 */
export async function mouseClick(s: TabSession, x: number, y: number, button: 'left' | 'right' | 'middle', count: number,
  modifiers: number): Promise<void> {
  await mouseMove(s, x, y, modifiers);
  for (let i = 1; i <= count; i++) {
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount: i, modifiers });
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers });
  }
}

export async function mouseWheel(s: TabSession, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

async function keyEvent(s: TabSession, type: 'keyDown' | 'rawKeyDown' | 'keyUp', def: KeyDef, modifiers: number, withText: boolean): Promise<void> {
  const params: Record<string, unknown> = {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };

  if (def.location !== undefined) {
    params.location = def.location;
  }

  if (withText && def.text) {
    params.text = def.text;
    params.unmodifiedText = def.text;
  }

  await s.cdp.send('Input.dispatchKeyEvent', params);
}

/**
 * 按一个组合键 repeat 次。带 Control / Meta / Alt 时不产生字符（Control+A 是全选，不是输入 a）。
 */
export async function pressChord(s: TabSession, spec: string, repeat: number): Promise<void> {
  const chord = parseChord(spec);
  const producesText = (chord.modifiers & (1 | 2 | 4)) === 0;

  for (let i = 0; i < repeat; i++) {
    let held = 0;
    for (const m of chord.modifierKeys) {
      held |= m.key === 'Alt' ? 1 : m.key === 'Control' ? 2 : m.key === 'Meta' ? 4 : 8;
      await keyEvent(s, 'rawKeyDown', m, held, false);
    }

    const withText = producesText && chord.key.text !== '';
    await keyEvent(s, withText ? 'keyDown' : 'rawKeyDown', chord.key, chord.modifiers, withText);
    await keyEvent(s, 'keyUp', chord.key, chord.modifiers, false);

    for (const m of [...chord.modifierKeys].reverse()) {
      held &= ~(m.key === 'Alt' ? 1 : m.key === 'Control' ? 2 : m.key === 'Meta' ? 4 : 8);
      await keyEvent(s, 'keyUp', m, held, false);
    }
  }
}

/** 一次插入整段文字（替换当前选中的内容）。 */
export async function insertText(s: TabSession, text: string): Promise<void> {
  await s.cdp.send('Input.insertText', { text });
}

/** 逐字敲（slowly）：每个字符一次按键，页面的按键监听都会触发。 */
export async function typeSlowly(s: TabSession, text: string, signal: AbortSignal): Promise<void> {
  for (const ch of text) {
    if (signal.aborted) {
      return;
    }

    if (ch === '\n') {
      await pressChord(s, 'Enter', 1);
      continue;
    }

    const def = parseChord(ch === '+' ? '+' : ch).key;
    if (def.code === '') {
      await insertText(s, ch);
      continue;
    }

    await keyEvent(s, 'keyDown', def, 0, true);
    await keyEvent(s, 'keyUp', def, 0, false);
  }
}

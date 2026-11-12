// 各动作的参数校验，见契约第 4 节。Chat 侧已经按工具定义校验过一遍，这里再校验一遍：
// 参数直接决定插件对用户浏览器做什么，不能信任连接另一端一定没出错。
//
// 校验失败抛 ActionError('invalid_args')，说明写给模型看。

import { ActionError } from './errors';
import type { ActionName } from './frames';

type Raw = Record<string, unknown>;

const MAX_ELEMENT = 200;
const MAX_REF = 64;
const MAX_URL = 4096;
const MAX_TEXT = 10_000;
const MAX_SCRIPT = 100_000;
const MAX_VALUES = 50;
const MAX_FIELDS = 50;
const MAX_FILES = 20;
const MAX_COORD = 100_000;

export interface Point {
  x: number;
  y: number;
}

/** 元素目标：按编号或按坐标（坐标只给能看图的模型用，以截图为准）。 */
export type Target = { element: string; ref: string } | { element: string; point: Point };

export interface OpenArgs { url: string; newTab: boolean }
export interface NavigateArgs { direction: 'back' | 'forward' | 'reload' }
export interface TabsArgs { op: 'list' | 'new' | 'select' | 'close'; index?: number; url?: string }
export interface CloseArgs { keepTabs: boolean }
export interface ReadArgs { ref?: string; depth?: number; boxes: boolean }
export interface FindArgs { text?: string; regex?: string }
export interface ScreenshotArgs { ref?: string; fullPage: boolean }
export interface WaitArgs { text?: string; textGone?: string; seconds?: number }
export interface ConsoleArgs { level: 'error' | 'warning' | 'info' | 'debug' }
export interface NetworkArgs { filter?: string; includeStatic: boolean; index?: number }
export interface ClickArgs {
  target: Target;
  button: 'left' | 'right' | 'middle';
  count: number;
  modifiers: Modifier[];
}
export interface HoverArgs { target: Target }
export interface TypeArgs { element: string; ref: string; text: string; submit: boolean; slowly: boolean }
export interface FormField { element: string; ref: string; type: 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'slider'; value: string }
export interface FillFormArgs { fields: FormField[] }
export interface SelectArgs { element: string; ref: string; values: string[] }
export interface PressKeyArgs { key: string; repeat: number }
export type ScrollArgs =
  | { element: string; ref: string }
  | { point: Point; direction: 'up' | 'down' | 'left' | 'right'; amount: number };
export interface DragArgs { start: Target; end: Target }
export interface DialogArgs { accept: boolean; promptText?: string }
export interface UploadFile { token: string; name: string; size: number; contentType: string }
export interface UploadArgs { element: string; ref: string; files: UploadFile[] }
export interface EvaluateArgs { fn: string; element?: string; ref?: string }

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface ActionArgs {
  open: OpenArgs;
  navigate: NavigateArgs;
  tabs: TabsArgs;
  close: CloseArgs;
  read: ReadArgs;
  find: FindArgs;
  screenshot: ScreenshotArgs;
  wait: WaitArgs;
  console: ConsoleArgs;
  network: NetworkArgs;
  pdf: Record<string, never>;
  click: ClickArgs;
  hover: HoverArgs;
  type: TypeArgs;
  fill_form: FillFormArgs;
  select: SelectArgs;
  press_key: PressKeyArgs;
  scroll: ScrollArgs;
  drag: DragArgs;
  dialog: DialogArgs;
  upload: UploadArgs;
  evaluate: EvaluateArgs;
}

function bad(message: string): never {
  throw new ActionError('invalid_args', message);
}

function str(raw: Raw, key: string, max: number, required: true): string;
function str(raw: Raw, key: string, max: number, required: false): string | undefined;
function str(raw: Raw, key: string, max: number, required: boolean): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (required) {
      bad(`${key} is required.`);
    }

    return undefined;
  }

  if (typeof v !== 'string') {
    bad(`${key} must be a string.`);
  }

  if (required && v.trim() === '') {
    bad(`${key} must not be empty.`);
  }

  if (v.length > max) {
    bad(`${key} is too long (at most ${max} characters).`);
  }

  return v;
}

function bool(raw: Raw, key: string): boolean {
  const v = raw[key];
  if (v === undefined || v === null) {
    return false;
  }

  if (typeof v !== 'boolean') {
    bad(`${key} must be true or false.`);
  }

  return v;
}

function int(raw: Raw, key: string, min: number, max: number): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    return undefined;
  }

  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    bad(`${key} must be a whole number from ${min} to ${max}.`);
  }

  return v;
}

function num(raw: Raw, key: string, min: number, max: number): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    return undefined;
  }

  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    bad(`${key} must be a number from ${min} to ${max}.`);
  }

  return v;
}

function oneOf<T extends string>(raw: Raw, key: string, allowed: readonly T[], fallback?: T): T {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) {
      return fallback;
    }

    bad(`${key} is required.`);
  }

  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    bad(`${key} must be one of: ${allowed.join(', ')}.`);
  }

  return v as T;
}

/** 元素编号：`e12`，iframe 里的带框架前缀 `f1e3`。 */
const REF_RE = /^(?:f\d{1,6})?e\d{1,9}$/;

function ref(raw: Raw, key: string, required: true): string;
function ref(raw: Raw, key: string, required: false): string | undefined;
function ref(raw: Raw, key: string, required: boolean): string | undefined {
  const v = required ? str(raw, key, MAX_REF, true) : str(raw, key, MAX_REF, false);
  if (v !== undefined && !REF_RE.test(v)) {
    bad(`${key} must be an element ref from the latest browser_read result, like e12.`);
  }

  return v;
}

/** `element` + `ref`，或 `element` + `x`/`y`；前缀用于 drag 的 start_ / end_。 */
function target(raw: Raw, prefix: string): Target {
  const element = str(raw, `${prefix}element`, MAX_ELEMENT, true);
  const r = ref(raw, `${prefix}ref`, false);
  const x = num(raw, `${prefix}x`, 0, MAX_COORD);
  const y = num(raw, `${prefix}y`, 0, MAX_COORD);

  if (r !== undefined) {
    if (x !== undefined || y !== undefined) {
      bad(`Give either ${prefix}ref or ${prefix}x and ${prefix}y, not both.`);
    }

    return { element, ref: r };
  }

  if (x === undefined || y === undefined) {
    bad(`Give ${prefix}ref, or both ${prefix}x and ${prefix}y.`);
  }

  return { element, point: { x, y } };
}

const MODIFIERS: readonly Modifier[] = ['Alt', 'Control', 'Meta', 'Shift'];

function modifiers(raw: Raw): Modifier[] {
  const v = raw.modifiers;
  if (v === undefined || v === null) {
    return [];
  }

  if (!Array.isArray(v) || v.length > MODIFIERS.length) {
    bad('modifiers must be a list of Alt, Control, Meta, Shift.');
  }

  const out: Modifier[] = [];
  for (const m of v) {
    if (typeof m !== 'string' || !(MODIFIERS as readonly string[]).includes(m)) {
      bad('modifiers must be a list of Alt, Control, Meta, Shift.');
    }

    if (!out.includes(m as Modifier)) {
      out.push(m as Modifier);
    }
  }

  return out;
}

function stringList(raw: Raw, key: string, max: number, itemMax: number): string[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.length === 0 || v.length > max) {
    bad(`${key} must list 1 to ${max} values.`);
  }

  return v.map((item) => {
    if (typeof item !== 'string' || item.length > itemMax) {
      bad(`Each of ${key} must be a string of at most ${itemMax} characters.`);
    }

    return item;
  });
}

const validators: { [K in ActionName]: (raw: Raw) => ActionArgs[K] } = {
  open: (raw) => ({ url: str(raw, 'url', MAX_URL, true), newTab: bool(raw, 'new_tab') }),
  navigate: (raw) => ({ direction: oneOf(raw, 'direction', ['back', 'forward', 'reload'] as const) }),
  tabs: (raw) => {
    const op = oneOf(raw, 'op', ['list', 'new', 'select', 'close'] as const);
    const index = int(raw, 'index', 0, 1000);
    const url = str(raw, 'url', MAX_URL, false);

    if (op === 'select' && index === undefined) {
      bad('index is required for select.');
    }

    const out: TabsArgs = { op };
    if (index !== undefined) {
      out.index = index;
    }

    if (url !== undefined && op === 'new') {
      out.url = url;
    }

    return out;
  },
  close: (raw) => ({ keepTabs: bool(raw, 'keep_tabs') }),
  read: (raw) => {
    const out: ReadArgs = { boxes: bool(raw, 'boxes') };
    const r = ref(raw, 'ref', false);
    const depth = int(raw, 'depth', 1, 50);

    if (r !== undefined) {
      out.ref = r;
    }

    if (depth !== undefined) {
      out.depth = depth;
    }

    return out;
  },
  find: (raw) => {
    const text = str(raw, 'text', 1000, false);
    const regex = str(raw, 'regex', 1000, false);

    if ((text === undefined || text.trim() === '') === (regex === undefined || regex === '')) {
      bad('Give exactly one of text or regex.');
    }

    if (regex !== undefined) {
      try {
        new RegExp(regex);
      } catch {
        bad('regex is not a valid regular expression.');
      }

      return { regex };
    }

    return { text: text as string };
  },
  screenshot: (raw) => {
    const out: ScreenshotArgs = { fullPage: bool(raw, 'full_page') };
    const r = ref(raw, 'ref', false);
    if (r !== undefined) {
      out.ref = r;
    }

    return out;
  },
  wait: (raw) => {
    const out: WaitArgs = {};
    const text = str(raw, 'text', 1000, false);
    const textGone = str(raw, 'text_gone', 1000, false);
    const seconds = num(raw, 'seconds', 0.5, 30);

    if (text !== undefined && text !== '') {
      out.text = text;
    }

    if (textGone !== undefined && textGone !== '') {
      out.textGone = textGone;
    }

    if (seconds !== undefined) {
      out.seconds = seconds;
    }

    if (out.text === undefined && out.textGone === undefined && out.seconds === undefined) {
      bad('Give text, text_gone or seconds.');
    }

    return out;
  },
  console: (raw) => ({ level: oneOf(raw, 'level', ['error', 'warning', 'info', 'debug'] as const, 'info') }),
  network: (raw) => {
    const out: NetworkArgs = { includeStatic: bool(raw, 'static') };
    const filter = str(raw, 'filter', 500, false);
    const index = int(raw, 'index', 0, 10_000_000);

    if (filter !== undefined && filter !== '') {
      out.filter = filter;
    }

    if (index !== undefined) {
      out.index = index;
    }

    return out;
  },
  pdf: () => ({}),
  click: (raw) => ({
    target: target(raw, ''),
    button: oneOf(raw, 'button', ['left', 'right', 'middle'] as const, 'left'),
    count: int(raw, 'count', 1, 3) ?? 1,
    modifiers: modifiers(raw),
  }),
  hover: (raw) => ({ target: target(raw, '') }),
  type: (raw) => {
    const text = raw.text;
    if (typeof text !== 'string' || text.length > MAX_TEXT) {
      bad(`text must be a string of at most ${MAX_TEXT} characters.`);
    }

    return {
      element: str(raw, 'element', MAX_ELEMENT, true),
      ref: ref(raw, 'ref', true),
      text,
      submit: bool(raw, 'submit'),
      slowly: bool(raw, 'slowly'),
    };
  },
  fill_form: (raw) => {
    const fields = raw.fields;
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FIELDS) {
      bad(`fields must list 1 to ${MAX_FIELDS} fields.`);
    }

    return {
      fields: fields.map((f) => {
        if (typeof f !== 'object' || f === null || Array.isArray(f)) {
          bad('Each field must be an object with element, ref, type and value.');
        }

        const field = f as Raw;
        const value = field.value;
        if (typeof value !== 'string' || value.length > MAX_TEXT) {
          bad(`Each field value must be a string of at most ${MAX_TEXT} characters.`);
        }

        return {
          element: str(field, 'element', MAX_ELEMENT, true),
          ref: ref(field, 'ref', true),
          type: oneOf(field, 'type', ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] as const),
          value,
        };
      }),
    };
  },
  select: (raw) => ({
    element: str(raw, 'element', MAX_ELEMENT, true),
    ref: ref(raw, 'ref', true),
    values: stringList(raw, 'values', MAX_VALUES, MAX_ELEMENT),
  }),
  press_key: (raw) => ({ key: str(raw, 'key', 64, true), repeat: int(raw, 'repeat', 1, 20) ?? 1 }),
  scroll: (raw) => {
    const r = ref(raw, 'ref', false);
    if (r !== undefined) {
      return { element: str(raw, 'element', MAX_ELEMENT, false) ?? '', ref: r };
    }

    const x = num(raw, 'x', 0, MAX_COORD);
    const y = num(raw, 'y', 0, MAX_COORD);
    if (x === undefined || y === undefined) {
      bad('Give ref, or x and y with a direction.');
    }

    return {
      point: { x, y },
      direction: oneOf(raw, 'direction', ['up', 'down', 'left', 'right'] as const),
      amount: num(raw, 'amount', 1, MAX_COORD) ?? 600,
    };
  },
  drag: (raw) => ({ start: target(raw, 'start_'), end: target(raw, 'end_') }),
  dialog: (raw) => {
    if (typeof raw.accept !== 'boolean') {
      bad('accept must be true or false.');
    }

    const out: DialogArgs = { accept: raw.accept };
    const promptText = str(raw, 'prompt_text', MAX_TEXT, false);
    if (promptText !== undefined) {
      out.promptText = promptText;
    }

    return out;
  },
  upload: (raw) => {
    const files = raw.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
      bad(`files must list 1 to ${MAX_FILES} files.`);
    }

    return {
      element: str(raw, 'element', MAX_ELEMENT, true),
      ref: ref(raw, 'ref', true),
      files: files.map((f) => {
        if (typeof f !== 'object' || f === null || Array.isArray(f)) {
          bad('Each file must be an object.');
        }

        const file = f as Raw;
        const size = file.size;
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
          bad('Each file must have a size.');
        }

        return {
          token: str(file, 'token', 256, true),
          name: str(file, 'name', 255, true),
          size,
          contentType: str(file, 'content_type', 255, false) ?? 'application/octet-stream',
        };
      }),
    };
  },
  evaluate: (raw) => {
    const out: EvaluateArgs = { fn: str(raw, 'function', MAX_SCRIPT, true) };
    const r = ref(raw, 'ref', false);
    if (r !== undefined) {
      out.ref = r;
      out.element = str(raw, 'element', MAX_ELEMENT, false) ?? '';
    }

    return out;
  },
};

/** 校验一个动作的参数，返回规整后的参数。 */
export function validateArgs<K extends ActionName>(action: K, raw: Raw): ActionArgs[K] {
  return validators[action](raw);
}

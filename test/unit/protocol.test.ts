import { describe, expect, it } from 'vitest';

import { validateArgs } from '../../src/protocol/args';
import { ActionError } from '../../src/protocol/errors';
import { parseInbound } from '../../src/protocol/frames';

const RID = '11111111-2222-4333-8444-555555555555';
const CONV = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ActionError ? err.code : 'other';
  }
}

describe('parseInbound', () => {
  it('收下合法的各类帧', () => {
    expect(parseInbound({ type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'a@b.c', max_file_bytes: 100 }))
      .toEqual({ type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'a@b.c', max_file_bytes: 100 });
    expect(parseInbound({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parseInbound({ type: 'request', request_id: RID, action: 'click', args: { ref: 'e1' }, conversation: CONV, deadline_ms: 30000, auth_wait_ms: 120000 }))
      .toMatchObject({ type: 'request', action: 'click' });
    expect(parseInbound({ type: 'cancel', request_id: RID })).toEqual({ type: 'cancel', request_id: RID });
    expect(parseInbound({ type: 'closed', reason: 'replaced' })).toEqual({ type: 'closed', reason: 'replaced' });
  });

  it('未知类型与格式不对的帧丢弃（返回 null），不抛异常', () => {
    expect(parseInbound({ type: 'mystery' })).toBeNull();
    expect(parseInbound('ping')).toBeNull();
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound([])).toBeNull();
    // request_id 不是小写 UUID、动作不认识、args 不是对象、时限不对
    expect(parseInbound({ type: 'request', request_id: CONV.toUpperCase(), action: 'click', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 })).toBeNull();
    expect(parseInbound({ type: 'request', request_id: RID, action: 'getCookies', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 })).toBeNull();
    expect(parseInbound({ type: 'request', request_id: RID, action: 'click', args: [], conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 })).toBeNull();
    expect(parseInbound({ type: 'request', request_id: RID, action: 'click', args: {}, conversation: CONV, deadline_ms: 0, auth_wait_ms: 1 })).toBeNull();
    expect(parseInbound({ type: 'ready', protocol: 1, heartbeat_seconds: 0, account: '', max_file_bytes: 1 })).toBeNull();
  });

  it('approval 的 kind / decision 不认识时照样交上去（由审批登记按 ask_user 处理）', () => {
    expect(parseInbound({ type: 'approval', request_id: RID, approval_id: 'a1-x', kind: 'cookies', decision: 'yes' }))
      .toMatchObject({ kind: 'cookies', decision: 'yes' });
    expect(parseInbound({ type: 'approval', request_id: RID, approval_id: 'bad id!', kind: 'site', decision: 'allow' })).toBeNull();
  });
});

describe('validateArgs', () => {
  it('open / tabs / navigate', () => {
    expect(validateArgs('open', { url: 'https://x.test/' })).toEqual({ url: 'https://x.test/', newTab: false });
    expect(code(() => validateArgs('open', {}))).toBe('invalid_args');
    expect(code(() => validateArgs('open', { url: 'x'.repeat(5000) }))).toBe('invalid_args');
    expect(code(() => validateArgs('tabs', { op: 'select' }))).toBe('invalid_args');
    expect(validateArgs('tabs', { op: 'select', index: 2 })).toEqual({ op: 'select', index: 2 });
    expect(code(() => validateArgs('navigate', { direction: 'up' }))).toBe('invalid_args');
  });

  it('元素目标：ref 与坐标二选一，ref 形如 e12 / f1e3', () => {
    expect(validateArgs('click', { element: 'OK', ref: 'f2e10' }).target).toEqual({ element: 'OK', ref: 'f2e10' });
    expect(validateArgs('click', { element: 'OK', x: 10, y: 20 }).target).toEqual({ element: 'OK', point: { x: 10, y: 20 } });
    expect(code(() => validateArgs('click', { element: 'OK', ref: 'e1', x: 1, y: 2 }))).toBe('invalid_args');
    expect(code(() => validateArgs('click', { element: 'OK' }))).toBe('invalid_args');
    expect(code(() => validateArgs('click', { element: 'OK', ref: 'button' }))).toBe('invalid_args');
    expect(code(() => validateArgs('click', { ref: 'e1' }))).toBe('invalid_args');
    expect(code(() => validateArgs('click', { element: 'OK', ref: 'e1', count: 4 }))).toBe('invalid_args');
    expect(code(() => validateArgs('click', { element: 'OK', ref: 'e1', modifiers: ['Hyper'] }))).toBe('invalid_args');
    expect(validateArgs('click', { element: 'OK', ref: 'e1', modifiers: ['Shift', 'Shift'] }).modifiers).toEqual(['Shift']);
  });

  it('find 要且只要 text 或 regex；正则要能编译', () => {
    expect(validateArgs('find', { text: 'a' })).toEqual({ text: 'a' });
    expect(validateArgs('find', { regex: '^a$' })).toEqual({ regex: '^a$' });
    expect(code(() => validateArgs('find', {}))).toBe('invalid_args');
    expect(code(() => validateArgs('find', { text: 'a', regex: 'b' }))).toBe('invalid_args');
    expect(code(() => validateArgs('find', { regex: '(' }))).toBe('invalid_args');
  });

  it('wait 至少给一样，seconds 在 0.5–30', () => {
    expect(code(() => validateArgs('wait', {}))).toBe('invalid_args');
    expect(code(() => validateArgs('wait', { seconds: 31 }))).toBe('invalid_args');
    expect(validateArgs('wait', { text_gone: 'x' })).toEqual({ textGone: 'x' });
  });

  it('fill_form、select、upload、dialog、evaluate、scroll、drag', () => {
    expect(code(() => validateArgs('fill_form', { fields: [] }))).toBe('invalid_args');
    expect(code(() => validateArgs('fill_form', { fields: [{ element: 'a', ref: 'e1', type: 'password', value: 'x' }] }))).toBe('invalid_args');
    expect(validateArgs('fill_form', { fields: [{ element: 'a', ref: 'e1', type: 'checkbox', value: 'true' }] }).fields).toHaveLength(1);
    expect(code(() => validateArgs('select', { element: 'a', ref: 'e1', values: [] }))).toBe('invalid_args');
    expect(code(() => validateArgs('upload', { element: 'a', ref: 'e1', files: [{ token: 't', name: 'n' }] }))).toBe('invalid_args');
    expect(validateArgs('upload', { element: 'a', ref: 'e1', files: [{ token: 't', name: 'n', size: 3 }] }).files[0])
      .toEqual({ token: 't', name: 'n', size: 3, contentType: 'application/octet-stream' });
    expect(code(() => validateArgs('dialog', {}))).toBe('invalid_args');
    expect(code(() => validateArgs('evaluate', { function: '' }))).toBe('invalid_args');
    expect(validateArgs('scroll', { x: 1, y: 2, direction: 'down' })).toEqual({ point: { x: 1, y: 2 }, direction: 'down', amount: 600 });
    expect(code(() => validateArgs('scroll', { x: 1, y: 2 }))).toBe('invalid_args');
    expect(validateArgs('drag', { start_element: 'a', start_ref: 'e1', end_element: 'b', end_x: 5, end_y: 6 }))
      .toEqual({ start: { element: 'a', ref: 'e1' }, end: { element: 'b', point: { x: 5, y: 6 } } });
  });
});

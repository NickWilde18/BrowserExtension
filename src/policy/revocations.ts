// 授权撤销的同步广播：标签登记与站点授权各持一份，在途读取据此作废匹配的租约（见 browser/read-leases）。
export type Revocation =
  | { kind: 'tab'; tabId: number; conversation: string }
  | { kind: 'conversation'; conversation: string }
  | { kind: 'site'; site: string }
  | { kind: 'all' };

type Listener = (revocation: Revocation) => void;

/** 授权来源（标签登记、站点授权）各持一份，撤销时同步派发。 */
export class Revocations {
  private readonly listeners = new Set<Listener>();

  /** 当前登记的在途读取数（测试核对释放）。 */
  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(revocation: Revocation): void {
    for (const listener of [...this.listeners]) listener(revocation);
  }
}

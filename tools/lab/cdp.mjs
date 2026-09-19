// cdp.mjs — 极简 Chrome DevTools Protocol 客户端。
// 依赖 Node 22 内置的全局 WebSocket 与 fetch，零第三方依赖。

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._handlers = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败: ' + url)), { once: true });
    });
    return new CDP(ws);
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message + (msg.error.data ? ' — ' + msg.error.data : ''));
        e.code = msg.error.code;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const h of this._handlers.get(msg.method) || []) h(msg.params, msg.sessionId);
    }
  }

  on(method, fn) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(fn);
    return this;
  }

  send(method, params = {}, sessionId) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn() 返回真值或超时。 */
export async function waitFor(fn, { timeout = 30000, interval = 250, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`);
    await sleep(interval);
  }
}

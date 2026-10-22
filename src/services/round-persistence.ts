import { profileStorageId } from '../platform.js';
import { errorInfo } from '../shared/errors.ts';
import type { Repetition, RoundResult } from '../shared/contracts/api.ts';
import type { SessionService } from './session.ts';
/** Durable delivery and recovery; no access to screen DOM or camera resources. */
export class RoundPersistence {
  private writes = new Set<Promise<string>>();
  private readonly session: SessionService;
  constructor(session: SessionService) {
    this.session = session;
  }
  private finalKey() {
    return `movement.finalization.${profileStorageId(this.session.state?.profile?.id)}`;
  }
  private activeKey() {
    return `movement.active.${profileStorageId(this.session.requireState().profile.id)}`;
  }
  remember(result: RoundResult) {
    localStorage.setItem(this.finalKey(), JSON.stringify({ id: result.id, status: result.status }));
  }
  forget() {
    localStorage.removeItem(this.finalKey());
    sessionStorage.removeItem(this.activeKey());
  }
  pending(): RoundResult | null {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(this.finalKey()) || 'null');
      if (
        typeof saved === 'object' &&
        saved !== null &&
        'id' in saved &&
        typeof saved.id === 'string' &&
        'status' in saved &&
        ['completed', 'interrupted', 'aborted'].includes(String(saved.status))
      )
        return saved as RoundResult;
    } catch {}
    return null;
  }
  async record(event: Omit<Repetition, 'id'>) {
    const queue = this.session.outbox;
    if (!queue || !this.session.outboxReady) return;
    const write = queue.add({ id: crypto.randomUUID(), ...event });
    this.writes.add(write);
    try {
      await write;
      this.session.persistenceError = false;
    } catch (error) {
      this.session.persistenceError = true;
      throw error;
    } finally {
      this.writes.delete(write);
    }
  }
  async settled() {
    await Promise.allSettled([...this.writes]);
  }
  async finish(result: RoundResult) {
    await this.settled();
    const queue = this.session.outbox;
    if (this.session.persistenceError || !queue) throw new Error('local persistence failed');
    const sent = await queue.flush();
    if (sent) await this.session.apply(sent);
    if (await queue.count()) throw new Error('pending');
    if (result.status === 'completed') await new Promise((resolve) => setTimeout(resolve, 200));
    let response;
    try {
      response = await this.session.api(
        `rounds/${result.id}/${result.status === 'completed' ? 'finish' : 'abort'}`,
        { method: 'POST', body: {}, keepalive: result.status !== 'completed' },
      );
    } catch (error) {
      if (result.status !== 'completed' || errorInfo(error).code !== 'ROUND_RUNNING') throw error;
      await new Promise((resolve) => setTimeout(resolve, 600));
      response = await this.session.api(`rounds/${result.id}/finish`, { method: 'POST', body: {} });
    }
    await this.session.apply(response.state);
    this.forget();
    return response.round;
  }
  async recoverReload() {
    const state = this.session.requireState(),
      key = this.activeKey(),
      ownRound = sessionStorage.getItem(key);
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const isReload =
      entry?.type === 'reload' || (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
    if (!isReload) sessionStorage.removeItem(key);
    if (isReload && state.activeRound?.id === ownRound) {
      await this.session.api(`rounds/${ownRound}/abort`, { method: 'POST', body: {} });
      sessionStorage.removeItem(key);
      try {
        this.remember({ id: ownRound!, status: 'interrupted' });
      } catch {}
      await this.session.apply(await this.session.api('state'));
      return true;
    }
    return false;
  }
}

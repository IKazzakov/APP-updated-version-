// Cursor requests and screen-owned loading are independent of training/outbox.
export class HistoryLoader {
  constructor({ api, onPage, onError }) {
    Object.assign(this, { api, onPage, onError });
    this.owner = null;
    this.generation = 0;
    this.pages = new Map();
  }
  setOwner(owner) {
    if (owner !== this.owner) {
      this.owner = owner;
      this.generation++;
      this.pages.clear();
    }
  }
  info(kind) {
    return this.pages.get(kind) || {};
  }
  async load(kind, { more = false, refresh = false, from, to } = {}) {
    if (!this.owner) return;
    const old = this.info(kind),
      range = JSON.stringify([from, to]);
    if (old.pending) {
      if (old.range !== range || refresh) {
        const owner = this.owner;
        await old.pending;
        if (owner !== this.owner) return;
        return this.load(kind, { more, refresh, from, to });
      }
      return old.pending;
    }
    if (!more && !refresh && old.loaded && old.range === range) return;
    if (more && !old.next) return;
    const generation = this.generation,
      query = new URLSearchParams({ limit: kind === 'competitions' ? '50' : '50' });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (more) query.set('cursor', old.next);
    const page = { ...old, range, loading: true };
    this.pages.set(kind, page);
    page.pending = (async () => {
      try {
        const result = await this.api(
          (kind === 'competitions' ? 'competitions' : 'history/' + kind) + '?' + query,
        );
        if (generation !== this.generation) return;
        Object.assign(page, {
          next: result.nextCursor,
          loaded: true,
          loading: false,
          pending: null,
        });
        this.onPage(kind, result.items, { append: more, from, to });
      } catch (error) {
        if (generation === this.generation) {
          page.loading = false;
          page.pending = null;
          this.onError(error);
        }
      }
    })();
    return page.pending;
  }
}

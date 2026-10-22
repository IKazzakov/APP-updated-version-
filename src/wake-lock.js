export class ScreenWakeLock {
  constructor() {
    this.sentinel = null;
    this.desired = false;
    this.boundVisibility = this.handleVisibility.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.boundVisibility);
    }
  }

  get isSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async acquire() {
    this.desired = true;
    if (!this.isSupported || document.visibilityState !== 'visible') return false;
    try {
      if (!this.sentinel || this.sentinel.released) {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => {
          if (!this.desired) this.sentinel = null;
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  release() {
    this.desired = false;
    if (this.sentinel) {
      try {
        this.sentinel.release();
      } catch {}
      this.sentinel = null;
    }
  }

  async handleVisibility() {
    if (document.visibilityState === 'visible' && this.desired) {
      await this.acquire();
    }
  }

  destroy() {
    this.release();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.boundVisibility);
    }
  }
}

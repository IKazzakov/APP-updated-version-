import {registerPlugin} from '@capacitor/core';
import {isNativeApp} from './platform.js';

const WorkoutScreen = registerPlugin('WorkoutScreen');

export class ScreenWakeLock {
  constructor({native = isNativeApp(), nativeScreen = WorkoutScreen} = {}) {
    this.native = native;
    this.nativeScreen = nativeScreen;
    this.sentinel = null;
    this.desired = false;
    this.generation = 0;
    this.boundVisibility = this.handleVisibility.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.boundVisibility);
    }
  }

  get isSupported() {
    return this.native || typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async acquire() {
    this.desired = true;
    const generation = ++this.generation;
    if (!this.isSupported || document.visibilityState !== 'visible') return false;
    try {
      if (this.native) {
        await this.nativeScreen.setEnabled({enabled: true});
        if (!this.desired) {
          await this.nativeScreen.setEnabled({enabled: false});
          return false;
        }
        return true;
      }
      if (!this.sentinel || this.sentinel.released) {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!this.desired || generation !== this.generation || document.visibilityState !== 'visible') {
          await sentinel.release();
          return false;
        }
        this.sentinel = sentinel;
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
    this.generation++;
    if (this.native) this.nativeScreen.setEnabled({enabled: false}).catch(() => {});
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

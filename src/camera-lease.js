const CAMERA_LOCK = 'exercise-counter-camera';

// A browser-native, same-origin lock prevents two tabs from counting the same
// exercise simultaneously. Chrome releases the lock if the tab is destroyed.
// There is deliberately no timer or localStorage lease that could go stale.
export class CameraLease {
  constructor({locks = globalThis.navigator?.locks} = {}) {
    this.locks = locks; this.supported = typeof locks?.request === 'function';
    this.held = false; this.attempt = null; this.reason = this.supported ? null : 'unsupported';
  }
  async acquire() {
    if (!this.supported) {this.reason = 'unsupported'; return false;}
    if (this.held) return true;
    if (this.attempt) return this.attempt.available;

    let resolveAvailable, releaseHold;
    const available = new Promise(resolve => {resolveAvailable = resolve;});
    const hold = new Promise(resolve => {releaseHold = resolve;});
    const attempt = {available, releaseHold, settled: false};
    const settle = value => {
      if (!attempt.settled) {attempt.settled = true; resolveAvailable(value);}
    };
    attempt.cancel = () => {settle(false); releaseHold();};
    this.attempt = attempt; this.reason = null;
    const finish = () => {
      if (this.attempt === attempt) {this.held = false; this.attempt = null;}
    };
    try {
      Promise.resolve(this.locks.request(CAMERA_LOCK, {ifAvailable: true}, async lock => {
        // release() may have happened while Chrome was dispatching this
        // request. A late grant must leave immediately, never hold the camera.
        if (this.attempt !== attempt) {settle(false); return;}
        if (!lock) {this.reason = 'occupied'; settle(false); return;}
        this.held = true; this.reason = null; settle(true);
        await hold;
      })).catch(() => {
        if (this.attempt === attempt) this.reason = 'error';
        settle(false);
      }).finally(finish);
    } catch {
      this.reason = 'error'; settle(false); finish();
    }
    return available;
  }
  release() {
    const attempt = this.attempt;
    this.attempt = null; this.held = false;
    attempt?.cancel();
  }
}

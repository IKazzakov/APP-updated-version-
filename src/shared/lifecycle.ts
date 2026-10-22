export class Lifecycle {
  private cleanups: (() => void)[] = [];
  add(cleanup: () => void) {
    this.cleanups.push(cleanup);
    return cleanup;
  }
  listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    this.add(() => target.removeEventListener(type, listener, options));
  }
  interval(callback: () => void, ms: number) {
    const id = setInterval(callback, ms);
    this.add(() => clearInterval(id));
  }
  destroy() {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }
}

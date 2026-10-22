import { activity } from '../activity-log.js';
export interface Screen {
  root: HTMLElement;
  activate?(): void;
  deactivate?(): void;
  destroy?(): void;
}
export class Navigation {
  private screens = new Map<string, Screen>();
  current = 'today';
  private nav: HTMLElement;
  private readonly onChange: () => void;
  constructor(nav: HTMLElement, onChange: () => void) {
    this.nav = nav;
    this.onChange = onChange;
  }
  register(id: string, screen: Screen) {
    if (this.screens.has(id)) throw new Error('Duplicate screen');
    this.screens.set(id, screen);
  }
  open(id: string) {
    if (!this.screens.has(id)) return;
    if (id !== this.current) {
      activity.record('ui.tab', { action: id });
      this.screens.get(this.current)?.deactivate?.();
    }
    this.current = id;
    for (const [key, screen] of this.screens) screen.root.hidden = key !== id;
    for (const button of this.nav.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = button.dataset.tab === id;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    this.screens.get(id)?.activate?.();
    this.onChange();
  }
  destroy() {
    for (const s of this.screens.values()) s.destroy?.();
    this.screens.clear();
  }
}

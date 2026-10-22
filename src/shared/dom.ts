import type { Elements } from './elements.ts';
/** All lookups stay within a feature's root. Missing required markup fails early. */
export function dom(root: ParentNode) {
  function get<K extends keyof Elements>(id: K): Elements[K];
  function get<T extends HTMLElement = HTMLElement>(id: string): T;
  function get(id: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(`#${id}`);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el;
  }
  return {
    get,
    text: (id: string, value: unknown) => {
      const el = get(id),
        text = String(value ?? '');
      if (el.textContent !== text) el.textContent = text;
    },
  };
}
export function escape(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export const dateLabel = (
  value: number,
  zone: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' },
) => new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: zone }).format(new Date(value));

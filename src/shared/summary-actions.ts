import type { SessionService } from '../services/session.ts';
import { errorMessage } from './errors.ts';
export function bindSummaryActions(
  root: HTMLElement,
  session: SessionService,
  onError: (message: string) => void,
) {
  const handler = async (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-seen-week]');
    if (!button || !root.contains(button)) return;
    const week = button.dataset.seenWeek;
    if (!week) return;
    button.disabled = true;
    try {
      const r = await session.api('weeks/seen', {
        method: 'POST',
        body: { week, total: Number(button.dataset.seenTotal) },
      });
      await session.apply(r.state);
    } catch (error) {
      onError(errorMessage(error));
      button.disabled = false;
    }
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

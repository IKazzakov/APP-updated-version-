import { comparableRounds } from '../progress.js';
import { RULES_VERSION } from '../config.js';
import type { AppState } from './contracts/api.ts';
export function resultComparison(state: AppState | null) {
  const p = comparableRounds(state?.rounds || [], RULES_VERSION),
    delta = p.delta ?? 0;
  return !p.last
    ? 'Первый завершённый раунд станет вашей исходной точкой.'
    : !p.previous
      ? 'Первая завершённая минута — ваша исходная точка. После следующей появится сравнение.'
      : `Предыдущий результат — ${p.previous.count}. ${delta > 0 ? `На ${delta} повторения больше` : delta < 0 ? `На ${Math.abs(delta)} повторения меньше` : 'Столько же повторений'}.`;
}

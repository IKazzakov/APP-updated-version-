import type { Round } from './shared/contracts/api.ts';
export function comparableRounds(
  rounds: Round[],
  rulesVersion?: string,
): {
  last: Round | null;
  previous: Round | null;
  delta: number | null;
  record: number | null;
  history: Round[];
};

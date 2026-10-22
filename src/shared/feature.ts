import type { SessionService } from '../services/session.ts';
import type { TrainingMode } from './contracts/api.ts';
export interface FeatureContext {
  session: SessionService;
  navigate: (screen: string) => void;
  chooseMode: (mode: TrainingMode, id?: string | null) => void;
  openProfile: () => void;
  openLeague: (type: 'result' | 'points', week: string) => void;
  showError: (message: string) => void;
  refresh: () => Promise<void>;
}

import type { SessionService } from '../services/session.ts';
import type { WorkoutsService } from '../services/workouts.ts';
import type { TrainingMode } from './contracts/api.ts';
export interface FeatureContext {
  session: SessionService;
  workouts: WorkoutsService;
  openWorkout: (programId?: string) => void;
  navigate: (screen: string) => void;
  chooseMode: (mode: TrainingMode, id?: string | null) => void;
  openProfile: () => void;
  openLeague: (type: 'result' | 'points', week: string) => void;
  showError: (message: string) => void;
  refresh: () => Promise<void>;
}

import template from './template.html?raw';
import { createWorkoutRunner } from './runner.ts';
import type { createTraining } from '../training/controller.ts';
import type { FeatureContext } from '../../shared/feature.ts';

/** Keep the established training lifecycle and DOM intact beside the program runner. */
export function createWorkoutTraining(
  root: HTMLElement,
  ctx: FeatureContext,
  createLegacy: () => ReturnType<typeof createTraining>,
) {
  const legacyHost = document.createElement('div');
  legacyHost.dataset.legacyTraining = '';
  legacyHost.append(...root.childNodes);
  const programHost = document.createElement('section');
  programHost.dataset.feature = 'workouts';
  programHost.dataset.workoutRunner = '';
  programHost.innerHTML = template;
  programHost.hidden = true;
  root.append(legacyHost, programHost);
  const legacy = createLegacy();
  let showingProgram = false;
  const runner = createWorkoutRunner(programHost, ctx, async () => {
    if (legacy.running || legacy.busy) throw new Error('Сначала завершите минутную попытку.');
    legacy.deactivate();
    if (!(await legacy.prepareLogout())) throw new Error('Дождитесь сохранения приседаний.');
  });
  function render() {
    if (ctx.workouts.unfinished) showingProgram = true;
    legacyHost.hidden = showingProgram;
    programHost.hidden = !showingProgram;
    legacy.render();
    runner.render();
  }
  return {
    ...legacy,
    render,
    openWorkout(programId?: string) {
      if (legacy.running || legacy.busy) {
        ctx.showError('Сначала завершите текущую минутную попытку.');
        return;
      }
      legacy.deactivate();
      showingProgram = true;
      runner.select(programId);
      render();
    },
    chooseMode(...args: Parameters<typeof legacy.chooseMode>) {
      if (ctx.workouts.unfinished) {
        ctx.showError(
          ctx.workouts.record?.pendingEnd
            ? 'Завершение программы ожидает подтверждения. Повторите сохранение.'
            : 'Сначала продолжите или завершите программу.',
        );
        return;
      }
      runner.pause();
      showingProgram = false;
      legacy.chooseMode(...args);
      render();
    },
    get busy() {
      return legacy.busy || runner.busy;
    },
    get cameraOn() {
      return legacy.cameraOn || runner.cameraOn;
    },
    get running() {
      return legacy.running || runner.running;
    },
    deactivate() {
      runner.pause();
      legacy.deactivate();
    },
    onHidden() {
      runner.pause('Программа на паузе: приложение ушло в фон.');
      legacy.onHidden();
    },
    onPageHide() {
      runner.pause('Программа на паузе. Продолжение доступно в течение 24 часов.');
      legacy.onPageHide();
    },
    async prepareLogout() {
      runner.pause();
      try {
        await ctx.workouts.prepareLogout();
      } catch (error) {
        ctx.showError(error instanceof Error ? error.message : 'Дождитесь сохранения программы.');
        return false;
      }
      return legacy.prepareLogout();
    },
    destroy() {
      runner.destroy();
      legacy.destroy();
    },
  };
}

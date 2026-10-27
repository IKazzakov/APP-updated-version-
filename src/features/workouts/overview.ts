import { escape } from '../../shared/dom.ts';
import { findWorkoutProgram } from '../../shared/workouts/catalog.ts';
import { errorMessage } from '../../shared/errors.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import type { WorkoutStep } from '../../shared/contracts/workouts.ts';
import './style.css';

const names = { squat: 'Приседания', pushup: 'Отжимания', plank: 'Планка' };
function label(step: WorkoutStep) {
  return `${names[step.exercise]}: ${step.unit === 'ms' ? step.target / 1000 + ' с' : step.target}`;
}
export function createWorkoutOverview(root: HTMLElement, ctx: FeatureContext) {
  const catalog = root.querySelector<HTMLElement>('[data-workout-catalog]')!;
  const activity = root.querySelector<HTMLElement>('[data-workout-activity]')!;
  let signature = '';
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      '[data-program-id],[data-workout-resume],[data-workout-check]',
    );
    if (button?.hasAttribute('data-workout-check')) {
      void ctx.workouts.retry().catch((error) => ctx.showError(errorMessage(error)));
    } else if (button) ctx.openWorkout(button.dataset.programId);
  };
  catalog.addEventListener('click', click);
  return {
    render() {
      const service = ctx.workouts,
        progress = service.activity;
      if (progress)
        activity.innerHTML = `<div class="activity-metrics"><div><strong data-workout-xp>${progress.totalXp} XP</strong><p>Уровень ${progress.level} · ${progress.xpInLevel} / 100 до следующего</p></div><div><strong data-workout-streak>${progress.streak.current} дн.</strong><p>Серия · лучшая ${progress.streak.best} дн.</p></div></div><progress class="activity-progress" value="${progress.xpInLevel}" max="100" aria-label="Опыт до следующего уровня"></progress><p>Сегодня ${progress.today.units} из ${progress.today.goal} единиц активности · ${progress.today.xp} XP. Приседание и отжимание — по 1, планка — 1 за 5 секунд.</p><p class="muted">XP начисляется за фактическую активность, до 300 в день. Несколько занятий суммируются; 10 единиц продлевают серию.</p>`;
      else
        activity.innerHTML =
          '<h2>Опыт и серия дней</h2><p>Здесь появятся подтверждённые XP и серия после подключения профиля. Сохранённые баллы прежних заданий остаются в истории.</p>';
      const nextSignature = JSON.stringify([
        service.programs,
        service.record?.workout.id,
        service.unfinished,
        service.record?.pendingEnd,
        service.apiState,
        service.expired,
        !!service.availabilityError,
        ctx.session.state?.profile?.id,
      ]);
      if (signature === nextSignature) return;
      signature = nextSignature;
      const resume = service.unfinished
        ? `<article class="card"><h2>${service.record?.pendingEnd ? 'Завершение ожидает подтверждения' : 'Есть незаконченная программа'}</h2><p>${service.record?.pendingEnd ? 'Программа прекращена на устройстве. Упражнения и намерение завершения сохранены; дождитесь подтверждения перед новым запуском.' : service.expired ? '24 часа истекли. Сохраните частичный итог.' : 'Продолжение — до 24 часов после начала. Выполненный объём сохранён на устройстве.'}</p><button data-workout-resume class="button primary">${service.record?.pendingEnd ? 'Открыть сохранение результата' : service.expired ? 'Сохранить частичный итог' : 'Продолжить или завершить'}</button></article>`
        : '';
      catalog.innerHTML =
        resume +
        (service.availabilityError
          ? `<article class="card"><p role="status">${escape(errorMessage(service.availabilityError))}</p><button data-workout-check class="button secondary" ${service.apiState === 'checking' ? 'disabled' : ''}>Проверить снова</button></article>`
          : '') +
        service.programs
          .map(
            (program) =>
              `<article class="card"><h2>${escape(program.title)}</h2><p>${program.steps.map(label).map(escape).join(' → ')}</p><p class="muted">${program.rounds} круг · отдых ${program.restMs / 1000} с между подходами${program.id === 'starter-circuit-v1' ? ' · 13 единиц активности' : ''}</p><button class="button primary" data-program-id="${escape(program.id)}" ${!ctx.session.state?.profile || service.unfinished || service.apiUnavailable ? 'disabled' : ''}>${service.unfinished ? 'Сначала сохраните текущую программу' : 'Выбрать программу'}</button></article>`,
          )
          .join('');
    },
    destroy() {
      catalog.removeEventListener('click', click);
    },
  };
}
export function renderWorkoutHistory(root: HTMLElement, ctx: FeatureContext) {
  const host = root.querySelector<HTMLElement>('[data-workout-history]')!;
  const service = ctx.workouts;
  host.innerHTML = service.history.length
    ? service.history
        .map((item) => {
          const program = findWorkoutProgram(item.programId),
            date = new Intl.DateTimeFormat('ru-RU', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(item.startedAt);
          return `<div class="workout-history-item"><strong>${escape(program?.title ?? 'Программа')}</strong><p>${escape(date)} · ${item.status === 'completed' ? 'Выполнена' : 'Завершена досрочно'}</p><p>${item.stepProgress.map((amount, i) => (program?.steps[i % program.steps.length]?.unit === 'ms' ? `${(amount / 1000).toFixed(1)} с` : `${amount} повторений`)).join(' · ')} · ${Math.round(item.activeMs / 1000)} с без пауз</p></div>`;
        })
        .join('')
    : '<p class="muted">Сохранённые программы появятся здесь после завершения. Минутные рекорды учитываются отдельно.</p>';
  const button = root.querySelector<HTMLButtonElement>('[data-workout-history-more]')!;
  button.hidden = !service.hasMore;
  button.disabled = service.loadingHistory;
}

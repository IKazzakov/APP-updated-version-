import today from '../features/today/template.html?raw';
import training from '../features/training/template.html?raw';
import competitions from '../features/competitions/template.html?raw';
import progress from '../features/progress/template.html?raw';
import { createToday } from '../features/today/view.ts';
import { createTraining } from '../features/training/controller.ts';
import { createWorkoutTraining } from '../features/workouts/integration.ts';
import { createCompetitions } from '../features/competitions/controller.ts';
import { createProgress } from '../features/progress/view.ts';
import { dom, escape } from '../shared/dom.ts';
import type { FeatureContext } from '../shared/feature.ts';
import type { Diagnostics } from '../diagnostics.js';
import type { Screen } from './navigation.ts';
interface ScreenServices {
  diagnostics: Diagnostics;
  getError: () => string;
}
/** Register the template, navigation label and factory for a new screen here. */
export const screens = {
  today: {
    label: 'Сегодня',
    icon: '◉',
    html: today,
    create: (root: HTMLElement, ctx: FeatureContext, _services: ScreenServices) =>
      createToday(root, ctx),
  },
  training: {
    label: 'Тренировка',
    icon: '<svg class="arrow-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    html: training,
    create: (root: HTMLElement, ctx: FeatureContext, services: ScreenServices) =>
      createWorkoutTraining(root, ctx, () =>
        createTraining(root, ctx, services.diagnostics, { getError: services.getError }),
      ),
  },
  competitions: {
    label: 'Соревнования',
    icon: '⚑',
    html: competitions,
    create: (root: HTMLElement, ctx: FeatureContext, _services: ScreenServices) =>
      createCompetitions(root, ctx),
  },
  progress: {
    label: 'Мой прогресс',
    icon: '▥',
    html: progress,
    create: (root: HTMLElement, ctx: FeatureContext, _services: ScreenServices) =>
      createProgress(root, ctx),
  },
};
export type ScreenInstances = {
  [K in keyof typeof screens]: ReturnType<(typeof screens)[K]['create']>;
};
export type FeatureScreen = Screen & { render: () => void; refresh?: () => void };
export function mountScreens(
  main: HTMLElement,
  nav: HTMLElement,
  ctx: FeatureContext,
  services: ScreenServices,
): ScreenInstances {
  const instances = {} as ScreenInstances;
  for (const id of Object.keys(screens) as (keyof typeof screens)[]) {
    const definition = screens[id],
      host = document.createElement('div');
    host.dataset.feature = id;
    host.style.display = 'contents';
    host.innerHTML = definition.html;
    main.append(host);
    const root = dom(host).get('tab-' + id),
      instance = definition.create(root, ctx, services);
    Object.assign(instances, { [id]: instance });
    const button = document.createElement('button');
    button.dataset.tab = id;
    button.className = 'nav-item' + (id === 'today' ? ' active' : '');
    if (id === 'today') button.setAttribute('aria-current', 'page');
    button.innerHTML = `<span aria-hidden="true">${definition.icon}</span>${escape(definition.label)}`;
    nav.append(button);
  }
  return instances;
}

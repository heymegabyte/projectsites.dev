import {
  animate,
  keyframes,
  query,
  stagger,
  state,
  style,
  transition,
  trigger,
  type AnimationTriggerMetadata,
} from '@angular/animations';

const DUR_XS = '120ms';
const DUR_SM = '180ms';
const DUR_MD = '260ms';
const DUR_LG = '420ms';

const EASE_DECEL = 'cubic-bezier(0, 0, 0.2, 1)';
const EASE_ACCEL = 'cubic-bezier(0.4, 0, 1, 1)';
const EASE_SPRING_SOFT = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * Center-anchored scale + fade. Modals, command palettes, popovers.
 */
export const scaleFade: AnimationTriggerMetadata = trigger('scaleFade', [
  transition(':enter', [
    style({ opacity: 0, transform: 'scale(0.94)' }),
    animate(`${DUR_MD} ${EASE_SPRING_SOFT}`, style({ opacity: 1, transform: 'scale(1)' })),
  ]),
  transition(':leave', [
    animate(`${DUR_XS} ${EASE_ACCEL}`, style({ opacity: 0, transform: 'scale(0.96)' })),
  ]),
]);

/**
 * Bottom-edge toast slide-up with scale settle.
 */
export const toastSlide: AnimationTriggerMetadata = trigger('toastSlide', [
  transition(':enter', [
    style({ opacity: 0, transform: 'translate3d(0, 16px, 0) scale(0.96)' }),
    animate(
      `${DUR_LG} ${EASE_SPRING_SOFT}`,
      style({ opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' })
    ),
  ]),
  transition(':leave', [
    animate(
      `${DUR_SM} ${EASE_ACCEL}`,
      style({ opacity: 0, transform: 'translate3d(0, 8px, 0) scale(0.98)' })
    ),
  ]),
]);

/**
 * List stagger. Apply on a container; queries `:enter` children and rises them in sequence.
 * Pair the items with `*ngFor`/`@for` so Angular triggers `:enter` per item.
 */
export const listStagger: AnimationTriggerMetadata = trigger('listStagger', [
  transition('* => *', [
    query(
      ':enter',
      [
        style({ opacity: 0, transform: 'translate3d(0, 14px, 0)' }),
        stagger(60, [
          animate(
            `${DUR_LG} ${EASE_SPRING_SOFT}`,
            style({ opacity: 1, transform: 'translate3d(0, 0, 0)' })
          ),
        ]),
      ],
      { optional: true }
    ),
  ]),
]);

// NOTE: route/page transitions are handled by the router's native View Transitions
// API (`withViewTransitions` in app.config.ts), not an Angular animation trigger —
// the previous `routeAnimations` trigger was dead (0 callers) and was removed.

/**
 * Pressed/loading/disabled button state machine.
 * Bind to `[@buttonState]` with a string state.
 */
export const buttonState: AnimationTriggerMetadata = trigger('buttonState', [
  state('idle', style({ transform: 'scale(1)' })),
  state('press', style({ transform: 'scale(0.97)' })),
  state('loading', style({ transform: 'scale(1)' })),
  state('success', style({ transform: 'scale(1.03)' })),
  state('disabled', style({ transform: 'scale(1)', opacity: 0.55 })),
  transition('* <=> press', animate(`${DUR_XS} ${EASE_DECEL}`)),
  transition('* => success', [
    animate(
      `${DUR_MD} ${EASE_SPRING_SOFT}`,
      keyframes([
        style({ transform: 'scale(1)', offset: 0 }),
        style({ transform: 'scale(1.06)', offset: 0.5 }),
        style({ transform: 'scale(1.02)', offset: 1 }),
      ])
    ),
  ]),
  transition('* <=> *', animate(`${DUR_SM} ${EASE_DECEL}`)),
]);

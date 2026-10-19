import type { OperationalEvent } from '@raibitserver/schemas/operational';
import { DiscordPolicyError } from './discord-alert-errors.ts';

export type NotificationTransition =
  | { readonly source: 'deployment'; readonly outcome: 'failed' | 'ready'; readonly terminal: boolean }
  | { readonly source: 'build'; readonly outcome: 'failed'; readonly retry: 'scheduled' | 'exhausted' }
  | { readonly source: 'runtime'; readonly outcome: 'unhealthy'; readonly previouslyReady: boolean; readonly consecutiveFailures: number; readonly observationGapSeconds: number }
  | { readonly source: 'runtime'; readonly outcome: 'recovered'; readonly incidentOpen: boolean; readonly verifiedHealthy: boolean }
  | { readonly source: 'backup'; readonly outcome: 'failed' | 'ready'; readonly terminal: boolean }
  | { readonly source: 'promotion'; readonly outcome: 'failed' | 'ready'; readonly terminal: boolean };

export function eventForNotificationTransition(transition: NotificationTransition): OperationalEvent | null {
  switch (transition.source) {
    case 'deployment': return transition.terminal ? `deployment.${transition.outcome}` : null;
    case 'build': return transition.retry === 'exhausted' ? 'deployment.failed' : null;
    case 'runtime':
      if (transition.outcome === 'unhealthy') {
        return transition.previouslyReady && transition.consecutiveFailures >= 2 && transition.observationGapSeconds >= 60 ? 'runtime.unhealthy' : null;
      }
      return transition.incidentOpen && transition.verifiedHealthy ? 'runtime.recovered' : null;
    case 'backup': return transition.terminal ? `backup.${transition.outcome}` : null;
    case 'promotion': return transition.terminal ? `promotion.${transition.outcome}` : null;
    default: return assertNever(transition);
  }
}

function assertNever(value: never): never {
  throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
}

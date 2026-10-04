import type { ComponentChildren } from 'preact';
import { IconEmpty } from './icons';

export interface EmptyStateProps {
  title: string;
  /** One or two sentences: what this means and what the user can do next. */
  message?: string;
  icon?: ComponentChildren;
  /** Usually a <Button>. */
  action?: ComponentChildren;
  testId?: string;
}

export function EmptyState({ title, message, icon, action, testId }: EmptyStateProps) {
  return (
    <div class="empty" data-testid={testId}>
      <div class="empty__icon">{icon ?? <IconEmpty size={40} />}</div>
      <h2 class="empty__title">{title}</h2>
      {message && <p class="empty__message">{message}</p>}
      {action && <div class="empty__action">{action}</div>}
    </div>
  );
}

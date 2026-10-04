import { me } from '../../auth';
import { t } from '../../i18n';
import { Link } from '../Link';

/** The fields of `my_context()` (docs/contracts/sync.md §2) the card reads. */
interface AccountSource {
  profile?: { full_name?: string | null } | null;
  roles?: ReadonlyArray<{ role?: string | null }> | null;
  assigned_roles?: ReadonlyArray<{ role?: string | null }> | null;
}

/** Highest role first. */
const ROLE_RANK = ['hq_admin', 'country_manager', 'branch_supervisor', 'field_collector', 'viewer'];

export interface AccountSummary {
  name: string;
  /** Role code of the highest effective role (or granted role awaiting MFA), null when none. */
  role: string | null;
  initial: string;
}

/** Name and role of the signed-in user — always from the server context, never hard-coded (brief §7.7). */
export function accountSummary(context: AccountSource | null | undefined): AccountSummary {
  const name = context?.profile?.full_name?.trim() ?? '';
  const granted = [...(context?.roles ?? []), ...(context?.assigned_roles ?? [])]
    .map((entry) => entry.role)
    .filter((role): role is string => typeof role === 'string');
  const role = ROLE_RANK.find((candidate) => granted.includes(candidate)) ?? granted[0] ?? null;
  return { name, role, initial: [...name][0] ?? '' };
}

export function roleLabel(role: string | null): string {
  return role && ROLE_RANK.includes(role) ? t(`common.role_${role}`) : t('common.role_none');
}

export function AccountCard({ onNavigate }: { onNavigate?: () => void }) {
  const summary = accountSummary(me.value as AccountSource | null);
  return (
    <Link
      href="/settings"
      class="account"
      testId="account-card"
      onClick={onNavigate}
      title={t('nav.account')}
    >
      <span class="account__avatar" aria-hidden="true">
        {summary.initial || '?'}
      </span>
      <span class="account__text">
        {/* dir="auto": an Arabic name keeps its own direction (and its ellipsis) in the LTR interface, and vice versa */}
        <strong class="account__name" data-testid="account-name" dir="auto">
          {summary.name || t('common.unnamedUser')}
        </strong>
        <span class="account__role" data-testid="account-role">
          {roleLabel(summary.role)}
        </span>
      </span>
    </Link>
  );
}

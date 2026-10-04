/**
 * Users (brief §2.6, §3): every account the caller administers with its roles, scopes, last
 * sign-in and devices. Head office: assign / remove roles, (de)activate, create accounts,
 * restore devices. Head office and country managers: revoke all sessions of a user or one
 * lost device — immediately, refresh tokens included (through the `admin` Edge Function).
 *
 * Guard rails shown before the server refuses: the last head-office administrator cannot
 * lose the role or be deactivated, and nobody deactivates their own account.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { me } from '../auth';
import { db } from '../db';
import { fmt, t } from '../i18n';
import { norm } from '../lib/normalize';
import { navigate } from '../routes';
import {
  Badge,
  Button,
  confirm,
  EmptyState,
  IconPlus,
  IconUsers,
  Select,
  toast,
  useDebounced,
  useLiveQuery,
  VirtualList,
} from '../ui';
import {
  listUsers,
  refreshOwnContext,
  removeRole,
  restoreDevice,
  revokeSessions,
  setUserActive,
} from './api';
import { CreateUserDialog } from './CreateUserDialog';
import { adminErrorKey } from './errors';
import { deviceName, grantScopeName, roleLabel } from './labels';
import { RoleDialog, type ScopeChoices } from './RoleDialog';
import { deactivateBlock, isLastHqGrant, roleNeedsMfa, sortedRoles } from './roles';
import { Ltr, ResourceState, useResource, When } from './shared';
import {
  ROLE_NAMES,
  type AdminDevice,
  type AdminRole,
  type AdminUser,
  type AuthLogoutOutcome,
} from './types';

const ROW_HEIGHT = 84;

type StatusFilter = '' | 'active' | 'inactive' | 'revoked';

export interface UserFilter {
  q: string;
  role: string;
  status: StatusFilter;
}

/** Local filter over the complete list (≤ a few thousand accounts). */
export function filterUsers(users: readonly AdminUser[], filter: UserFilter): AdminUser[] {
  const q = norm(filter.q);
  const digits = filter.q.replace(/\D/g, '');
  return users.filter((u) => {
    if (filter.role && !u.roles.some((r) => r.role === filter.role)) return false;
    if (filter.status === 'active' && !u.active) return false;
    if (filter.status === 'inactive' && u.active) return false;
    if (filter.status === 'revoked' && !u.devices.some((d) => d.revoked_at)) return false;
    if (!q) return true;
    if (norm(u.full_name ?? '').includes(q)) return true;
    if ((u.email ?? '').toLowerCase().includes(filter.q.trim().toLowerCase())) return true;
    return digits.length >= 3 && (u.phone ?? '').replace(/\D/g, '').includes(digits);
  });
}

function displayName(user: Pick<AdminUser, 'full_name' | 'email' | 'phone'>): string {
  return user.full_name?.trim() || user.email || user.phone || t('admin.unnamedUser');
}

/** Scope choices for the role dialogs: the synced countries and branches of this device. */
function useScopeChoices(): ScopeChoices {
  const countries = useLiveQuery(() => db.countries.toArray(), [], []);
  const branches = useLiveQuery(() => db.branches.toArray(), [], []);
  return useMemo(
    () => ({ countries: countries ?? [], branches: branches ?? [] }),
    [countries, branches],
  );
}

export function UsersPanel({ hq, selectedId }: { hq: boolean; selectedId: string | null }) {
  const users = useResource(listUsers);
  const [filter, setFilter] = useState<UserFilter>({ q: '', role: '', status: '' });
  const debouncedQ = useDebounced(filter.q, 250);
  const [creating, setCreating] = useState(false);
  const choices = useScopeChoices();
  const myId = me.value?.user_id ?? null;

  return (
    <section class="adm-panel" aria-labelledby="adm-users-title" data-testid="admin-users">
      <div class="adm-panel__head">
        <h2 id="adm-users-title">{t('admin.usersTitle')}</h2>
        {hq && (
          <Button
            variant="gold"
            icon={<IconPlus size={18} />}
            testId="admin-user-create"
            onClick={() => setCreating(true)}
          >
            {t('admin.newUser')}
          </Button>
        )}
      </div>
      <ResourceState resource={users} testId="admin-users">
        {(all) => {
          const selected = selectedId ? (all.find((u) => u.id === selectedId) ?? null) : null;
          const visible = filterUsers(all, { ...filter, q: debouncedQ });
          return (
            <div class={selectedId ? 'adm-split adm-split--detail' : 'adm-split'}>
              <div class="adm-split__list">
                <div class="adm-toolbar">
                  <input
                    type="search"
                    class="control"
                    data-testid="admin-users-search"
                    aria-label={t('admin.searchUsers')}
                    placeholder={t('admin.searchUsers')}
                    value={filter.q}
                    onInput={(e) => setFilter((f) => ({ ...f, q: e.currentTarget.value }))}
                  />
                  <Select
                    testId="admin-users-role"
                    aria-label={t('admin.filterRole')}
                    value={filter.role}
                    placeholder={t('admin.allRoles')}
                    options={ROLE_NAMES.map((r) => ({ value: r, label: roleLabel(r) }))}
                    onChange={(role) => setFilter((f) => ({ ...f, role }))}
                  />
                  <Select
                    testId="admin-users-status"
                    aria-label={t('admin.filterStatus')}
                    value={filter.status}
                    placeholder={t('admin.allStatuses')}
                    options={[
                      { value: 'active', label: t('admin.statusActive') },
                      { value: 'inactive', label: t('admin.statusInactive') },
                      { value: 'revoked', label: t('admin.statusRevokedDevice') },
                    ]}
                    onChange={(status) =>
                      setFilter((f) => ({ ...f, status: status as StatusFilter }))
                    }
                  />
                </div>
                <p class="adm-count" role="status" data-testid="admin-users-count">
                  {t('admin.usersCount', {
                    shown: fmt.number(visible.length),
                    total: fmt.number(all.length),
                  })}
                </p>
                {visible.length === 0 ? (
                  <EmptyState
                    icon={<IconUsers size={40} />}
                    title={t('admin.noUsers')}
                    testId="admin-users-empty"
                  />
                ) : (
                  <VirtualList
                    class="adm-users-list"
                    testId="admin-users-list"
                    label={t('admin.usersTitle')}
                    items={visible}
                    rowHeight={ROW_HEIGHT}
                    rowKey={(u) => u.id}
                    onActivate={(index) => {
                      const u = visible[index];
                      if (u) navigate(`/admin/users/${u.id}`);
                    }}
                    renderRow={(u) => <UserRow user={u} selected={u.id === selectedId} />}
                  />
                )}
              </div>
              {selectedId && (
                <div class="adm-split__detail">
                  {selected ? (
                    <UserDetail
                      key={selected.id}
                      user={selected}
                      all={all}
                      hq={hq}
                      myId={myId}
                      choices={choices}
                      onChanged={() => void users.reload()}
                    />
                  ) : (
                    <EmptyState
                      testId="admin-user-missing"
                      title={t('admin.userMissing')}
                      action={
                        <Button testId="admin-user-back" onClick={() => navigate('/admin/users')}>
                          {t('admin.backToUsers')}
                        </Button>
                      }
                    />
                  )}
                </div>
              )}
            </div>
          );
        }}
      </ResourceState>
      {creating && users.data && (
        <CreateUserDialog
          users={users.data}
          choices={choices}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void users.reload().then(() => navigate(`/admin/users/${id}`));
          }}
        />
      )}
    </section>
  );
}

function UserRow({ user, selected }: { user: AdminUser; selected: boolean }) {
  const roles = sortedRoles(user.roles);
  const revoked = user.devices.filter((d) => d.revoked_at).length;
  return (
    <div
      class={selected ? 'adm-user-row adm-user-row--selected' : 'adm-user-row'}
      data-testid="admin-user-row"
      data-user-id={user.id}
      data-email={user.email ?? ''}
      aria-current={selected ? 'true' : undefined}
    >
      <div class="adm-user-row__main">
        <span class="adm-user-row__name">{displayName(user)}</span>
        <span class="adm-user-row__sub">
          {user.email ? <Ltr>{user.email}</Ltr> : user.phone ? <Ltr>{user.phone}</Ltr> : null}
        </span>
        <span class="adm-user-row__roles">
          {roles.length === 0 ? (
            <span class="muted">{t('admin.noRoles')}</span>
          ) : (
            roles.slice(0, 2).map((r) => (
              <span key={r.id} class="adm-chip">
                {roleLabel(r.role)} · {grantScopeName(r)}
              </span>
            ))
          )}
          {roles.length > 2 && (
            <span class="muted">{t('admin.moreRoles', { count: roles.length - 2 })}</span>
          )}
        </span>
      </div>
      <div class="adm-user-row__side">
        {!user.active && <Badge tone="danger">{t('admin.statusInactive')}</Badge>}
        {revoked > 0 && (
          <Badge tone="warning">{t('admin.revokedDevices', { count: revoked })}</Badge>
        )}
        <span class="adm-user-row__seen">
          {t('admin.lastSignIn')}: <When at={user.last_sign_in_at} />
        </span>
      </div>
    </div>
  );
}

function logoutWarning(outcome: AuthLogoutOutcome | undefined): void {
  if (outcome && !outcome.done) toast(t('admin.refreshNotRevoked'), 'error');
}

function UserDetail({
  user,
  all,
  hq,
  myId,
  choices,
  onChanged,
}: {
  user: AdminUser;
  all: readonly AdminUser[];
  hq: boolean;
  myId: string | null;
  choices: ScopeChoices;
  onChanged: () => void;
}) {
  const [busy, setBusyState] = useState<string | null>(null);
  // The guard reads a ref: a handler created before the previous action finished (e.g. one
  // waiting on a confirmation) must see the current state, not the one of its render.
  const busyRef = useRef<string | null>(null);
  const setBusy = (value: string | null): void => {
    busyRef.current = value;
    setBusyState(value);
  };
  const [addingRole, setAddingRole] = useState(false);
  const self = user.id === myId;
  const block = deactivateBlock(user, myId, all);
  const devices = [...user.devices].sort((a, b) =>
    (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''),
  );
  const name = displayName(user);

  const act = async (key: string, run: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    setBusy(key);
    try {
      await run();
      if (self) refreshOwnContext();
      onChanged();
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
    }
  };

  const onRevokeAll = (): void => {
    void (async () => {
      const ok = await confirm({
        title: t('admin.revokeAllTitle'),
        message: t('admin.revokeAllBody', { name }),
        confirmLabel: t('admin.revokeAll'),
        danger: true,
      });
      if (!ok) return;
      await act('revoke', async () => {
        const result = await revokeSessions(user.id);
        toast(t('admin.revokedAll'), 'success');
        logoutWarning(result.auth_logout);
      });
    })();
  };

  const onRevokeDevice = (device: AdminDevice): void => {
    void (async () => {
      const ok = await confirm({
        title: t('admin.revokeDeviceTitle'),
        message: t('admin.revokeDeviceBody', { device: deviceName(device), name }),
        confirmLabel: t('admin.revokeDevice'),
        danger: true,
      });
      if (!ok) return;
      await act(`device:${device.device_id}`, async () => {
        const result = await revokeSessions(user.id, device.device_id);
        toast(t('admin.revokedDevice'), 'success');
        logoutWarning(result.auth_logout);
      });
    })();
  };

  const onRestoreDevice = (device: AdminDevice): void => {
    void act(`restore:${device.device_id}`, async () => {
      await restoreDevice(user.id, device.device_id);
      toast(t('admin.restoredDevice'), 'success');
    });
  };

  const onSetActive = (active: boolean): void => {
    void (async () => {
      if (!active) {
        const ok = await confirm({
          title: t('admin.deactivateTitle'),
          message: t('admin.deactivateBody', { name }),
          confirmLabel: t('admin.deactivate'),
          danger: true,
        });
        if (!ok) return;
      }
      await act('active', async () => {
        const result = await setUserActive(user.id, active);
        toast(active ? t('admin.activated') : t('admin.deactivated'), 'success');
        logoutWarning(result.auth_logout);
        if (result.auth_ban && !result.auth_ban.done) toast(t('admin.banNotUpdated'), 'error');
      });
    })();
  };

  const onRemoveRole = (grant: AdminRole): void => {
    void (async () => {
      const ownHq = self && grant.role === 'hq_admin';
      const ok = await confirm({
        title: t('admin.removeRoleTitle'),
        message: ownHq
          ? t('admin.removeOwnHqBody')
          : t('admin.removeRoleBody', {
              role: roleLabel(grant.role),
              scope: grantScopeName(grant),
              name,
            }),
        confirmLabel: t('admin.removeRole'),
        danger: true,
      });
      if (!ok) return;
      await act(`role:${grant.id}`, async () => {
        await removeRole(grant.id);
        toast(t('admin.roleRemoved'), 'success');
      });
    })();
  };

  return (
    <article
      class="adm-detail card"
      data-testid="admin-user-detail"
      data-user-id={user.id}
      aria-labelledby="adm-user-name"
    >
      <div class="adm-detail__head">
        <Button
          variant="ghost"
          size="sm"
          testId="admin-user-close"
          onClick={() => navigate('/admin/users')}
        >
          {t('admin.backToUsers')}
        </Button>
        <h3 id="adm-user-name">{name}</h3>
        <div class="row">
          {user.active ? (
            <Badge tone="success" testId="admin-user-status">
              {t('admin.statusActive')}
            </Badge>
          ) : (
            <Badge tone="danger" testId="admin-user-status">
              {t('admin.statusInactive')}
            </Badge>
          )}
          {self && <Badge tone="info">{t('admin.you')}</Badge>}
        </div>
      </div>

      <dl class="kv adm-kv">
        <dt>{t('admin.fieldEmail')}</dt>
        <dd>{user.email ? <Ltr>{user.email}</Ltr> : <span class="muted">—</span>}</dd>
        <dt>{t('admin.fieldPhone')}</dt>
        <dd>{user.phone ? <Ltr>{user.phone}</Ltr> : <span class="muted">—</span>}</dd>
        <dt>{t('admin.fieldLanguage')}</dt>
        <dd>{user.preferred_language ? t(`admin.lang_${user.preferred_language}`) : '—'}</dd>
        <dt>{t('admin.lastSignIn')}</dt>
        <dd>
          <When at={user.last_sign_in_at} />
        </dd>
        <dt>{t('admin.createdAt')}</dt>
        <dd>{fmt.date(user.created_at)}</dd>
        {user.sessions_revoked_at && (
          <>
            <dt>{t('admin.sessionsRevokedAt')}</dt>
            <dd data-testid="admin-user-revoked-at">
              <When at={user.sessions_revoked_at} />
            </dd>
          </>
        )}
      </dl>

      <section class="adm-sub" aria-labelledby="adm-user-roles">
        <div class="adm-sub__head">
          <h4 id="adm-user-roles">{t('admin.rolesTitle')}</h4>
          {hq && (
            <Button
              size="sm"
              icon={<IconPlus size={16} />}
              testId="admin-user-add-role"
              onClick={() => setAddingRole(true)}
            >
              {t('admin.addRole')}
            </Button>
          )}
        </div>
        {user.roles.length === 0 ? (
          <p class="muted" data-testid="admin-user-no-roles">
            {t('admin.noRolesLong')}
          </p>
        ) : (
          <ul class="adm-list" data-testid="admin-user-roles">
            {sortedRoles(user.roles).map((grant) => {
              const last = isLastHqGrant(user, grant, all);
              return (
                <li
                  key={grant.id}
                  class="adm-list__item"
                  data-testid="admin-role-item"
                  data-role={grant.role}
                  data-role-id={grant.id}
                >
                  <div>
                    <strong>{roleLabel(grant.role)}</strong>
                    <span class="muted"> · {grantScopeName(grant)}</span>
                    {roleNeedsMfa(grant.role) && <span class="adm-tag">{t('admin.needsMfa')}</span>}
                    {last && (
                      <p class="adm-guard" data-testid="admin-guard-last-hq">
                        {t('admin.guardLastHqRole')}
                      </p>
                    )}
                  </div>
                  {hq && (
                    <Button
                      size="sm"
                      variant="ghost"
                      testId="admin-role-remove"
                      data-role-id={grant.id}
                      disabled={last}
                      busy={busy === `role:${grant.id}`}
                      aria-label={t('admin.removeRoleNamed', {
                        role: roleLabel(grant.role),
                        scope: grantScopeName(grant),
                      })}
                      onClick={() => onRemoveRole(grant)}
                    >
                      {t('admin.removeRole')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="adm-sub" aria-labelledby="adm-user-access">
        <h4 id="adm-user-access">{t('admin.accessTitle')}</h4>
        <p class="adm-note">{t('admin.revokeExplain')}</p>
        <div class="row">
          <Button
            variant="danger"
            testId="admin-user-revoke"
            busy={busy === 'revoke'}
            onClick={onRevokeAll}
          >
            {t('admin.revokeAll')}
          </Button>
          {hq &&
            (user.active ? (
              <Button
                testId="admin-user-deactivate"
                disabled={block !== null}
                busy={busy === 'active'}
                onClick={() => onSetActive(false)}
              >
                {t('admin.deactivate')}
              </Button>
            ) : (
              <Button
                testId="admin-user-activate"
                busy={busy === 'active'}
                onClick={() => onSetActive(true)}
              >
                {t('admin.activate')}
              </Button>
            ))}
        </div>
        {hq && user.active && block === 'self' && (
          <p class="adm-guard" data-testid="admin-guard-self">
            {t('admin.guardSelf')}
          </p>
        )}
        {hq && user.active && block === 'last_hq' && (
          <p class="adm-guard" data-testid="admin-guard-last-hq-user">
            {t('admin.guardLastHqUser')}
          </p>
        )}
      </section>

      <section class="adm-sub" aria-labelledby="adm-user-devices">
        <h4 id="adm-user-devices">{t('admin.devicesTitle', { count: devices.length })}</h4>
        {devices.length === 0 ? (
          <p class="muted">{t('admin.noDevices')}</p>
        ) : (
          <ul class="adm-list adm-devices" data-testid="admin-user-devices">
            {devices.map((device) => (
              <li
                key={device.id}
                class="adm-list__item"
                data-testid="admin-device-row"
                data-device-id={device.device_id}
              >
                <div class="adm-device">
                  <strong>{deviceName(device)}</strong>
                  {device.revoked_at && (
                    <Badge tone="danger" testId="admin-device-revoked">
                      {t('admin.deviceRevoked')}
                    </Badge>
                  )}
                  <span class="adm-device__meta">
                    {t('admin.appVersion')}: <Ltr>{device.app_version ?? '—'}</Ltr>
                    {' · '}
                    {t('admin.lastSeen')}: <When at={device.last_seen_at} />
                    {' · '}
                    {t('admin.pendingShort', {
                      ops: device.pending_ops,
                      photos: device.pending_photos,
                    })}
                  </span>
                  <span class="adm-device__id">
                    <Ltr>{device.device_id}</Ltr>
                  </span>
                </div>
                <div class="row">
                  {device.revoked_at ? (
                    hq && (
                      <Button
                        size="sm"
                        testId="admin-device-restore"
                        busy={busy === `restore:${device.device_id}`}
                        onClick={() => onRestoreDevice(device)}
                      >
                        {t('admin.restoreDevice')}
                      </Button>
                    )
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      testId="admin-device-revoke"
                      busy={busy === `device:${device.device_id}`}
                      onClick={() => onRevokeDevice(device)}
                    >
                      {t('admin.revokeDevice')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {addingRole && (
        <RoleDialog
          user={user}
          choices={choices}
          myUserId={myId}
          onClose={() => setAddingRole(false)}
          onSaved={() => {
            setAddingRole(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

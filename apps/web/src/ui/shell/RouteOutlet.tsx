import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { applyPendingScroll, navigate, type RouteDef, type RouteMatch } from '../../routes';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { IconAlert } from '../icons';
import { captureError } from '../monitoring';
import { Spinner } from '../Spinner';

type Loader = RouteDef['load'];

/** Views already downloaded: revisiting a page renders at once, online or offline. */
const loaded = new Map<Loader, ComponentType>();
const loaderIds = new Map<Loader, number>();

function loaderId(load: Loader): number {
  let id = loaderIds.get(load);
  if (id === undefined) {
    id = loaderIds.size + 1;
    loaderIds.set(load, id);
  }
  return id;
}

/**
 * Identity of the mounted view: another project id remounts the page; an `/admin/*`
 * sub-path, or two paths served by the same loader (`/` and `/map`), do not.
 */
export function viewKey(match: RouteMatch): string {
  if (!match.route) return 'not-found';
  const named = Object.entries(match.params).filter(([name]) => name !== '*');
  return `${loaderId(match.route.load)}|${JSON.stringify(named)}`;
}

function LazyView({ match, route }: { match: RouteMatch; route: RouteDef }) {
  const [, setLoadedTick] = useState(0);
  const [failed, setFailed] = useState<{ load: Loader } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const View = loaded.get(route.load);

  useEffect(() => {
    if (loaded.has(route.load)) return;
    let alive = true;
    route
      .load()
      .then((module) => {
        loaded.set(route.load, module.default);
        if (alive) setLoadedTick((n) => n + 1);
      })
      .catch((error: unknown) => {
        // Usually a chunk that is not on the device yet while offline.
        captureError(error);
        if (alive) setFailed({ load: route.load });
      });
    return () => {
      alive = false;
    };
  }, [route.load, attempt]);

  // New page: start at the top. Back / forward: return to where the user was.
  useEffect(() => {
    if (View) applyPendingScroll();
  }, [View, match.path]);

  if (View) return <View key={viewKey(match)} />;
  if (failed?.load === route.load) {
    return (
      <EmptyState
        testId="route-error"
        icon={<IconAlert size={40} />}
        title={t('common.pageLoadErrorTitle')}
        message={t('common.pageLoadErrorBody')}
        action={
          <Button
            variant="primary"
            testId="route-retry"
            onClick={() => {
              setFailed(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        }
      />
    );
  }
  return <Spinner block />;
}

export function NotFound() {
  return (
    <EmptyState
      testId="not-found"
      title={t('common.notFoundTitle')}
      message={t('common.notFoundBody')}
      action={
        <Button variant="primary" onClick={() => navigate('/map')}>
          {t('common.goHome')}
        </Button>
      }
    />
  );
}

/** Renders the lazy view of the current route, a loading state, a retry screen or the 404 view. */
export function RouteOutlet({ match }: { match: RouteMatch }) {
  if (!match.route) return <NotFound />;
  return <LazyView match={match} route={match.route} />;
}

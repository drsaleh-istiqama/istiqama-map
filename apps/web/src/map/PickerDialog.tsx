/**
 * Pick mode (docs/V2_PARITY.md 1.8): a full-screen map on which the user taps the location,
 * sees its coordinates, then chooses "confirm and return" or "return without change".
 *
 * Keyboard and screen-reader users can move the map with the arrow keys and choose its centre
 * ("use the map centre"). Esc never throws a chosen point away silently: it asks first.
 *
 * Pick mode lives on <body>, above the route: it closes as "return without change" (the form
 * keeps its point) when the route changes underneath it (browser Back, a link) or the app
 * locks with the PIN, so it can never outlive the form that opened it.
 */
import { render } from 'preact';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pin } from '../auth';
import { t } from '../i18n';
import type { LonLat } from '../lib/geo';
import { currentRoute } from '../routes';
import { Button, confirm, useFocusTrap } from '../ui';
import MapView, { type MapViewApi } from './MapView';
import { createPickSession, formatCoordinates, type PickResult } from './pick';
import { PROJECT_ZOOM } from './config';
import { IconPin } from './icons';

interface PickerProps {
  initial: LonLat | null;
  onDone: (result: PickResult | null) => void;
}

const NO_FILTER = {};

function PickerDialog({ initial, onDone }: PickerProps) {
  const session = useMemo(() => createPickSession(initial), []);
  /** The page pick mode was opened from. */
  const openedOn = useMemo(() => currentRoute.peek().path, []);
  const [selected, setSelected] = useState<LonLat | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const api = useRef<MapViewApi | null>(null);
  const asking = useRef(false);
  /** onDone ran: every later button press, key or route change is ignored. */
  const done = useRef(false);
  const titleId = useId();
  const statusId = useId();
  useFocusTrap(dialog, true);

  const finish = (result: PickResult | null): void => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };

  /** "Return without change": the form keeps the point it had. */
  const cancel = (): void => {
    if (done.current) return;
    session.cancel();
    finish(null);
  };

  const leave = async (askFirst: boolean): Promise<void> => {
    if (done.current || asking.current) return;
    if (askFirst && session.changed()) {
      asking.current = true;
      try {
        const discard = await confirm({
          title: t('map.pickDiscardTitle'),
          message: t('map.pickDiscardBody'),
          confirmLabel: t('map.pickDiscard'),
          cancelLabel: t('map.pickKeepChoosing'),
        });
        if (!discard) return;
      } finally {
        asking.current = false;
      }
    }
    cancel();
  };

  // Layout effect: Esc, Back and the lock work from the very first frame.
  useLayoutEffect(() => {
    document.documentElement.classList.add('has-modal');
    const onKey = (event: KeyboardEvent): void => {
      // While the confirmation is open, Esc belongs to it.
      if (event.key !== 'Escape' || asking.current) return;
      event.preventDefault();
      void leave(true);
    };
    document.addEventListener('keydown', onKey);
    // The page under pick mode changed (browser Back, a link) or the app locked: close
    // (in a microtask — never unmount from inside a signal callback of this render).
    const stopRoute = currentRoute.subscribe((route) => {
      if (route.path !== openedOn) queueMicrotask(cancel);
    });
    const stopLock = pin.locked.subscribe((locked) => {
      if (locked) queueMicrotask(cancel);
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      stopRoute();
      stopLock();
      document.documentElement.classList.remove('has-modal');
    };
  }, []);

  const choose = (p: LonLat): void => {
    try {
      setSelected(session.choose(p));
    } catch {
      // A tap outside valid coordinates (antimeridian wrap) is ignored.
    }
  };

  const shown = selected ?? session.original;

  return (
    <div
      ref={dialog}
      class="picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={statusId}
      data-testid="map-pick"
    >
      <div class="picker__bar">
        <div class="picker__text">
          <strong id={titleId}>{t('map.pickTitle')}</strong>
          <span id={statusId} role="status" data-testid="map-pick-coords">
            {selected ? (
              <>
                {t('map.pickChosen')}{' '}
                <bdi dir="ltr" class="ltr">
                  {formatCoordinates(selected)}
                </bdi>
              </>
            ) : session.original ? (
              <>
                {t('map.pickCurrent')}{' '}
                <bdi dir="ltr" class="ltr">
                  {formatCoordinates(session.original)}
                </bdi>{' '}
                — {t('map.pickHint')}
              </>
            ) : (
              t('map.pickHint')
            )}
          </span>
        </div>
        <div class="picker__actions">
          <Button
            variant="gold"
            disabled={!selected}
            testId="map-pick-confirm"
            onClick={() => finish(session.confirm())}
          >
            {t('map.pickConfirm')}
          </Button>
          <Button testId="map-pick-cancel" onClick={() => void leave(false)}>
            {t('map.pickCancel')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconPin size={18} />}
            testId="map-pick-center"
            onClick={() => api.current && choose(api.current.center())}
          >
            {t('map.pickUseCenter')}
          </Button>
        </div>
      </div>
      <div class="picker__map">
        <MapView
          mode="pick"
          filter={NO_FILTER}
          onPick={choose}
          pickPoint={shown}
          apiRef={api}
          register={false}
          rememberCamera={false}
          testId="map-pick-view"
          {...(session.original
            ? { initialView: { center: session.original, zoom: PROJECT_ZOOM } }
            : {})}
        />
        <span class="picker__crosshair" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Opens pick mode; resolves with the confirmed point, or null for "return without change". */
export function openPicker(initial: LonLat | null): Promise<PickResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.dataset.mapHost = 'picker';
    document.body.appendChild(host);
    let done = false;
    const onDone = (result: PickResult | null): void => {
      if (done) return;
      done = true;
      render(null, host);
      host.remove();
      resolve(result);
    };
    render(<PickerDialog initial={initial} onDone={onDone} />, host);
  });
}

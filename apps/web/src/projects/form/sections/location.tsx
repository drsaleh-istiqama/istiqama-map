/**
 * Step 3 (brief §7.1): the location — GPS capture with the accuracy in metres and a warning
 * above `gps.accuracy_warn_m` (default 30 m), or a point picked on the map, or typed
 * coordinates. The country and area are then filled from the point (ProjectForm runs it).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt, t } from '../../../i18n';
import { Button, IconAlert, toast } from '../../../ui';
import { enumLabel } from '../../labels';
import { useForm } from '../context';
import { NumberInput } from '../controls';
import { loadPickLocation } from '../peers';
import { fieldId } from '../validate';

/** Stop improving the fix once it is this good, or after this long. */
const GOOD_ENOUGH_M = 10;
const WATCH_MS = 25_000;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

type GpsState = 'idle' | 'acquiring' | 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export function useGps(onFix: (fix: { lon: number; lat: number; accuracy: number }) => void) {
  const [state, setState] = useState<GpsState>('idle');
  const watch = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const best = useRef<number>(Infinity);
  const latest = useRef(onFix);
  latest.current = onFix;

  const stop = (): void => {
    if (watch.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watch.current);
    }
    watch.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState((s) => (s === 'acquiring' ? 'idle' : s));
  };

  const start = (): void => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('unsupported');
      return;
    }
    stop();
    best.current = Infinity;
    setState('acquiring');
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        const accuracy = Math.max(0, Math.round(pos.coords.accuracy));
        if (accuracy > best.current) return; // keep the better fix
        best.current = accuracy;
        latest.current({
          lon: round6(pos.coords.longitude),
          lat: round6(pos.coords.latitude),
          accuracy,
        });
        if (accuracy <= GOOD_ENOUGH_M) stop();
      },
      (err) => {
        const next: GpsState =
          err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
        if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
        watch.current = null;
        if (timer.current) clearTimeout(timer.current);
        // A timeout after a usable fix is not an error.
        setState(next === 'timeout' && best.current < Infinity ? 'idle' : next);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: WATCH_MS },
    );
    timer.current = setTimeout(stop, WATCH_MS);
  };

  useEffect(() => stop, []);
  return { state, start, stop };
}

const GPS_MESSAGES: Partial<Record<GpsState, string>> = {
  denied: 'form.gpsDenied',
  unavailable: 'form.gpsUnavailable',
  timeout: 'form.gpsTimeout',
  unsupported: 'form.gpsUnsupported',
};

export function LocationSection() {
  const { draft, api, errors, env } = useForm();
  const p = draft.working.project;
  const [picking, setPicking] = useState(false);
  const gps = useGps((fix) => {
    api.setProject({
      lon: fix.lon,
      lat: fix.lat,
      gps_accuracy_m: fix.accuracy,
      location_source: 'gps',
    });
    api.clearError('location');
  });

  const pickOnMap = async (): Promise<void> => {
    setPicking(true);
    try {
      const pick = await loadPickLocation();
      if (!pick) {
        toast(t('form.mapUnavailable'), 'error');
        return;
      }
      const initial =
        typeof p.lon === 'number' && typeof p.lat === 'number' ? { lon: p.lon, lat: p.lat } : null;
      const chosen = await pick(initial);
      if (chosen) {
        gps.stop();
        api.setProject({
          lon: round6(chosen.lon),
          lat: round6(chosen.lat),
          gps_accuracy_m: null,
          location_source: 'map',
        });
        api.clearError('location');
      }
    } finally {
      setPicking(false);
    }
  };

  const setCoord = (axis: 'lon' | 'lat', v: number | null): void => {
    gps.stop();
    api.setProject({ [axis]: v, gps_accuracy_m: null, location_source: 'map' });
    api.clearError('location');
  };

  const accuracy = p.gps_accuracy_m;
  const weak = typeof accuracy === 'number' && accuracy > env.accuracyWarnM;
  const error = errors.location;
  const errorId = `${fieldId('location')}-error`;
  const gpsMessage = GPS_MESSAGES[gps.state];

  return (
    <fieldset
      class={error ? 'pf-step pf-location field--invalid' : 'pf-step pf-location'}
      id={fieldId('location')}
      aria-describedby={error ? errorId : undefined}
    >
      <legend class="field__label">
        {t('form.location')}
        <span class="field__required" aria-hidden="true">
          *
        </span>
        <span class="sr-only"> ({t('ui.required')})</span>
      </legend>
      <p class="field__hint">{t('form.locationHint')}</p>
      <div class="pf-location__actions">
        <Button
          variant="primary"
          testId="form-gps"
          busy={gps.state === 'acquiring'}
          onClick={() => gps.start()}
        >
          {gps.state === 'acquiring' ? t('form.gpsAcquiring') : t('form.gpsCapture')}
        </Button>
        {gps.state === 'acquiring' && (
          <Button variant="ghost" testId="form-gps-stop" onClick={() => gps.stop()}>
            {t('form.gpsStop')}
          </Button>
        )}
        <Button testId="form-pick-map" busy={picking} onClick={() => void pickOnMap()}>
          {t('form.pickOnMap')}
        </Button>
      </div>

      {gpsMessage && (
        <p class="pf-note pf-note--error" role="alert" data-testid="form-gps-error">
          {t(gpsMessage)}
        </p>
      )}

      {typeof accuracy === 'number' && (
        <p
          class={weak ? 'pf-accuracy pf-accuracy--weak' : 'pf-accuracy'}
          data-testid="form-gps-accuracy"
          data-warn={weak ? 'true' : 'false'}
          role={weak ? 'alert' : 'status'}
        >
          {weak && <IconAlert size={18} />}
          <span>
            {t('form.gpsAccuracy', { m: fmt.number(accuracy) })}
            {weak && ` — ${t('form.gpsWeak', { limit: fmt.number(env.accuracyWarnM) })}`}
          </span>
        </p>
      )}

      <div class="pf-coords">
        <label class="pf-coords__item">
          <span class="field__label">{t('form.lat')}</span>
          <NumberInput
            id={fieldId('lat')}
            decimal
            value={p.lat}
            testId="form-lat"
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? 'true' : undefined}
            onValue={(v) => setCoord('lat', v)}
          />
        </label>
        <label class="pf-coords__item">
          <span class="field__label">{t('form.lon')}</span>
          <NumberInput
            id={fieldId('lon')}
            decimal
            value={p.lon}
            testId="form-lon"
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? 'true' : undefined}
            onValue={(v) => setCoord('lon', v)}
          />
        </label>
      </div>
      {p.location_source && typeof p.lon === 'number' && (
        <p class="muted pf-source" data-testid="form-location-source">
          {t('form.locationSource', { source: enumLabel('location_source', p.location_source) })}
        </p>
      )}
      {error && (
        <p class="field__error" id={errorId} role="alert">
          {t(error)}
        </p>
      )}
    </fieldset>
  );
}

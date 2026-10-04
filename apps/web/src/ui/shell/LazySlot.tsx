/**
 * Mounts a component of another feature module that the shell shows on every screen (the
 * notifications bell, the v2 migration prompt, …) without putting that module into the
 * initial bundle: the chunk is loaded after the first render (it is precached, so this also
 * works offline). Until it is there — or when it cannot be loaded or throws while rendering —
 * the `fallback` is shown and the rest of the app keeps working.
 */
import { Component, type ComponentChildren, type ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** Resolves to the component, or to null when the module does not provide one (yet). */
export type ComponentLoader<P extends object = Record<string, never>> = () => Promise<
  ComponentType<P> | null | undefined
>;

/** Components already loaded, by loader: a remount (sign-out → sign-in, route) does not flash. */
const loaded = new WeakMap<ComponentLoader<never>, ComponentType<never>>();

interface GuardProps {
  fallback: ComponentChildren;
  children: ComponentChildren;
}

/** Error boundary: a failing integrated component never takes the shell down with it. */
class Guard extends Component<GuardProps, { failed: boolean }> {
  override state = { failed: false };

  static override getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('[shell] an integrated component failed to render', error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface LazySlotProps<P extends object> {
  load: ComponentLoader<P>;
  /** Props for the loaded component. */
  props?: P;
  /** Shown while loading, when nothing could be loaded and after a render error. */
  fallback?: ComponentChildren;
}

export function LazySlot<P extends object>({ load, props, fallback = null }: LazySlotProps<P>) {
  const [Loaded, setLoaded] = useState<ComponentType<P> | null>(
    () => (loaded.get(load as ComponentLoader<never>) as ComponentType<P> | undefined) ?? null,
  );

  useEffect(() => {
    if (Loaded) return;
    let alive = true;
    load().then(
      (component) => {
        if (!component) return;
        loaded.set(load as ComponentLoader<never>, component as ComponentType<never>);
        if (alive) setLoaded(() => component);
      },
      (error: unknown) => console.warn('[shell] could not load an integrated component', error),
    );
    return () => {
      alive = false;
    };
  }, [load]);

  if (!Loaded) return <>{fallback}</>;
  return (
    <Guard fallback={fallback}>
      <Loaded {...((props ?? {}) as P)} />
    </Guard>
  );
}

import { useLayoutEffect } from 'react';
import { signal, useSignal } from './store';

// Hash routes (#/history/abc), so the app works from any folder on any static
// host. Each history entry carries an index: it tells "back" from "forward"
// and is the key under which the scroll position is remembered.

interface Location {
  path: string;
  index: number;
  /** True when this entry was reached with the browser's back/forward. */
  restored: boolean;
}

const pathFromHash = () => window.location.hash.replace(/^#/, '') || '/';
const indexOf = (state: unknown): number | null => {
  const index = (state as { index?: unknown } | null)?.index;
  return typeof index === 'number' ? index : null;
};

// The entry the app was opened on gets an index too (a reload keeps the one it had).
if (indexOf(history.state) === null) history.replaceState({ index: 0 }, '');

const location = signal<Location>({ path: pathFromHash(), index: indexOf(history.state) ?? 0, restored: false });
const scrollPositions = new Map<number, number>();

function rememberScroll(): void {
  scrollPositions.set(location.get().index, window.scrollY);
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  rememberScroll();
  const current = location.get();
  const index = options.replace ? current.index : current.index + 1;
  history[options.replace ? 'replaceState' : 'pushState']({ index }, '', `#${path}`);
  location.set({ path, index, restored: false });
}

/** Goes back if the previous page is one of ours, otherwise to `fallback`. */
export function goBack(fallback: string): void {
  if (location.get().index > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Follows a change of address the router didn't make itself. */
function sync(): void {
  const path = pathFromHash();
  const current = location.get();
  const index = indexOf(history.state);
  if (index === current.index && path === current.path) return;
  rememberScroll();
  if (index !== null) {
    // Back or forward.
    location.set({ path, index, restored: true });
  } else {
    // A hand-typed address or a plain #link: a new entry without an index yet.
    history.replaceState({ index: current.index + 1 }, '');
    location.set({ path, index: current.index + 1, restored: false });
  }
}

// Browsers fire one or both of these for a change of hash; `sync` ignores the second.
window.addEventListener('popstate', sync);
window.addEventListener('hashchange', sync);

/** Current route as path segments: "#/history/abc" → ["history", "abc"]. */
export function useRoute(): string[] {
  const current = useSignal(location);
  useLayoutEffect(() => {
    window.scrollTo(0, current.restored ? (scrollPositions.get(current.index) ?? 0) : 0);
  }, [current]);
  return current.path.split('/').filter(Boolean).map(decodeURIComponent);
}

export const href = (path: string) => `#${path}`;

/** For plain links: lets the router handle an ordinary click, the browser everything else. */
export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>, path: string): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

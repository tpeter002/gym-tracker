import { useSyncExternalStore } from 'react';

/** A value components can subscribe to. */
export interface Signal<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useSignal = <T>(source: Signal<T>): T => useSyncExternalStore(source.subscribe, source.get);

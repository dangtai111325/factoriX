/**
 * Open state of the navigation drawer on narrow screens (R3-UI-01). Below 768 px the sidebar is an
 * off-canvas drawer toggled by the hamburger button in the top bar; on wider screens it is always
 * visible and this state is ignored by the CSS.
 */
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

export function setSidebarOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  listeners.forEach((listener) => listener());
}

export function toggleSidebar(): void {
  setSidebarOpen(!open);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => open;

export function useSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Matches the CSS breakpoint where the sidebar becomes a drawer. */
export const MOBILE_QUERY = '(max-width: 767.98px)';

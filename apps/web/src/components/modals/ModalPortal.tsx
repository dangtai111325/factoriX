import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders a modal overlay directly under <body>, outside the page layout (sidebar, topbar, main).
 *
 * Overlays rendered inside `main.fx-main` were offset from the viewport top in some Chromium
 * renderings (a ~16px uncovered strip), while the one rendered from the sidebar was not. Mounting
 * every overlay at the document root makes its containing block the viewport regardless of the page
 * structure, and index.css locks the document scroll while an `aria-modal` dialog is open.
 *
 * React events and context still flow through the component tree, so callers keep their handlers.
 */
export const ModalPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
};

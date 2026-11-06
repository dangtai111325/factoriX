import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a tooltip, e.g. why an item is disabled. */
  hint?: string;
  danger?: boolean;
}

interface MenuButtonProps {
  label: string;
  icon?: React.ReactNode;
  items: MenuItem[];
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
  /** Accessible label when the visible label is not descriptive enough. */
  ariaLabel?: string;
}

/** Small dropdown menu for secondary actions ("More"). Keyboard: Enter/Space opens, arrows move, Esc closes. */
export const MenuButton: React.FC<MenuButtonProps> = ({ label, icon, items, size = 'md', align = 'right', ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    const first = rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const moveFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const nodes = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || [],
    );
    if (!nodes.length) return;
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % nodes.length : (index - 1 + nodes.length) % nodes.length;
    nodes[next].focus();
  };

  const sizeClass = size === 'sm' ? 'h-8 px-2.5 text-[12px] gap-1.5' : 'h-9 px-3.5 text-[13px] gap-2';

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center justify-center font-semibold rounded-lg transition-colors bg-white text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37] border border-[#D4DFEC] whitespace-nowrap ${sizeClass}`}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span>{label}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-[#94A3B8] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={ariaLabel || label}
          onKeyDown={moveFocus}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1.5 min-w-[200px] rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1.5 z-40`}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px] outline-none disabled:opacity-45 disabled:cursor-not-allowed focus-visible:bg-[#F1F5FA] ${
                item.danger ? 'text-[#DB2028] hover:bg-[#FFF5F5]' : 'text-[#334568] hover:bg-[#F8FAFC]'
              }`}
            >
              {item.icon && <span className="w-4 h-4 flex items-center justify-center shrink-0" aria-hidden="true">{item.icon}</span>}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

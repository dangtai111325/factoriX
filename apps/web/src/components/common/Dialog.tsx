import React, { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'

interface DialogProps {
  isOpen: boolean
  title: string
  onClose: () => void
  busy?: boolean
  size?: 'standard' | 'wide'
  footer?: React.ReactNode
  children: React.ReactNode
}

/** Native modal owns inert/Escape/focus return; explicit cycling keeps Tab inside the modal. */
export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  title,
  onClose,
  busy = false,
  size = 'standard',
  footer,
  children,
}) => {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!isOpen) return
    const dialog = ref.current
    const previousFocus = document.activeElement as HTMLElement | null
    if (dialog && !dialog.open) dialog.showModal()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      if (dialog?.open) dialog.close()
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [isOpen])
  if (!isOpen) return null
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.nativeEvent.isComposing) return
        const dialog = event.currentTarget
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex]'),
        ).filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.matches(':disabled') &&
            control.getClientRects().length > 0 &&
            getComputedStyle(control).visibility !== 'hidden',
        )
        const first = controls[0]
        const last = controls[controls.length - 1]
        const active = document.activeElement
        if (!first) {
          event.preventDefault()
          dialog.focus()
          return
        }
        if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
          event.preventDefault()
          first.focus()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className={`m-auto w-[calc(100%-2rem)] ${size === 'wide' ? 'max-w-6xl h-[90dvh] open:flex open:flex-col' : 'max-w-2xl'} max-h-[90dvh] rounded-xl border border-[var(--fx-border)] bg-[var(--fx-surface)] p-0 text-[var(--fx-body)] shadow-xl backdrop:bg-slate-900/40 backdrop:backdrop-blur-sm`}
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--fx-border)] bg-[var(--fx-bg-soft)] px-6 py-3">
        <h2 id={titleId} className="text-lg font-bold text-[var(--fx-ink)]">
          {title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          className="!h-10 !w-10 !p-0"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
          icon={<X className="h-4 w-4" />}
        />
      </header>
      {children}
      {footer ? (
        <footer className="shrink-0 border-t border-[var(--fx-border)] bg-[var(--fx-surface)] px-5 py-4">
          {footer}
        </footer>
      ) : null}
    </dialog>
  )
}

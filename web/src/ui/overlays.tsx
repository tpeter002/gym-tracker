import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/** Shows a <dialog> as a modal for as long as the component is mounted. */
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    // Focus goes to the field marked for it (React's autoFocus runs before the
    // dialog is visible, when focusing does nothing), otherwise to the dialog
    // as a whole rather than to whichever button happens to come first.
    (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog).focus();
    return () => dialog.close();
  }, []);
  return {
    ref,
    // Escape: let the owner unmount us rather than the browser closing the dialog under React.
    onCancel: (event: React.SyntheticEvent) => {
      event.preventDefault();
      onClose();
    },
    onClick: (event: React.MouseEvent) => {
      if (event.target === ref.current) onClose(); // a click on the backdrop
    },
    // The browser closed it anyway (a second Escape can't be cancelled): follow.
    onClose,
  };
}

interface SheetProps {
  title: string;
  onClose: () => void;
  /** Replaces the Cancel button. */
  leading?: ReactNode;
  trailing?: ReactNode;
  footer?: ReactNode;
  /** Full height, for long lists. */
  tall?: boolean;
  children: ReactNode;
}

/** Slides up from the bottom on a phone; a centred panel on a wide screen. */
export function Sheet({ title, onClose, leading, trailing, footer, tall, children }: SheetProps) {
  const modal = useModal(onClose);
  return (
    <dialog className={tall ? 'sheet tall' : 'sheet'} aria-label={title} tabIndex={-1} {...modal}>
      <header className="sheet-header">
        <div className="leading">
          {leading ?? <button className="bar-button" onClick={onClose}>Cancel</button>}
        </div>
        <h2>{title}</h2>
        {trailing && <div className="trailing">{trailing}</div>}
      </header>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-footer">{footer}</div>}
    </dialog>
  );
}

export interface DialogAction {
  label: string;
  destructive?: boolean;
  run: () => void;
}

interface ConfirmProps {
  title: string;
  message?: string;
  actions?: DialogAction[];
  /** Label of the button that only closes the dialog. */
  cancelLabel?: string;
  onClose: () => void;
}

/** A question with its answers; with no actions it is a plain notice. */
export function ConfirmDialog({ title, message, actions = [], cancelLabel = 'Cancel', onClose }: ConfirmProps) {
  const modal = useModal(onClose);
  return (
    <dialog className="alert" role="alertdialog" aria-label={title} tabIndex={-1} {...modal}>
      <h2>{title}</h2>
      {message && <p>{message}</p>}
      <div className="actions">
        {actions.map((action) => (
          <button
            key={action.label}
            className={action.destructive ? 'destructive' : undefined}
            onClick={() => {
              onClose();
              action.run();
            }}
          >
            {action.label}
          </button>
        ))}
        <button className="cancel" onClick={onClose}>{cancelLabel}</button>
      </div>
    </dialog>
  );
}

export interface MenuItem {
  label: string;
  destructive?: boolean;
  /** Shows a tick, for on/off items. */
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

interface MenuProps {
  /** Accessible name of the button that opens the menu. */
  label: string;
  className?: string;
  items: MenuItem[];
  children: ReactNode;
}

/** A button that opens a small menu next to itself. */
export function Menu({ label, className, items, children }: MenuProps) {
  const id = useId();
  const menuRef = useRef<HTMLDivElement>(null);

  // Runs before the browser opens the popover. Anchoring an edge instead of
  // measuring the menu means it never appears in the wrong place first.
  const place = (event: React.MouseEvent<HTMLButtonElement>) => {
    const menu = menuRef.current!;
    const anchor = event.currentTarget.getBoundingClientRect();
    const onRightHalf = anchor.left + anchor.width / 2 > window.innerWidth / 2;
    const roomBelow = window.innerHeight - anchor.bottom > 56 + items.length * 46;
    menu.style.left = onRightHalf ? 'auto' : `${Math.max(8, anchor.left)}px`;
    menu.style.right = onRightHalf ? `${Math.max(8, window.innerWidth - anchor.right)}px` : 'auto';
    menu.style.top = roomBelow ? `${anchor.bottom + 6}px` : 'auto';
    menu.style.bottom = roomBelow ? 'auto' : `${window.innerHeight - anchor.top + 6}px`;
  };

  const close = useCallback(() => {
    if (menuRef.current?.matches(':popover-open')) menuRef.current.hidePopover();
  }, []);

  const onToggle = (event: React.ToggleEvent<HTMLDivElement>) => {
    if (event.newState !== 'open') {
      window.removeEventListener('scroll', close, true);
      return;
    }
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    // The menu is pinned to the window, so it would drift off its button.
    window.addEventListener('scroll', close, { capture: true, once: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...menuRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return (
    <>
      <button className={className} aria-label={label} aria-haspopup="menu" popoverTarget={id} onClick={place}>
        {children}
      </button>
      <div id={id} ref={menuRef} popover="auto" className="menu" role="menu" onToggle={onToggle} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.label}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            className={item.destructive ? 'destructive' : undefined}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.run();
            }}
          >
            {item.label}
            {item.checked && <Check size={18} aria-hidden />}
          </button>
        ))}
      </div>
    </>
  );
}

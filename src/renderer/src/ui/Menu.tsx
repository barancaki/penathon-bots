import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronIcon } from './icons';

export type MenuOption = { value: string; label: string; hint?: string };

/**
 * App-styled single-select menu. Replaces native <select> so the popover matches
 * the theme; keyboard: ArrowUp/Down, Home/End, Enter/Space, Escape, type-ahead.
 */
export function Menu({
  value,
  options,
  label,
  disabled,
  placement = 'auto',
  trigger,
  className = 'pill',
  onChange,
}: {
  value: string;
  options: MenuOption[];
  label: string;
  disabled?: boolean;
  placement?: 'auto' | 'up' | 'down';
  trigger?: ReactNode;
  className?: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(placement === 'up');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    if (placement === 'auto' && button.current) {
      const rect = button.current.getBoundingClientRect();
      setUp(window.innerHeight - rect.bottom < 280 && rect.top > window.innerHeight - rect.bottom);
    }
    list.current?.focus();
  }, [open, placement]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const openMenu = () => {
    if (disabled) return;
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="menu" ref={root}>
      <button
        ref={button}
        type="button"
        className={className}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        title={label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger ?? (
          <>
            <span>{current?.label ?? value}</span>
            <ChevronIcon size={12} className="menu-chev" />
          </>
        )}
      </button>
      {open && (
        <ul
          ref={list}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          className={`menu-pop ${up ? 'up' : 'down'}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              button.current?.focus();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Home') {
              e.preventDefault();
              setActive(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              setActive(options.length - 1);
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              pick(active);
            } else if (e.key === 'Tab') {
              setOpen(false);
            } else if (e.key.length === 1) {
              const next = options.findIndex((o) =>
                o.label.toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()),
              );
              if (next >= 0) setActive(next);
            }
          }}
        >
          <li className="menu-title" aria-hidden="true">
            {label}
          </li>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-active={index === active || undefined}
              onPointerEnter={() => setActive(index)}
              onClick={() => pick(index)}
            >
              <span className="menu-label">
                {option.label}
                {option.hint && <span className="menu-hint">{option.hint}</span>}
              </span>
              {option.value === value && <CheckIcon size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

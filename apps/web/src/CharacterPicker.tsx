import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CharacterPick } from './useCharacters';

interface CharacterPickerProps extends CharacterPick {
  /** Locked during a call: the character is fixed when the call starts. */
  readonly disabled: boolean;
}

export function CharacterPicker({ options, selectedId, select, disabled }: CharacterPickerProps) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const expanded = open && !disabled && options.length > 1;

  useEffect(() => {
    if (disabled || options.length < 2) setOpen(false);
  }, [disabled, options.length]);

  useEffect(() => {
    if (!expanded) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % items.length; break;
      case 'ArrowUp': next = (index - 1 + items.length) % items.length; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  if (options.length < 2) return null;
  const selected = options.find((c) => c.id === selectedId);
  const label = disabled ? `当前角色：${selected?.name ?? ''}（通话中不可切换）` : `选择角色：${selected?.name ?? ''}`;
  return (
    <div
      className="character-picker"
      ref={pickerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="character-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={expanded ? menuId : undefined}
        disabled={disabled}
        data-testid="character-picker"
        onClick={() => setOpen(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-3-5.2" />
        </svg>
      </button>
      {expanded && (
        <div className="character-menu" id={menuId} ref={menuRef} role="menu" aria-label="选择角色" onKeyDown={navigate}>
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              className="character-option"
              role="menuitemradio"
              aria-checked={c.id === selectedId}
              tabIndex={-1}
              data-testid={`character-${c.id}`}
              onClick={() => {
                select(c.id);
                close();
              }}
            >
              <span className="character-copy">
                <span className="character-name">{c.name}</span>
                {c.description && <span className="character-description">{c.description}</span>}
              </span>
              {c.id === selectedId && (
                <svg className="character-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 4 4L19 6" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

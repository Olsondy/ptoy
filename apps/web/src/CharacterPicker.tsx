import type { CharacterPick } from './useCharacters';

interface CharacterPickerProps extends CharacterPick {
  /** Locked during a call: the character is fixed when the call starts. */
  readonly disabled: boolean;
}

export function CharacterPicker({ options, selectedId, select, disabled }: CharacterPickerProps) {
  if (options.length < 2) return null;
  const selected = options.find((c) => c.id === selectedId);
  return (
    <div className="character-picker">
      <div className="character-options" role="radiogroup" aria-label="选择角色" data-testid="character-picker">
        {options.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === selectedId}
            className={`character-option ${c.id === selectedId ? 'is-selected' : ''}`}
            data-testid={`character-${c.id}`}
            disabled={disabled}
            onClick={() => select(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      {selected?.description && <p className="character-description">{selected.description}</p>}
    </div>
  );
}

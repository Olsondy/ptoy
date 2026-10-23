import { useEffect, useState } from 'react';
import { UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CharacterPick } from './useCharacters';

interface CharacterPickerProps extends CharacterPick {
  readonly disabled: boolean;
}

export function CharacterPicker({ options, selectedId, select, disabled }: CharacterPickerProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled || options.length < 2) setOpen(false);
  }, [disabled, options.length]);

  if (options.length < 2) return null;
  const selected = options.find((character) => character.id === selectedId);
  const label = disabled
    ? `当前角色：${selected?.name ?? ''}（通话中不可切换）`
    : `选择角色：${selected?.name ?? ''}`;

  return (
    <DropdownMenu open={open && !disabled} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11 rounded-full text-muted-foreground"
          aria-label={label} title={label} disabled={disabled} data-testid="character-picker">
          <UsersRound className="size-5" strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} collisionPadding={16}
        className="w-72 max-w-[calc(100vw-32px)] rounded-2xl p-1.5" aria-label="选择角色">
        <DropdownMenuLabel className="px-3 py-2 text-xs text-muted-foreground">选择通话角色</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selectedId} onValueChange={select}>
          {options.map((character) => (
            <DropdownMenuRadioItem key={character.id} value={character.id} textValue={character.name}
              className="min-h-14 rounded-xl py-3 pl-3 pr-9" data-testid={`character-${character.id}`}>
              <span className="grid gap-1">
                <span className="text-sm">{character.name}</span>
                {character.description && <span className="text-xs leading-relaxed text-muted-foreground">{character.description}</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

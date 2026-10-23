import { useEffect, useState } from 'react';
import { type CharacterOption, fetchCharacters } from './token';

const STORAGE_KEY = 'ptoy.character';

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode or blocked storage: the pick just isn't remembered.
  }
}

export interface CharacterPick {
  /** Empty until the list loads, and stays empty if it fails (the call then gets the server default). */
  readonly options: readonly CharacterOption[];
  readonly selectedId: string | undefined;
  readonly select: (id: string) => void;
}

/** The character list from the token server, with the last pick remembered in this browser. */
export function useCharacters(): CharacterPick {
  const [options, setOptions] = useState<readonly CharacterOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    fetchCharacters(abort.signal)
      .then((list) => {
        const last = remembered();
        setOptions(list.characters);
        setSelectedId(list.characters.some((c) => c.id === last) ? (last as string) : list.defaultId);
      })
      .catch(() => {
        // No picker: the token server's default character answers the call.
      });
    return () => abort.abort();
  }, []);

  const select = (id: string) => {
    setSelectedId(id);
    remember(id);
  };

  return { options, selectedId, select };
}

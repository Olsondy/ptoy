import { useEffect, useState } from 'react';
import { type CharacterOption, fetchCharacters, InvalidCharacterLink } from './token';

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
  /** Empty until loaded; only the homepage may fall back to the server default on failure. */
  readonly options: readonly CharacterOption[];
  readonly selectedId: string | undefined;
  readonly select: (id: string) => void;
  readonly characterLink: string | undefined;
  readonly locked: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
}

/** The character list from the token server, with the last pick remembered in this browser. */
export function useCharacters(enabled = true): CharacterPick {
  const [options, setOptions] = useState<readonly CharacterOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [characterLink] = useState(() => {
    const values = new URLSearchParams(window.location.search).getAll('character');
    return values.length > 1 ? '' : values[0];
  });
  const locked = characterLink !== undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) { setOptions([]); setSelectedId(undefined); setLoading(true); setError(undefined); return; }
    setLoading(true); setError(undefined);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    fetchCharacters(signal, characterLink)
      .then((list) => {
        if (abort.signal.aborted) return;
        if (locked && (list.characters.length !== 1 || list.characters[0]?.id !== list.defaultId)) {
          throw new InvalidCharacterLink();
        }
        const last = locked ? null : remembered();
        setOptions(list.characters);
        setSelectedId(list.characters.some((c) => c.id === last) ? (last as string) : list.defaultId);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        if (locked) setError(error instanceof InvalidCharacterLink
          ? '角色链接无效或已失效，请向分享者获取新链接。'
          : '暂时无法加载角色，请刷新页面重试。');
        // Only the homepage may still call using the server's default character.
      })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [characterLink, locked, enabled]);

  const select = (id: string) => {
    if (locked || !options.some((character) => character.id === id)) return;
    setSelectedId(id);
    remember(id);
  };

  return { options, selectedId, select, characterLink, locked, loading, error };
}

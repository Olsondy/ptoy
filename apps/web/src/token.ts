/** Mirrors `TokenResponse` in apps/agent/src/token-server.ts. */
export interface CallToken {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
}

/** Mirrors `CharacterSummary` in apps/agent/src/characters.ts. */
export interface CharacterOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Mirrors `CharactersResponse` in apps/agent/src/token-server.ts. */
export interface CharacterList {
  readonly defaultId: string;
  readonly characters: readonly CharacterOption[];
}

const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || '/api/token';
/** Sibling of the token endpoint on the same token server (`/api/token` → `/api/characters`). */
const CHARACTERS_ENDPOINT = new URL('characters', new URL(TOKEN_ENDPOINT, window.location.href)).href;
const CHARACTER_LINK_ENDPOINT = new URL('character-link', new URL(TOKEN_ENDPOINT, window.location.href)).href;

export class InvalidCharacterLink extends Error {}

/** `character` undefined lets the token server pick its default. */
export async function fetchCallToken(character?: string, signal?: AbortSignal, characterLink?: string): Promise<CallToken> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(characterLink !== undefined ? { characterLink } : character ? { character } : {}),
    signal,
  });
  if (res.status === 400 && characterLink !== undefined) throw new InvalidCharacterLink();
  if (!res.ok) throw new Error(`token endpoint responded ${res.status}`);
  const body = (await res.json()) as Partial<CallToken>;
  if (!body.serverUrl || !body.participantToken || !body.roomName || !body.participantName) {
    throw new Error('token endpoint returned an incomplete body');
  }
  return body as CallToken;
}

export async function fetchCharacters(signal?: AbortSignal, characterLink?: string): Promise<CharacterList> {
  const url = new URL(CHARACTERS_ENDPOINT);
  if (characterLink !== undefined) url.searchParams.set('characterLink', characterLink);
  const res = await fetch(url, { signal });
  if (res.status === 400 && characterLink !== undefined) throw new InvalidCharacterLink();
  if (!res.ok) throw new Error(`characters endpoint responded ${res.status}`);
  const body = (await res.json()) as Partial<CharacterList>;
  if (!body.defaultId || !Array.isArray(body.characters) || body.characters.length === 0) {
    throw new Error('characters endpoint returned an incomplete body');
  }
  return body as CharacterList;
}

export async function fetchCharacterLink(character: string): Promise<string> {
  const res = await fetch(CHARACTER_LINK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`character link endpoint responded ${res.status}`);
  const body = await res.json() as { characterLink?: unknown };
  if (typeof body.characterLink !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.characterLink)) {
    throw new Error('character link endpoint returned an invalid body');
  }
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('character', body.characterLink);
  return url.href;
}

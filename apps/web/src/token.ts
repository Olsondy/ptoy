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

/** `character` undefined lets the token server pick its default. */
export async function fetchCallToken(character?: string, signal?: AbortSignal): Promise<CallToken> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(character ? { character } : {}),
    signal,
  });
  if (!res.ok) throw new Error(`token endpoint responded ${res.status}`);
  const body = (await res.json()) as Partial<CallToken>;
  if (!body.serverUrl || !body.participantToken || !body.roomName || !body.participantName) {
    throw new Error('token endpoint returned an incomplete body');
  }
  return body as CallToken;
}

export async function fetchCharacters(signal?: AbortSignal): Promise<CharacterList> {
  const res = await fetch(CHARACTERS_ENDPOINT, { signal });
  if (!res.ok) throw new Error(`characters endpoint responded ${res.status}`);
  const body = (await res.json()) as Partial<CharacterList>;
  if (!body.defaultId || !Array.isArray(body.characters) || body.characters.length === 0) {
    throw new Error('characters endpoint returned an incomplete body');
  }
  return body as CharacterList;
}

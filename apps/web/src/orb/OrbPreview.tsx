import { ORB_STATES, type OrbState } from './renderer';

/** Dev-only: `?orb=idle|listening|thinking|speaking` forces the orb into a state with synthetic audio. */
export function readPreviewState(): OrbState | undefined {
  const value = new URLSearchParams(window.location.search).get('orb');
  return ORB_STATES.find((s) => s === value);
}

interface OrbPreviewPanelProps {
  readonly value: OrbState;
  readonly onChange: (state: OrbState) => void;
}

/** Floating state switcher shown only in dev builds when `?orb=` is present. */
export function OrbPreviewPanel({ value, onChange }: OrbPreviewPanelProps) {
  const select = (state: OrbState) => {
    const url = new URL(window.location.href);
    url.searchParams.set('orb', state);
    window.history.replaceState(null, '', url);
    onChange(state);
  };

  return (
    <div className="orb-preview" role="group" aria-label="Orb preview" data-testid="orb-preview">
      {ORB_STATES.map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={state === value}
          className={state === value ? 'is-active' : ''}
          onClick={() => select(state)}
        >
          {state}
        </button>
      ))}
    </div>
  );
}

import { useState } from 'react';
import { Link, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fetchCharacterLink } from './token';

export function CharacterLinkButton({ characterId, characterName, disabled }: {
  characterId: string; characterName: string; disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualLink, setManualLink] = useState('');
  const label = `复制${characterName}的固定角色链接`;

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setManualLink('');
    try {
      const url = await fetchCharacterLink(characterId);
      try {
        await navigator.clipboard.writeText(url);
        setMessage(`${characterName}的链接已复制`);
      } catch {
        setManualLink(url);
        setMessage('链接已生成，请手动复制');
      }
    } catch {
      setMessage('生成链接失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="character-link-control">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11 rounded-full text-muted-foreground"
            aria-label={label} disabled={disabled || busy} onClick={() => void copy()} data-testid="character-link-copy">
            {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Link aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {message && <div className="character-link-feedback">
        <p role="status">{message}</p>
        {manualLink && <a href={manualLink} className="character-link-url" aria-label="固定角色链接">{manualLink}</a>}
      </div>}
    </div>
  );
}

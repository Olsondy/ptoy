import { Volume2, VolumeX } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function AmbienceToggle({ enabled, onEnabledChange }: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const Icon = enabled ? Volume2 : VolumeX;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle className="control-icon captions-toggle" pressed={enabled} onPressedChange={onEnabledChange}
          aria-label="背景音" data-testid="ambience-toggle">
          <Icon aria-hidden="true" />
        </Toggle>
      </TooltipTrigger>
      <TooltipContent sideOffset={10}>{enabled ? '关闭背景音' : '开启背景音'}</TooltipContent>
    </Tooltip>
  );
}

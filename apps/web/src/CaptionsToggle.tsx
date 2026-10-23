import { Type } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function CaptionsToggle({ visible, onVisibleChange }: {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle className="control-icon captions-toggle" pressed={visible} onPressedChange={onVisibleChange}
          aria-label="显示字幕" data-testid="captions-toggle">
          <Type aria-hidden="true">
            {!visible && <path d="m3 3 18 18" />}
          </Type>
        </Toggle>
      </TooltipTrigger>
      <TooltipContent sideOffset={10}>{visible ? '隐藏实时字幕' : '显示实时字幕'}</TooltipContent>
    </Tooltip>
  );
}

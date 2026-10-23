import { Captions, LoaderCircle, Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CallStatus } from './useCall';

interface CallControlsProps {
  status: CallStatus;
  error: string | undefined;
  captions: boolean;
  onCaptionsChange: (visible: boolean) => void;
  onToggle: () => void;
}

export function CallControls({ status, error, captions, onCaptionsChange, onToggle }: CallControlsProps) {
  const inCall = status !== 'disconnected';
  const callAction = inCall ? '挂断' : '开始通话';
  return (
    <footer className="call-footer">
      <div className="call-error-slot" aria-live="polite">
        {error && <p className="call-error" role="alert" data-testid="call-error">{error}</p>}
      </div>
      <div className="call-controls" role="group" aria-label="通话控制">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" className={`call-toggle ${inCall ? 'is-active' : ''}`} data-testid="call-toggle"
              aria-label={callAction} aria-pressed={inCall} onClick={onToggle}>
              {status === 'connecting' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : inCall ? <PhoneOff aria-hidden="true" /> : <Phone aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={10}>{callAction}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle className="control-icon captions-toggle" pressed={captions} onPressedChange={onCaptionsChange}
              aria-label="显示字幕" data-testid="captions-toggle"><Captions aria-hidden="true" /></Toggle>
          </TooltipTrigger>
          <TooltipContent sideOffset={10}>{captions ? '隐藏实时字幕' : '显示实时字幕'}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}

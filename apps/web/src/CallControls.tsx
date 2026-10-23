import { LoaderCircle, PhoneCall, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CallStatus } from './useCall';

interface CallControlsProps {
  status: CallStatus;
  error: string | undefined;
  onToggle: () => void;
}

export function CallControls({ status, error, onToggle }: CallControlsProps) {
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
              {status === 'connecting' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : inCall ? <PhoneOff aria-hidden="true" /> : <PhoneCall aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={10}>{callAction}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}

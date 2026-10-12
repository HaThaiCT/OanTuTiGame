import React from 'react';

export interface KeyboardControlHandlers {
  onPlayPause?: () => void;
  onStepPrev?: () => void;
  onStepNext?: () => void;
  onToggleMute?: () => void;
  onToggleTheater?: () => void;
}

export function isInteractiveInput(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  const tagName = el.tagName?.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function' && el.closest('.monaco-editor')) {
    return true;
  }
  return false;
}

export function handleKeyboardEvent(
  event: KeyboardEvent,
  handlers: KeyboardControlHandlers
): void {
  if (isInteractiveInput(event.target)) return;

  const code = event.code;
  const key = event.key ? event.key.toLowerCase() : '';

  if (code === 'Space' || key === ' ') {
    event.preventDefault?.();
    handlers.onPlayPause?.();
  } else if (code === 'ArrowLeft' || key === 'arrowleft') {
    event.preventDefault?.();
    handlers.onStepPrev?.();
  } else if (code === 'ArrowRight' || key === 'arrowright') {
    event.preventDefault?.();
    handlers.onStepNext?.();
  } else if (code === 'KeyM' || key === 'm') {
    event.preventDefault?.();
    handlers.onToggleMute?.();
  } else if (code === 'KeyF' || key === 'f') {
    event.preventDefault?.();
    handlers.onToggleTheater?.();
  }
}

export function useKeyboardControls(handlers: KeyboardControlHandlers): void {
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleKeyboardEvent(event, handlersRef.current);
    };

    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('keydown', listener);
    };
  }, []);
}

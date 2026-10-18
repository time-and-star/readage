import React, { useEffect, useRef } from 'react';

/** A normal tap opens the book; a stationary hold offers deletion. */
export function LibraryBookButton({ onOpen, onDelete, children, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; start.current = null; };
  useEffect(() => {
    window.addEventListener('scroll', cancel, true);
    window.addEventListener('blur', cancel);
    return () => { cancel(); window.removeEventListener('scroll', cancel, true); window.removeEventListener('blur', cancel); };
  }, []);
  return <button {...props} type="button" style={{ ...props.style, WebkitTouchCallout: 'none', userSelect: 'none' }}
    onPointerDown={event => {
      cancel(); suppressClick.current = false;
      if (!onDelete || !event.isPrimary || event.button !== 0) return;
      start.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      timer.current = setTimeout(() => { cancel(); suppressClick.current = true; onDelete(); }, 650);
    }}
    onPointerMove={event => {
      if (start.current && (event.pointerId !== start.current.pointerId
        || Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10)) cancel();
    }}
    onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onContextMenu={event => { if (onDelete) { event.preventDefault(); cancel(); suppressClick.current = true; onDelete(); } }}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false;
      if (onDelete && (event.key === 'Delete' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault(); cancel(); onDelete();
      }
    }}
    onClick={event => { if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; } onOpen(); }}>
    {children}
  </button>;
}

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Refetches everything when the server reports a change, and after a dropped connection returns. */
export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream');
    let down = false;
    es.addEventListener('change', () => void qc.invalidateQueries());
    es.onerror = () => {
      down = true; // the browser reconnects by itself
    };
    es.onopen = () => {
      if (down) {
        down = false;
        void qc.invalidateQueries();
      }
    };
    return () => es.close();
  }, [qc]);
}

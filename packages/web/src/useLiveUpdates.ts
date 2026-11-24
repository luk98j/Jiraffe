import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Queries that have their own, cheaper refresh path and are left out of a board-wide refetch. */
const OWN_REFRESH = new Set(['logs', 'diff']);

/**
 * Refetches the board data when the server reports a change, and after a dropped connection
 * returns. Run output has its own `log` event that refreshes only that task's logs; the diff is
 * keyed by the task's updatedAt, so it is fetched again only when the task changed.
 */
export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream');
    let down = false;
    const refresh = () =>
      void qc.invalidateQueries({ predicate: (q) => !OWN_REFRESH.has(String(q.queryKey[0])) });
    es.addEventListener('change', refresh);
    es.addEventListener('log', (e) => {
      try {
        const { taskId } = JSON.parse((e as MessageEvent).data) as { taskId: number };
        void qc.invalidateQueries({ queryKey: ['logs', taskId] });
      } catch {
        // a malformed hint is ignored
      }
    });
    es.onerror = () => {
      down = true; // the browser reconnects by itself
    };
    es.onopen = () => {
      if (down) {
        down = false;
        void qc.invalidateQueries(); // after a gap, everything may be stale, logs included
      }
    };
    return () => es.close();
  }, [qc]);
}

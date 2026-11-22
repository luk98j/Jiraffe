import { request } from '../api.ts';
import { useApiMutation, useDeleted } from '../queries.ts';

export function Deleted() {
  const q = useDeleted();
  const restore = useApiMutation((id: number) => request('POST', `/api/tasks/${id}/restore`));
  const error = q.error ?? restore.error;
  return (
    <section>
      <h2>Deleted</h2>
      {error && (
        <div role="alert" className="error">
          {error.message}
        </div>
      )}
      {q.isSuccess && q.data.length === 0 && <p>No deleted tasks</p>}
      <ul>
        {(q.data ?? []).map((t) => (
          <li key={t.id} data-testid={`deleted-${t.key}`}>
            <strong>{t.key}</strong> <span>{t.title}</span>{' '}
            <small>deleted {t.deletedAt?.replace('T', ' ').slice(0, 19)}</small>{' '}
            <button type="button" onClick={() => restore.mutate(t.id)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useState } from 'react';
import { useJournal } from '../queries.ts';

export function Journal() {
  const [taskKey, setTaskKey] = useState('');
  const [action, setAction] = useState('');
  const q = useJournal(taskKey.trim(), action.trim());
  return (
    <section>
      <h2>Journal</h2>
      <div className="filters">
        <label>Task key <input value={taskKey} onChange={(e) => setTaskKey(e.target.value)} /></label>{' '}
        <label>Action <input value={action} onChange={(e) => setAction(e.target.value)} /></label>
      </div>
      {q.error && <div role="alert" className="error">{q.error.message}</div>}
      {q.isSuccess && q.data.length === 0 && <p>No journal entries</p>}
      {q.data && q.data.length > 0 && (
        <table>
          <thead>
            <tr><th>Date</th><th>Task key</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id} data-testid="journal-row">
                <td>{e.at.replace('T', ' ').slice(0, 19)}</td>
                <td>{e.taskKey ?? ''}</td>
                <td>{e.status ?? ''}</td>
                <td>{e.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

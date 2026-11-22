import { useState, type FormEvent } from 'react';
import { request } from '../api.ts';
import { useApiMutation } from '../queries.ts';

export function AddTaskForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const add = useApiMutation((v: { title: string; description: string; repoPath: string }) =>
    request('POST', '/api/tasks', v),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(
      { title, description, repoPath },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          setRepoPath('');
        },
      },
    );
  };

  return (
    <form className="add-task" onSubmit={submit}>
      <label>
        Title <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Description{' '}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Repository{' '}
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/path/to/repository"
        />
      </label>
      <button type="submit" disabled={add.isPending}>
        Add task
      </button>
      {add.isError && (
        <div role="alert" className="error">
          {add.error.message}
        </div>
      )}
    </form>
  );
}

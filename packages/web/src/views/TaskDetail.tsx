import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { MessageDto, TaskDto } from '@jiraffe/core';
import { request } from '../api.ts';
import { useApiMutation, useTaskDetail } from '../queries.ts';
import { STATUS_VIEW } from '../statusView.ts';

type Detail = { task: TaskDto; messages: MessageDto[] };

function RepoEditor({ task }: { task: TaskDto }) {
  const [value, setValue] = useState(task.repoPath ?? '');
  const save = useApiMutation((repoPath: string) => request('PATCH', `/api/tasks/${task.id}`, { repoPath }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(value);
  };
  return (
    <form onSubmit={submit} className="repo-editor">
      <label>Repository <input value={value} onChange={(e) => setValue(e.target.value)} /></label>
      <button type="submit" disabled={save.isPending}>Save repository</button>
      {save.isError && <div role="alert" className="error">{save.error.message}</div>}
    </form>
  );
}

function Chat({ detail }: { detail: Detail }) {
  const { task, messages } = detail;
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [params] = useSearchParams();
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (params.get('focus') === 'chat') box.current?.focus();
  }, [params]);

  const send = useMutation({
    mutationFn: (content: string) => request('POST', `/api/tasks/${task.id}/messages`, { content }),
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey: ['task', task.id] });
      const previous = qc.getQueryData<Detail>(['task', task.id]);
      if (previous) {
        const optimistic: MessageDto = {
          id: -Date.now(), taskId: task.id, role: 'user', source: 'app', content, createdAt: new Date().toISOString(),
        };
        qc.setQueryData<Detail>(['task', task.id], { ...previous, messages: [...previous.messages, optimistic] });
      }
      return { previous };
    },
    onError: (_e, _c, ctx) => {
      if (ctx?.previous) qc.setQueryData(['task', task.id], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setText('');
    send.mutate(content);
  };

  return (
    <section aria-labelledby="chat-h">
      <h3 id="chat-h">Chat</h3>
      <div className="chat">
        {messages.length === 0 && <p className="empty">No messages yet</p>}
        {messages.map((m) => (
          <div key={m.id} data-testid="message" className="message">
            <small>
              <span>{m.role === 'user' ? 'You' : 'Agent'}</span> · <span>{m.source === 'jira' ? 'Jira' : 'App'}</span> · {m.createdAt}
            </small>
            <div data-testid="message-text">{m.content}</div>
          </div>
        ))}
      </div>
      <form onSubmit={submit}>
        <label>Message <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
      {send.isError && <div role="alert" className="error">{send.error.message}</div>}
    </section>
  );
}

const EMPTY_AREAS = ['Analysis result', 'Logs', 'Diff'];

export function TaskDetail() {
  const id = Number(useParams().id);
  const q = useTaskDetail(id);

  if (q.isError && !q.data) return <div role="alert" className="error">{q.error.message}</div>;
  if (!q.data) return <p>Loading...</p>;
  const { task } = q.data;
  const view = STATUS_VIEW[task.status];

  return (
    <article className={`detail ${view.colorClass}`}>
      <Link to="/">Back to board</Link>
      <h2><span>{task.key}</span> {task.title}</h2>
      {q.isError && <div role="alert" className="error">{q.error.message}</div>}
      <p className="state"><span aria-hidden="true">{view.icon}</span> <span>{view.label}</span></p>
      <RepoEditor key={task.repoPath ?? ''} task={task} />
      <p className="body">{task.body}</p>
      <Chat detail={q.data} />
      {EMPTY_AREAS.map((name) => (
        <section key={name} aria-label={name} className="empty-area">
          <h3>{name}</h3>
          <p>Nothing here yet</p>
        </section>
      ))}
    </article>
  );
}

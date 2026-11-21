import { NavLink, Route, Routes } from 'react-router';
import { Board } from './views/Board.tsx';
import { useSync } from './queries.ts';
import { Settings } from './views/Settings.tsx';
import { Deleted } from './views/Deleted.tsx';
import { Journal } from './views/Journal.tsx';
import { TaskDetail } from './views/TaskDetail.tsx';

const NAV = [
  ['/', 'Board'],
  ['/deleted', 'Deleted'],
  ['/journal', 'Journal'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const sync = useSync();
  return (
    <div className="app">
      <header className="top">
        <h1>Jiraffe</h1>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      {sync.data?.state === 'not_configured' && (
        <div className="banner">Jira not configured. Set jira_base_url in Settings to import tasks.</div>
      )}
      <main>
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/deleted" element={<Deleted />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
        </Routes>
      </main>
    </div>
  );
}

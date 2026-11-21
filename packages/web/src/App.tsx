import { NavLink, Route, Routes } from 'react-router';
import { Board } from './views/Board.tsx';

const NAV = [
  ['/', 'Board'],
  ['/deleted', 'Deleted'],
  ['/journal', 'Journal'],
  ['/settings', 'Settings'],
] as const;

export function App() {
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
      <main>
        <Routes>
          <Route path="/" element={<Board />} />
        </Routes>
      </main>
    </div>
  );
}

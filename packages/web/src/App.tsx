import { NavLink } from 'react-router';

const NAV = [
  ['/', 'Board'],
  ['/deleted', 'Deleted'],
  ['/journal', 'Journal'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  return (
    <div className="app">
      <header>
        <h1>Jiraffe</h1>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main />
    </div>
  );
}

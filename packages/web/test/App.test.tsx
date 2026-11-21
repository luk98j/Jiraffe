import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';

describe('App skeleton', () => {
  it('renders the title and the navigation', () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Jiraffe' })).toBeInTheDocument();
    for (const name of ['Board', 'Deleted', 'Journal', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});

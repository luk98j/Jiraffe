import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './helpers.tsx';

describe('App shell', () => {
  it('renders the title and the navigation', () => {
    renderApp('/', () => undefined);
    expect(screen.getByRole('heading', { name: 'Jiraffe' })).toBeInTheDocument();
    for (const name of ['Board', 'Deleted', 'Journal', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});

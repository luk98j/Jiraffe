import { describe, expect, it } from 'vitest';
import { buildJql } from '../src/index.ts';

describe('buildJql (AC-23)', () => {
  it('builds the base query for empty lists', () => {
    expect(buildJql({ ignoredStatuses: [], projects: [] })).toBe(
      'assignee = currentUser() AND statusCategory != Done',
    );
  });

  it('adds ignored statuses and projects', () => {
    expect(buildJql({ ignoredStatuses: ['Blocked', "Won't do"], projects: ['PROJ', 'ABC'] })).toBe(
      `assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Blocked","Won't do") AND project IN (PROJ,ABC)`,
    );
  });

  it('adds only the projects clause when no statuses are ignored', () => {
    expect(buildJql({ ignoredStatuses: [], projects: ['PROJ'] })).toBe(
      'assignee = currentUser() AND statusCategory != Done AND project IN (PROJ)',
    );
  });

  it('escapes quotes and backslashes inside status names', () => {
    expect(buildJql({ ignoredStatuses: ['A"B', 'C\\D'], projects: [] })).toBe(
      'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("A\\"B","C\\\\D")',
    );
  });
});

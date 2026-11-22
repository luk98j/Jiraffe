import type { Status } from '@jiraffe/core';

export type ActionId =
  | 'analyse'
  | 'cancel'
  | 'answer'
  | 'delegate'
  | 'reanalyse'
  | 'logs'
  | 'resume'
  | 'diff'
  | 'accept'
  | 'error'
  | 'retry'
  | 'delete';

export interface StatusView {
  label: string;
  colorClass: string;
  icon: string;
  actions: ActionId[];
}

/** Section 9 of the spec: every status has a label, a color class, an icon and its card actions. */
export const STATUS_VIEW: Record<Status, StatusView> = {
  new: {
    label: 'New / Queued',
    colorClass: 'status-grey',
    icon: '○',
    actions: ['analyse', 'delete'],
  },
  queued_analysis: {
    label: 'New / Queued',
    colorClass: 'status-grey',
    icon: '◔',
    actions: ['analyse', 'delete'],
  },
  analysing: {
    label: 'Analysing',
    colorClass: 'status-blue status-animated',
    icon: '⟳',
    actions: ['cancel'],
  },
  waiting_user: {
    label: 'Waiting for you',
    colorClass: 'status-orange',
    icon: '?',
    actions: ['answer', 'delete'],
  },
  ready_to_delegate: {
    label: 'Ready to delegate',
    colorClass: 'status-green',
    icon: '✓',
    actions: ['delegate', 'reanalyse', 'delete'],
  },
  delegated: {
    label: 'Queued for execution',
    colorClass: 'status-blue',
    icon: '⇢',
    actions: ['cancel'],
  },
  running: {
    label: 'Running',
    colorClass: 'status-blue status-animated',
    icon: '▶',
    actions: ['logs', 'cancel'],
  },
  paused_quota: {
    label: 'Paused (usage limit)',
    colorClass: 'status-yellow',
    icon: '⏸',
    actions: ['resume', 'cancel'],
  },
  review: {
    label: 'Needs review',
    colorClass: 'status-purple',
    icon: '◎',
    actions: ['diff', 'accept'],
  },
  done: {
    label: 'Done',
    colorClass: 'status-darkgreen status-dimmed',
    icon: '●',
    actions: ['delete'],
  },
  failed: {
    label: 'Failed',
    colorClass: 'status-red',
    icon: '✖',
    actions: ['error', 'retry', 'delete'],
  },
  cancelled: { label: 'Cancelled', colorClass: 'status-grey', icon: '⊘', actions: ['delete'] },
};

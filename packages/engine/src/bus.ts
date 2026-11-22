import { EventEmitter } from 'node:events';
import type { EventType, Status } from '@jiraffe/core';

export interface DomainEvent {
  taskId: number;
  type: EventType;
  from?: Status;
  to?: Status;
}

export interface Logger {
  error(message: string, err?: unknown): void;
}

/** In-process bus. Subscribers only ever see committed changes. */
export class Bus {
  private emitter = new EventEmitter();

  constructor(private logger: Logger) {
    this.emitter.setMaxListeners(0);
  }

  private subscribe<T>(topic: string, fn: (payload: T) => unknown): () => void {
    const handler = (payload: T) => {
      try {
        const r = fn(payload);
        if (r instanceof Promise) r.catch((err) => this.logger.error(`bus handler failed (${topic})`, err));
      } catch (err) {
        this.logger.error(`bus handler failed (${topic})`, err);
      }
    };
    this.emitter.on(topic, handler);
    return () => this.emitter.off(topic, handler);
  }

  /** Domain events: transitions and user comments. */
  onEvent(fn: (e: DomainEvent) => unknown) {
    return this.subscribe('event', fn);
  }

  /** UI invalidation hint: something changed. */
  onChanged(fn: () => unknown) {
    return this.subscribe('changed', fn);
  }

  listenerCount(topic: 'event' | 'changed'): number {
    return this.emitter.listenerCount(topic);
  }

  emitEvent(e: DomainEvent): void {
    this.emitter.emit('event', e);
  }

  emitChanged(): void {
    this.emitter.emit('changed');
  }
}

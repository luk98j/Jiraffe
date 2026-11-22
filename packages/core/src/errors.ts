/** Base class for errors the API turns into readable responses. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super('validation', message);
  }
}

export class TaskNotFoundError extends AppError {
  constructor(message = 'Task not found') {
    super('not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('conflict', message);
  }
}

export class InvalidTransitionError extends AppError {
  constructor(message: string) {
    super('invalid_transition', message);
  }
}

export class TaskNotReadyError extends AppError {
  constructor(message: string) {
    super('not_ready', message);
  }
}

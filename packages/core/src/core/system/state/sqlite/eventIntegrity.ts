export class RuntimeEventIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeEventIntegrityError';
  }
}

export interface EventPersistenceResult {
  inserted: boolean;
}

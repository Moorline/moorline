export class JsonBodyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

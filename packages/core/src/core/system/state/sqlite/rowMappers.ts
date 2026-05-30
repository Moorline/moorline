export function mapRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

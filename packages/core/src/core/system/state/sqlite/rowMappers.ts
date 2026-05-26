export function mapRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

export function mapRow<T>(row: unknown): T {
  return row as T;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === undefined) return 'undefined';
  if (err === null) return 'null';
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

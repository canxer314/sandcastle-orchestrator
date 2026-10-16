export type Values = Record<string, string | undefined>;

export function required(values: Values, name: string) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
}

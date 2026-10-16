export function validateScheduledAt(time: string) {
  const format = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const calendar = new Date(`${time.slice(0, 10)}T00:00:00Z`);
  if (!format.test(time) || !Number.isFinite(Date.parse(time))
    || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== time.slice(0, 10)) throw new Error('Invalid scheduledAt');
}

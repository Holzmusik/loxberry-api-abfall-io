/**
 * The upstream answered, but has no collection dates for the address (yet). Typical between the
 * last collection of a year and the publication of the next year's calendar. Not a fetch failure:
 * the plugin reports status `no_future_dates`, keeps the regular fetch interval and keeps any
 * still-upcoming cached dates.
 */
export class NoCollectionDatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoCollectionDatesError";
  }
}

export function isNoCollectionDatesError(err: unknown): err is NoCollectionDatesError {
  return err instanceof NoCollectionDatesError;
}

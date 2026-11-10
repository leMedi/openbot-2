/** The message of an API or network error, for display. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

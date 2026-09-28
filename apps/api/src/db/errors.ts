/** D1 surfaces constraint failures as plain Errors; Drizzle may wrap them in `cause`. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) {
    if (cur.message.includes('UNIQUE constraint failed')) return true
  }
  return false
}

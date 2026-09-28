import type { ApiErrorBody, ErrorCode } from '@nampu/types'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: ApiErrorBody['error']['issues'],
  ) {
    super(message)
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.issues && { issues: this.issues }) } }
  }
}

export const notFound = (what = 'resource') => new ApiError(404, 'not_found', `${what} not found`)

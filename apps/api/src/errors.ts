/**
 * A failure the client caused or can act on (missing file, wrong state, bad input).
 * Services throw it without knowing about HTTP; the error handler in http/app.ts maps
 * `code` to a status. Anything else thrown is a bug and becomes a logged 500.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type DomainErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'invalid_state'
  | 'not_uploaded'
  | 'size_mismatch'
  | 'processing_failed'
  | 'blocked'

export function fileNotFound(): DomainError {
  return new DomainError('not_found', 'File not found')
}

export function userNotFound(): DomainError {
  return new DomainError('not_found', 'User not found')
}

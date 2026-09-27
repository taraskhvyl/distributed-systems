// Route schemas shared by more than one feature. A malformed id fails validation (400)
// instead of reaching Postgres as a bad uuid cast (500).

export const FILE_ID_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const

export const USERNAME_PARAMS = {
  type: 'object',
  required: ['username'],
  properties: { username: { type: 'string', minLength: 1, maxLength: 255 } },
} as const

export type FileIdParams = { id: string }
export type UsernameParams = { username: string }

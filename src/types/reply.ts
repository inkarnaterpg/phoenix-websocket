/**
 * A container object representing a reply from the Phoenix server.  Includes the status and an optional response payload.
 */
export type PhoenixReply = {
  response: { [key: string]: any } | string
  status: 'ok' | 'error'
}

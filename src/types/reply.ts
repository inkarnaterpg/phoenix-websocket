/**
 * A container object representing a reply from the Phoenix server.  Includes the status and an optional response payload.
 */
export type PhoenixReply = PhoenixOkReply | PhoenixErrorReply

export type PhoenixOkReply = {
  response: { [key: string]: any } | string
  status: 'ok'
}

export type PhoenixErrorReply = {
  response: { [key: string]: any } | string
  status: 'error'
}

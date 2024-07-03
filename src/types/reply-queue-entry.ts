import { PhoenixOkReply, PhoenixReply } from './reply'
import {
  PhoenixConnectionError,
  PhoenixInternalServerError,
  PhoenixRespondedWithError,
} from './errors'

/**
 * A container object representing a promise waiting on a reply from the Phoenix server.
 */
export type ReplyQueueEntry = {
  onReply: (reply: PhoenixOkReply) => void
  onError: (
    error: PhoenixConnectionError | PhoenixInternalServerError | PhoenixRespondedWithError
  ) => void
}

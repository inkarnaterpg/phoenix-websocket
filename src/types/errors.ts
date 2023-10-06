/**
 * Thrown when you try to interact with a topic that you are not currently subscribed to.
 */
export class PhoenixInvalidTopicError extends Error {
  constructor(topic?: string) {
    super(
      topic
        ? `Attempted to interact with topic "${topic}" that you are either not subscribed to, or that has been disconnected from.`
        : 'Attempted to interact with a topic that you are either not subscribed to, or that has been disconnected from.'
    )
  }
}

/**
 * Represents that the WebSocket connection was in an unexpected state while trying to perform an action.
 *
 * For example, disconnected when trying to send a message.
 */
export class PhoenixInvalidStateError extends Error {
  constructor() {
    super(
      'Attempted to interact with Phoenix while the WebSocket connection is in an invalid state.'
    )
  }
}

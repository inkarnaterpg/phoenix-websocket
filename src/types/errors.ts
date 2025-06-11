import { PhoenixReply } from './reply'

/**
 * Base class for all phoenix-websocket error types.
 */
export abstract class PhoenixError extends Error {}

/**
 * Thrown when you try to interact with a topic that you are not currently subscribed to.
 */
export class PhoenixInvalidTopicError extends PhoenixError {
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
export class PhoenixInvalidStateError extends PhoenixError {
  constructor() {
    super(
      'Attempted to interact with Phoenix while the WebSocket connection is in an invalid state.'
    )
  }
}

/**
 * Thrown when an unexpected network state or server error interrupts a topic connection.
 */
export class PhoenixConnectionError extends PhoenixError {
  constructor(topic?: string) {
    super(
      topic
        ? `A connection error was encountered while trying to subscribe/interact with topic ${topic}.`
        : `A connection error was encountered while trying to subscribe/interact with topic.`
    )
  }
}

/**
 * Thrown when the server responds to a message with a server error that closes the topic.
 */
export class PhoenixInternalServerError extends PhoenixError {
  constructor() {
    super('The server encountered an internal error which forcibly closed the topic.')
  }
}

/**
 * Thrown when the server responds with an error reply.
 * Differs from internal server error since this means the server successfully handled
 * the request but explicitly returned an error.
 */
export class PhoenixRespondedWithError extends PhoenixError {
  constructor(public reply?: PhoenixReply) {
    super('The server responded with an error to the message.')
  }
}

/**
 * Thrown when attempting to interact with Phoenix after `disconnect()` has been called on the PhoenixWebsocket instance.
 */
export class PhoenixDisconnectedError extends PhoenixError {
  constructor() {
    super('Attempted to interact with Phoenix after the connection has been closed.')
  }
}

/**
 * Thrown when a heartbeat message doesn't get a reply within the timeout window.
 */
export class PhoenixTimeoutError extends PhoenixError {
  constructor() {
    super('Message timed out before receiving a response.')
  }
}

import { PhoenixReply } from './reply'
import { ReplyQueueEntry } from './reply-queue-entry'
import {
  PhoenixConnectionError,
  PhoenixDisconnectedError,
  PhoenixInternalServerError,
  PhoenixRespondedWithError,
} from './errors'

/**
 * Represents a callback that gets called and passed an optional payload when receiving a pre-defined message from a subscribed topic.
 */
export type TopicMessageHandler = (data: { [key: string]: any } | undefined) => void

/**
 * The different statuses that a topic subscription can be in.
 */
export enum TopicStatuses {
  /** A topic that has been successfully left or disconnected from. */
  Unsubscribed,
  /** In the process of leaving the topic (waiting for the server's response). */
  Leaving,
  /** In the process of subscribing to the topic (waiting for the server's response). */
  Joining,
  /** Successfully subscribed to the topic. */
  Subscribed,
}

/**
  Internal state container for a topic subscription.
 */
export class PhoenixTopic {
  private static _nextTopicId: number = 1
  protected static get nextTopicId() {
    return this._nextTopicId++
  }

  public subscribedResolvers: (() => void)[] = []
  public subscribedRejectors: ((
    error:
      | PhoenixRespondedWithError
      | PhoenixConnectionError
      | PhoenixDisconnectedError
      | PhoenixInternalServerError
  ) => void)[] = []
  public reconnectionHandler: ((connectionPromise: Promise<void>) => void) | undefined

  public readonly topic: string
  public readonly joinPayload: { [key: string]: any } | undefined
  public readonly topicMessageHandlerMap: Map<string, TopicMessageHandler> = new Map<
    string,
    TopicMessageHandler
  >()
  public readonly replyQueue: Map<string, ReplyQueueEntry> = new Map<string, ReplyQueueEntry>()

  private _status: TopicStatuses = TopicStatuses.Unsubscribed
  public get status(): TopicStatuses {
    return this._status
  }
  public set status(value) {
    if (this._status !== TopicStatuses.Subscribed && value === TopicStatuses.Subscribed) {
      this._status = value
      this.subscribedResolvers.forEach((m) => m())
      this.subscribedResolvers = []
      this.subscribedRejectors = []
    } else {
      this._status = value
    }
  }

  private _id: number = -1
  public get id(): string {
    return this._id.toString(10)
  }

  /**
   * Number of times this topic has been joined.  Will be increment on initial join, and then any subsequent reconnection attempts.
   */
  private joinCount: number = 0

  constructor(topic: string, joinPayload?: { [key: string]: any } | undefined) {
    this.topic = topic
    this.joinPayload = joinPayload
  }

  public assignNewId(): void {
    this._id = PhoenixTopic.nextTopicId
  }

  public onServerError(): void {
    for (let queueEntry of this.replyQueue.values()) {
      queueEntry.onError(new PhoenixInternalServerError())
    }
    this.replyQueue.clear()
    this.subscribedRejectors.forEach((r) => r(new PhoenixInternalServerError()))
    this.subscribedRejectors = []
    this.subscribedResolvers = []
  }

  public onConnectionError(): void {
    for (let queueEntry of this.replyQueue.values()) {
      queueEntry.onError(new PhoenixConnectionError())
    }
    this.replyQueue.clear()
    this.subscribedRejectors.forEach((r) => r(new PhoenixConnectionError()))
    this.subscribedRejectors = []
    this.subscribedResolvers = []
  }

  public onConnectionClosed(): void {
    for (let queueEntry of this.replyQueue.values()) {
      queueEntry.onError(new PhoenixDisconnectedError())
    }
    this.replyQueue.clear()
    this.subscribedRejectors.forEach((r) => r(new PhoenixDisconnectedError()))
    this.subscribedRejectors = []
    this.subscribedResolvers = []
  }

  public onJoining(): void {
    this.joinCount++
    if (this.joinCount > 1) {
      this.subscribedRejectors = []
      this.subscribedResolvers = []
      if (this.reconnectionHandler) {
        let { promise, resolve, reject } = Promise.withResolvers<void>()
        this.subscribedRejectors.push(reject)
        this.subscribedResolvers.push(resolve as () => void)
        this.reconnectionHandler(promise)
      }
    }
  }
}

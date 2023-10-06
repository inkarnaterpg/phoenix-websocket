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

  public subscribedResolvers: (() => void)[] = []
  public subscribedRejectors: ((error: any) => void)[] = []

  protected static get nextTopicId() {
    return this._nextTopicId++
  }

  public readonly topic: string
  public readonly joinPayload: { [key: string]: any } | undefined
  public readonly topicMessageHandlerMap: Map<string, TopicMessageHandler> = new Map<
    string,
    TopicMessageHandler
  >()
  private _status: TopicStatuses = TopicStatuses.Unsubscribed
  public get status(): TopicStatuses {
    return this._status
  }
  public set status(value) {
    if (this._status !== TopicStatuses.Subscribed && value === TopicStatuses.Subscribed) {
      this._status = value
      this.subscribedResolvers.forEach((m) => m())
      this.subscribedResolvers = []
    } else {
      this._status = value
    }
  }

  private _id: number = -1
  public get id(): string {
    return this._id.toString(10)
  }

  constructor(topic: string, joinPayload?: { [key: string]: any } | undefined) {
    this.topic = topic
    this.joinPayload = joinPayload
  }

  public assignNewId(): void {
    this._id = PhoenixTopic.nextTopicId
  }
}

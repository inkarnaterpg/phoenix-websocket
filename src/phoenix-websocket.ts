import {
  PhoenixInvalidStateError,
  PhoenixInvalidTopicError,
  PhoenixRespondedWithError,
  PhoenixInternalServerError,
  PhoenixConnectionError,
  PhoenixDisconnectedError,
} from './types/errors'
import { PhoenixTopic, TopicMessageHandler, TopicStatuses } from './types/topic'
import { WebsocketStatuses } from './types/websocket-statuses'
import { PhoenixMessage } from './types/message'
import { PhoenixOkReply, PhoenixReply } from './types/reply'
import { PhoenixWebsocketLogLevels } from './types/log-levels'
import { ReplyQueueEntry } from './types/reply-queue-entry'

/**
 * Represents a connection instance to a Phoenix Sockets endpoint.
 */
export class PhoenixWebsocket {
  private readonly HEARTBEAT_INTERVAL = 30000
  private readonly TIMEOUT_LENGTH = 1000 * 60
  private readonly TIMEOUT_THRESHOLD = 3
  private logLevel: PhoenixWebsocketLogLevels = PhoenixWebsocketLogLevels.Informative
  private connectionAttempt: number = 0

  private wsUrl: string
  private socket?: WebSocket
  private topics: Map<string, PhoenixTopic> = new Map<string, PhoenixTopic>()

  /**
   * An array of all the topics you are currently successfully connected to.
   * Does not include topics that have been disconnected, or that are in the process of connecting.
   */
  public get subscribedTopics(): string[] {
    return [...this.topics.keys()].filter(
      (key) => this.topics.get(key)?.status === TopicStatuses.Subscribed
    )
  }

  private _connectionStatus: WebsocketStatuses = WebsocketStatuses.Disconnected
  /**
    The current status of the WebSocket connection.
   */
  public get connectionStatus(): WebsocketStatuses {
    return this._connectionStatus
  }
  private heartbeatTimeout: number | undefined
  private heartbeatReplyQueue: Map<string, ReplyQueueEntry> = new Map<string, ReplyQueueEntry>()
  private reconnectionTimeout: number | undefined

  private onConnectedResolvers: (() => void)[] = []

  /**
    A callback to be called whenever the WebSocket successfully connects or reconnects.
   */
  public onConnectedCallback: (() => void) | undefined
  /**
    A callback to be called whenever the WebSocket is disconnected.
  */
  public onDisconnectedCallback: (() => void) | undefined

  private _nextMessageId: number = 1
  protected get nextMessageId() {
    return (this._nextMessageId++).toString(10)
  }

  /**
   * @constructor
   * @param {string} url - The fully qualified url to your Phoenix socket endpoint.
   * @param {{ [key: string]: string } | undefined} queryParams - Optional object of key/value pairs to be appended to the url as query parameters.
   * @param {number | undefined} timeoutInMs - Optional timeout value in milliseconds, if not provided the default 60 second timeout will be used.
   */
  constructor(url: string, queryParams?: { [key: string]: string }, timeoutInMs?: number) {
    if (!queryParams) {
      queryParams = {}
    }
    let searchParams = new URLSearchParams()
    Object.entries(queryParams).forEach(([key, value]) => searchParams.append(key, value))
    searchParams.append('vsn', '2.0.0')
    let websocketUrl = url + (url.endsWith('/') ? 'websocket' : '/websocket')
    websocketUrl += `?${searchParams.toString()}`
    this.wsUrl = websocketUrl
    if (timeoutInMs) {
      this.TIMEOUT_LENGTH = timeoutInMs
    }
  }

  protected onOpen(_event: Event): void {
    if (this._connectionStatus === WebsocketStatuses.Reconnecting) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log('Phoenix Websocket, Reconnected...')
      }
    }
    this.connectionAttempt = 0
    this._connectionStatus = WebsocketStatuses.Connected
    this.onConnectedResolvers.forEach((r) => r())
    this.onConnectedResolvers = []
    for (let [_id, topic] of this.topics) {
      this.joinTopic(topic)
    }
    this.scheduleHeartbeat()
    this.onConnectedCallback?.()
  }

  protected onError(event: Event): void {
    if (this._connectionStatus !== WebsocketStatuses.Reconnecting) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
        console.error('Phoenix Websocket: connection error: ' + event)
      }
      this.attemptReconnection()
    }
    this.disposeOnConnectionError()
    this.onDisconnectedCallback?.()
  }

  protected onClose(_event: CloseEvent): void {
    if (
      this._connectionStatus !== WebsocketStatuses.Disconnecting &&
      this._connectionStatus !== WebsocketStatuses.Disconnected
    ) {
      if (this._connectionStatus !== WebsocketStatuses.Reconnecting) {
        //Unexpected close
        if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
          console.error('Phoenix Websocket: unexpectedly closed.')
        }
      }
      this.attemptReconnection()
    } else {
      this._connectionStatus = WebsocketStatuses.Disconnected
      if (this.reconnectionTimeout) {
        clearTimeout(this.reconnectionTimeout)
        this.reconnectionTimeout = undefined
      }
    }
    this.disposeOnConnectionError()
    this.onDisconnectedCallback?.()
  }

  private disposeOnConnectionError(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = undefined
    }
    for (let topic of this.topics.values()) {
      topic.onConnectionError()
    }
    this.socket = undefined
  }

  private attemptReconnection(): void {
    if (!this.reconnectionTimeout) {
      if (this.connectionAttempt > this.TIMEOUT_THRESHOLD) {
        this.reconnectionTimeout = setTimeout(() => {
          this.reconnectionTimeout = undefined
          this._connect()
        }, this.TIMEOUT_LENGTH) as any as number
        if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
          console.warn('Websocket Connection in Timeout.')
        }
      } else {
        this.reconnectionTimeout = setTimeout(
          () => {
            this.reconnectionTimeout = undefined
            this._connect()
          },
          this._connectionStatus === WebsocketStatuses.Reconnecting ? 10000 : 1000
        ) as any as number
      }
    }
    this._connectionStatus = WebsocketStatuses.Reconnecting
  }

  protected onMessage(event: MessageEvent): void {
    if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
      console.log('Phoenix Websocket: Message received: ', event.data)
    }
    const parsedData = JSON.parse(event.data)
    let topicId = parsedData[0] ?? null
    let messageId = parsedData[1] ?? null
    let topic = parsedData[2] != null ? (parsedData[2] as string) : ''
    let message = parsedData[3] != null ? (parsedData[3] as string) : ''
    let messageData =
      parsedData[4] != null
        ? (parsedData[4] as { [key: string]: any })
        : ({} as { [key: string]: any })
    let response = new PhoenixMessage(topicId, messageId, topic, message, messageData)

    if (response.topicId && response.messageId && response.message === 'phx_reply') {
      if ((response.data as PhoenixReply)?.status === 'ok') {
        if (this.heartbeatReplyQueue.has(response.messageId)) {
          this.heartbeatReplyQueue.get(response.messageId)?.onReply(response.data as PhoenixOkReply)
          this.heartbeatReplyQueue.delete(response.messageId)
        } else {
          this.topics
            .get(response.topic ?? '')
            ?.replyQueue.get(response.messageId)
            ?.onReply(response.data as PhoenixOkReply)
          this.topics.get(response.topic ?? '')?.replyQueue.delete(response.messageId)
        }
      } else {
        if (this.heartbeatReplyQueue.has(response.messageId)) {
          this.heartbeatReplyQueue
            .get(response.messageId)
            ?.onError(new PhoenixRespondedWithError(response.data as PhoenixReply))
          this.heartbeatReplyQueue.delete(response.messageId)
        } else {
          this.topics
            .get(response.topic ?? '')
            ?.replyQueue.get(response.messageId)
            ?.onError(new PhoenixRespondedWithError(response.data as PhoenixReply))
          this.topics.get(response.topic ?? '')?.replyQueue.delete(response.messageId)
        }
      }
    } else if (response.topicId && response.message === 'phx_close') {
      if (this.topics.has(response.topic ?? '')) {
        this.topics.get(response.topic ?? '')!.status = TopicStatuses.Unsubscribed
        this.topics.delete(response.topic ?? '')
        if (this.topics.size === 0 && this.socket?.readyState === WebSocket.OPEN) {
          this.disconnect()
        }
      }
    } else if (response.topicId && response.message === 'phx_error') {
      if (this.topics.has(response.topic ?? '')) {
        if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
          console.error(
            `Phoenix Websocket: Topic ${response.topic} responded with error, reconnecting...`
          )
        }
        let erroredTopic = this.topics.get(response.topic ?? '')!
        erroredTopic.status = TopicStatuses.Unsubscribed
        erroredTopic.onServerError()
        this.topics.delete(response.topic ?? '')
        this.subscribeToTopic(
          erroredTopic.topic,
          erroredTopic.joinPayload,
          erroredTopic.topicMessageHandlerMap
        )
      }
    } else {
      if (response.topic) {
        if (this.topics.has(response.topic)) {
          if (
            response.message &&
            this.topics.get(response.topic)!.topicMessageHandlerMap.has(response.message)
          ) {
            this.topics.get(response.topic)!.topicMessageHandlerMap.get(response.message)?.(
              response.data
            )
          } else {
            if (this.logLevel <= PhoenixWebsocketLogLevels.Warnings) {
              console.warn(
                `Phoenix Websocket: Topic (${response.topic}) has no message handler for message (${response.message})`
              )
            }
          }
        } else {
          if (this.logLevel <= PhoenixWebsocketLogLevels.Warnings) {
            console.warn(
              `Phoenix Websocket: Message received for unknown topic (${response.topic})`
            )
          }
        }
        this.topics.get(response.topic)?.topicMessageHandlerMap.get(response.topic)?.(response.data)
      }
    }
  }

  /**
   Attempt to open the websocket connection.
   @returns {Promise<void>} A promise which will resolve when the connection is successfully opened.  If the websocket is already connected, this will resolve immediately.
  */
  public connect(): Promise<void> {
    return new Promise((resolve, _reject) => {
      if (this._connectionStatus === WebsocketStatuses.Connected) {
        resolve()
      } else {
        this.onConnectedResolvers.push(resolve)
        this._connect()
      }
    })
  }

  private _connect() {
    this.connectionAttempt++
    if (typeof navigator === 'undefined' || navigator.onLine) {
      this.onConnectionCheckSuccessful()
    } else {
      this.attemptReconnection()
    }
  }

  private onConnectionCheckSuccessful() {
    this.socket = new WebSocket(this.wsUrl)
    this.socket.onopen = (e) => this.onOpen(e)
    this.socket.onerror = (e) => this.onError(e)
    this.socket.onclose = (e) => this.onClose(e)
    this.socket.onmessage = (e) => this.onMessage(e)
  }

  /**
    Close the current websocket connection.
    @param {boolean} [clearTopics=true] - If true, all topics will be unsubscribed from and removed as part of the disconnection.  If false, the topics will remain subscribed to and will automatically be resubscribed to if the socket is reconnected.
   */
  public disconnect(clearTopics: boolean = true): void {
    if (this.reconnectionTimeout) {
      clearTimeout(this.reconnectionTimeout)
      this.reconnectionTimeout = undefined
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = undefined
    }
    if (this._connectionStatus != WebsocketStatuses.Disconnected) {
      this._connectionStatus = WebsocketStatuses.Disconnecting
    }

    this.topics.forEach((t) => t.onConnectionClosed())

    if (clearTopics) {
      this.topics.clear()
    }

    this.socket?.close()
  }

  /**
   * Subscribe to the passed in topic.  This will attempt to subscribe immediately if the websocket
   * connection is already open, otherwise it will try to subscribe once the connection is opened.
   *
   * Optionally pass in a topicMessageHandler to handle incoming messages for the topic.
   * If this is left undefined, then it is assumed you will only interact with the topic via messages and responses.
   *
   * If an 'error' status is received from the server in response to the join request, then the promise will be reject with the payload of the error response.
   *
   * @param {string} topic - The topic to subscribe to.
   * @param { { [key: string]: any } | undefined } payload - An optional payload object to be sent along with the join request.
   * @param { [message: string]: TopicMessageHandler } messageHandlers - An optional object containing mappings of messages to message handler callbacks, which are called when the given message is received.
   *
   * @throws { PhoenixInternalServerError }
   * @throws { PhoenixConnectionError }
   * @throws { PhoenixDisconnectedError }
   * @throws { PhoenixRespondedWithError }
   */
  public subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: { [message: string]: TopicMessageHandler }
  ): Promise<void>
  public subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: Map<string, TopicMessageHandler>
  ): Promise<void>
  subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: { [message: string]: TopicMessageHandler } | Map<string, TopicMessageHandler>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.topics.has(topic)) {
        if (this.logLevel <= PhoenixWebsocketLogLevels.Warnings) {
          console.warn(`Phoenix Websocket: Tried to add duplicate topic ${topic}.`)
        }
        resolve()
        return
      }
      const newTopic = new PhoenixTopic(topic, payload)
      if (messageHandlers && messageHandlers instanceof Map) {
        for (let key of messageHandlers.keys()) {
          newTopic.topicMessageHandlerMap.set(
            key,
            (messageHandlers as Map<string, TopicMessageHandler>).get(key)!
          )
        }
      } else if (messageHandlers) {
        for (let key of Object.keys(messageHandlers)) {
          newTopic.topicMessageHandlerMap.set(key, messageHandlers[key])
        }
      }
      this.topics.set(topic, newTopic)
      newTopic.subscribedResolvers.push(() => resolve())
      newTopic.subscribedRejectors.push((err) => reject(err))
      if (this._connectionStatus === WebsocketStatuses.Connected) {
        this.joinTopic(newTopic)
      }
    })
  }

  /**
   * Unsubscribe from the passed in topic.
   *
   * @param {string} topic - The topic to unsubscribe from.
   */
  public unsubscribeToTopic(topic: string): void {
    if (this.topics.has(topic)) {
      this.leaveTopic(this.topics.get(topic)!)
    } else {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Warnings) {
        console.warn(
          `Phoenix Websocket: Attempted to unsubscribe from non-existant topic (${topic})`
        )
      }
    }
  }

  /**
   * Send a message and optional payload to the given topic.
   *
   * @param {string} topic - The topic to send the message to.  You must already be subscribed to this topic a topic before you can send a message to it.
   * @param {string} message - The message to send.
   * @param { { [key: string]: any } | undefined } payload - An optional payload to be sent along with the message.
   *
   * @return { Promise<PhoenixReply> } A promise which will resolve with the reply sent from the server.
   *
   * @throws { PhoenixInvalidTopicError }
   * @throws { PhoenixInvalidStateError }
   * @throws { PhoenixInternalServerError }
   * @throws { PhoenixRespondedWithError }
   * @throws { PhoenixDisconnectedError }
   * @throws { PhoenixInternalServerError }
   */
  public async sendMessage(
    topic: string,
    message: string,
    payload?: { [key: string]: any } | undefined
  ): Promise<PhoenixReply> {
    if (this.topics.has(topic)) {
      if (this.topics.get(topic)!.status !== TopicStatuses.Subscribed) {
        if (
          this.topics.get(topic)!.status === TopicStatuses.Leaving ||
          this.topics.get(topic)!.status === TopicStatuses.Unsubscribed
        ) {
          throw new PhoenixInvalidTopicError(topic)
        } else {
          await new Promise<void>((resolve, _reject) =>
            this.topics.get(topic)!.subscribedResolvers.push(() => resolve())
          )
        }
      }

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        let phoenixTopic = this.topics.get(topic)!
        const phoenixMessage = new PhoenixMessage(
          phoenixTopic.id,
          this.nextMessageId,
          phoenixTopic.topic,
          message,
          payload
        )
        return await new Promise((resolve, reject) => {
          if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
            console.log('Phoenix Websocket: Sending message: ', phoenixMessage.toString())
          }
          this.socket?.send(phoenixMessage.toString())
          phoenixTopic.replyQueue.set(phoenixMessage.messageId!, {
            onReply: (reply) => resolve(reply),
            onError: (err) => reject(err),
          } as ReplyQueueEntry)
        })
      } else {
        throw new PhoenixInvalidStateError()
      }
    } else {
      throw new PhoenixInvalidTopicError(topic)
    }
  }

  private joinTopic(topic: PhoenixTopic): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      topic.assignNewId()
      const message = new PhoenixMessage(
        topic.id,
        this.nextMessageId,
        topic.topic,
        'phx_join',
        topic.joinPayload
      )
      this.socket.send(message.toString())
      topic.replyQueue.set(message.messageId!, {
        onReply: (_reply) => {
          topic.status = TopicStatuses.Subscribed
          topic.subscribedResolvers.forEach((r) => r())
          topic.subscribedResolvers = []
          topic.subscribedRejectors = []
        },
        onError: (err) => {
          topic.status = TopicStatuses.Unsubscribed
          this.topics.delete(topic.topic)
          topic.subscribedRejectors.forEach((r) => r(err))
          topic.subscribedResolvers = []
          topic.subscribedRejectors = []
        },
      } as ReplyQueueEntry)
      topic.status = TopicStatuses.Joining
    } else {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
        console.error(
          new Error(
            `Phoenix Websocket: Tried to join topic while socket is in an invalid state (${this.socket?.readyState})`
          )
        )
      }
    }
  }

  private leaveTopic(topic: PhoenixTopic): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket?.send(
        new PhoenixMessage(
          topic.id,
          this.nextMessageId,
          topic.topic,
          'phx_leave',
          undefined
        ).toString()
      )
      topic.status = TopicStatuses.Leaving
    } else if (
      this.connectionStatus === WebsocketStatuses.Disconnected ||
      this.connectionStatus === WebsocketStatuses.Disconnecting
    ) {
      topic.status = TopicStatuses.Unsubscribed
      this.topics.delete(topic.topic)
    }
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = undefined
    }
    this.heartbeatTimeout = setTimeout(() => {
      this.sendHeartbeat()
    }, this.HEARTBEAT_INTERVAL) as unknown as number
  }

  private sendHeartbeat(): void {
    if (this.socket && this._connectionStatus === WebsocketStatuses.Connected) {
      const newMessage = new PhoenixMessage(
        undefined,
        this.nextMessageId,
        'phoenix',
        'heartbeat',
        undefined
      )
      this.socket.send(newMessage.toString())
      this.heartbeatReplyQueue.set(newMessage.messageId!, {
        onReply: (_reply) => this.scheduleHeartbeat(),
        onError: (_reply) => this.scheduleHeartbeat(),
      } as ReplyQueueEntry)
      this.heartbeatTimeout = undefined
    }
  }

  /**
   * Set the log level for this PhoenixWebsocket instance.  If you would like nothing to be logged to the browser console, you can set this to PhoenixWebsocketLogLevels.Quiet.
   *
   * When unchanged, this will log information connection and subscription status to the console by default.
   *
   * @param { PhoenixWebsocketLogLevels } logLevel - The log level to use.
   */
  public setLogLevel(logLevel: PhoenixWebsocketLogLevels): void {
    this.logLevel = logLevel
  }
}

export * from './types/errors'
export * from './types/log-levels'
export * from './types/reply'
export { TopicStatuses, type TopicMessageHandler } from './types/topic'
export * from './types/websocket-statuses'

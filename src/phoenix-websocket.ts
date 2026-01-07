import {
  PhoenixConnectionError,
  PhoenixDisconnectedError,
  PhoenixInternalServerError,
  PhoenixInvalidStateError,
  PhoenixInvalidTopicError,
  PhoenixRespondedWithError,
  PhoenixTimeoutError,
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
  private readonly HEARTBEAT_TIMEOUT_LENGTH = 1000 * 60
  private readonly TIMEOUT_LENGTH = 1000 * 60
  private readonly TIMEOUT_THRESHOLD = 3
  private readonly WORKER_ONLINE_CHECK_INTERVAL = 1500
  private logLevel: PhoenixWebsocketLogLevels = PhoenixWebsocketLogLevels.Warnings
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
  private heartbeatConnectionTimeouts: Set<number> = new Set<number>()
  private phoenixReplyQueue: Map<string, ReplyQueueEntry> = new Map<string, ReplyQueueEntry>()
  private reconnectionTimeout: number | undefined
  private onlineCheckInterval: number | undefined
  private lastOnlineState: boolean = true

  private onConnectedResolvers: (() => void)[] = []
  private onConnectedRejectors: ((error: any) => void)[] = []

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

  private onOnline = () => {
    if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
      console.log('Phoenix Websocket: onOnline')
    }
    if (
      this.socket?.readyState !== WebSocket.OPEN &&
      this.socket?.readyState !== WebSocket.CONNECTING
    ) {
      if (this.reconnectionTimeout) {
        clearTimeout(this.reconnectionTimeout)
        this.reconnectionTimeout = undefined
        this._connect()
      }
    }
  }

  /**
   * In the browser sockets don't always seem to be closed immediately on connection loss, so this event handler forces it if needed.
   */
  private onOffline = () => {
    const readyState = this.socket?.readyState
    if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
      console.log(
        `Phoenix Websocket: onOffline, readyState: ${readyState}, connectionStatus: ${this._connectionStatus}`
      )
    }

    if (readyState != null && readyState !== WebSocket.CLOSED) {
      // If the socket was already closed, then it should already be reconnecting
      // If it wasn't, then update the status to trigger a reconnection (in onClose) rather than closing the socket permanently
      this.socket?.close()
    }
  }

  /**
   * Polling check for online status in web workers
   */
  private checkOnlineStatus = () => {
    const isOnline = navigator.onLine
    if (isOnline !== this.lastOnlineState) {
      this.lastOnlineState = isOnline
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log(`Phoenix Websocket: Connection status changed, online: ${isOnline}`)
      }

      if (!isOnline) {
        this.onOffline()
      } else {
        this.onOnline()
      }
    }
  }

  /**
   * Disconnects the websocket if it isn't already, and then cleans up event listeners.
   * This will also be called by PhoenixWebsocket's Symbol.dispose() if the `using` keyword is preferred over explicitly calling dispose().
   */
  public disposeEvents() {
    if (typeof window !== 'undefined') {
      // Browser environment
      window.removeEventListener('online', this.onOnline)
      window.removeEventListener('offline', this.onOffline)
    }
    if (this.onlineCheckInterval) {
      clearInterval(this.onlineCheckInterval)
      this.onlineCheckInterval = undefined
    }
  }

  protected onOpen(_event: Event): void {
    if (this._connectionStatus === WebsocketStatuses.Reconnecting) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log('Phoenix Websocket, Reconnected...')
      }
    }
    if (this.reconnectionTimeout) {
      clearTimeout(this.reconnectionTimeout)
      this.reconnectionTimeout = undefined
    }
    this.connectionAttempt = 0
    this._connectionStatus = WebsocketStatuses.Connected
    this.onConnectedResolvers.forEach((r) => r())
    this.onConnectedResolvers = []
    this.onConnectedRejectors = []
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
    }
    // Per spec, onClose should always be called after onError, so let onClose handle reconnection logic and error handling
  }

  protected onClose(event?: CloseEvent): void {
    if (
      this._connectionStatus !== WebsocketStatuses.Disconnecting &&
      this._connectionStatus !== WebsocketStatuses.Disconnected
    ) {
      // Close was not intentional, or failed to reconnect
      if (this._connectionStatus !== WebsocketStatuses.Reconnecting) {
        // Unexpectedly closed
        if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
          console.error('Phoenix Websocket: unexpectedly closed.')
        }
      }
      this.disposeOnConnectionError()
      this.attemptReconnection()
    } else {
      // Close was intentional
      this._connectionStatus = WebsocketStatuses.Disconnected
      if (this.reconnectionTimeout) {
        clearTimeout(this.reconnectionTimeout)
        this.reconnectionTimeout = undefined
      }
      this.disposeConnection()
    }
    this.onDisconnectedCallback?.()
  }

  private disposeOnConnectionError(): void {
    this.disposeConnection()
    for (let topic of this.topics.values()) {
      topic.onConnectionError()
    }
  }

  private disposeConnection(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = undefined
    }
    ;[...this.heartbeatConnectionTimeouts.values()].forEach((timeout) => {
      clearTimeout(timeout)
    })
    this.heartbeatConnectionTimeouts.clear()

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
        this.topics
          .get(response.topic ?? '')
          ?.replyQueue.get(response.messageId)
          ?.onReply(response.data as PhoenixOkReply)
        this.topics.get(response.topic ?? '')?.replyQueue.delete(response.messageId)
      } else {
        this.topics
          .get(response.topic ?? '')
          ?.replyQueue.get(response.messageId)
          ?.onError(new PhoenixRespondedWithError(response.data as PhoenixReply))
        this.topics.get(response.topic ?? '')?.replyQueue.delete(response.messageId)
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
    } else if (response.messageId && response.message === 'phx_reply') {
      // Replies without a topicId should always be replies to the base phoenix topic
      if ((response.data as PhoenixReply)?.status === 'ok') {
        if (this.phoenixReplyQueue.has(response.messageId)) {
          this.phoenixReplyQueue.get(response.messageId)?.onReply(response.data as PhoenixOkReply)
          this.phoenixReplyQueue.delete(response.messageId)
        }
      } else if ((response.data as PhoenixReply)?.status === 'error') {
        if (this.phoenixReplyQueue.has(response.messageId)) {
          this.phoenixReplyQueue
            .get(response.messageId)
            ?.onError(new PhoenixRespondedWithError(response.data as PhoenixReply))
          this.phoenixReplyQueue.delete(response.messageId)
        }
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
    return new Promise((resolve, reject) => {
      if (this._connectionStatus === WebsocketStatuses.Connected) {
        resolve()
      } else {
        this.onConnectedResolvers.push(resolve as () => void)
        this.onConnectedRejectors.push(reject)

        if (this._connectionStatus === WebsocketStatuses.Disconnected) {
          if (typeof window !== 'undefined') {
            // Browser environment - online/offline events work reliably
            window.addEventListener('online', this.onOnline)
            window.addEventListener('offline', this.onOffline)
          } else if (
            typeof WorkerGlobalScope !== 'undefined' &&
            typeof self !== 'undefined' &&
            self instanceof WorkerGlobalScope
          ) {
            // Web Worker environment - use polling to check navigator.onLine
            // This works reliably across all browsers including Chromium, in which online/offline events don't work (see https://issues.chromium.org/issues/40155587)
            if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
              if (this.onlineCheckInterval) {
                clearInterval(this.onlineCheckInterval)
                this.onlineCheckInterval = undefined
              }

              this.lastOnlineState = navigator.onLine
              this.onlineCheckInterval = setInterval(
                this.checkOnlineStatus,
                this.WORKER_ONLINE_CHECK_INTERVAL
              )
              if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
                console.log(
                  'Phoenix Websocket: Using polling for connection monitoring in web worker'
                )
              }
            }
          }
          this._connect()
        } else if (this._connectionStatus === WebsocketStatuses.Reconnecting) {
          // Don't wait for timeout and try reconnecting immediately
          if (this.reconnectionTimeout) {
            clearTimeout(this.reconnectionTimeout)
            this.reconnectionTimeout = undefined
            this._connect()
          }
        }
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
    if (
      this.connectionStatus !== WebsocketStatuses.Disconnected &&
      this.connectionStatus !== WebsocketStatuses.Reconnecting
    ) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
        console.error('Phoenix Websocket: Trying to connect while in an invalid state')
      }
      return
    }
    if (
      this.connectionStatus === WebsocketStatuses.Reconnecting &&
      (this.socket?.readyState === WebSocket.CONNECTING ||
        this.socket?.readyState === WebSocket.OPEN)
    ) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Warnings) {
        console.warn(
          new Error(
            `Phoenix Websocket: Attempting to reconnect while an existing socket is trying to connect, this shouldn't happen.`
          )
        )
      }
    }

    try {
      this.socket = new WebSocket(this.wsUrl)
      this.socket.onopen = (e) => this.onOpen(e)
      this.socket.onerror = (e) => this.onError(e)
      this.socket.onclose = (e) => this.onClose(e)
      this.socket.onmessage = (e) => this.onMessage(e)
    } catch (error) {
      if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
        console.error('Phoenix Websocket: Error opening websocket connection:', error)
      }
      this.disposeOnConnectionError()
      this._connectionStatus = WebsocketStatuses.Disconnected
      this.onConnectedRejectors.forEach((r) => r(error))
      this.onConnectedResolvers = []
      this.onConnectedRejectors = []
    }
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
    ;[...this.heartbeatConnectionTimeouts.values()].forEach((timeout) => {
      clearTimeout(timeout)
    })
    this.heartbeatConnectionTimeouts.clear()

    if (this._connectionStatus != WebsocketStatuses.Disconnected) {
      this._connectionStatus = WebsocketStatuses.Disconnecting
    }

    this.topics.forEach((t) => t.onConnectionClosed())

    if (clearTopics) {
      this.topics.clear()
    }

    this.socket?.close()
    this.disposeEvents()
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
   * @param { string } topic - The topic to subscribe to.
   * @param { { [key: string]: any } | undefined } payload - An optional payload object to be sent along with the join request.
   * @param { { [message: string]: TopicMessageHandler } | Map<string, TopicMessageHandler> | undefined } messageHandlers - An optional object containing mappings of messages to message
   *                                                                                                                        handler callbacks, which are called when the given message is
   *                                                                                                                        received.
   * @param { ((reconnectPromise: Promise<void>) => void) | undefined } reconnectHandler - An optional callback which will be called with the connection promise of any subsequent reconnection
   *                                                                                       attempts (useful when, for example, you expect that a topic connection may or may not result in error,
   *                                                                                       and you want to  implement custom logic on these errors).  Specifically will *not* be called with the
   *                                                                                       initial connection Promise returned by this method.
   *
   * @throws { PhoenixInternalServerError }
   * @throws { PhoenixConnectionError }
   * @throws { PhoenixDisconnectedError }
   * @throws { PhoenixRespondedWithError }
   */
  public subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: { [message: string]: TopicMessageHandler },
    reconnectHandler?: (reconnectPromise: Promise<void>) => void
  ): Promise<void>
  public subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: Map<string, TopicMessageHandler>,
    reconnectHandler?: (reconnectPromise: Promise<void>) => void
  ): Promise<void>
  subscribeToTopic(
    topic: string,
    payload?: { [key: string]: any } | undefined,
    messageHandlers?: { [message: string]: TopicMessageHandler } | Map<string, TopicMessageHandler>,
    reconnectHandler?: (reconnectPromise: Promise<void>) => void
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
      newTopic.reconnectionHandler = reconnectHandler
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
      topic.onJoining()
      const message = new PhoenixMessage(
        topic.id,
        this.nextMessageId,
        topic.topic,
        'phx_join',
        topic.joinPayload
      )
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log('Phoenix Websocket: Sending message: ', message.toString())
      }
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
      const message = new PhoenixMessage(
        topic.id,
        this.nextMessageId,
        topic.topic,
        'phx_leave',
        undefined
      )
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log('Phoenix Websocket: Sending message: ', message.toString())
      }
      this.socket?.send(message.toString())
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
      const heartbeatMessageId = newMessage.messageId!
      if (this.logLevel <= PhoenixWebsocketLogLevels.Informative) {
        console.log('Phoenix Websocket: Sending heartbeat: ', newMessage.toString())
      }
      this.socket.send(newMessage.toString())
      this.phoenixReplyQueue.set(heartbeatMessageId, {
        onReply: (_reply) => this.scheduleHeartbeat(),
        onError: (error) => this.onHeartbeatError(error),
      } as ReplyQueueEntry)
      const connectionTimeoutId = setTimeout(() => {
        // If the heartbeat hasn't received a response within HEARTBEAT_TIMEOUT_LENGTH, assume the connection died
        if (this.phoenixReplyQueue.has(heartbeatMessageId)) {
          this.phoenixReplyQueue.get(heartbeatMessageId)!.onError(new PhoenixTimeoutError())
          this.phoenixReplyQueue.delete(heartbeatMessageId)
        }
        this.heartbeatConnectionTimeouts.delete(connectionTimeoutId)
        this.socket?.close()
      }, this.HEARTBEAT_TIMEOUT_LENGTH)
      this.heartbeatConnectionTimeouts.add(connectionTimeoutId)
      this.heartbeatTimeout = undefined
    }
  }

  private onHeartbeatError(error: any): void {
    if (this.logLevel <= PhoenixWebsocketLogLevels.Errors) {
      console.error('Phoenix Websocket: Heartbeat error:', error)
    }

    if (this.socket?.readyState == WebSocket.OPEN) {
      this.socket?.close()
    } else if (
      this.socket?.readyState != WebSocket.CLOSING &&
      this.connectionStatus === WebsocketStatuses.Connected
    ) {
      // This state should never happen, and means this.connectionStatus isn't always being updated correctly
      // In case it does, force the socket disconnection logic to be called.
      try {
        this.socket?.close()
      } catch (error) {}
      this.onClose()
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

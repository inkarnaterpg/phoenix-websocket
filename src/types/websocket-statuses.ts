/** The different states that a PhoenixWebsocket's connection can be in. */
export enum WebsocketStatuses {
  /** Not connected, either because you haven't attempted to connect yet, are in the process of connecting, or have been disconnected. */
  Disconnected,
  /** Successfully connected. */
  Connected,
  /** In the process of disconnecting. */
  Disconnecting,
  /** Unexpectedly disconnected and attempting to automatically reconnect. */
  Reconnecting,
}

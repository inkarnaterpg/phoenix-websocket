# phoenix-websocket

[![NPM version](https://img.shields.io/npm/v/phoenix-websocket.svg)](https://www.npmjs.org/package/phoenix-websocket)
![NPM](https://img.shields.io/npm/l/phoenix-websocket)

> A custom implementation of the Channels API for communicating with an Elixir/Phoenix backend via WebSockets.

Full Documentation: https://inkarnaterpg.github.io/phoenix-websocket/

## How this differs from the `phoenix` package

- Built with async/await.
- Allows defining multiple message handler functions that are called depending on the content of received messages.
- Opinionated in assuming the server will send pre-defined messages with variable payloads.
- Only supports the WebSocket protocol, does not have a LongPoll fallback.
- Does not include built in Presence support
- Configurable timeout which can help avoid flooding the dev console with connection errors. 
- Built with TypeScript and includes definitions without a second dependency.

## Install

```
npm install phoenix-websocket
```

## Usage

### Setup and Configuration
First create a `PhoenixWebsocket` instance, normally you should only need one instance per backend endpoint, which can then be shared throughout your application.
```typescript
const socket = new PhoenixWebsocket("wss://example.io/channel-endpoint")
```

You can optionally pass in a params object to be included with the connection request.
```typescript
const socket = new PhoenixWebsocket("wss://example.io/channel-endpoint", { token: "auth-token" })
```

You can also optionally pass in a timeout value (in milliseconds), which can be helpful if you need a more or less aggressive connection retry, or if you want to avoid having connection errors flooding your development console while testing locally.
```typescript
const socket = new PhoenixWebsocket(
    "wss://example.io/channel-endpoint",
    { token: "auth-token" },
    process.env.NODE_ENV === 'development' ? (1000*60*15) : (1000*30)
)
```

You may also wish to add callbacks for connected/disconnected events.
```typescript
socket.onConnectedCallback = () => {
    // Do something when connected, such as updating the UI
}

socket.onDisconnectedCallback = () => {
     // Do something when disconnected, such as updating the UI
}
```

### Connecting

You can initiate the connection to the server by calling `.connect()` on your PhoenixWebsocket instance.

```typescript
socket.connect().then(() => {
    //Connected!
})
```
Once `.connect()` is called, this library will continue attempting to keep the connection alive, and will automatically try to reconnect after any disconnections, until `.disconnect()` is called.

**Note:** Awaiting the `.connect()` promise and setting a `.onConnectedCallback` listener are both ways to learn when the connection is successfully opened.  The difference is that `.onConnectedCallback` will also be called anytime a reconnection happens, and so it is recommended to use this callback for any UI updates.

### Subscribing to Topics

To send or receive messages, you'll first need to subscribe to a topic.  The simplest way to do this is:
```typescript
socket.subscribeToTopic("exampleTopic")
```

To include a payload object with the request, pass it in as the second parameter:
```typescript
socket.subscribeToTopic("exampleTopic", {userId: "1"})
```

Calling `.subscribeToTopic` with one or two parameters will connect to the topic but will not include any way to handle messages or broadcasts received from the server.  As such this method is only recommended when you intend to interact with the server purely in the Client -> Server direction.  See the following section for instructions on handling server messages.

**Note:** Attempting to subscribe to the same topic twice will result in a warning being logged to the console, but otherwise no action will be taken and the original topic subscription will remain active.  This differs from the behavior of the `phoenix` package which will rejoin a channel on subsequent subscription attempts.  To rejoin a channel with this library, you must first explicitly leave it with `.unsubscribeToTopic()` before re-joining.

### Receiving Server Messages

To handle messages broadcast from the server, you can pass in callbacks to the `.subscribeToTopic()` function which are called when a message is received whose content matches one of the callbacks.  This library currently makes the opinionated assumption that the messages you receive are predefined by the server, and any dynamic content is only included in the payload.  In otherwords, messages are treated as event names while the payload can include any additional data for that event.

Callbacks are passed in as a single object containing key/value entries mapping a message to a callback.  For example:
```typescript
socket.subscribeToTopic("exampleTopic", {userId: "1"},
    {
        user_joined: (payload) => { /** User joined! */},
        user_left: (payload) => { /** User left! */},
    }
)
```

### Handling Error Responses to Topic Join Requests

If the server responds to a join request with an 'error 'status, the topic will not be added to your PhoenixWebsocket instance and the promise will be rejected with the payload of the error response.  An example of handling a join error conditionally based on the message payload is:

```typescript
socket.subscribeToTopic("exampleTopic", {userId: "1"}).catch((payload) => {
        if (payload.errorMsg === "Invalid User") {
            // Do something
        }
    }
)
```

### Sending Messages To The Server

To send a message to a subscribed topic, you can call `.sendMessage()` and optionally include a payload.  To wait for and handle the server's response, you can await the promise returned from `.sendMessage()`.

To send a message without a payload:
```typescript
socket.sendMessage("exampleTopic", "notify_server")
```

To send a message with a payload:
```typescript
socket.sendMessage("exampleTopic", "send_message", {message: "Hello!", attachments: []})
```

To handle a message response:
```typescript
socket.sendMessage("exampleTopic", "query_users").then((reply) => {
    if (reply.status === 'ok') {
        this.userList = [...reply.response.users]
    }
})
```

### Handling Errors With `.sendMessage()`

It's worth noting that the promise returned by `.sendMessage()` will resolve regardless of if the server responded with an 'ok' or 'error' status since we consider any response a valid response.

The `.sendMessage()` function may throw either a `PhoenixInvalidTopicError` or a `PhoenixInvalidStateError` if you try to send a message to a topic you aren't subscribed to, or if the websocket is not currently connected.  These types are exported and can be used to catch these library-specific errors and handle them.  For ex: 
```typescript
try {
    socket.sendMessage("topicImNotSubscribedTo", "test")
}
catch (error) {
    if (error instanceof PhoenixInvalidTopicError || error instanceof PhoenixInvalidStateError) {
        // Do something
    }
    else {
        throw error
    }
}
```

## Maintainer
This library is maintained by [Inkarnate](https://github.com/inkarnaterpg).

In addition, this library is currently in use by us in a high-traffic, production environment.  While we strive to keep this library up-to-date and bug free, there may be use cases not used by us with unknown bugs.  As such, Issue reports and PRs are most welcome.

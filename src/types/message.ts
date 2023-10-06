/**
 * Internal container representing a message sent to the Phoenix server.
 */
export class PhoenixMessage {
  public topicId: string | undefined
  public messageId: string | undefined
  public topic: string | undefined
  public message: string | undefined
  public data: { [key: string]: any } | undefined

  constructor(
    topicId: string | undefined,
    messageId: string | undefined,
    topic: string | undefined,
    message: string | undefined,
    data: { [key: string]: any } | undefined
  ) {
    this.topicId = topicId
    this.messageId = messageId
    this.topic = topic
    this.message = message
    this.data = data
  }

  public toString(): string {
    return JSON.stringify([
      this.topicId ?? null,
      this.messageId != null ? this.messageId.toString() : null,
      this.topic ?? '',
      this.message ?? '',
      this.data ?? ({} as { [key: string]: any }),
    ])
  }
}

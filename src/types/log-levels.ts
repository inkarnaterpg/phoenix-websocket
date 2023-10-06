/**
 * An enum containing the different log levels used for configuring what is logged to the console by a PhoenixWebsocket instance.
 */
export enum PhoenixWebsocketLogLevels {
  /** The most verbose logging level and the default, will log information about connection and subscription status. */
  Informative = 1,
  /** Will log warnings and errors, but not less-important connection status information. */
  Warnings = 2,
  /** Will only log errors. (More specifically, errors which are handled but still logged ot the console as an error.  Exceptions are thrown regardless of this setting.) */
  Errors = 3,
  /** Do not log anything to the console. */
  Quiet = 4,
}

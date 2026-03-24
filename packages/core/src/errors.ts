/** Exception classes for Edictum. */

/** Raised when guard.run() denies a tool call in enforce mode. */
export class EdictumDenied extends Error {
  readonly reason: string
  readonly decisionSource: string | null
  readonly decisionName: string | null

  constructor(
    reason: string,
    decisionSource: string | null = null,
    decisionName: string | null = null,
  ) {
    super(reason)
    this.name = 'EdictumDenied'
    this.reason = reason
    this.decisionSource = decisionSource
    this.decisionName = decisionName
  }
}

/** Raised for configuration/load-time errors (invalid YAML, schema failures, etc.). */
export class EdictumConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdictumConfigError'
  }
}

/** Raised when the governed tool itself fails. */
export class EdictumToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdictumToolError'
  }
}

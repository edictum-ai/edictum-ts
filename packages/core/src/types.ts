/** Shared types for Edictum internals. */

// Hook callbacks have different signatures depending on phase:
// before: (envelope) => HookDecision | Promise<HookDecision>
// after: (envelope, response) => void | Promise<void>
// Using generic callable type here; pipeline narrows at call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any

/** Registration for a hook callback. */
export interface HookRegistration {
  readonly phase: 'before' | 'after'
  readonly tool: string
  readonly callback: AnyFunction
  readonly when?: AnyFunction | null
}

/** Internal tool configuration. */
export interface ToolConfig {
  readonly name: string
  readonly sideEffect: string
  readonly idempotent: boolean
}

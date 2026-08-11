import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { Decision, Edictum } from '@edictum/core'

import { ClaudeAgentSDKAdapter } from '../dist/index.mjs'

const mode = process.argv[2]
if (mode !== 'control' && mode !== 'block' && mode !== 'post') {
  console.error('usage: pnpm verify:live-hooks <control|block|post>')
  process.exit(2)
}

const sentinel = '/tmp/edictum-ts-claude-sdk-hook-sentinel'
const postProbeFile = `/tmp/edictum-ts-claude-sdk-post-probe-${process.pid}`
if (existsSync(sentinel)) {
  unlinkSync(sentinel)
}

let hookDenied = false
let postInputShape = 'NOT_CALLED'
let postInputKeys = 'NOT_CALLED'
let postInputContainedProbe = false
let postconditionWarned = false
let returnedUpdatedToolOutput = false
let returnedHookOutputKeys = 'NOT_CALLED'
let assistantText = ''
let sdkResult = 'NOT_EMITTED'
const postProbe = 'POSTCONDITION_PROBE_VALUE'
const denyTouch = {
  tool: 'Bash',
  check: async (toolCall) => {
    const command = toolCall.args.command
    if (typeof command === 'string' && command.includes('touch') && command.includes(sentinel)) {
      return Decision.fail('live proof denies sentinel creation')
    }
    return Decision.pass_()
  },
}
const suppressProbeOutput = {
  _edictum_type: 'postcondition',
  type: 'postcondition',
  name: 'live_postcondition_probe',
  tool: 'Read',
  effect: 'deny',
  check: async (_toolCall, output) =>
    JSON.stringify(output).includes(postProbe)
      ? Decision.fail('live proof suppresses Read output')
      : Decision.pass_(),
}

const guard = new Edictum({
  rules: mode === 'post' ? [suppressProbeOutput] : [denyTouch],
  tools: mode === 'post' ? { Read: { side_effect: 'read' } } : { Bash: { side_effect: 'execute' } },
  onDeny: () => {
    hookDenied = true
  },
})
const adapter = new ClaudeAgentSDKAdapter(guard, { sessionId: `live-${mode}` })
const hooks = adapter.toSdkHooks({
  onPostconditionWarn: () => {
    postconditionWarned = true
  },
})

if (mode === 'post') {
  writeFileSync(postProbeFile, postProbe, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const originalPostHook = hooks.PostToolUse[0].hooks[0]
  hooks.PostToolUse[0].hooks[0] = async (input, toolUseID, context) => {
    if (input.hook_event_name === 'PostToolUse') {
      postInputShape = Array.isArray(input.tool_response)
        ? 'array'
        : input.tool_response === null
          ? 'null'
          : typeof input.tool_response
      postInputKeys =
        typeof input.tool_response === 'object' && input.tool_response != null
          ? Object.keys(input.tool_response).sort().join(',')
          : 'NONE'
      postInputContainedProbe = JSON.stringify(input.tool_response).includes(postProbe)
    }
    const output = await originalPostHook(input, toolUseID, context)
    const hookOutput = output.hookSpecificOutput
    returnedHookOutputKeys = hookOutput ? Object.keys(hookOutput).sort().join(',') : 'NONE'
    returnedUpdatedToolOutput = Boolean(
      hookOutput && Object.prototype.hasOwnProperty.call(hookOutput, 'updatedToolOutput'),
    )
    return output
  }
}

const options = {
  allowedTools: [mode === 'post' ? 'Read' : 'Bash'],
  permissionMode: 'acceptEdits',
  settingSources: [],
  maxTurns: 2,
  ...(mode === 'control' ? {} : { hooks }),
}

console.log(`MODE=${mode}`)
console.log('SDK=@anthropic-ai/claude-agent-sdk@0.3.221')
console.log(`PREAPPROVED_TOOLS=${mode === 'post' ? 'Read' : 'Bash'}`)
console.log(`HOOKS=${mode === 'control' ? 'REMOVED' : 'ADAPTER'}`)

for await (const message of query({
  prompt:
    mode === 'post'
      ? `Use Read exactly once to read ${postProbeFile}. Then answer only SUPPRESSED if the tool output begins with [OUTPUT SUPPRESSED], otherwise answer only ORIGINAL.`
      : `Use the Bash tool exactly once to run this exact command, then stop: touch ${sentinel}`,
  options,
})) {
  if (message.type === 'assistant') {
    assistantText += message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  if (message.type === 'result') {
    sdkResult = message.subtype
    console.log(`SDK_RESULT=${message.subtype}`)
  }
}

const present = existsSync(sentinel)
if (mode === 'post' && existsSync(postProbeFile)) {
  unlinkSync(postProbeFile)
}
console.log(`HOOK_DENIED=${hookDenied ? 'YES' : 'NO'}`)
console.log(`SENTINEL=${present ? 'PRESENT' : 'ABSENT'}`)

if (mode === 'post') {
  console.log(`POST_INPUT_SHAPE=${postInputShape}`)
  console.log(`POST_INPUT_KEYS=${postInputKeys}`)
  console.log(`POST_INPUT_CONTAINED_PROBE=${postInputContainedProbe ? 'YES' : 'NO'}`)
  console.log(`POSTCONDITION_WARNED=${postconditionWarned ? 'YES' : 'NO'}`)
  console.log(`UPDATED_TOOL_OUTPUT_RETURNED=${returnedUpdatedToolOutput ? 'YES' : 'NO'}`)
  console.log(`HOOK_OUTPUT_KEYS=${returnedHookOutputKeys}`)
  console.log(
    `MODEL_REPORTED_SUPPRESSED=${assistantText.trim().endsWith('SUPPRESSED') ? 'YES' : 'NO'}`,
  )
  console.log(`MODEL_REPORTED_ORIGINAL=${assistantText.trim().endsWith('ORIGINAL') ? 'YES' : 'NO'}`)
}

const passed =
  mode === 'control'
    ? sdkResult === 'success' && present && !hookDenied
    : mode === 'block'
      ? sdkResult === 'success' && !present && hookDenied
      : sdkResult === 'success' &&
        postInputShape !== 'NOT_CALLED' &&
        postInputContainedProbe &&
        postconditionWarned &&
        !returnedUpdatedToolOutput &&
        assistantText.trim().endsWith('ORIGINAL')
if (!passed) {
  process.exitCode = 1
}

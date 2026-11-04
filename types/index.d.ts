export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AdvisorMode = 'ask' | 'auto' | 'off'

export type ShiftDirection = 'down' | 'same' | 'up'

export type StepTally = {
  count: number
  outputTokens: number
}

export type GearboxStats = {
  classifications: number
  asked: number
  accepted: number
  declined: number
  automatic: number
  inputTokens: number
  outputTokens: number
  steps: Readonly<Record<ShiftDirection, StepTally>>
  recachedTokens: number
  subagentSteps: number
}

declare module 'claude-code' {
  interface PluginState {
    'gearbox': {
      mode: AdvisorMode
      override: Effort | null
      sessionEffort: Effort | null
      modelOverride: string | null
      sessionModel: string | null
      isModelSwitching: boolean
      effortCaps: Readonly<Record<string, Effort>>
      declined: string | null
      stats: GearboxStats
    }
  }
}

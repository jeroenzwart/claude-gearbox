import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import type { Effort } from '../types'

const USAGE = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type On = Parameters<TestBody>[1]

type Probe = {
  questions: string[]
  classifierPrompts: string[]
  sentEffort: unknown
  sentModel: unknown
  status: string | undefined
  now: number
}

type StandIn = {
  classifierAnswers: string[]
  pickedLabel?: string
  settings?: Record<string, unknown>
  messages?: unknown[]
  stepUsages?: (StepUsage | null)[]
  agents?: { id: string; type: string }[]
  store?: Record<string, unknown>
}

type StepUsage = { output: number; cacheRead: number; cacheWrite: number }

type Step = { effort?: Effort; model?: string; index?: number; agentId?: string }

function standInEngine (on: On, standIn: StandIn): Probe {
  const probe: Probe = {
    questions: [],
    classifierPrompts: [],
    sentEffort: null,
    sentModel: null,
    status: undefined,
    now: 0,
  }
  on('command.register', () => ({ value: { command: 'gearbox' } }))
  on('ui.status', (_, e) => {
    probe.status = e.text

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: (standIn.messages ?? []) as never }))
  on('settings.read', () => ({ value: (standIn.settings ?? {}) as never }))
  mock.store(on, standIn.store)
  on('clock.now', () => ({ value: probe.now }))
  on('session.cwd', () => ({ value: '/project' }))
  on('agent.list', () => ({ value: (standIn.agents ?? []) as never }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', (_, e) => {
    probe.classifierPrompts.push(e.prompt)
    const text: string = standIn.classifierAnswers.shift() ?? 'KEEP'

    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') {
      return { result: 'exit code 1', isError: true } as never
    }

    const input = e as unknown as { questions: { question: string }[] }
    const question: string = input.questions[0]?.question ?? ''
    probe.questions.push(question)

    return { result: { questions: input.questions, answers: { [question]: standIn.pickedLabel ?? '' } } } as never
  })
  on('turn.step', async function* (_, e) {
    probe.sentEffort = e.effort
    probe.sentModel = e.model

    const stepUsage: StepUsage | null = standIn.stepUsages?.shift() ?? null
    const usage = stepUsage === null ? null : {
      model: 'claude-opus-5-5',
      input_tokens: 2,
      output_tokens: stepUsage.output,
      cache_read_input_tokens: stepUsage.cacheRead,
      cache_creation_input_tokens: stepUsage.cacheWrite,
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  return probe
}

async function start ($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

async function step ($: Engine, request: Step = {}): Promise<void> {
  const stream = $.turn.step({
    turnId: 't',
    index: request.index ?? 0,
    model: request.model ?? 'opus',
    effort: request.effort ?? 'low',
    messageCount: 1,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
  })
  for await (const chunk of stream) {
    void chunk
  }
}

async function submit ($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
}

async function command ($: Engine, args: string): Promise<string> {
  return JSON.stringify(await $.command.run({ command: 'gearbox', args } as never))
}

async function failToolCall ($: Engine): Promise<void> {
  // Widened through unknown: with the generated tool typings, the overloads of call are too deep for tsc (TS2589)
  const tool = $.tool as unknown as { call: (input: unknown) => Promise<unknown> }
  await tool.call({ tool: 'Bash', command: 'false' })
}

test('asks on the first prompt with the current effort known, and sends the pick', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh'], pickedLabel: 'Extra high (recommended)' })

  await start($)
  await submit($, 'Redesign the auth layer across all services')
  await step($)

  expect(probe.questions).toEqual(['This prompt fits effort extra high better (now low). What do you want?'])
  expect(probe.sentEffort).toBe('xhigh')
})

test('keeping the current effort sends the session setting and does not ask again', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['high', 'high'], pickedLabel: 'Keep low' })

  await start($)
  await submit($, 'Debug this flaky test')
  await step($)
  await submit($, 'And the other flaky test')
  await step($)

  expect(probe.questions.length).toBe(1)
  expect(probe.sentEffort).toBe('low')
})

test('auto-adjust switches now and later without asking', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['high', 'max'], pickedLabel: 'Auto-adjust from now on' })

  await start($)
  await submit($, 'Debug this flaky test')
  await step($)
  expect(probe.sentEffort).toBe('high')

  await submit($, 'Now prove the scheduler is deadlock-free')
  await step($)

  expect(probe.questions.length).toBe(1)
  expect(probe.sentEffort).toBe('max')
})

test('the reason leads the question in the built-in dialog', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus nl raakt meerdere lagen.'] })

  await start($)
  await submit($, 'Herontwerp de autorisatielaag van alle services')
  await step($)

  expect(probe.questions).toEqual(['Raakt meerdere lagen. Deze prompt past beter bij effort extra hoog (nu laag). Wat wil je?'])
})

test('the popup speaks the language of the conversation', async ($, on) => {
  const probe: Probe = standInEngine(on, {
    classifierAnswers: ['xhigh opus nl'],
    pickedLabel: 'Extra hoog (aanbevolen)',
    settings: { language: 'English' },
  })

  await start($)
  await submit($, 'Herontwerp de autorisatielaag van alle services')
  await step($)

  expect(probe.questions).toEqual(['Deze prompt past beter bij effort extra hoog (nu laag). Wat wil je?'])
  expect(probe.sentEffort).toBe('xhigh')
})

test('without a known conversation language the popup follows Claude\'s language setting', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus it'], settings: { language: 'Dutch' } })

  await start($)
  await submit($, 'Riprogetta il livello di autorizzazione')
  await step($)

  expect(probe.questions).toEqual(['Deze prompt past beter bij effort extra hoog (nu laag). Wat wil je?'])
})

test('without any known language the popup is English', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus it'], settings: { language: 'Klingon' } })

  await start($)
  await submit($, 'Riprogetta il livello di autorizzazione')
  await step($)

  expect(probe.questions).toEqual(['This prompt fits effort extra high better (now low). What do you want?'])
})

test('a language set with --language wins over the conversation', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus nl'], settings: { language: 'Dutch' } })

  await start($)
  const result: string = await command($, '--language de')
  await submit($, 'Herontwerp de autorisatielaag van alle services')
  await step($)

  expect(result).toContain('Gearbox: Sprache de (jetzt de)')
  expect(probe.questions).toEqual(['Dieser Prompt passt besser zu Effort extra hoch (jetzt niedrig). Was möchtest du?'])
  expect(probe.classifierPrompts[0]).toContain('Write the reason in German.')
})

test('--language auto hands the choice back to the conversation', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus nl'] })

  await start($)
  await command($, '--language de')
  const result: string = await command($, '--language auto')
  await submit($, 'Herontwerp de autorisatielaag van alle services')
  await step($)

  expect(result).toContain('Gearbox: language auto (now en)')
  expect(probe.questions).toEqual(['Deze prompt past beter bij effort extra hoog (nu laag). Wat wil je?'])
})

test('an unknown --language is refused and changes nothing', async ($, on) => {
  standInEngine(on, { classifierAnswers: [], settings: { language: 'Dutch' } })

  await start($)
  const refused: string = await command($, '--language klingon')
  const status: string = await command($, '--language')

  expect(refused).toContain('Onbekende taal klingon. Kies auto, en, nl, de, fr of es.')
  expect(status).toContain('Gearbox: taal auto (nu nl)')
})

test('an unknown argument is refused with the usage', async ($, on) => {
  standInEngine(on, { classifierAnswers: [], settings: { language: 'Dutch' } })

  await start($)
  const refused: string = await command($, 'foo')

  expect(refused).toContain('Onbekend argument foo. Gebruik ask, auto, off, reset, stats, --language <code>, --model <on|off> of --icon <on|off>.')
})

test('the status command shows the level names', async ($, on) => {
  standInEngine(on, { classifierAnswers: ['KEEP opus nl'] })

  await start($)
  await submit($, 'ok ga door met de volgende stap')
  await step($)
  const result: string = await command($, '')

  expect(result).toContain('Gearbox: modus ask, effort laag (sessie-instelling)')
})

test('a one-level downshift is not worth a popup, two levels is', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['low', 'low'], pickedLabel: 'Keep medium' })

  await start($)
  await submit($, 'Rename this variable please')
  await step($, { effort: 'medium' })
  expect(probe.questions.length).toBe(0)

  await submit($, 'Rename that other variable too')
  await step($, { effort: 'high' })

  expect(probe.questions.length).toBe(1)
})

test('the classifier reads the recent conversation', async ($, on) => {
  const messages: unknown[] = [
    { role: 'user', text: 'Refactor the roster planning', toolUses: [] },
    { role: 'assistant', text: 'Done', toolUses: [{ tool_use_id: '1', tool: 'Edit', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [] },
  ]
  const probe: Probe = standInEngine(on, { classifierAnswers: ['KEEP'], messages })

  await start($)
  await submit($, 'Now do the same for the leave module')
  await step($)

  expect(probe.classifierPrompts[0]).toContain('user: Refactor the roster planning\nassistant: Done [tools: Edit]\n\n')
})

test('changing the effort in the app wins over gearbox', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh'], pickedLabel: 'Extra high (recommended)' })

  await start($)
  await submit($, 'Redesign the auth layer across all services')
  await step($)
  expect(probe.sentEffort).toBe('xhigh')

  await step($, { effort: 'medium' })

  expect(probe.sentEffort).toBe('medium')
})

test('the status line shows only the icon, from the start', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: [] })

  await start($)
  expect(probe.status).toBe('▟')
  await step($)

  expect(probe.status).toBe('▟')
})

test('the icon can be hidden and shown again, and leaves with gearbox off', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: [] })

  await start($)
  const hidden: string = await command($, '--icon off')
  expect(hidden).toContain('Gearbox: icon hidden')
  expect(probe.status).toBeUndefined()

  const shown: string = await command($, '--icon on')
  expect(shown).toContain('Gearbox: icon shown')
  expect(probe.status).toBe('▟')

  await command($, 'off')
  expect(probe.status).toBeUndefined()
})

test('an unknown --icon value is refused and keeps the icon', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: [] })

  await start($)
  const refused: string = await command($, '--icon maybe')

  expect(refused).toContain('Unknown argument --icon maybe.')
  expect(probe.status).toBe('▟')
})

test('a decorated classifier answer is still recognised', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['**High.**'] })

  await start($)
  await command($, 'auto')
  await submit($, 'Debug this flaky integration test')
  await step($)

  expect(probe.sentEffort).toBe('high')
})

test('a confirmation or a short prompt is not classified, a longer task is', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['high'] })

  await start($)
  await submit($, 'ja, doe maar')
  await step($)
  await submit($, 'fix de build')
  await step($)
  expect(probe.classifierPrompts.length).toBe(0)

  await submit($, 'fix de build op main')
  await step($)

  expect(probe.classifierPrompts.length).toBe(1)
})

test('KEEP leaves the session effort alone', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['KEEP'] })

  await start($)
  await submit($, 'ok ga door met de volgende stap')
  await step($)

  expect(probe.questions.length).toBe(0)
  expect(probe.sentEffort).toBe('low')
})

test('a level name typed in the conversation language is understood', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['xhigh opus nl'], pickedLabel: 'Hoog' })

  await start($)
  await submit($, 'Herontwerp de autorisatielaag van alle services')
  await step($)

  expect(probe.sentEffort).toBe('high')
})

test('a level the model silently lowers caps the advice for that model', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['max', 'max'], pickedLabel: 'Maximum (recommended)' })
  on('classic.PostToolUse', () => ({}) as never)

  await start($)
  await submit($, 'Prove the scheduler is deadlock-free')
  await step($)
  expect(probe.sentEffort).toBe('max')

  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, effort: { level: 'xhigh' } } as never)
  await step($, { index: 1 })
  expect(probe.sentEffort).toBe('xhigh')

  await submit($, 'And prove the dispatcher is deadlock-free too')
  await step($)

  expect(probe.questions.length).toBe(1)
})

test('repeated failing tool calls reassess the turn, once, upward only', async ($, on) => {
  const probe: Probe = standInEngine(on, {
    classifierAnswers: ['KEEP', 'xhigh', 'max'],
    pickedLabel: 'Extra high (recommended)',
  })

  await start($)
  await submit($, 'Make the integration tests pass again')
  await step($)
  await failToolCall($)
  await step($, { index: 1 })
  expect(probe.classifierPrompts.length).toBe(1)

  await failToolCall($)
  await step($, { index: 2 })
  await failToolCall($)
  await step($, { index: 3 })

  expect(probe.classifierPrompts.length).toBe(2)
  expect(probe.classifierPrompts[1]).toContain('The agent has hit 2 failing tool calls in this turn so far.')
  expect(probe.sentEffort).toBe('xhigh')
})

test('with model switching on, a harder task offers a stronger model', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['high opus en'], pickedLabel: 'High · opus (recommended)' })

  await start($)
  const result: string = await command($, '--model on')
  await submit($, 'Redesign the auth layer across all services')
  await step($, { effort: 'high', model: 'claude-sonnet-5-5' })

  expect(result).toContain('Gearbox: model switching on')
  expect(probe.questions).toEqual(['This prompt fits effort high · opus better (now high · sonnet). What do you want?'])
  expect(probe.sentModel).toBe('claude-opus-5-5')
  expect(probe.sentEffort).toBe('high')
})

test('model switching is off unless asked for', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['high opus en'] })

  await start($)
  await submit($, 'Redesign the auth layer across all services')
  await step($, { effort: 'high', model: 'claude-sonnet-5-5' })

  expect(probe.questions.length).toBe(0)
  expect(probe.sentModel).toBe('claude-sonnet-5-5')
})

test('stats count the assessments, the answers and the classifier tokens', async ($, on) => {
  standInEngine(on, { classifierAnswers: ['xhigh', 'KEEP'], pickedLabel: 'Extra high (recommended)' })

  await start($)
  await submit($, 'Redesign the auth layer across all services')
  await step($)
  await submit($, 'Then document the new layer for the team')
  await step($)
  const result: string = await command($, 'stats')

  expect(result).toContain('Gearbox: 2 prompts assessed, 1 asked (1 accepted, 0 declined), 0 switched automatically; classifier 20 input and 4 output tokens')
})

test('a shift that keeps the prompt cache leaves downshifts free', async ($, on) => {
  const probe: Probe = standInEngine(on, {
    classifierAnswers: ['low', 'low'],
    pickedLabel: 'Low (recommended)',
    stepUsages: [{ output: 900, cacheRead: 0, cacheWrite: 60000 }, { output: 100, cacheRead: 60000, cacheWrite: 500 }],
  })

  await start($)
  await step($, { effort: 'high' })
  await submit($, 'Rename this variable in the parser please')
  await step($, { effort: 'high' })

  expect(probe.sentEffort).toBe('low')
  expect(await command($, 'stats')).toContain('0 tokens cached again after a shift')
})

test('a shift that drops the prompt cache is counted', async ($, on) => {
  standInEngine(on, {
    classifierAnswers: ['low'],
    pickedLabel: 'Low (recommended)',
    stepUsages: [{ output: 900, cacheRead: 0, cacheWrite: 60000 }, { output: 100, cacheRead: 0, cacheWrite: 60000 }],
  })

  await start($)
  await step($, { effort: 'high' })
  await submit($, 'Rename this variable in the parser please')
  await step($, { effort: 'high' })

  expect(await command($, 'stats')).toContain('60000 tokens cached again after a shift')
})

test('once shifts are seen to drop the cache, a downshift waits for a cold cache', async ($, on) => {
  const probe: Probe = standInEngine(on, {
    classifierAnswers: ['low', 'low'],
    stepUsages: [{ output: 900, cacheRead: 0, cacheWrite: 60000 }],
    store: { cacheEvidence: { shifts: 2, breaks: 2 } },
  })

  await start($)
  await step($, { effort: 'high' })
  await submit($, 'Rename this variable in the parser please')
  await step($, { effort: 'high' })
  expect(probe.questions.length).toBe(0)

  probe.now = 2 * 60 * 60 * 1000
  await submit($, 'Rename that other variable too please')
  await step($, { effort: 'high' })

  expect(probe.questions.length).toBe(1)
})

test('an Explore subagent runs at low effort, another agent and gearbox off leave it alone', async ($, on) => {
  const probe: Probe = standInEngine(on, {
    classifierAnswers: [],
    agents: [{ id: 'explore-1', type: 'Explore' }, { id: 'general-1', type: 'general-purpose' }],
  })

  await start($)
  await step($, { effort: 'high', agentId: 'explore-1' })
  expect(probe.sentEffort).toBe('low')
  await step($, { effort: 'high', agentId: 'general-1' })
  expect(probe.sentEffort).toBe('high')
  expect(await command($, 'stats')).toContain('1 subagent steps lightened')

  await command($, 'off')
  await step($, { effort: 'high', agentId: 'explore-1' })

  expect(probe.sentEffort).toBe('high')
})

test('stats estimate the output tokens a lighter step saved', async ($, on) => {
  standInEngine(on, {
    classifierAnswers: ['low'],
    pickedLabel: 'Low (recommended)',
    stepUsages: [{ output: 1000, cacheRead: 0, cacheWrite: 0 }, { output: 200, cacheRead: 0, cacheWrite: 0 }],
  })

  await start($)
  await step($, { effort: 'high' })
  await submit($, 'Rename this variable in the parser please')
  await step($, { effort: 'high' })

  expect(await command($, 'stats')).toContain('estimated 800 output tokens saved on lighter steps, 0 extra on heavier ones')
})

test('after three declines in a row a project is no longer asked that way, until reset', async ($, on) => {
  const probe: Probe = standInEngine(on, { classifierAnswers: ['low', 'medium', 'high', 'low', 'low'], pickedLabel: '' })

  await start($)
  for (const prompt of ['Rename the first variable please', 'Rename the second variable please', 'Rename the third variable please']) {
    await submit($, prompt)
    await step($, { effort: 'max' })
  }
  expect(probe.questions.length).toBe(3)

  await submit($, 'Rename the fourth variable please')
  await step($, { effort: 'max' })
  expect(probe.questions.length).toBe(3)

  await command($, 'reset')
  await submit($, 'Rename the fifth variable please')
  await step($, { effort: 'max' })

  expect(probe.questions.length).toBe(4)
})

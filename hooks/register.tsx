import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'

import type { AdvisorMode, Effort, GearboxStats, ShiftDirection, StepTally } from '../types'

type Language = 'en' | 'nl' | 'de' | 'fr' | 'es'

type ModelFamily = 'haiku' | 'sonnet' | 'opus'

type Texts = {
  levels: Readonly<Record<Effort, string>>
  question: (recommended: string, current: string) => string
  recommended: (recommended: string) => string
  keep: (current: string) => string
  auto: string
  unknown: string
  description: string
  status: (mode: AdvisorMode, effort: string, isChosenByGearbox: boolean) => string
  languageStatus: (setting: string, active: Language) => string
  languageInvalid: (value: string) => string
  modelSwitching: (isOn: boolean) => string
  iconStatus: (isShown: boolean) => string
  unknownArgument: (value: string) => string
  stats: (stats: GearboxStats) => string
  savings: (saved: number | null, extra: number | null, recached: number, subagentSteps: number) => string
}

type Classification = {
  effort: Effort | null
  model: ModelFamily | null
  language: Language | null
  reason: string
}

type Recommendation = { effort: Effort | null; model: string | null; reason: string }

type ShiftPolicy = (shift: number) => boolean

type StepRecord = { effort: TurnStepInput['effort']; model: string; cachedTokens: number; at: number }

type Counts = Readonly<Record<string, number>>

const COMMAND = 'gearbox'
const LANGUAGE_FLAG = '--language'
const MODEL_FLAG = '--model'
const ICON_FLAG = '--icon'
const LANGUAGE_STORE_KEY = 'language'
const ICON_STORE_KEY = 'icon'
const CACHE_STORE_KEY = 'cacheEvidence'
const PROJECT_STORE_PREFIX = 'declines:'
// The status line takes text only, so the icon is a quadrant block that rises to the right like the logo's step
const ICON = '▟'
const LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const FAMILIES: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus']
const MODEL_TIMEOUT_MS = 3000
const CONTEXT_MESSAGE_COUNT = 6
const FAILED_TOOL_CALL_THRESHOLD = 2
// shortcut: a short prompt is judged worth no shift, which misses a terse but heavy one ("herschrijf de auth-laag"); lower it if that bites
const MINIMUM_WORD_COUNT = 4
// Claude Code writes its prompt cache with a one-hour lifetime; past that a shift costs no cached prefix
const COLD_CACHE_MS = 60 * 60 * 1000
// A step after a shift that reads less than half of what the step before cached has lost the prompt cache
const CACHE_BREAK_SHARE = 0.5
const DECLINE_LIMIT = 3
// Agent types that only search and read, where a high effort buys little
const LIGHT_AGENT_TYPES: ReadonlySet<string> = new Set(['Explore'])
const LIGHT_AGENT_EFFORT: Effort = 'low'
const NO_STEPS: StepTally = { count: 0, outputTokens: 0 }
const NO_STATS: GearboxStats = {
  classifications: 0,
  asked: 0,
  accepted: 0,
  declined: 0,
  automatic: 0,
  inputTokens: 0,
  outputTokens: 0,
  steps: { down: NO_STEPS, same: NO_STEPS, up: NO_STEPS },
  recachedTokens: 0,
  subagentSteps: 0,
}

const mode = atom({ plugin: 'gearbox', key: 'mode' } as const, 'ask')
const override = atom({ plugin: 'gearbox', key: 'override' } as const, null)
const sessionEffort = atom({ plugin: 'gearbox', key: 'sessionEffort' } as const, null)
const modelOverride = atom({ plugin: 'gearbox', key: 'modelOverride' } as const, null)
const sessionModel = atom({ plugin: 'gearbox', key: 'sessionModel' } as const, null)
const isModelSwitching = atom({ plugin: 'gearbox', key: 'isModelSwitching' } as const, false)
const effortCaps = atom({ plugin: 'gearbox', key: 'effortCaps' } as const, {})
const declined = atom({ plugin: 'gearbox', key: 'declined' } as const, null)
const stats = atom({ plugin: 'gearbox', key: 'stats' } as const, NO_STATS)

let conversationLanguage: Language | null = null
let pendingPrompt: string | null = null
let turnPrompt: string | null = null
let failedToolCalls = 0
let hasReassessedTurn = false
let lastSentEffort: Effort | null = null
let lastModel: string | null = null
let lastStep: StepRecord | null = null
const agentTypes: Map<string, string> = new Map()

const CLASSIFIER_SYSTEM = [
  'You pick the reasoning effort and model tier a coding agent should use for the next user prompt.',
  'Weigh the recent conversation: a prompt that continues a hard task stays hard.',
  'low: trivial questions, lookups, renames, one-line edits, chit-chat.',
  'medium: ordinary edits and explanations within one or two files.',
  'high: multi-file features, debugging with unclear cause, code review.',
  'xhigh: architecture, hard debugging across layers, security or data-loss risk.',
  'max: very hard problems where correctness dominates cost and time.',
  'Model tiers: haiku for trivial work, sonnet for ordinary work, opus for hard work.',
  'Use KEEP as the effort when the prompt only continues or confirms the previous task.',
  'Answer on one line: the effort (low, medium, high, xhigh, max or KEEP), the model tier (haiku, sonnet or opus),'
    + ' the ISO 639-1 code of the language the user writes in, then a reason of at most eight words,'
    + ' e.g. "high opus en touches several layers of the planning".',
].join('\n')

const TEXTS: Readonly<Record<Language, Texts>> = {
  en: {
    levels: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' },
    question: (recommended, current) => `This prompt fits effort ${recommended.toLocaleLowerCase()} better (now ${current.toLocaleLowerCase()}). What do you want?`,
    recommended: recommended => `${recommended} (recommended)`,
    keep: current => `Keep ${current.toLocaleLowerCase()}`,
    auto: 'Auto-adjust from now on',
    unknown: 'unknown',
    description: 'Gearbox: ask | auto | off | reset | stats | --language <auto|en|nl|de|fr|es> | --model <on|off> | --icon <on|off> (no argument: status)',
    status: (mode, effort, isChosenByGearbox) =>
      `Gearbox: mode ${mode}, effort ${effort.toLocaleLowerCase()} (${isChosenByGearbox ? 'chosen by gearbox' : 'session setting'})`,
    languageStatus: (setting, active) => `Gearbox: language ${setting} (now ${active})`,
    languageInvalid: value => `Unknown language ${value}. Choose auto, en, nl, de, fr or es.`,
    modelSwitching: isOn => `Gearbox: model switching ${isOn ? 'on' : 'off'}`,
    iconStatus: isShown => `Gearbox: icon ${isShown ? 'shown' : 'hidden'}`,
    unknownArgument: value => `Unknown argument ${value}. Use ask, auto, off, reset, stats, --language <code>, --model <on|off> or --icon <on|off>.`,
    stats: count => `Gearbox: ${count.classifications} prompts assessed, ${count.asked} asked (${count.accepted} accepted, ${count.declined} declined),`
      + ` ${count.automatic} switched automatically; classifier ${count.inputTokens} input and ${count.outputTokens} output tokens`,
    savings: (saved, extra, recached, subagentSteps) => `estimated ${saved ?? '?'} output tokens saved on lighter steps, ${extra ?? '?'} extra on heavier ones;`
      + ` ${recached} tokens cached again after a shift; ${subagentSteps} subagent steps lightened`,
  },
  nl: {
    levels: { low: 'Laag', medium: 'Gemiddeld', high: 'Hoog', xhigh: 'Extra hoog', max: 'Maximaal' },
    question: (recommended, current) => `Deze prompt past beter bij effort ${recommended.toLocaleLowerCase()} (nu ${current.toLocaleLowerCase()}). Wat wil je?`,
    recommended: recommended => `${recommended} (aanbevolen)`,
    keep: current => `${current} behouden`,
    auto: 'Vanaf nu automatisch aanpassen',
    unknown: 'onbekend',
    description: 'Gearbox: ask | auto | off | reset | stats | --language <auto|en|nl|de|fr|es> | --model <on|off> | --icon <on|off> (zonder argument: status)',
    status: (mode, effort, isChosenByGearbox) =>
      `Gearbox: modus ${mode}, effort ${effort.toLocaleLowerCase()} (${isChosenByGearbox ? 'door gearbox gekozen' : 'sessie-instelling'})`,
    languageStatus: (setting, active) => `Gearbox: taal ${setting} (nu ${active})`,
    languageInvalid: value => `Onbekende taal ${value}. Kies auto, en, nl, de, fr of es.`,
    modelSwitching: isOn => `Gearbox: model schakelen ${isOn ? 'aan' : 'uit'}`,
    iconStatus: isShown => `Gearbox: icoon ${isShown ? 'zichtbaar' : 'verborgen'}`,
    unknownArgument: value => `Onbekend argument ${value}. Gebruik ask, auto, off, reset, stats, --language <code>, --model <on|off> of --icon <on|off>.`,
    stats: count => `Gearbox: ${count.classifications} prompts beoordeeld, ${count.asked} keer gevraagd (${count.accepted} overgenomen, ${count.declined} afgewezen),`
      + ` ${count.automatic} keer automatisch geschakeld; classifier ${count.inputTokens} invoer- en ${count.outputTokens} uitvoertokens`,
    savings: (saved, extra, recached, subagentSteps) => `geschat ${saved ?? '?'} uitvoertokens bespaard op lichtere stappen, ${extra ?? '?'} extra op zwaardere;`
      + ` ${recached} tokens opnieuw gecachet na een schakeling; ${subagentSteps} subagent-stappen lichter gemaakt`,
  },
  de: {
    levels: { low: 'Niedrig', medium: 'Mittel', high: 'Hoch', xhigh: 'Extra hoch', max: 'Maximal' },
    question: (recommended, current) => `Dieser Prompt passt besser zu Effort ${recommended.toLocaleLowerCase()} (jetzt ${current.toLocaleLowerCase()}). Was möchtest du?`,
    recommended: recommended => `${recommended} (empfohlen)`,
    keep: current => `${current} beibehalten`,
    auto: 'Ab jetzt automatisch anpassen',
    unknown: 'unbekannt',
    description: 'Gearbox: ask | auto | off | reset | stats | --language <auto|en|nl|de|fr|es> | --model <on|off> | --icon <on|off> (ohne Argument: Status)',
    status: (mode, effort, isChosenByGearbox) =>
      `Gearbox: Modus ${mode}, Effort ${effort.toLocaleLowerCase()} (${isChosenByGearbox ? 'von Gearbox gewählt' : 'Sitzungseinstellung'})`,
    languageStatus: (setting, active) => `Gearbox: Sprache ${setting} (jetzt ${active})`,
    languageInvalid: value => `Unbekannte Sprache ${value}. Wähle auto, en, nl, de, fr oder es.`,
    modelSwitching: isOn => `Gearbox: Modellwechsel ${isOn ? 'an' : 'aus'}`,
    iconStatus: isShown => `Gearbox: Symbol ${isShown ? 'sichtbar' : 'ausgeblendet'}`,
    unknownArgument: value => `Unbekanntes Argument ${value}. Verwende ask, auto, off, reset, stats, --language <Code>, --model <on|off> oder --icon <on|off>.`,
    stats: count => `Gearbox: ${count.classifications} Prompts bewertet, ${count.asked}-mal gefragt (${count.accepted} übernommen, ${count.declined} abgelehnt),`
      + ` ${count.automatic}-mal automatisch gewechselt; Klassifikator ${count.inputTokens} Eingabe- und ${count.outputTokens} Ausgabetokens`,
    savings: (saved, extra, recached, subagentSteps) => `geschätzt ${saved ?? '?'} Ausgabetokens gespart bei leichteren Schritten, ${extra ?? '?'} mehr bei schwereren;`
      + ` ${recached} Tokens nach einem Wechsel neu gecacht; ${subagentSteps} Subagent-Schritte erleichtert`,
  },
  fr: {
    levels: { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximal' },
    question: (recommended, current) => `Ce prompt correspond mieux à l'effort ${recommended.toLocaleLowerCase()} (actuellement ${current.toLocaleLowerCase()}). Que veux-tu faire ?`,
    recommended: recommended => `${recommended} (recommandé)`,
    keep: current => `Garder ${current.toLocaleLowerCase()}`,
    auto: 'Ajuster automatiquement désormais',
    unknown: 'inconnu',
    description: 'Gearbox : ask | auto | off | reset | stats | --language <auto|en|nl|de|fr|es> | --model <on|off> | --icon <on|off> (sans argument : statut)',
    status: (mode, effort, isChosenByGearbox) =>
      `Gearbox : mode ${mode}, effort ${effort.toLocaleLowerCase()} (${isChosenByGearbox ? 'choisi par gearbox' : 'réglage de la session'})`,
    languageStatus: (setting, active) => `Gearbox : langue ${setting} (actuellement ${active})`,
    languageInvalid: value => `Langue inconnue ${value}. Choisis auto, en, nl, de, fr ou es.`,
    modelSwitching: isOn => `Gearbox : changement de modèle ${isOn ? 'activé' : 'désactivé'}`,
    iconStatus: isShown => `Gearbox : icône ${isShown ? 'affichée' : 'masquée'}`,
    unknownArgument: value => `Argument inconnu ${value}. Utilise ask, auto, off, reset, stats, --language <code>, --model <on|off> ou --icon <on|off>.`,
    stats: count => `Gearbox : ${count.classifications} prompts évalués, ${count.asked} questions posées (${count.accepted} acceptées, ${count.declined} refusées),`
      + ` ${count.automatic} changements automatiques ; classifieur ${count.inputTokens} tokens d'entrée et ${count.outputTokens} de sortie`,
    savings: (saved, extra, recached, subagentSteps) => `environ ${saved ?? '?'} tokens de sortie économisés sur les étapes plus légères, ${extra ?? '?'} de plus sur les plus lourdes ;`
      + ` ${recached} tokens remis en cache après un changement ; ${subagentSteps} étapes de sous-agent allégées`,
  },
  es: {
    levels: { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' },
    question: (recommended, current) => `Este prompt encaja mejor con effort ${recommended.toLocaleLowerCase()} (ahora ${current.toLocaleLowerCase()}). ¿Qué quieres hacer?`,
    recommended: recommended => `${recommended} (recomendado)`,
    keep: current => `Mantener ${current.toLocaleLowerCase()}`,
    auto: 'Ajustar automáticamente a partir de ahora',
    unknown: 'desconocido',
    description: 'Gearbox: ask | auto | off | reset | stats | --language <auto|en|nl|de|fr|es> | --model <on|off> | --icon <on|off> (sin argumento: estado)',
    status: (mode, effort, isChosenByGearbox) =>
      `Gearbox: modo ${mode}, effort ${effort.toLocaleLowerCase()} (${isChosenByGearbox ? 'elegido por gearbox' : 'ajuste de la sesión'})`,
    languageStatus: (setting, active) => `Gearbox: idioma ${setting} (ahora ${active})`,
    languageInvalid: value => `Idioma desconocido ${value}. Elige auto, en, nl, de, fr o es.`,
    modelSwitching: isOn => `Gearbox: cambio de modelo ${isOn ? 'activado' : 'desactivado'}`,
    iconStatus: isShown => `Gearbox: icono ${isShown ? 'visible' : 'oculto'}`,
    unknownArgument: value => `Argumento desconocido ${value}. Usa ask, auto, off, reset, stats, --language <código>, --model <on|off> o --icon <on|off>.`,
    stats: count => `Gearbox: ${count.classifications} prompts evaluados, ${count.asked} preguntas (${count.accepted} aceptadas, ${count.declined} rechazadas),`
      + ` ${count.automatic} cambios automáticos; clasificador ${count.inputTokens} tokens de entrada y ${count.outputTokens} de salida`,
    savings: (saved, extra, recached, subagentSteps) => `aprox. ${saved ?? '?'} tokens de salida ahorrados en pasos más ligeros, ${extra ?? '?'} extra en los más pesados;`
      + ` ${recached} tokens cacheados de nuevo tras un cambio; ${subagentSteps} pasos de subagente aligerados`,
  },
}

const LANGUAGE_NAMES_IN_ENGLISH: Readonly<Record<Language, string>> = {
  en: 'English',
  nl: 'Dutch',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
}

// Claude's `language` setting is free text, so its common spellings map to a language too
const LANGUAGE_NAMES: Readonly<Record<string, Language>> = {
  en: 'en', english: 'en', engels: 'en',
  nl: 'nl', dutch: 'nl', nederlands: 'nl',
  de: 'de', german: 'de', deutsch: 'de', duits: 'de',
  fr: 'fr', french: 'fr', français: 'fr', francais: 'fr', frans: 'fr',
  es: 'es', spanish: 'es', español: 'es', espanol: 'es', spaans: 'es',
}

// A prompt made only of these words confirms the running task, so it is not worth a classification
const CONFIRMATION_WORDS: ReadonlySet<string> = new Set([
  'ja', 'jep', 'jawel', 'nee', 'ok', 'oke', 'oké', 'okay', 'prima', 'top', 'goed', 'mooi', 'super', 'klopt', 'akkoord',
  'doe', 'maar', 'dat', 'ga', 'door', 'verder', 'graag', 'dank', 'je', 'bedankt', 'gedaan',
  'yes', 'yep', 'yeah', 'no', 'sure', 'go', 'on', 'ahead', 'continue', 'please', 'do', 'it', 'fine', 'great', 'nice',
  'correct', 'right', 'cool', 'perfect', 'thanks', 'thank', 'you', 'thx', 'done',
  'nein', 'gut', 'danke', 'bitte', 'mach', 'weiter', 'genau',
  'oui', 'non', 'merci', 'vas-y', "d'accord", 'parfait',
  'sí', 'si', 'vale', 'gracias', 'sigue', 'adelante', 'perfecto', 'claro',
])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const texts: Texts = await resolveTexts($)
    await $.command.register({ name: COMMAND, description: texts.description })
    await showStatus($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    return { text: await runCommand($, e.args.trim()) }
  })

  on('prompt.submit', async ($, e, next) => {
    const isClassified = e.command === undefined
      && e.isMeta !== true
      && e.turnId === undefined
      && isWorthClassifying(e.text)
      && (await read($, mode)) !== 'off'
    pendingPrompt = isClassified ? e.text : null

    return next(e)
  })

  // The advice runs at a turn's requests, the first moment the session's effort and model are known
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(await lightenSubagent($, e))
    }
    if (typeof e.effort !== 'string') {
      return yield* next(e)
    }

    await recordSessionModel($, e.model)
    await recordSessionEffort($, e.effort)
    await assessTurn($, e.index)
    const request: TurnStepInput = await applyOverrides($, e)
    lastModel = request.model
    lastSentEffort = await read($, override)
    const result: TurnStepResult = yield* next(request)
    await recordStepUsage($, request, result.usage)

    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.isError === true) {
      failedToolCalls += 1
    }

    return result
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await recordEffortCap($, e.agent_id, e.effort?.level)

    return next(e)
  })
}

function isWorthClassifying (prompt: string): boolean {
  const words: string[] = prompt.toLocaleLowerCase().split(/[^\p{L}'-]+/u).filter(word => word !== '')

  return words.length >= MINIMUM_WORD_COUNT && words.some(word => CONFIRMATION_WORDS.has(word) === false)
}

async function assessTurn ($: EngineInterface, index: number): Promise<void> {
  if (index === 0) {
    failedToolCalls = 0
    hasReassessedTurn = false
    turnPrompt = pendingPrompt
  }

  const prompt: string | null = pendingPrompt
  pendingPrompt = null
  if (prompt !== null) {
    await assess($, prompt, '', (await isDownshiftFree($)) ? isWorthShifting : isUpshift)

    return
  }

  if (
    index === 0
    || hasReassessedTurn
    || failedToolCalls < FAILED_TOOL_CALL_THRESHOLD
    || (await read($, mode)) === 'off'
  ) {
    return
  }

  hasReassessedTurn = true
  const note: string = `The agent has hit ${failedToolCalls} failing tool calls in this turn so far.`
  await assess($, turnPrompt ?? '', note, isUpshift)
}

async function assess ($: EngineInterface, prompt: string, note: string, policy: ShiftPolicy): Promise<void> {
  const classification: Classification = await classify($, prompt, note)
  conversationLanguage = classification.language ?? conversationLanguage
  const recommendation: Recommendation | null = await recommend($, classification, policy)
  if (recommendation === null) {
    return
  }

  await adviseSwitch($, recommendation, await resolveTexts($))
}

async function classify ($: EngineInterface, prompt: string, note: string): Promise<Classification> {
  const current: Effort | null = await currentEffort($)
  const conversation: string = await describeRecentConversation($, prompt)
  const stored: Language | null = await storedLanguage($)
  const result = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 40,
    timeoutMs: MODEL_TIMEOUT_MS,
    system: CLASSIFIER_SYSTEM,
    prompt: [
      `Current effort: ${current ?? 'unknown'}`,
      `Recent conversation, oldest first:\n${conversation === '' ? '(none)' : conversation}`,
      `Next prompt: ${prompt === '' ? '(a continuation of the conversation)' : prompt.slice(0, 4000)}`,
      note,
      `Write the reason in ${stored === null ? 'the language the user writes in' : LANGUAGE_NAMES_IN_ENGLISH[stored]}.`,
    ].filter(part => part !== '').join('\n\n'),
  })
  await update($, stats, count => ({
    ...count,
    classifications: count.classifications + 1,
    inputTokens: count.inputTokens + result.usage.input_tokens,
    outputTokens: count.outputTokens + result.usage.output_tokens,
  }))
  if (result.isAnswered === false) {
    return { effort: null, model: null, language: null, reason: '' }
  }

  return parseClassification(result.text)
}

function parseClassification (text: string): Classification {
  const [effortWord, modelWord, languageWord, ...reasonWords] = text.trim().split(/\s+/)

  return {
    effort: toEffort(effortWord ?? ''),
    model: toFamily(modelWord ?? ''),
    language: toLanguage(languageWord ?? ''),
    reason: capitalize(reasonWords.join(' ').replace(/^["'“]+|["'”.]+$/g, '').slice(0, 80)),
  }
}

async function describeRecentConversation ($: EngineInterface, prompt: string): Promise<string> {
  const messages: SessionMessage[] = await $.session.messages()

  return messages
    .filter(message => prompt === '' || message.text !== prompt)
    .map(describeMessage)
    .filter(line => line !== '')
    .slice(-CONTEXT_MESSAGE_COUNT)
    .join('\n')
}

function describeMessage (message: SessionMessage): string {
  const text: string = message.text.slice(0, 500)
  const tools: string = message.toolUses.map(toolUse => toolUse.tool).join(', ')
  if (text === '' && tools === '') {
    return ''
  }

  return `${message.role}: ${text}${tools === '' ? '' : ` [tools: ${tools}]`}`
}

async function recommend ($: EngineInterface, classification: Classification, policy: ShiftPolicy): Promise<Recommendation | null> {
  const model: string | null = await recommendModel($, classification.model, policy)
  const effort: Effort | null = await recommendEffort($, classification.effort, model ?? lastModel, policy)
  if (
    (effort === null && model === null)
    || recommendationKey(effort, model) === (await read($, declined))
  ) {
    return null
  }

  return { effort, model, reason: classification.reason }
}

async function recommendEffort ($: EngineInterface, wanted: Effort | null, targetModel: string | null, policy: ShiftPolicy): Promise<Effort | null> {
  const current: Effort | null = await currentEffort($)
  if (wanted === null || current === null) {
    return null
  }

  const capped: Effort = capEffort(wanted, targetModel === null ? undefined : (await read($, effortCaps))[targetModel])

  return policy(LEVELS.indexOf(capped) - LEVELS.indexOf(current)) ? capped : null
}

async function recommendModel ($: EngineInterface, wanted: ModelFamily | null, policy: ShiftPolicy): Promise<string | null> {
  const current: string | null = await currentModel($)
  const currentFamily: ModelFamily | null = familyOf(current ?? '')
  if (
    wanted === null
    || current === null
    || currentFamily === null
    || (await read($, isModelSwitching)) === false
    || policy(FAMILIES.indexOf(wanted) - FAMILIES.indexOf(currentFamily)) === false
  ) {
    return null
  }

  // shortcut: assumes every family shares the current model's generation suffix, list the models once the engine exposes them
  return current.replace(/claude-(haiku|sonnet|opus)-/, `claude-${wanted}-`)
}

function capEffort (effort: Effort, cap: Effort | undefined): Effort {
  if (cap === undefined || LEVELS.indexOf(effort) <= LEVELS.indexOf(cap)) {
    return effort
  }

  return cap
}

// Any upshift counts; a downshift only from two steps down, so a hard task is not dropped halfway
function isWorthShifting (shift: number): boolean {
  return shift > 0 || shift <= -2
}

function isUpshift (shift: number): boolean {
  return shift > 0
}

function recommendationKey (effort: Effort | null, model: string | null): string {
  return `${effort ?? '-'}|${model ?? '-'}`
}

async function adviseSwitch ($: EngineInterface, recommendation: Recommendation, texts: Texts): Promise<void> {
  if ((await read($, mode)) === 'auto') {
    await choose($, recommendation)
    await countStat($, 'automatic')
    const shown: string = await describeSetting($, texts, recommendation.effort, recommendation.model)
    $.ui.toast(`effort → ${shown}${recommendation.reason === '' ? '' : `: ${recommendation.reason}`}`)

    return
  }

  await askToSwitch($, recommendation, texts)
}

async function askToSwitch ($: EngineInterface, recommendation: Recommendation, texts: Texts): Promise<void> {
  const direction: ShiftDirection = await directionOf($, recommendation)
  if (((await readCounts($, await projectStoreKey($)))[direction] ?? 0) >= DECLINE_LIMIT) {
    return
  }

  const modelShown: string | null = recommendation.model === null ? null : await currentModel($)
  const currentName: string = await describeSetting($, texts, null, modelShown)
  const recommendedName: string = await describeSetting($, texts, recommendation.effort, recommendation.model)
  const recommendedLabel: string = texts.recommended(recommendedName)
  const autoLabel: string = texts.auto
  const plainQuestion: string = texts.question(recommendedName, currentName)
  const question: string = recommendation.reason === '' ? plainQuestion : `${recommendation.reason}. ${plainQuestion}`
  const options: readonly string[] = [recommendedLabel, texts.keep(currentName), autoLabel]
  await countStat($, 'asked')

  // The dialog rejects when dismissed, which counts as declining
  const answer: string | null = await $.ui.ask(question, { header: 'Effort', options }).catch(() => null)
  if (answer === autoLabel) {
    await update($, mode, () => 'auto' as AdvisorMode)
  }
  if (answer === recommendedLabel || answer === autoLabel) {
    await choose($, recommendation)
    await countStat($, 'accepted')
    await recordDecision($, direction, false)

    return
  }

  const typed: Effort | null = toEffort(answer ?? '') ?? fromLevelName(answer ?? '', texts)
  if (typed !== null) {
    await choose($, { effort: typed, model: null, reason: '' })
    await countStat($, 'accepted')
    await recordDecision($, direction, false)

    return
  }

  await update($, declined, () => recommendationKey(recommendation.effort, recommendation.model))
  await countStat($, 'declined')
  await recordDecision($, direction, true)
}

async function directionOf ($: EngineInterface, recommendation: Recommendation): Promise<ShiftDirection> {
  const current: Effort | null = await currentEffort($)
  if (recommendation.effort !== null && current !== null) {
    return toDirection(LEVELS.indexOf(recommendation.effort) - LEVELS.indexOf(current))
  }

  const currentFamily: ModelFamily | null = familyOf((await currentModel($)) ?? '')
  const family: ModelFamily | null = familyOf(recommendation.model ?? '')
  if (currentFamily === null || family === null) {
    return 'up'
  }

  return toDirection(FAMILIES.indexOf(family) - FAMILIES.indexOf(currentFamily))
}

function toDirection (shift: number): ShiftDirection {
  if (shift < 0) {
    return 'down'
  }

  return shift > 0 ? 'up' : 'same'
}

// Declines in a row per project and direction: after DECLINE_LIMIT of them gearbox stops asking that way there
async function recordDecision ($: EngineInterface, direction: ShiftDirection, isDeclined: boolean): Promise<void> {
  const key: string = await projectStoreKey($)
  const counts: Counts = await readCounts($, key)
  await $.store.set(key, { ...counts, [direction]: isDeclined ? (counts[direction] ?? 0) + 1 : 0 })
}

async function projectStoreKey ($: EngineInterface): Promise<string> {
  return `${PROJECT_STORE_PREFIX}${await $.session.cwd()}`
}

async function readCounts ($: EngineInterface, key: string): Promise<Counts> {
  const value: unknown = await $.store.get(key)
  if (typeof value !== 'object' || value === null) {
    return {}
  }

  return value as Counts
}

async function describeSetting ($: EngineInterface, texts: Texts, effort: Effort | null, model: string | null): Promise<string> {
  const shownEffort: Effort | null = effort ?? (await currentEffort($))
  const effortName: string = shownEffort === null ? texts.unknown : texts.levels[shownEffort]
  const family: ModelFamily | null = familyOf(model ?? '')

  return family === null ? effortName : `${effortName} · ${family}`
}

async function applyOverrides ($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> {
  const chosenEffort: Effort | null = await read($, override)
  const chosenModel: string | null = await read($, modelOverride)

  return { ...e, effort: chosenEffort ?? e.effort, model: chosenModel ?? e.model }
}

async function lightenSubagent ($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> {
  if (typeof e.effort !== 'string' || (await read($, mode)) === 'off' || (await isLightAgent($, e.agentId ?? '')) === false) {
    return e
  }

  const effort: Effort = capEffort(e.effort, LIGHT_AGENT_EFFORT)
  if (effort === e.effort) {
    return e
  }

  await update($, stats, count => ({ ...count, subagentSteps: count.subagentSteps + 1 }))

  return { ...e, effort }
}

async function isLightAgent ($: EngineInterface, agentId: string): Promise<boolean> {
  if (agentTypes.has(agentId) === false) {
    const type: string = (await $.agent.list()).find(agent => agent.id === agentId)?.type ?? ''
    agentTypes.set(agentId, type)
  }

  return LIGHT_AGENT_TYPES.has(agentTypes.get(agentId) ?? '')
}

async function recordStepUsage ($: EngineInterface, request: TurnStepInput, usage: TurnUsage | null): Promise<void> {
  if (usage === null) {
    return
  }

  const previous: StepRecord | null = lastStep
  lastStep = {
    effort: request.effort,
    model: request.model,
    cachedTokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    at: await $.clock.now(),
  }
  await tallyStep($, request.effort, usage.output_tokens)
  if (
    previous === null
    || previous.model !== lastStep.model
    || previous.effort === lastStep.effort
    || lastStep.at - previous.at > COLD_CACHE_MS
  ) {
    return
  }

  const isCacheBroken: boolean = usage.cache_read_input_tokens < previous.cachedTokens * CACHE_BREAK_SHARE
  const evidence: Counts = await readCounts($, CACHE_STORE_KEY)
  await $.store.set(CACHE_STORE_KEY, {
    shifts: (evidence.shifts ?? 0) + 1,
    breaks: (evidence.breaks ?? 0) + (isCacheBroken ? 1 : 0),
  })
  if (isCacheBroken) {
    await update($, stats, count => ({ ...count, recachedTokens: count.recachedTokens + usage.cache_creation_input_tokens }))
  }
}

async function tallyStep ($: EngineInterface, effort: TurnStepInput['effort'], outputTokens: number): Promise<void> {
  const session: Effort | null = await read($, sessionEffort)
  const sent: Effort | null = toEffort(String(effort ?? ''))
  if (session === null || sent === null) {
    return
  }

  const direction: ShiftDirection = toDirection(LEVELS.indexOf(sent) - LEVELS.indexOf(session))
  await update($, stats, count => {
    const tally: StepTally = count.steps[direction]

    return { ...count, steps: { ...count.steps, [direction]: { count: tally.count + 1, outputTokens: tally.outputTokens + outputTokens } } }
  })
}

// Shifts are measured to keep the prompt cache; once most seen here drop it, shift down only when the cache is cold anyway
async function isDownshiftFree ($: EngineInterface): Promise<boolean> {
  const evidence: Counts = await readCounts($, CACHE_STORE_KEY)
  if ((evidence.breaks ?? 0) * 2 <= (evidence.shifts ?? 0)) {
    return true
  }

  return lastStep === null || (await $.clock.now()) - lastStep.at > COLD_CACHE_MS
}

async function recordSessionEffort ($: EngineInterface, effort: Effort): Promise<void> {
  const previous: Effort | null = await read($, sessionEffort)
  if (previous === effort) {
    return
  }

  await update($, sessionEffort, () => effort)
  if (previous !== null) {
    // A changed session setting is the person's own pick in the app, which wins over gearbox's
    await update($, override, () => null)
  }
}

async function recordSessionModel ($: EngineInterface, model: string): Promise<void> {
  const previous: string | null = await read($, sessionModel)
  if (previous === model) {
    return
  }

  await update($, sessionModel, () => model)
  if (previous !== null) {
    await update($, modelOverride, () => null)
  }
}

async function recordEffortCap ($: EngineInterface, agentId: string | undefined, appliedLevel: string | undefined): Promise<void> {
  const applied: Effort | null = toEffort(appliedLevel ?? '')
  const sent: Effort | null = lastSentEffort
  const model: string | null = lastModel
  if (agentId !== undefined || applied === null || sent === null || model === null) {
    return
  }

  // Only a level below the one sent that is not the session's own setting proves the model's silent downgrade
  if (applied === (await read($, sessionEffort)) || LEVELS.indexOf(applied) >= LEVELS.indexOf(sent)) {
    return
  }

  await update($, effortCaps, caps => ({ ...caps, [model]: applied }))
  await update($, override, chosen => (chosen === null ? null : capEffort(chosen, applied)))
}

async function runCommand ($: EngineInterface, argument: string): Promise<string> {
  if (argument.startsWith(LANGUAGE_FLAG)) {
    return runLanguageCommand($, argument.slice(LANGUAGE_FLAG.length).trim())
  }
  if (argument.startsWith(MODEL_FLAG)) {
    return runModelCommand($, argument.slice(MODEL_FLAG.length).trim())
  }
  if (argument.startsWith(ICON_FLAG)) {
    return runIconCommand($, argument.slice(ICON_FLAG.length).trim())
  }

  const texts: Texts = await resolveTexts($)
  if (argument === 'stats') {
    return describeStats(await read($, stats), texts)
  }
  if (argument === 'ask' || argument === 'auto' || argument === 'off') {
    const chosenMode: AdvisorMode = argument
    await update($, mode, () => chosenMode)
    if (chosenMode === 'off') {
      await update($, override, () => null)
      await update($, modelOverride, () => null)
    }
  }
  if (argument === 'reset') {
    await update($, override, () => null)
    await update($, modelOverride, () => null)
    await update($, declined, () => null)
    await $.store.delete(await projectStoreKey($))
  }
  if (['', 'ask', 'auto', 'off', 'reset'].includes(argument) === false) {
    return texts.unknownArgument(argument)
  }
  await showStatus($)

  const isChosenByGearbox: boolean = (await read($, override)) !== null || (await read($, modelOverride)) !== null
  const shown: string = await describeSetting($, texts, null, await read($, modelOverride))

  return texts.status(await read($, mode), shown, isChosenByGearbox)
}

function describeStats (count: GearboxStats, texts: Texts): string {
  const { down, same, up } = count.steps
  const lighter: number | null = estimateExtraTokens(same, down)
  const saved: number | null = lighter === null ? null : -lighter
  const extra: number | null = estimateExtraTokens(same, up)

  return `${texts.stats(count)}; ${texts.savings(saved, extra, count.recachedTokens, count.subagentSteps)}`
}

// shortcut: compares average steps, which credits a light prompt's own brevity to the shift; fine for an estimate
function estimateExtraTokens (baseline: StepTally, shifted: StepTally): number | null {
  if (shifted.count === 0) {
    return 0
  }
  if (baseline.count === 0) {
    return null
  }

  return Math.round((shifted.outputTokens / shifted.count - baseline.outputTokens / baseline.count) * shifted.count)
}

async function runLanguageCommand ($: EngineInterface, value: string): Promise<string> {
  const language: Language | null = toLanguage(value)
  if (language !== null) {
    await $.store.set(LANGUAGE_STORE_KEY, language)
  }
  if (value === 'auto') {
    await $.store.delete(LANGUAGE_STORE_KEY)
  }

  const active: Language = await resolveLanguage($)
  if (value !== '' && value !== 'auto' && language === null) {
    return TEXTS[active].languageInvalid(value)
  }

  return TEXTS[active].languageStatus((await storedLanguage($)) ?? 'auto', active)
}

async function runModelCommand ($: EngineInterface, value: string): Promise<string> {
  const texts: Texts = await resolveTexts($)
  if (value !== '' && value !== 'on' && value !== 'off') {
    return texts.unknownArgument(`${MODEL_FLAG} ${value}`)
  }
  if (value === 'on' || value === 'off') {
    const isOn: boolean = value === 'on'
    await update($, isModelSwitching, () => isOn)
  }
  if (value === 'off') {
    await update($, modelOverride, () => null)
  }

  return texts.modelSwitching(await read($, isModelSwitching))
}

async function runIconCommand ($: EngineInterface, value: string): Promise<string> {
  const texts: Texts = await resolveTexts($)
  if (value !== '' && value !== 'on' && value !== 'off') {
    return texts.unknownArgument(`${ICON_FLAG} ${value}`)
  }
  if (value === 'on') {
    await $.store.delete(ICON_STORE_KEY)
  }
  if (value === 'off') {
    await $.store.set(ICON_STORE_KEY, false)
  }
  await showStatus($)

  return texts.iconStatus(await isIconShown($))
}

async function choose ($: EngineInterface, recommendation: Recommendation): Promise<void> {
  const { effort, model } = recommendation
  if (effort !== null) {
    await update($, override, () => effort)
  }
  if (model !== null) {
    await update($, modelOverride, () => model)
  }
  await update($, declined, () => null)
}

async function countStat ($: EngineInterface, key: 'asked' | 'accepted' | 'declined' | 'automatic'): Promise<void> {
  await update($, stats, count => ({ ...count, [key]: count[key] + 1 }))
}

async function currentEffort ($: EngineInterface): Promise<Effort | null> {
  return (await read($, override)) ?? (await read($, sessionEffort))
}

async function currentModel ($: EngineInterface): Promise<string | null> {
  return (await read($, modelOverride)) ?? (await read($, sessionModel))
}

async function showStatus ($: EngineInterface): Promise<void> {
  if ((await isIconShown($)) === false || (await read($, mode)) === 'off') {
    $.ui.status(undefined)

    return
  }

  $.ui.status(ICON)
}

async function isIconShown ($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ICON_STORE_KEY)) !== false
}

async function resolveTexts ($: EngineInterface): Promise<Texts> {
  return TEXTS[await resolveLanguage($)]
}

async function resolveLanguage ($: EngineInterface): Promise<Language> {
  const claudeLanguage: Language | null = toLanguage(String((await $.settings.read({ key: 'language' })) ?? ''))

  return (await storedLanguage($)) ?? conversationLanguage ?? claudeLanguage ?? 'en'
}

async function storedLanguage ($: EngineInterface): Promise<Language | null> {
  return toLanguage(String((await $.store.get(LANGUAGE_STORE_KEY)) ?? ''))
}

function toEffort (value: string): Effort | null {
  const word: string = value.toLowerCase().replace(/[^a-z]/g, '')

  return LEVELS.find(level => level === word) ?? null
}

function fromLevelName (value: string, texts: Texts): Effort | null {
  const name: string = value.trim().toLocaleLowerCase()

  return LEVELS.find(level => texts.levels[level].toLocaleLowerCase() === name) ?? null
}

function toFamily (value: string): ModelFamily | null {
  const word: string = value.toLowerCase().replace(/[^a-z]/g, '')

  return FAMILIES.find(family => family === word) ?? null
}

function familyOf (model: string): ModelFamily | null {
  return FAMILIES.find(family => model.includes(`claude-${family}-`)) ?? null
}

function toLanguage (value: string): Language | null {
  const name: string = value.trim().toLowerCase().replace(/[^\p{L}]/gu, '')
  if (Object.hasOwn(LANGUAGE_NAMES, name) === false) {
    return null
  }

  return LANGUAGE_NAMES[name] ?? null
}

function capitalize (text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

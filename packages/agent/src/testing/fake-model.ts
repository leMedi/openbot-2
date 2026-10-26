import {
  type AssistantMessage,
  type JsonObject,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai'

/** One scripted model response. */
export type FakeTurn = AssistantMessage

/** A turn that calls tools, e.g. `callsTools(['sendMessage', { text: 'hi' }])`. */
export function callsTools(...calls: [name: string, args: JsonObject][]): FakeTurn {
  return fauxAssistantMessage(
    calls.map(([name, args]) => fauxToolCall(name, args)),
    { stopReason: 'toolUse' },
  )
}

/** A turn that ends the run with private text; the owner never sees it. */
export function says(text: string): FakeTurn {
  return fauxAssistantMessage(fauxText(text))
}

/** A turn that ends the run with no text and no tool calls. */
export function endsSilently(): FakeTurn {
  return fauxAssistantMessage([])
}

/** pi-ai's faux provider behind a scriptable model, for Seam 1 tests. */
export function createFakeModel() {
  const faux = fauxProvider({ provider: 'fake', models: [{ id: 'fake-model', input: ['text', 'image'] }] })
  const models = createModels()
  models.setProvider(faux.provider)

  return {
    models,
    model: faux.getModel(),
    /** `provider/modelId`, as stored in settings and on bots. */
    ref: `${faux.getModel().provider}/${faux.getModel().id}`,
    /** Queues turns, consumed one per model request in order. */
    script(...turns: FakeTurn[]) {
      faux.appendResponses(turns)
    },
    get requestCount() {
      return faux.state.callCount
    },
    get pendingTurns() {
      return faux.getPendingResponseCount()
    },
  }
}

export type FakeModel = ReturnType<typeof createFakeModel>

import { createFauxCore, createProvider, fauxAssistantMessage, type Provider } from '@earendil-works/pi-ai'

/**
 * A provider `id` whose one model (`<id>/model`) answers every request with `answer(prompt)`, given the text of the
 * request's last message; needs no sign-in. E.g. a stand-in eval judge.
 */
export function answeringProvider(id: string, answer: (prompt: string) => string): Provider {
  const faux = createFauxCore({ provider: id, models: [{ id: 'model', input: ['text'] }] })
  const respond = () =>
    faux.appendResponses([
      (context) => {
        const last = context.messages.at(-1)
        const content = last && 'content' in last ? last.content : ''
        const prompt = typeof content === 'string' ? content : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
        return fauxAssistantMessage(answer(prompt))
      },
    ])
  return createProvider({
    id,
    name: id,
    auth: { apiKey: { name: id, resolve: async () => ({ auth: {} }) } },
    models: faux.models,
    api: {
      stream: (model, context, options) => (respond(), faux.stream(model, context, options)),
      streamSimple: (model, context, options) => (respond(), faux.streamSimple(model, context, options)),
    },
  })
}

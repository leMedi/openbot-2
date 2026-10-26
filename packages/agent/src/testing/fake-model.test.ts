import { describe, expect, it } from 'vitest'
import { callsTools, createFakeModel, endsSilently, says } from './fake-model.ts'

const ask = (text: string) => ({ messages: [{ role: 'user' as const, content: text, timestamp: Date.now() }] })

describe('fake model', () => {
  it('answers each request with the next scripted turn', async () => {
    const fake = createFakeModel()
    fake.script(
      callsTools(['sendMessage', { text: 'On it' }], ['message_bot', { to: 'rex', text: 'Can you check?' }]),
      says('Done.'),
    )

    const first = await fake.models.complete(fake.model, ask('Ask Rex to check the build'))
    expect(first.stopReason).toBe('toolUse')
    expect(first.content.filter((block) => block.type === 'toolCall')).toMatchObject([
      { name: 'sendMessage', arguments: { text: 'On it' } },
      { name: 'message_bot', arguments: { to: 'rex', text: 'Can you check?' } },
    ])

    const second = await fake.models.complete(fake.model, ask('…'))
    expect(second.stopReason).toBe('stop')
    expect(second.content).toMatchObject([{ type: 'text', text: 'Done.' }])
    expect(fake.requestCount).toBe(2)
  })

  it('can end a turn without saying anything', async () => {
    const fake = createFakeModel()
    fake.script(endsSilently())

    const reply = await fake.models.complete(fake.model, ask('hi'))

    expect(reply.stopReason).toBe('stop')
    expect(reply.content).toEqual([])
  })

  it('reports turns that were scripted but never requested', async () => {
    const fake = createFakeModel()
    fake.script(says('one'), says('two'))

    await fake.models.complete(fake.model, ask('hi'))

    expect(fake.pendingTurns).toBe(1)
  })
})

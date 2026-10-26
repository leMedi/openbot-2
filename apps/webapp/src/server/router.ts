import { SignInNotFoundError } from '@openbot/agent'
import { contract } from '@openbot/api-contract'
import { readModelSettings, writeModelSettings } from '@openbot/core'
import { implement, ORPCError } from '@orpc/server'
import type { ServerContext } from './context.ts'

const os = implement(contract).$context<ServerContext>()

export const router = os.router({
  health: os.health.handler(async ({ context }) => {
    await context.db.$client.execute('select 1')
    return { status: 'ok' as const, epoch: context.bus.epoch }
  }),

  events: os.events.handler(async function* ({ context, signal }) {
    // Subscribe before greeting so nothing published in between is lost.
    const live = context.bus.subscribe(signal)
    yield { epoch: context.bus.epoch, seq: context.bus.seq, event: { type: 'hello' as const } }
    yield* live
  }),

  providers: {
    list: os.providers.list.handler(({ context }) => context.providers.list()),

    connect: os.providers.connect.handler(async function* ({ context, input, signal }) {
      const provider = (await context.providers.list()).find((entry) => entry.id === input.providerId)
      if (!provider) throw new ORPCError('NOT_FOUND', { message: `Unknown provider ${input.providerId}` })
      if (!provider.methods.some((entry) => entry.method === input.method)) {
        throw new ORPCError('BAD_REQUEST', { message: `${provider.name} has no ${input.method} sign-in` })
      }
      yield* context.providers.signIn(input.providerId, input.method, signal)
    }),

    answer: os.providers.answer.handler(({ context, input }) => {
      try {
        context.providers.answer(input.signInId, input.promptId, input.value)
      } catch (error) {
        if (error instanceof SignInNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
        throw error
      }
    }),

    disconnect: os.providers.disconnect.handler(({ context, input }) => context.providers.disconnect(input.providerId)),
  },

  models: {
    list: os.models.list.handler(({ context }) => context.providers.listModels()),

    getSettings: os.models.getSettings.handler(({ context }) => readModelSettings(context.db)),

    updateSettings: os.models.updateSettings.handler(async ({ context, input }) => {
      for (const [setting, ref] of [
        ['defaultModel', input.defaultModel],
        ['computerUseModel', input.computerUseModel],
      ] as const) {
        if (ref == null) continue
        const model = await context.providers.findModel(ref)
        if (!model) throw new ORPCError('BAD_REQUEST', { message: `${ref} is not a model of a connected provider` })
        if (setting === 'computerUseModel' && !model.vision) {
          throw new ORPCError('BAD_REQUEST', { message: `${model.name} can't see images, so it can't use a computer` })
        }
      }
      return writeModelSettings(context.db, input)
    }),
  },
})

export type Router = typeof router

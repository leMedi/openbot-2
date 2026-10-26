import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { ServerContext } from './context.ts'
import { router } from './router.ts'

export const apiPrefix = '/api'

const handler = new OpenAPIHandler(router, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specPath: '/openapi.json',
      docsPath: '/docs',
      specGenerateOptions: { info: { title: 'OpenBot API', version: '0.0.0' }, servers: [{ url: apiPrefix }] },
    }),
  ],
})

/** Serves the API as plain HTTP under `/api`, with the OpenAPI description at `/api/openapi.json`. */
export async function handleApiRequest(request: Request, context: ServerContext): Promise<Response> {
  const { matched, response } = await handler.handle(request, { prefix: apiPrefix, context })
  return matched ? response : new Response('Not found', { status: 404 })
}

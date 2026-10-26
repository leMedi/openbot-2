import { createFileRoute } from '@tanstack/react-router'
import { getServerContext } from '../../server/app.ts'
import { handleApiRequest } from '../../server/http.ts'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: async ({ request }) => handleApiRequest(request, await getServerContext()),
    },
  },
})

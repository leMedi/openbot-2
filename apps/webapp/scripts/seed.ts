// `pnpm dev:seed`: adds sample bots and a group chat to the instance's database.
import { openDb } from '@openbot/db'
import { paths } from '@openbot/db/env'
import { sampleBots, sampleGroupTitle, seedSampleData } from '../src/server/seed.ts'

const db = await openDb(paths.database)
await seedSampleData(db)
db.$client.close()
console.log(`Seeded ${sampleBots.map((bot) => bot.name).join(', ')} and the "${sampleGroupTitle}" group in ${paths.database}`)

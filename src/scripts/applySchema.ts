import 'dotenv/config'
import { db, initDb } from '../db'

async function run() {
  await initDb()
  console.log('Schema applied successfully.')
}

run()
  .catch((err) => {
    console.error('Failed to apply schema:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.end()
  })

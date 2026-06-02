import express from 'express'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import authRouter from './auth/authRouter'
import adminRouter from './admin/adminRouter'
import bodyParser from 'body-parser'
import 'dotenv/config'
import { initDb } from './db'

const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(express.json({limit: '50mb'}))

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.use('/chat', chatRouter)
app.use('/images', imagesRouter)
app.use('/auth', authRouter)
app.use('/admin', adminRouter)

async function start() {
  await initDb()
  const raw = process.env.PORT
  const port = Number(raw) || 3050
  if (!raw) {
    console.warn(
      'PORT env is unset; using 3050. On Railway, the platform should set PORT — if public URL fails, set Networking target port to match what you listen on.'
    )
  } else {
    console.log(`PORT from environment: ${raw}`)
  }
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on 0.0.0.0:${port}`)
  })
}

start().catch((err) => {
  console.error('Failed to start server', err)
  process.exit(1)
})

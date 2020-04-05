import serverless from 'serverless-http'
import express from 'express'
import {
  SlackLinkSharedEvent,
  registerEventListener,
  postMessage
} from './slack'
import {
  parseAndAdd,
  createAuthorizeURL,
  authorize
} from './spotify'

const app = express()

const eventCallback = async (event: SlackLinkSharedEvent) => {
  console.debug(`in channel ${event.channel} user ${event.user} shared ${JSON.stringify(event.links)}`)
  const added = await parseAndAdd(event.links.map((link) => link.url))
  await postMessage({
    channel: event.channel,
    text: `Added ${added} track(s)`
  })
}
app.use('/slack/events', registerEventListener(eventCallback).requestListener())

app.get('/spotify/login', (_req, res) => {
  res.redirect(createAuthorizeURL())
})
app.get('/spotify/authorized', async (req, res) => {
  const { code, state } = req.query
  await authorize(code, state)
  res.status(200).send('success')
})

export const handler = serverless(app, {
  request(req: any) {
    req.rawBody = req.body
  }
})
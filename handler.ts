import {
  APIGatewayProxyHandler,
  APIGatewayProxyEvent,
  APIGatewayProxyResult
} from 'aws-lambda'
import serverless from 'serverless-http'
import express from 'express'
import {
  SlackLinkSharedEvent,
  registerEventListener,
  postMessage,
  teamInfo
} from './slack'
import {
  parseAndAdd,
  createAuthorizeURL,
  authorize
} from './spotify'

const app = express()

const eventCallback = async (event: SlackLinkSharedEvent, respond: () => void) => {
  console.debug(`in channel ${event.channel} user ${event.user} shared ${JSON.stringify(event.links)}`)
  const { ok, team, error } = await teamInfo()
  if (ok) {
    const added = await parseAndAdd((team as any).name, event.links.map((link) => link.url))
    await postMessage({
      channel: event.channel,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: added.map((track) => `• ${track}`).join('\n')
          }
        }
      ],
      text: `added ${added.length} track(s)`
    })
    respond()
  } else {
    console.warn('could not fetch slack team info', error)
  }
}
const listener = registerEventListener(eventCallback)
app.use('/', listener)

export const slackEvents = serverless(app, {
  request(req: any) {
    req.rawBody = req.body
  }
})

export const spotifyLogin: APIGatewayProxyHandler = async (): Promise<APIGatewayProxyResult> => {
  const { ok, team, error } = await teamInfo()
  if (ok) {
    const url = await createAuthorizeURL((team as any).name)
    console.debug(`redirecing to spotify login - ${url}`)
    return {
      statusCode: 302,
      headers: {
        Location: url
      },
      body: ''
    }
  } else {
    return {
      statusCode: 502,
      body: `could not fetch slack team info: ${error}`
    }
  }
}

export const spotifyAuthorized: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!event.queryStringParameters) {
    return {
      statusCode: 400,
      body: 'missing required callback parameters'
    }
  }
  const code = event.queryStringParameters['code']
  const state = event.queryStringParameters['state']

  const { ok, team, error } = await teamInfo()
  if (!ok) {
    return {
      statusCode: 502,
      body: `could not fetch slack team info: ${error}`
    }
  }

  try {
    await authorize((team as any).name, code, state)
    return {
      statusCode: 200,
      body: 'success'
    }
  } catch (err) {
    return {
      statusCode: 401,
      body: err.message() || 'authorization failed'
    }
  }
}
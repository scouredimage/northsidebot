import {
  APIGatewayProxyHandler,
  APIGatewayProxyEvent,
  APIGatewayProxyResult
} from 'aws-lambda'
import serverless from 'serverless-http'
import express from 'express'
import {
  EventBody,
  LinkSharedEvent,
  createAuthorizeURL as createSlackAuthorizeURL,
  authorize as slackAuthorize,
  registerEventListener,
  postMessage,
  teamInfo
} from './slack'
import {
  parseAndAdd,
  createAuthorizeURL as createSpotifyAuthorizeURL,
  authorize as spotifyAuthorize,
  AddedTracks
} from './spotify'

const app = express()

function serialize(added: AddedTracks[]): string {
  return ([] as string[]).concat(...added.map(
    (entry) => Object.values(entry.tracks).map(
      (track) => `• ${track.name} - ${track.artists}`
    )
  )).join('\n')
}

const eventCallback = async (event: LinkSharedEvent, body: EventBody, respond: () => void) => {
  console.debug(`in channel ${event.channel} user ${event.user} shared ${JSON.stringify(event.links)}`)
  const added = await parseAndAdd(
    body.team_id as string,
    event.user,
    event.links.map((link) => link.url)
  )
  await postMessage({
    channel: event.channel,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: serialize(added)
        }
      }
    ],
    text: `added ${added.map(({ tracks }) => Object.keys(tracks).length)} track(s)`
  })
  respond()
}
const listener = registerEventListener(eventCallback)
app.use('/', listener)

export const slackEvents = serverless(app, {
  request(req: any) {
    req.rawBody = req.body
  }
})

export const slackLogin: APIGatewayProxyHandler = async (): Promise<APIGatewayProxyResult> => {
  const url = await createSlackAuthorizeURL()
  return {
    statusCode: 302,
    headers: {
      Location: url
    },
    body: ''
  }
}

export const slackAuthorized: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!event.queryStringParameters) {
    return {
      statusCode: 400,
      body: 'missing required callback parameters'
    }
  }
  const code = event.queryStringParameters['code']
  try {
    await slackAuthorize(code)
    return {
      statusCode: 200,
      body: 'success'
    }
  } catch (err) {
    console.log(err)
    return {
      statusCode: 401,
      body: err.message() || 'authorization failed'
    }
  }
}

export const spotifyLogin: APIGatewayProxyHandler = async (): Promise<APIGatewayProxyResult> => {
  const { ok, team, error } = await teamInfo()
  if (ok) {
    const url = await createSpotifyAuthorizeURL((team as any).id)
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
    await spotifyAuthorize((team as any).id, code, state)
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
import { stringify } from 'querystring'
import { createEventAdapter } from '@slack/events-api'
import { WebClient, ChatPostMessageArguments } from '@slack/web-api'
import * as auth from './auth';
import { getenv } from './util'

export interface Link {
  domain: string
  url: string
}

export interface LinkSharedEvent {
  channel: string
  user: string
  links: Link[]
}

export interface EventBody {
  [key: string]: any
}

export type EventListenerCallback = (event: LinkSharedEvent, body: EventBody, respond: () => void) => void

export function registerEventListener(callback: EventListenerCallback) {
  const slackEvents = createEventAdapter(getenv('SLACK_SIGNING_SECRET'), { 
    includeBody: true,
    waitForResponse: true
  })
  const adapter = slackEvents.on('link_shared', callback)
  return adapter.requestListener()
}

async function webClient(): Promise<WebClient> {
  const state = await auth.get('default', 'slack')
  return new WebClient(state.auth.access_token)
}

export async function teamInfo() {
  const web = await webClient()
  return web.team.info()
}

export async function postMessage(options: ChatPostMessageArguments) {
  const web = await webClient()
  return web.chat.postMessage(options)
}

export async function createAuthorizeURL(): Promise<string> {
  const params = {
    client_id: getenv('SLACK_CLIENT_ID'),
    scope: getenv('SLACK_AUTH_SCOPES')
  }
  return 'https://slack.com/oauth/v2/authorize?' + stringify(params)
}

export async function authorize(code: string) {
  const response = await new WebClient().oauth.v2.access({
    client_id: getenv('SLACK_CLIENT_ID'),
    client_secret: getenv('SLACK_CLIENT_SECRET'),
    code
  })
  return auth.save(
    'default',
    'slack',
    { auth: response as { [key: string]: any }, expires: -1}
  )
}

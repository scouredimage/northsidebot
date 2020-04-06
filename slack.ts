import { createEventAdapter } from '@slack/events-api'
import { WebClient, ChatPostMessageArguments } from '@slack/web-api'
import { getenv } from './util'

export interface SlackLink {
  domain: string
  url: string
}

export interface SlackLinkSharedEvent {
  channel: string
  user: string
  links: SlackLink[]
}

export type EventListenerCallback = (event: SlackLinkSharedEvent, respond: () => void) => void

export function registerEventListener(callback: EventListenerCallback) {
  const slackEvents = createEventAdapter(getenv('SLACK_SIGNING_SECRET'), { waitForResponse: true })
  const adapter = slackEvents.on('link_shared', callback)
  return adapter.requestListener()
}

const web = new WebClient(getenv('SLACK_ACCESS_TOKEN'))

export function teamInfo() {
  return web.team.info()
}

export function postMessage(options: ChatPostMessageArguments) {
  return web.chat.postMessage(options)
}

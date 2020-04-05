import SpotifyWebApi from 'spotify-web-api-node'
import { getenv } from './util'

export interface SpotifyAccessToken {
  token: string
  expires: number
}

export const SpotifyLinkTypes = ['track', 'album', 'playlist'] as const
type SpotifyLinkTypeTuple = typeof SpotifyLinkTypes
export type SpotifyLinkType = SpotifyLinkTypeTuple[number]

export interface SpotifyLink {
  type: SpotifyLinkType
  id: string
}

const spotify = new SpotifyWebApi({
  clientId: getenv('SPOTIFY_CLIENT_ID'),
  clientSecret: getenv('SPOTIFY_CLIENT_SECRET'),
  redirectUri: getenv('SPOTIFY_AUTH_REDIRECT_URI')
})

namespace state {
  let authorizationState: string
  let accessTokenExpiry: number

  export function create(): string {
    authorizationState = Math.random().toString(36).substring(10)
    return authorizationState
  }

  export function verify(s: string): boolean {
    return authorizationState === s
  }

  export function expires(expires: number) {
    accessTokenExpiry = Date.now() + expires
  }

  export function expired(): boolean {
    return Date.now() >= accessTokenExpiry
  }
}

export function createAuthorizeURL() {
  const scopes = getenv('SPOTIFY_REQUEST_SCOPES').split(/,\s*/)
  return spotify.createAuthorizeURL(scopes, state.create())
}

export async function authorize(code: string, verify: string) {
  if (!state.verify(verify)) {
    throw new Error(`unknown authorization state ${state}`)
  }

  const {
    body: { 
      access_token: access,
      refresh_token: refresh,
      expires_in: expires
    }
  } = await spotify.authorizationCodeGrant(code)

  spotify.setAccessToken(access)
  spotify.setRefreshToken(refresh)

  state.expires(expires)
}

async function addTracksToPlaylists(tracksByPlaylist: Record<SpotifyLinkType, string[]>) {
  if (state.expired()) {
    const {
      body: {
        access_token: access,
        expires_in: expires
      } 
    } = await spotify.refreshAccessToken()
    spotify.setAccessToken(access)
    state.expires(expires)
  }

  return Promise.all(
    SpotifyLinkTypes
      .filter((type) => tracksByPlaylist[type].length > 0)
      .map((type) => {
        let playlist: string
        switch (type) {
          case 'track':
            playlist = getenv('SPOTIFY_TRACK_PLAYLIST_ID')
            break
          case 'album':
            playlist = getenv('SPOTIFY_ALBUM_PLAYLIST_ID')
            break
          case 'playlist':
            playlist = getenv('SPOTIFY_PLAYLIST_PLAYLIST_ID')
            break
        }
        return spotify
          .addTracksToPlaylist(playlist, tracksByPlaylist[type])
          .then(() => tracksByPlaylist[type].length)
          .catch((err) => {
            console.error(`error adding tracks ${tracksByPlaylist[type]} to playlist ${playlist}`, err)
            throw err
          })
      })
  )
}

function mapLinksToTracks(links: SpotifyLink[]): Record<SpotifyLinkType, string[]> {
  const tracksByPlaylist: Record<SpotifyLinkType, string[]> = {
    'track': [],
    'album': [],
    'playlist': []
  }
  links.forEach((link) => tracksByPlaylist[link.type].push(`spotify:track:${link.id}`))
  return tracksByPlaylist
}

function parseLink(link: string): SpotifyLink | undefined {
  const track = /https?:\/\/open\.spotify\.com\/(?<type>(track|album|playlist))\/(?<id>[a-zA-Z0-9]+)/.exec(link)
  if (track && track.groups) {
    return {
      type: track.groups.type as SpotifyLinkType,
      id: track.groups.id
    }
  }
}

function parseLinks(links: string[]): SpotifyLink[] {
  return links
    .map((link) => parseLink(link))
    .filter((link: SpotifyLink | undefined): link is SpotifyLink => !!link)
}

export async function parseAndAdd(links: string[]) {
  const result = await addTracksToPlaylists(
    mapLinksToTracks(
      parseLinks(links)
    )
  )
  return result.reduce((sum, added) => sum + added, 0)
}
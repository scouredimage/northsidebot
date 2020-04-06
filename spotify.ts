import SpotifyWebApi from 'spotify-web-api-node'
import { DynamoDB } from 'aws-sdk'
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
  space: string
  user: string
}

const spotify = new SpotifyWebApi({
  clientId: getenv('SPOTIFY_CLIENT_ID'),
  clientSecret: getenv('SPOTIFY_CLIENT_SECRET'),
  redirectUri: getenv('SPOTIFY_AUTH_REDIRECT_URI')
})

const db = new DynamoDB.DocumentClient()

namespace auth {
  interface state {
    access: string
    refresh: string
    expires: number
  }

  export async function create(space: string): Promise<string> {
    const verify = Math.random().toString(36).substring(2, 15)
    await db.put({
      TableName: getenv('DB_TABLE_NAME'),
      Item: {
        id: 'auth',
        space,
        verify,
        expires: Math.floor(Date.now() / 1000) + 3600 // one hour from now
      }
    }).promise()
    return verify
  }

  export async function verifyAndSave(space: string, verify: string, auth: state): Promise<boolean> {
    try {
      await db.update({
        TableName: getenv('DB_TABLE_NAME'),
        UpdateExpression: 'SET #a = :access, #r = :refresh, #e = :expires',
        ConditionExpression: '#v = :verify AND #e < :now',
        Key: {
          space,
          id: 'auth'
        },
        ExpressionAttributeNames: {
          '#v': 'verify',
          '#a': 'accessToken',
          '#r': 'refreshToken',
          '#e': 'expires'
        },
        ExpressionAttributeValues: {
          ':verify': verify,
          ':access': auth.access,
          ':refresh': auth.refresh,
          ':expires': Date.now() + auth.expires,
          ':now': Date.now(),
        },
        ReturnValues: 'ALL_NEW'
      }).promise()
    } catch (err) {
      if (err.code !== 'ConditionalCheckFailedException') {
        throw err
      }
      return false
    }
    return true
  }

  export async function get(space: string): Promise<state> {
    const result = await db.get({
      TableName: getenv('DB_TABLE_NAME'),
      Key: {
        space,
        id: 'auth'
      }
    }).promise()
    if (result?.Item) {
      const state = {
        access: result.Item.accessToken,
        refresh: result.Item.refreshToken,
        expires: result.Item.expires
      }
      return state
    }
    throw new Error('not found')
  }

  export function expired(auth: state): boolean {
    return Date.now() >= auth.expires
  }

  export async function update(space: string, access: string, expires: number): Promise<boolean> {
    try {
      await db.update({
        TableName: getenv('DB_TABLE_NAME'),
        UpdateExpression: 'SET #a = :access, #e = :expires',
        Key: {
          space,
          id: 'auth'
        },
        ExpressionAttributeNames: {
          '#a': 'accessToken',
          '#e': 'expires'
        },
        ExpressionAttributeValues: {
          ':access': access,
          ':expires': expires
        },
        ReturnValues: 'ALL_NEW'
      }).promise()
    } catch (err) {
      if (err.code !== 'ConditionalCheckFailedException') {
        throw err
      }
      return false
    }
    return true
  }
}

namespace history {
  // TODO: batch
  export async function save(playlist: string, tracks: SpotifyLink[]) {
    await db.batchWrite({
      RequestItems: {
        'tracks': tracks.map((track) => (
          {
            PutRequest: {
              Item: {
                TableName: getenv('DB_TABLE_NAME'),
                Item: {
                  space: track.space,
                  id: `${playlist}|${track.id}`,
                  type: track.type,
                  playlist,
                  track: track.id,
                  user: track.user
                }
              }
            }
          }
        ))
      }
    })
  }
}

export async function createAuthorizeURL(space: string): Promise<string> {
  const scopes = getenv('SPOTIFY_REQUEST_SCOPES').split(/,\s*/)
  return spotify.createAuthorizeURL(scopes, await auth.create(space))
}

export async function authorize(space: string, code: string, verify: string) {
  const {
    body: { 
      access_token: access,
      refresh_token: refresh,
      expires_in: expires
    }
  } = await spotify.authorizationCodeGrant(code)

  if (!await auth.verifyAndSave(space, verify, { access, refresh, expires })) {
    throw new Error(`unknown/expired authorization state ${verify}`)
  }

  spotify.setAccessToken(access)
  spotify.setRefreshToken(refresh)
}

async function addTracksToPlaylists(
  space: string,
  idsByPlaylist: Record<SpotifyLinkType, SpotifyLink[]>
): Promise<string[][]> {
  let state = await auth.get(space)
  spotify.setAccessToken(state.access)
  spotify.setRefreshToken(state.refresh)

  if (auth.expired(state)) {
    console.debug('refreshing spotify access token')
    const {
      body: {
        access_token: access,
        expires_in: expires
      } 
    } = await spotify.refreshAccessToken()
    
    const updated = await auth.update(space, access, expires)
    if (!updated) { // someone else won the update race!
      state = await auth.get(space)
    }
    spotify.setAccessToken(state.access)
  }

  return Promise.all(
    SpotifyLinkTypes
      .filter((type) => idsByPlaylist[type].length > 0)
      .map(async (type) => {

        let tracks: SpotifyLink[]
        let playlist: string
        switch (type) {
          case 'track':
            tracks = idsByPlaylist[type]
            playlist = getenv('SPOTIFY_TRACK_PLAYLIST_ID')
            break
          case 'album':
            const albums = idsByPlaylist[type]
            tracks = ([] as SpotifyLink[]).concat(...await Promise.all(
              albums.map(async (album) => {
                const { body: { tracks: { items }} } = await spotify.getAlbum(album.id)
                return items.map((track) => ({
                  type: 'track' as SpotifyLinkType,
                  id: track.id,
                  space: album.space,
                  user: album.user
                }))
              })
            ))
            playlist = getenv('SPOTIFY_ALBUM_PLAYLIST_ID')
            break
          case 'playlist':
            const playlists = idsByPlaylist[type]
            // TODO: paging
            tracks = ([] as SpotifyLink[]).concat(...await Promise.all(
              playlists.map(async (playlist) => {
                const { body: { tracks: { items }}} = await spotify.getPlaylist(playlist.id)
                return items.map((page) => ({
                  type: 'track' as SpotifyLinkType,
                  id: page.track.id,
                  space: playlist.space,
                  user: playlist.user
                }))
              })
            ))
            playlist = getenv('SPOTIFY_PLAYLIST_PLAYLIST_ID')
            break
        }

        console.debug(`adding ${JSON.stringify(tracks)} to ${playlist}`)

        await spotify
          .addTracksToPlaylist(playlist, tracks.map((track) => `spotify:track:${track.id}`))
          .catch((err) => {
            console.error(`error adding tracks ${idsByPlaylist[type]} to playlist ${playlist}`, err)
            throw err
          })

        await history.save(playlist, tracks)

        const { body: { tracks: info } } = await spotify.getTracks(tracks.map((track) => track.id))
        return info.map((track) => {
          return `${track.name} - ${track.artists.map((artist) => artist.name).join(', ')}`
        })
      })
  )
}

function mapLinksToTracks(links: SpotifyLink[]): Record<SpotifyLinkType, SpotifyLink[]> {
  const idsByPlaylist: Record<SpotifyLinkType, SpotifyLink[]> = {
    'track': [],
    'album': [],
    'playlist': []
  }
  links.forEach((link) => idsByPlaylist[link.type].push(link))
  return idsByPlaylist
}

function parseLink(space: string, user: string, link: string): SpotifyLink | undefined {
  const track = /https?:\/\/open\.spotify\.com\/(?<type>(track|album|playlist))\/(?<id>[a-zA-Z0-9]+)/.exec(link)
  if (track && track.groups) {
    return {
      type: track.groups.type as SpotifyLinkType,
      id: track.groups.id,
      space,
      user
    }
  }
}

function parseLinks(space: string, user: string, links: string[]): SpotifyLink[] {
  return links
    .map((link) => parseLink(space, user, link))
    .filter((link: SpotifyLink | undefined): link is SpotifyLink => !!link)
}

export async function parseAndAdd(space: string, user: string, links: string[]): Promise<string[]> {
  const result = await addTracksToPlaylists(space,
    mapLinksToTracks(
      parseLinks(space, user, links)
    )
  )                                                                                                                   
  return ([] as string[]).concat(...result)
}
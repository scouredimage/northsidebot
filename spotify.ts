import SpotifyWebApi from 'spotify-web-api-node'
import { DynamoDB } from 'aws-sdk'
import { getenv } from './util'

export const LinkTypes = ['track', 'album', 'playlist'] as const
type LinkTuple = typeof LinkTypes
export type LinkType = LinkTuple[number]

export interface SpotifyLink {
  type: LinkType
  id: string
  space: string
  user: string
}

export interface TracksById {
  [id: string]: { 
    name: String,
    artists: string[]
  }
}

export interface AddedTracks {
  type: LinkType,
  tracks: TracksById
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
        space,
        id: 'auth',
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
          ':expires': Date.now() + expires
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
  export function save(playlist: string, tracks: SpotifyLink[], byId: TracksById) {
    const tablename = getenv('DB_TABLE_NAME')
    return db.batchWrite({
      RequestItems: {
        [tablename]: tracks.map((track) => (
          {
            PutRequest: {
              Item: {
                TableName: tablename,
                Item: {
                  space: track.space,
                  id: `${playlist}|${track.id}`,
                  type: track.type,
                  playlist,
                  track: track.id,
                  name: byId[track.id].name,
                  artist: byId[track.id].artists.join(', '),
                  user: track.user,
                  added: Date.now()
                }
              }
            }
          }
        ))
      }
    }).promise()
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

async function getAlbumTracks(albums: SpotifyLink[]): Promise<SpotifyLink[]> {
  return ([] as SpotifyLink[]).concat(...await Promise.all(
    albums.map(async (album) => {
      const { body: { tracks: { items }} } = await spotify.getAlbum(album.id)
      return items.map((track) => ({
        type: 'track' as LinkType,
        id: track.id,
        space: album.space,
        user: album.user
      }))
    })
  ))
}

// TODO: paging
async function getPlaylistTracks(playlists: SpotifyLink[]): Promise<SpotifyLink[]> {
  return ([] as SpotifyLink[]).concat(...await Promise.all(
    playlists.map(async (playlist) => {
      const { body: { tracks: { items }}} = await spotify.getPlaylist(playlist.id)
      return items.map((page) => ({
        type: 'track' as LinkType,
        id: page.track.id,
        space: playlist.space,
        user: playlist.user
      }))
    })
  ))
}

async function addTracksToPlaylists(
  space: string,
  idsByPlaylist: Record<LinkType, SpotifyLink[]>
): Promise<AddedTracks[]> {
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
    LinkTypes
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
            tracks = await getAlbumTracks(albums)
            playlist = getenv('SPOTIFY_ALBUM_PLAYLIST_ID')
            break
          case 'playlist':
            const playlists = idsByPlaylist[type]
            tracks = await getPlaylistTracks(playlists)
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

        const { body: { tracks: info } } = await spotify.getTracks(tracks.map((track) => track.id))
        const addedForType = info.reduce((byId, track) => {
          byId[track.id] = {
            name: track.name,
            artists: track.artists.map((artist) => artist.name)
          }
          return byId
        }, {} as TracksById)

        await history.save(playlist, tracks, addedForType)

        return { type, tracks: addedForType }
      })
  )
}

function mapLinksToTracks(links: SpotifyLink[]): Record<LinkType, SpotifyLink[]> {
  const idsByPlaylist: Record<LinkType, SpotifyLink[]> = {
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
      type: track.groups.type as LinkType,
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

export async function parseAndAdd(space: string, user: string, links: string[]): Promise<AddedTracks[]> {
  return addTracksToPlaylists(space,
    mapLinksToTracks(
      parseLinks(space, user, links)
    )
  )                                                                                                                   
}
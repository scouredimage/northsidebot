import SpotifyWebApi from 'spotify-web-api-node'
import { db } from './db';
import * as auth from './auth';
import { now, getenv } from './util'

export const LinkTypes = ['track', 'album', 'playlist'] as const
type LinkTuple = typeof LinkTypes
export type LinkType = LinkTuple[number]

export interface Link {
  type: LinkType
  id: string
  name: string
  by: string[]
  items: string[]
  space: string
  user: string
}

export interface Playlist {
  id: string,
  type: LinkType,
  name: string
}

export interface Added {
  playlist: Playlist,
  links: Link[]
}

const spotify = new SpotifyWebApi({
  clientId: getenv('SPOTIFY_CLIENT_ID'),
  clientSecret: getenv('SPOTIFY_CLIENT_SECRET'),
  redirectUri: getenv('SPOTIFY_AUTH_REDIRECT_URI')
})

namespace history {
  // TODO: batch
  export function save(added: Added) {
    const { links, playlist } = added
    const tablename = getenv('DB_TABLE_NAME')
    return db.batchWrite({
      RequestItems: {
        [tablename]: links.map((link) => (
          {
            PutRequest: {
              Item: {
                space: link.space,
                id: `${playlist.id}|${link.id}`,
                link,
                playlist,
                added: now()
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
  spotify.resetAccessToken()
  spotify.resetRefreshToken()
  return spotify.createAuthorizeURL(scopes, await auth.create(space, 'spotify'))
}

export async function authorize(space: string, code: string, verify: string) {
  const {
    body: { 
      access_token: access,
      refresh_token: refresh,
      expires_in: expires
    }
  } = await spotify.authorizationCodeGrant(code)

  const state: auth.state = {
    auth: { access, refresh },
    expires: now() + expires
  }
  if (!await auth.verifyAndSave(space, 'spotify', verify, state)) {
    throw new Error(`unknown/expired authorization state ${verify}`)
  }

  spotify.setAccessToken(access)
  spotify.setRefreshToken(refresh)
}

async function getTrack(space: string, user: string, track: string): Promise<Link> {
  const { body: { id, name, artists } } = await spotify.getTrack(track)
  return {
    type: 'track' as LinkType,
    id,
    name,
    by: artists.map((artist) => artist.name),
    items: [id],
    space,
    user
  }
}

// TODO: paging
async function getAlbum(space: string, user: string, album: string): Promise<Link> {
  const { body: { id, name, artists, tracks } } = await spotify.getAlbum(album)
  return {
    type: 'album' as LinkType,
    id,
    name,
    by: artists.map((artist) => artist.name),
    items: tracks.items.map((track) => track.id),
    space,
    user
  }
}

// TODO: paging
async function getPlaylist(space: string, user: string, playlist: string): Promise<Link> {
  const { body: { id, name, owner, tracks } } = await spotify.getPlaylist(playlist)
  return {
    type: 'playlist' as LinkType,
    id,
    name,
    by: [owner.display_name || owner.id],
    items: tracks.items.map(({ track }) => track.id),
    space,
    user
  }
}

async function refreshAccessToken(space: string, state: auth.state) {
  console.debug('refreshing spotify access token')
  const {
    body: {
      access_token: access,
      expires_in: expires
    } 
  } = await spotify.refreshAccessToken()
  state.auth.access = access
  state.expires = now() + expires
  
  const updated = await auth.update(space, 'spotify', state)
  if (!updated) { // someone else won the update race!
    state = await auth.get(space, 'spotify')
  }
  spotify.setAccessToken(state.auth.access)
}

async function addTracksToPlaylist(tracks: string[], playlist: string) {
  console.debug(`adding ${JSON.stringify(tracks)} to ${playlist}`)
  try {
    await spotify.addTracksToPlaylist(playlist, tracks.map((track) => `spotify:track:${track}`))
  } catch(err) {
    console.error(`error adding tracks ${tracks} to playlist ${playlist}`, err)
    throw err
  }
}

async function addTracksToPlaylists(links: Link[]): Promise<Added[]> {
  const byPlaylist: { [id: string]: Added } = {}
  await Promise.all(
    links.map(async (link) => {
      const playlistId = getenv(`SPOTIFY_${link.type.toUpperCase()}_PLAYLIST_ID`)
      await addTracksToPlaylist(link.items, playlistId)

      const { body: { name: playlistName } } = await spotify.getPlaylist(playlistId)
      const playlist = { id: playlistId, name: playlistName, type: link.type}
      if (!byPlaylist[playlistId]) {
        byPlaylist[playlistId] = { playlist, links: [link] }
      } else {
        byPlaylist[playlistId].links.push(link)
      }
    })
  )
  await Promise.all(Object.values(byPlaylist).map(
    (added) => history.save(added))
  )
  return Object.values(byPlaylist)
}

function parseLink(space: string, user: string, link: string): Promise<Link> {
  const track = /https?:\/\/open\.spotify\.com\/(?<type>(track|album|playlist))\/(?<id>[a-zA-Z0-9]+)/.exec(link)
  if (track && track.groups) {
    const type: LinkType = track.groups.type as LinkType
    switch (type) {
      case 'track':
        return getTrack(space, user, track.groups.id)
      case 'album':
        return getAlbum(space, user, track.groups.id)
      case 'playlist':
        return getPlaylist(space, user, track.groups.id)
    }
  }
  throw new Error(`could not parse: ${link}`)
}

function parseLinks(space: string, user: string, links: string[]): Promise<Link[]> {
  return Promise.all(links.map((link) => parseLink(space, user, link)))
}

export async function parseAndAdd(space: string, user: string, urls: string[]): Promise<Added[]> {
  const state = await auth.get(space, 'spotify')
  spotify.setAccessToken(state.auth.access)
  spotify.setRefreshToken(state.auth.refresh)
  if (auth.expired(state)) {
    await refreshAccessToken(space, state)
  }

  const links = await parseLinks(space, user, urls)
  console.log(`parsed links: ${JSON.stringify(links)}`)
  return addTracksToPlaylists(links.filter((l1, i) => links.findIndex((l2) => l1.id === l2.id) === i))
}

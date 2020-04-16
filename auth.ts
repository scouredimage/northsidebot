import { db } from './db';
import { now, getenv } from './util'

export interface state {
  auth: { [key: string]: any },
  expires: number
}

export async function create(space: string, provider: string): Promise<string> {
  const verify = Math.random().toString(36).substring(2, 15)
  await db.put({
    TableName: getenv('DB_TABLE_NAME'),
    Item: {
      space,
      id: `auth|${provider}`,
      verify
    }
  }).promise()
  return verify
}

export async function verifyAndSave(
  space: string,
  provider: string,
  verify: string,
  state: state,
): Promise<boolean> {
  try {
    await db.update({
      TableName: getenv('DB_TABLE_NAME'),
      UpdateExpression: 'SET #a = :auth, #e = :expires',
      ConditionExpression: '#v = :verify',
      Key: {
        space,
        id: `auth|${provider}`
      },
      ExpressionAttributeNames: {
        '#v': 'verify',
        '#a': 'auth',
        '#e': 'expires'
      },
      ExpressionAttributeValues: {
        ':verify': verify,
        ':auth': state.auth,
        ':expires': state.expires
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

export async function save(
  space: string,
  provider: string,
  state: state
) {
  return db.put({
    TableName: getenv('DB_TABLE_NAME'),
    Item: {
      space,
      id: `auth|${provider}`,
      auth: state.auth,
      expires: state.expires
    },
    ReturnValues: 'NONE'
  }).promise()
}

export async function get(space: string, provider: string): Promise<state> {
  const result = await db.get({
    TableName: getenv('DB_TABLE_NAME'),
    Key: {
      space,
      id: `auth|${provider}`
    }
  }).promise()
  if (result?.Item) {
    const state = {
      auth: result.Item.auth,
      expires: result.Item.expires
    }
    return state
  }
  throw new Error('not found')
}

export function expired(state: state): boolean {
  return now() >= state.expires
}

export async function update(space: string, provider: string, state: state): Promise<boolean> {
  try {
    await db.update({
      TableName: getenv('DB_TABLE_NAME'),
      UpdateExpression: 'SET #a = :auth, #e = :expires',
      Key: {
        space,
        id: `auth|${provider}`
      },
      ExpressionAttributeNames: {
        '#a': 'auth',
        '#e': 'expires'
      },
      ExpressionAttributeValues: {
        ':auth': state.auth,
        ':expires': state.expires
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
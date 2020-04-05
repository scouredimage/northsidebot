export function getenv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw Error(`env var ${name} not defined/empty`)
  }
  return value
}

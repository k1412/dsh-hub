/** Safe parsing and validation for the authenticated Hub enrollment bootstrap. */

/** Bootstrap identity pinned into a newly initialized Node Agent. */
export interface HubBootstrapIdentity {
  protocolVersion: 1
  hubPublicKey: string
  serviceIdentity: string
}

function isJson(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true
}

function bootstrapFailure(response: Response): Error {
  const status = `HTTP ${String(response.status)}`
  if (!isJson(response.headers.get('content-type'))) {
    return new Error(
      `Hub bootstrap returned ${status} with a non-JSON page before reaching Hub; `
      + 'verify the Cloudflare Access Client ID and Secret values, the Service Auth policy, '
      + 'and Service Token access to /hub/v1/bootstrap',
    )
  }
  return new Error(`Hub bootstrap failed with ${status}; verify the Cloudflare Service Token and Access policy`)
}

/**
 * Parse one bootstrap response without ever feeding an Access HTML page to
 * `JSON.parse` or reflecting an edge response body into terminal output.
 * @param response - Authenticated response from the Hub bootstrap endpoint.
 * @param expectedServiceIdentity - Service identity pinned by node configuration.
 * @returns The validated Hub identity used to initialize the Node Agent.
 */
export async function readHubBootstrap(
  response: Response,
  expectedServiceIdentity: string,
): Promise<HubBootstrapIdentity> {
  if (!response.ok) throw bootstrapFailure(response)
  if (!isJson(response.headers.get('content-type'))) throw bootstrapFailure(response)

  let value: unknown
  try {
    value = JSON.parse(await response.text())
  } catch {
    throw new Error('Hub bootstrap returned malformed JSON')
  }
  if (typeof value !== 'object' || value === null) throw new Error('Hub bootstrap identity is invalid')
  const bootstrap = value as Record<string, unknown>
  if (bootstrap.protocolVersion !== 1
    || typeof bootstrap.hubPublicKey !== 'string'
    || bootstrap.serviceIdentity !== expectedServiceIdentity) {
    throw new Error('Hub bootstrap identity is invalid')
  }
  return {
    protocolVersion: 1,
    hubPublicKey: bootstrap.hubPublicKey,
    serviceIdentity: expectedServiceIdentity,
  }
}

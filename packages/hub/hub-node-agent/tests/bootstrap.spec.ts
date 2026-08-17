import { describe, expect, it } from 'vitest'
import { readHubBootstrap } from '../src/bootstrap.ts'

describe('Node enrollment bootstrap', () => {
  it('accepts the exact authenticated Hub identity', async () => {
    const response = new Response(JSON.stringify({
      protocolVersion: 1,
      hubPublicKey: 'hub-public-key',
      serviceIdentity: 'node-token.access',
    }), { headers: { 'content-type': 'application/json; charset=utf-8' } })

    await expect(readHubBootstrap(response, 'node-token.access')).resolves.toEqual({
      protocolVersion: 1,
      hubPublicKey: 'hub-public-key',
      serviceIdentity: 'node-token.access',
    })
  })

  it('explains an Access HTML interception without parsing or echoing its body', async () => {
    const response = new Response('<!DOCTYPE html><title>Cloudflare Access</title><p>sensitive edge detail</p>', {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

    await expect(readHubBootstrap(response, 'node-token.access')).rejects.toThrow(
      /non-JSON page before reaching Hub.*Client ID and Secret.*Service Auth policy.*\/hub\/v1\/bootstrap/,
    )
    await expect(readHubBootstrap(new Response('<p>sensitive edge detail</p>', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    }), 'node-token.access')).rejects.not.toThrow(/sensitive edge detail/)
  })

  it('rejects malformed JSON and a mismatched service identity explicitly', async () => {
    await expect(readHubBootstrap(new Response('<not-json>', {
      headers: { 'content-type': 'application/json' },
    }), 'node-token.access')).rejects.toThrow('malformed JSON')

    await expect(readHubBootstrap(new Response(JSON.stringify({
      protocolVersion: 1,
      hubPublicKey: 'hub-public-key',
      serviceIdentity: 'another-token.access',
    }), { headers: { 'content-type': 'application/json' } }), 'node-token.access')).rejects.toThrow(
      'Hub bootstrap identity is invalid',
    )
  })
})

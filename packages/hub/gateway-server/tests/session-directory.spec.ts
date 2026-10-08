import { expect, it } from 'vitest'
import { createFixture, until } from './fixture.ts'
it('authenticates directory, native list fan-out and exact intent through tickets; rejects stale ownership', async () => {
  const f = await createFixture({ sessionDirectory: true })
  try {
    const alpha = await f.addNode('alpha'), beta = await f.addNode('beta')
    const invitation = await f.request('/invites', { operator: true, method: 'POST', headers: { origin: f.publicUrl }, body: 'name=coexist&mode=tailcat' })
    expect(invitation.status).toBe(200)
    const invitationPage = await invitation.text()
    expect(invitationPage).toContain('--instance gateway-node-session --package-alias @k1412/dsh-gateway-node-session')
    expect(invitationPage).toContain('$HOME/.local/state/dsh-gateway-session')
    expect(invitationPage).not.toContain('--control')
    expect((await f.request('/sessions')).status).toBe(401)
    const html = await (await f.request('/sessions', { operator: true })).text()
    expect(html).toContain('Session alpha'); expect(html).toContain('Session beta')
    const orphan = f.gateway.store.ticket(alpha.id, 'session')
    expect((await f.request(`/_hub/ticket?ticket=${orphan}`, { node: alpha })).status).toBe(409)
    const generation = f.gateway.peers.get(alpha.id)!.generation
    const opening = await f.request(`/open/${alpha.id}?session=same-session&runtime=runtime-alpha&generation=${generation}`, { operator: true })
    const ticketUrl = new URL(opening.headers.get('location')!)
    const wrongNode = await f.request(ticketUrl.pathname + ticketUrl.search, { node: beta })
    expect(wrongNode.status).toBe(403)
    const ticketReply = await f.request(ticketUrl.pathname + ticketUrl.search, { node: alpha })
    const landing = new URL(ticketReply.headers.get('location')!, 'https://fixture.invalid')
    expect(landing.searchParams.has('gatewayIntent')).toBe(true)
    const intentPath = `/_hub/session-intent?intent=${landing.searchParams.get('gatewayIntent')}`
    expect((await f.request(intentPath, { node: beta })).status).toBe(409)
    const intent = await (await f.request(intentPath, { node: alpha })).json()
    expect(intent).toMatchObject({ nodeId: alpha.id, runtimeId: 'runtime-alpha', sessionId: 'same-session', generation })
    alpha.socket.terminate(); await until(() => !f.gateway.peers.has(alpha.id))
    expect((await f.request(intentPath, { node: alpha })).status).toBe(409)
    const partial = await (await f.request('/sessions', { operator: true })).text()
    expect(partial).toContain('offline'); expect(partial).not.toContain('Session alpha'); expect(partial).toContain('Session beta')
    await f.connect(alpha)
    expect(f.gateway.peers.get(alpha.id)!.generation).not.toBe(generation)
    expect((await f.request(intentPath, { node: alpha })).status).toBe(409)
    expect(await (await f.request('/sessions', { operator: true })).text()).toContain('Session alpha')
  } finally { await f.close() }
})

it('preserves the exact target through password reauthentication and rejects foreign return URLs', async () => {
  const f = await createFixture({ sessionDirectory: true, password: true })
  try {
    const node = await f.addNode('alpha'), generation = f.gateway.peers.get(node.id)!.generation
    const target = `/open/${node.id}?session=same-session&runtime=runtime-alpha&generation=${generation}`
    const unauthenticated = await f.request(target)
    expect(new URL(unauthenticated.headers.get('location')!, f.publicUrl).searchParams.get('returnTo')).toBe(target)
    const login = await f.request('/login', { method: 'POST', headers: { origin: f.publicUrl }, body: new URLSearchParams({ password: f.password, returnTo: target }) })
    expect(login.headers.get('location')).toBe(target)
    const rejected = await f.request('/login', { method: 'POST', headers: { origin: f.publicUrl }, body: new URLSearchParams({ password: f.password, returnTo: 'https://foreign.invalid/' }) })
    expect(rejected.headers.get('location')).toBe('/')
  } finally { await f.close() }
})

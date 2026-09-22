import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')

describe.skipIf(process.platform === 'win32')('Tailcat device pairing scripts', () => {
  let directory: string
  let mock: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hub-tailcat-test-'))
    mock = join(directory, 'tailcat')
    await writeFile(mock, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
    await chmod(mock, 0o700)
  })
  afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

  function run(script: string, env: Record<string, string> = {}) {
    return spawnSync('bash', [join(root, 'deploy/tailcat', script)], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TAILCAT_BIN: mock,
        ...env,
      },
    })
  }

  it('uses the enrolled custom client identity when forwarding, bound to loopback', () => {
    const enrollment = run('enroll-client.sh', { TAILCAT_CLIENT_KEY: 'laptop' })
    expect(enrollment.status).toBe(0)
    expect(enrollment.stdout.trim().split('\n')).toEqual(['genkey', '--client', '--key=laptop'])
    const connection = run('connect-hub.sh', {
      TAILCAT_CLIENT_KEY: 'laptop', TAILCAT_ADDRESS: 'tc-test-address',
      DSH_HUB_PORT: '8080', DSH_HUB_LOCAL_PORT: '18080',
    })
    expect(connection.status).toBe(0)
    expect(connection.stdout.trim().split('\n')).toEqual([
      '--key=laptop', 'forward', '--bind=127.0.0.1', 'tc-test-address', '18080:8080',
    ])
    expect(run('connect-hub.sh', { TAILCAT_ADDRESS: 'tc-test-address' }).stdout)
      .toContain('--key=client-default\n')
  })

  it('refuses to serve without a device allowlist and forwards the selected public key', () => {
    for (const key of ['', 'invalid-key']) {
      const rejected = run('serve-hub.sh', { TAILCAT_ALLOWED_NODEKEY: key })
      expect(rejected.status).toBe(2)
      expect(rejected.stdout).toBe('')
    }
    const nodekey = `nodekey:${'a'.repeat(64)}`
    const server = run('serve-hub.sh', { TAILCAT_ALLOWED_NODEKEY: nodekey, DSH_HUB_PORT: '8080' })
    expect(server.status).toBe(0)
    expect(server.stdout.trim().split('\n')).toEqual(['serve', '--key=default', `--allow=${nodekey}`, '8080'])
    expect(run('connect-hub.sh').status).toBe(2)
  })
})

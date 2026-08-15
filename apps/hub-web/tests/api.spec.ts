import { describe, expect, it } from 'vitest'
import { conversation } from '../src/api.ts'

describe('Hub conversation projection', () => {
  it('keeps user and assistant messages while ignoring operational records', () => {
    expect(conversation([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'world' }] } },
    ])).toEqual([
      { id: '1', role: 'user', text: 'hello', time: 2 },
      { id: '2', role: 'assistant', text: 'world', time: 3 },
    ])
  })
})

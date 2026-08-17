/**
 * Goal surface plugin, browser half: the GoalBar entry in the
 * conversation.input.dock strip. Projection-mode surface — the live goal
 * arrives through `useProjection('goal')` (seeded by the history tail page,
 * updated by session/projection frames), so this plugin owns no store, no
 * refresh chain, and no event listener. The inject face carries only the
 * four mutation verbs through the generated Goal Remote API;
 * their CAS ref reads the session's current projected value at call time.
 * Goal creation stays on the /goal host command.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `goal` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type { GoalProjection, GoalRef } from '@deepseek-ai/dsh-goal/client'
import type { GoalActionResult, GoalBarActions } from './slots.ts'
import { GoalDock } from './GoalBar.tsx'
import { GoalCommandInputView } from './GoalCommandInputView.tsx'
import { goalCommandInputDefinition } from './goal-command-input.ts'
import { en, zh, type GoalKey } from './locales.ts'

export { GoalBar, GoalDock } from './GoalBar.tsx'
export type { GoalActionResult, GoalBarActions } from './slots.ts'
export type { GoalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal strip's copy. */
    goal: GoalKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'goal'

/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents']

/**
 * Client plugin body: the GoalBar dock entry with its mutation verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(goalCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command-input',
    locale: NS,
  }, GoalCommandInputView))

  const sessions = ctx.sessions

  /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
  const refOf = (sessionId: SessionId): GoalRef | undefined => {
    const face = sessions.binding(sessionId)?.session.projections.faceOf('goal')
    const projection = face?.getSnapshot() as GoalProjection | null | undefined
    if (projection == null) return undefined
    return { id: projection.goal.id, revision: projection.goal.revision }
  }

  const noCurrentGoal: GoalActionResult = {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate', details: {} },
  }

  /**
   * Re-read the authoritative history after a rejected mutation. A carrier
   * failure may race a mutation that the Host already committed, while a CAS
   * rejection proves this browser projected an obsolete revision. Either way,
   * keeping that projection would offer the same invalid action again.
   */
  const reconcile = (sessionId: SessionId): void => {
    const session = sessions.binding(sessionId)?.session
    if (session === undefined) return
    void session.refresh().catch((error: unknown) => {
      console.error('[ui-goal] authoritative Goal refresh failed:', error)
    })
  }

  /** Preserve the Remote result while scheduling convergence for every failed carrier or business outcome. */
  const mutate = async (
    sessionId: SessionId,
    action: () => Promise<GoalActionResult>,
  ): Promise<GoalActionResult> => {
    try {
      const result = await action()
      if (!result.ok) reconcile(sessionId)
      return result
    } catch (error) {
      reconcile(sessionId)
      throw error
    }
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal',
    order: 10,
    locale: NS,
    inject: (sessionId): GoalBarActions => ({
      onEdit: async (objective) => {
        const ref = refOf(sessionId)
        if (ref === undefined) {
          reconcile(sessionId)
          return noCurrentGoal
        }
        return await mutate(sessionId, () => ctx.remote.goals.edit(sessionId, ref, { objective }))
      },
      onPause: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) {
          reconcile(sessionId)
          return noCurrentGoal
        }
        return await mutate(sessionId, () => ctx.remote.goals.pause(sessionId, ref))
      },
      onResume: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) {
          reconcile(sessionId)
          return noCurrentGoal
        }
        return await mutate(sessionId, () => ctx.remote.goals.resume(sessionId, ref))
      },
      onClear: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) {
          reconcile(sessionId)
          return noCurrentGoal
        }
        return await mutate(sessionId, () => ctx.remote.goals.clear(sessionId, ref))
      },
    }),
  }, GoalDock))
}

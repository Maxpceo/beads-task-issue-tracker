import { describe, expect, it } from 'vitest'

import sessionContextExtension from '../../.pi/extensions/session-context/index'

const runtimeOwnerKey = 'runtime:test-session-context'
;(globalThis as typeof globalThis & { __piWorkflowRuntimeOwnerKey?: string }).__piWorkflowRuntimeOwnerKey = runtimeOwnerKey

describe('Pi session context bd-first workflow display', () => {
  it('renders workflow context with session, bead, bd, plan, and slot fields', async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
    const notifications: Array<{ message: string; level: string }> = []
    const pi = {
      async exec(command: string, args: string[]) {
        if (command === 'git' && args.join(' ') === 'branch --show-current') return { stdout: 'task/demo\n', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === 'status --short') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.join(' ') === 'worktree list --porcelain') return { stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/task/demo\n', stderr: '', code: 0 }
        if (command === 'bd') return { stdout: '-', stderr: '', code: 0 }
        if (command === 'bash') return { stdout: '-', stderr: '', code: 0 }
        return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
      },
      on(event: string, handler: any) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    }
    const ctx = {
      cwd: '/repo',
      sessionManager: {
        getEntries: () => [
          {
            type: 'custom',
            customType: 'workflow-state',
            data: {
              activeBead: 'beads-task-issue-tracker-bmgc',
              sessionMode: 'implementing',
              planMode: 'off',
              planApproved: true,
              mergeSlotHeld: false,
              bdStatus: 'custom_hold',
              runtimeOwnerKey,
            },
          },
        ],
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level })
        },
      },
    }

    sessionContextExtension(pi as any)
    await handlers.get('session_start')?.({}, ctx)
    const injected = await handlers.get('before_agent_start')?.({}, ctx) as any
    const content = injected.message.content as string

    expect(content).toContain('Workflow context:\nsession:implementing | bead:beads-task-issue-tracker-bmgc | bd:custom_hold | plan:off/approved | slot:free')
    expect(content).not.toContain('Workflow context:\nundefined')
    expect(content).not.toContain('wf:')
    expect(notifications.at(-1)).toEqual({ message: 'Pi session context captured', level: 'info' })
  })
})

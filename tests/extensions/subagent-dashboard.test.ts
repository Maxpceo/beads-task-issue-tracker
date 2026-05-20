import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearObservedDashboardCards,
  createDashboardState,
  publishDashboardCard,
  renderDashboardLines,
  selectDashboardAgents,
  setSharedDashboardState,
  getSharedDashboardState,
  upsertDashboardCard,
} from '../../.pi/extensions/subagent/dashboard'
interface TestAgentConfig {
  name: string
  description: string
  source: 'project' | 'user'
  filePath: string
  systemPrompt: string
}

interface TestAgentTeamConfigResult {
  teams: Array<{ name: string; members: string[]; warnings: string[] }>
  filePath: string
  warnings: string[]
}

const agents: TestAgentConfig[] = [
  {
    name: 'reviewer',
    description: 'Review code',
    source: 'project',
    filePath: '/repo/.pi/agents/reviewer.md',
    systemPrompt: 'Review',
  },
  {
    name: 'supervisor',
    description: 'Implement tasks',
    source: 'project',
    filePath: '/repo/.pi/agents/supervisor.md',
    systemPrompt: 'Implement',
  },
]

const noTeams: TestAgentTeamConfigResult = {
  teams: [],
  filePath: '/repo/.pi/agents/teams.yaml',
  warnings: ['No .pi/agents/teams.yaml found; showing individual agents only.'],
}

const teams: TestAgentTeamConfigResult = {
  teams: [
    { name: 'core', members: ['supervisor', 'reviewer'], warnings: [] },
    { name: 'broken', members: ['missing'], warnings: ['Unknown agent: missing'] },
  ],
  filePath: '/repo/.pi/agents/teams.yaml',
  warnings: [],
}

function createTheme() {
  const colors: string[] = []
  return {
    colors,
    theme: {
      fg: (color: string, text: string) => {
        colors.push(color)
        return text
      },
      bold: (text: string) => text,
    },
  }
}

describe('subagent dashboard helpers', () => {
  beforeEach(() => {
    clearObservedDashboardCards()
    setSharedDashboardState(null)
  })

  it('falls back to all project-local agents when no team is configured', () => {
    const selection = selectDashboardAgents(agents, noTeams)

    expect(selection.teamName).toBeUndefined()
    expect(selection.agents.map((agent) => agent.name)).toEqual(['reviewer', 'supervisor'])
    expect(selection.warnings.join('\n')).toContain('No .pi/agents/teams.yaml')
  })

  it('selects a named/default team without activating unknown members', () => {
    const defaultSelection = selectDashboardAgents(agents, teams)
    const brokenSelection = selectDashboardAgents(agents, teams, 'broken')

    expect(defaultSelection.teamName).toBe('core')
    expect(defaultSelection.agents.map((agent) => agent.name)).toEqual(['supervisor', 'reviewer'])
    expect(brokenSelection.teamName).toBe('broken')
    expect(brokenSelection.agents).toEqual([])
    expect(brokenSelection.warnings).toContain('Unknown agent: missing')
  })

  it('renders active empty state without idle project agents', () => {
    const state = createDashboardState(selectDashboardAgents(agents, teams), 'active')
    const { theme } = createTheme()
    const lines = renderDashboardLines(state, 80, theme, 1_000)

    expect(state.cards.size).toBe(0)
    expect(lines.join('\n')).toContain('[active]')
    expect(lines.join('\n')).toContain('No active agents observed in this Pi session.')
    expect(lines.join('\n')).not.toContain('reviewer')
    expect(lines.join('\n')).not.toContain('supervisor')
  })

  it('renders all mode with idle selected project agents', () => {
    const state = createDashboardState(selectDashboardAgents(agents, teams), 'all')
    const { theme } = createTheme()
    const lines = renderDashboardLines(state, 80, theme, 1_000)

    expect(Array.from(state.cards.keys()).sort()).toEqual(['reviewer', 'supervisor'])
    expect(lines.join('\n')).toContain('[all]')
    expect(lines.join('\n')).toContain('[idle]')
    expect(lines.join('\n')).toContain('reviewer')
    expect(lines.join('\n')).toContain('supervisor')
  })

  it('publishes generic and workflow cards into the shared active dashboard store', () => {
    const state = createDashboardState(selectDashboardAgents(agents, teams), 'active')
    setSharedDashboardState(state)

    publishDashboardCard({ agent: 'supervisor', source: 'project', status: 'running', task: 'Implement bead', startedAt: 1_000, toolCount: 1, lastPreview: 'reading files' })
    publishDashboardCard({ agent: 'code-reviewer', source: 'project', status: 'completed', task: 'Review bead', startedAt: 1_000, completedAt: 2_000, toolCount: 0, lastPreview: 'VERDICT: APPROVED' })

    const shared = getSharedDashboardState()
    expect(shared?.cards.get('supervisor')?.status).toBe('running')
    expect(shared?.cards.get('code-reviewer')?.status).toBe('completed')
    expect(shared?.cards.has('reviewer')).toBe(false)
  })

  it('renders live running and error cards with a mode/help hint within narrow widths', () => {
    const state = createDashboardState(selectDashboardAgents(agents, teams))
    upsertDashboardCard(state, {
      agent: 'supervisor',
      source: 'project',
      status: 'running',
      task: 'Implement a persistent visual dashboard with a very long task description',
      startedAt: 1_000,
      toolCount: 2,
      contextText: 'ctx:12k in:3k out:900',
      lastPreview: 'reading .pi/extensions/subagent/index.ts',
    })
    upsertDashboardCard(state, {
      agent: 'missing-agent',
      source: 'unknown',
      status: 'failed',
      task: 'Run unknown agent',
      startedAt: 1_000,
      completedAt: 2_000,
      toolCount: 0,
      errorMessage: 'Unknown agent: missing-agent',
    })

    const { colors, theme } = createTheme()
    const lines = renderDashboardLines(state, 52, theme, 4_000)
    const supervisorLine = lines.find((line) => line.includes('supervisor'))

    expect(lines.join('\n')).toContain('Modes: active/all')
    expect(lines.join('\n')).toContain('supervisor')
    expect(lines.join('\n')).toContain('[running]')
    expect(lines.join('\n')).toContain('ctx:12k in:3k out:900')
    expect(lines.join('\n')).toContain('missing-agent')
    expect(lines.join('\n')).toContain('Unknown agent')
    expect(supervisorLine?.startsWith('│  ')).toBe(true)
    expect(colors).toContain('warning')
    expect(colors).toContain('error')
    expect(colors).toContain('borderMuted')
    expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true)
  })

  it('keeps two-column running cards within the terminal width when status icons are double-width', () => {
    const state = createDashboardState(
      selectDashboardAgents(
        [
          {
            name: 'code-reviewer',
            description: 'Pi-native adversarial code reviewer for spec compliance, automated checks, and handoff quality.',
            source: 'project',
          },
          {
            name: 'documentation-expert',
            description: 'Pi-native documentation updater for CHANGELOG, README and docs during accepted changes.',
            source: 'project',
          },
        ],
        noTeams,
      ),
    )
    upsertDashboardCard(state, {
      agent: 'code-reviewer',
      source: 'project',
      status: 'running',
      task: 'Повтори полный вывод архитектурной проверки плана beads-task-issue-tracker-tbc6',
      startedAt: 1_000,
      toolCount: 3,
      contextText: 'ctx:10k',
      lastPreview: 'bash {"command":"rg -n \\"tbc6|follow-up reminder|followup|NEEDS_CHANGES\\""}',
    })

    const { theme } = createTheme()
    const lines = renderDashboardLines(state, 138, theme, 17_000)

    expect(lines.join('\n')).toContain('Modes: active/all/refresh')
    expect(lines.some((line) => line.includes('⏳'))).toBe(true)
    expect(lines.every((line) => visibleWidth(line) <= 138)).toBe(true)
  })
})

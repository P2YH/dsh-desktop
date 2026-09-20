/** Packaged DSH skill for source-backed Architecture Review knowledge work. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'

export const ARCHITECTURE_REVIEW_SKILL_NAME = 'architecture-review-knowledge'

const skillUrl = new URL('../skills/architecture-review-knowledge/SKILL.md', import.meta.url)
const resourceBase = { kind: 'directory', path: fileURLToPath(new URL('../skills/architecture-review-knowledge/', import.meta.url)) } as const
const description = 'Maintain and query the Architecture Review workspace wiki, and verify review claims against original sources. Use for knowledge maintenance, source-backed questions, and evidence checks during architecture reviews.'
const candidate: SkillCandidate = {
  name: ARCHITECTURE_REVIEW_SKILL_NAME,
  description,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: ARCHITECTURE_REVIEW_SKILL_NAME,
  source: 'bundled',
  resourceBase,
  rank: 600,
  locator: skillUrl,
}

export function architectureReviewSkillProvider(): SkillProvider {
  return {
    name: ARCHITECTURE_REVIEW_SKILL_NAME,
    list: async () => [candidate],
    async get() {
      const text = await readFile(skillUrl, 'utf8')
      const content = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trimStart()
      if (content === text.trimStart()) throw new Error('architecture review skill frontmatter is missing')
      return { ...candidate, content }
    },
  }
}

export function registerArchitectureReviewSkill(ctx: Context): void {
  ctx.skills.registerProvider(architectureReviewSkillProvider)
}

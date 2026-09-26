import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const extensionsDir = resolve(__dirname, '../../.pi/extensions')

export function extensionEntrypointPaths(): string[] {
  return readdirSync(extensionsDir)
    .filter(name => statSync(resolve(extensionsDir, name)).isDirectory())
    .map(name => resolve(extensionsDir, name, 'index.ts'))
    .filter(path => existsSync(path))
    .sort()
}

function hasDefaultModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))
}

function hasExportModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function isFunctionLikeInitializer(node: ts.Node): boolean {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

export function hasDefaultFactoryExport(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile('extension-entrypoint.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functionBindings = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionBindings.add(statement.name.text)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isFunctionLikeInitializer(declaration.initializer)) {
          functionBindings.add(declaration.name.text)
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && hasDefaultModifier(statement)) {
      return true
    }
    if (ts.isExportAssignment(statement)) {
      if (isFunctionLikeInitializer(statement.expression)) return true
      if (ts.isIdentifier(statement.expression) && functionBindings.has(statement.expression.text)) return true
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== 'default') continue
        const exportedName = element.propertyName?.text ?? element.name.text
        if (functionBindings.has(exportedName)) return true
      }
    }
  }

  return false
}

describe('Pi extension entrypoint contracts', () => {
  it('exports a default factory function from every .pi/extensions/*/index.ts entrypoint', () => {
    const invalidEntrypoints: string[] = []
    const entrypoints = extensionEntrypointPaths()

    expect(entrypoints.some(path => path.endsWith('/plan-review/index.ts'))).toBe(true)

    for (const entrypoint of entrypoints) {
      const source = readFileSync(entrypoint, 'utf8')
      if (!hasDefaultFactoryExport(source)) invalidEntrypoints.push(entrypoint.replace(`${extensionsDir}/`, ''))
    }

    expect(invalidEntrypoints).toEqual([])
  })

  it('rejects helper-only modules without a default factory', () => {
    const helperOnlySource = `
export const REQUIRED_HELPERS = ['named exports are not enough']
export function parseSomething() {
  return 'named helper export'
}
`

    expect(hasDefaultFactoryExport(helperOnlySource)).toBe(false)
  })

  it('accepts common callable default factory export forms', () => {
    expect(hasDefaultFactoryExport('export default function extensionFactory() {}')).toBe(true)
    expect(hasDefaultFactoryExport('const extensionFactory = () => {}\nexport default extensionFactory')).toBe(true)
    expect(hasDefaultFactoryExport('function extensionFactory() {}\nexport { extensionFactory as default }')).toBe(true)
  })
})

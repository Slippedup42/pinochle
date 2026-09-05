/// <reference types="node" />

// A reader-driven walk of the app's static import graph (#236).
//
// This module is test-only infrastructure: it reads source off disk and parses
// it, and nothing under `src/` outside this directory imports it. That is not a
// convention here - `bundleBoundary.test.ts` walks the graph this module builds
// and would report this file if it ever became reachable from `index.html`.
//
// All filesystem access goes through `SourceReader` so the walk can be run over
// a virtual tree in a test. A guard whose only subject is the real repository
// can only ever be watched passing, and its failure path gets exercised once by
// whoever wrote it and never again (#261).

import { readFileSync } from 'node:fs'
import * as posix from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

/**
 * Paths are POSIX-normalised everywhere below, including on Windows, where the
 * caller converts separators on the way in. Node's `fs` accepts forward slashes
 * on Windows, so nothing has to convert back.
 */
export interface SourceReader {
  /** File contents, or `null` if there is no file at that path. */
  read(path: string): string | null
}

export interface ImportEdge {
  readonly from: string
  readonly specifier: string
  readonly to: string
  /**
   * `import type ...` / `export type ... from ...` / `import('x').T`. Erased by
   * the compiler, so a type-only edge puts no bytes in the bundle - see
   * `bundleBoundary.test.ts` for why it is still reported as a violation.
   */
  readonly typeOnly: boolean
}

export interface GraphWalk {
  /** Every module reachable from the entries, entries included. Sorted. */
  readonly reachable: readonly string[]
  readonly edges: readonly ImportEdge[]
  /**
   * Relative specifiers this resolver could not find a file for. Never expected
   * to be non-empty on a tree that compiles; surfaced rather than swallowed,
   * because an unresolved import is a branch of the graph that went unwalked,
   * and an unwalked branch is indistinguishable from a clean one.
   */
  readonly unresolved: readonly { readonly from: string; readonly specifier: string }[]
  /** How each reachable module was first reached. Entries map to `null`. */
  readonly reachedVia: ReadonlyMap<string, string | null>
}

const PARSEABLE = /\.(c|m)?[jt]sx?$/
const TSX = /\.[jt]sx$/

/**
 * Extension candidates in the order a bundler would try them. `.js` specifiers
 * map to their TypeScript sources as well: this codebase writes extensionless
 * and explicit `.tsx` specifiers today, but a `.js` specifier resolves to a
 * `.ts` file under `moduleResolution: bundler`, and a resolver that missed that
 * shape would walk straight past a real edge.
 */
function candidates(base: string): string[] {
  const out = [base]
  if (/\.jsx?$/.test(base)) {
    out.push(base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'))
  }
  out.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`)
  out.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`)
  return out
}

/** True for specifiers that name a file in this repository rather than a package. */
export function isLocalSpecifier(specifier: string): boolean {
  const clean = specifier.split('?')[0]
  return clean.startsWith('.') || clean.startsWith('/')
}

/**
 * Resolves a relative or root-absolute specifier to a path under `root`. Bare
 * specifiers (`react`, `node:fs`) return `null`: they are packages, not part of
 * this repository's own graph, and following them would walk `node_modules`.
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  root: string,
  reader: SourceReader,
): string | null {
  const clean = specifier.split('?')[0]
  // `join` rather than `resolve`: a Windows-rooted path like `C:/repo/web` is
  // not absolute to `path/posix`, so `resolve` would silently prefix it with
  // `process.cwd()` and every relative import in the tree would come back
  // unresolved. `join` normalises `.` and `..` without consulting the cwd.
  let base: string
  if (clean.startsWith('/')) base = posix.join(root, clean)
  else if (clean.startsWith('.')) base = posix.join(posix.dirname(fromFile), clean)
  else return null

  for (const candidate of candidates(base)) {
    if (reader.read(candidate) !== null) return candidate
  }
  return null
}

interface RawImport {
  readonly specifier: string
  readonly typeOnly: boolean
}

/**
 * Every module specifier in one file, via the TypeScript parser rather than a
 * regular expression. The distinction matters for a guard: this module's own
 * header quotes an import path inside a comment, and several files under
 * `src/ab/` discuss `../engine/...` in prose. A textual scan reports those as
 * edges, and a guard that cries wolf gets suppressed rather than fixed.
 */
export function moduleSpecifiers(source: string, fileName: string): RawImport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    TSX.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: RawImport[] = []

  const push = (node: ts.Node | undefined, typeOnly: boolean): void => {
    if (node && ts.isStringLiteralLike(node)) found.push({ specifier: node.text, typeOnly })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // `import { type A } from 'x'` is deliberately *not* type-only: under
      // `verbatimModuleSyntax` the statement itself survives compilation, so the
      // module is loaded at runtime even though every binding it named is gone.
      push(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push(node.moduleSpecifier, node.isTypeOnly)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push(node.moduleReference.expression, false)
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) push(node.argument.literal, true)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node.arguments[0], false)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return found
}

/**
 * Breadth-first from `entries`. Reachable files that are not parseable source
 * (`./index.css`, an imported asset) are recorded as reached and not opened -
 * they are real nodes of the shipped graph, so a stylesheet under a forbidden
 * directory still counts, but there is nothing in them to follow.
 */
export function walkImports(
  entries: readonly string[],
  root: string,
  reader: SourceReader,
): GraphWalk {
  const reachedVia = new Map<string, string | null>()
  const edges: ImportEdge[] = []
  const unresolved: { from: string; specifier: string }[] = []
  const queue: string[] = []

  for (const entry of entries) {
    if (!reachedVia.has(entry)) {
      reachedVia.set(entry, null)
      queue.push(entry)
    }
  }

  while (queue.length > 0) {
    const file = queue.shift()!
    if (!PARSEABLE.test(file)) continue
    const source = reader.read(file)
    if (source === null) continue

    for (const { specifier, typeOnly } of moduleSpecifiers(source, file)) {
      if (!isLocalSpecifier(specifier)) continue
      const to = resolveSpecifier(specifier, file, root, reader)
      if (to === null) {
        unresolved.push({ from: file, specifier })
        continue
      }
      edges.push({ from: file, specifier, to, typeOnly })
      if (!reachedVia.has(to)) {
        reachedVia.set(to, file)
        queue.push(to)
      }
    }
  }

  return { reachable: [...reachedVia.keys()].sort(), edges, unresolved, reachedVia }
}

/**
 * The chain from an entry down to `file`, as first reached. Reported instead of
 * a bare filename so a failure names the import that has to be undone rather
 * than the module at the bottom of it.
 */
export function chainTo(walk: GraphWalk, file: string): string[] {
  const chain: string[] = []
  let current: string | null | undefined = file
  while (current != null && !chain.includes(current)) {
    chain.unshift(current)
    current = walk.reachedVia.get(current)
  }
  return chain
}

const MODULE_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["']/gi

/**
 * The module scripts of an HTML page, which is what Rollup takes as build input.
 * Deriving the roots from the page rather than naming `src/main.tsx` here is the
 * difference between a guard on the app and a guard on one path through it: a
 * second `<script type="module">` added to `index.html` becomes a root
 * automatically, where a hardcoded entry would leave it unwalked and the guard
 * would go on reporting success.
 */
export function htmlEntries(htmlPath: string, root: string, reader: SourceReader): string[] {
  const html = reader.read(htmlPath)
  if (html === null) return []
  const out: string[] = []
  for (const match of html.matchAll(MODULE_SCRIPT)) {
    const resolved = resolveSpecifier(match[1], htmlPath, root, reader)
    if (resolved !== null) out.push(resolved)
  }
  return out
}

/** Reads real files. Callers hand it the POSIX paths used throughout this module. */
export const diskReader: SourceReader = {
  read(path: string): string | null {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

/**
 * A `file:` URL as a POSIX path, with the trailing slash and any Windows
 * separators taken off. Callers pass their own `import.meta.url`: under
 * vite-node only an entry module is guaranteed a `file:` URL of its own, so a
 * module-relative constant computed *here* resolves against something else
 * entirely and throws. This keeps the module ignorant of where the repository
 * sits, which is the right shape for it anyway.
 */
export function dirOf(metaUrl: string, up: string): string {
  return fileURLToPath(new URL(up, metaUrl))
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

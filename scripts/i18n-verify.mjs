#!/usr/bin/env node
/* Check every language against default.ts.
 *
 * AGENTS.md requires this after ANY i18n change, for two failures the
 * compiler cannot see:
 *   - a missing id (the LangDict type catches this one, but only if the
 *     language object is typed; a stray `as any` would hide it)
 *   - a `${placeholder}` that differs from the English key's, which leaves a
 *     translation referencing a variable the code never passes. Nothing
 *     typechecks that, and it renders as a literal ${foo} to the user.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const D = join(ROOT, 'startos/i18n/dictionaries')
const dictSrc = readFileSync(join(D, 'default.ts'), 'utf8')
const transSrc = readFileSync(join(D, 'translations.ts'), 'utf8')

const lit = (q, body) => Function(`"use strict"; return ${q}${body}${q}`)()
const english = new Map() // id -> english string
for (const m of dictSrc.matchAll(
  /^\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*)):\s*(\d+),$/gm,
)) {
  const key =
    m[1] !== undefined
      ? lit("'", m[1])
      : m[2] !== undefined
        ? lit('"', m[2])
        : m[3]
  english.set(Number(m[4]), key)
}

const PH = (s) => (s.match(/\$\{[^}]*\}/g) || []).sort().join(',')

let bad = 0
const langs = [...transSrc.matchAll(/^  ([a-z]{2}_[A-Z]{2}): \{$/gm)].map(
  (m) => m[1],
)
if (!langs.length) {
  console.error('no languages found')
  process.exit(1)
}
for (const lang of langs) {
  const start = transSrc.indexOf(`  ${lang}: {`)
  const end = transSrc.indexOf('\n  },', start)
  const block = transSrc.slice(start, end)
  const have = new Map()
  for (const m of block.matchAll(
    /^\s*(\d+):\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"),?$/gm,
  )) {
    have.set(Number(m[1]), m[2] !== undefined ? lit("'", m[2]) : lit('"', m[3]))
  }
  const missing = [...english.keys()].filter((id) => !have.has(id))
  const extra = [...have.keys()].filter((id) => !english.has(id))
  const drift = [...have.entries()].filter(
    ([id, v]) => english.has(id) && PH(english.get(id)) !== PH(v),
  )
  if (missing.length) {
    console.error(`${lang}: MISSING ids ${missing.join(', ')}`)
    bad++
  }
  if (extra.length) {
    console.error(`${lang}: ids not in default.ts: ${extra.join(', ')}`)
    bad++
  }
  for (const [id, v] of drift) {
    console.error(
      `${lang}: id ${id} placeholders differ\n    en: ${PH(english.get(id)) || '(none)'}\n    ${lang}: ${PH(v) || '(none)'}`,
    )
    bad++
  }
  if (!missing.length && !extra.length && !drift.length)
    console.log(
      `${lang}: ${have.size}/${english.size} complete, placeholders match`,
    )
}
process.exit(bad ? 1 : 0)

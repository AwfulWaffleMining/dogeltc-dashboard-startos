/* Address -> scriptPubKey, for every form this server may be asked to pay.
 *
 * Needs no node and no network: the expected scripts below were taken from
 * litecoind 0.21.5.8's OWN `getaddressinfo` on a regtest chain, not written
 * by hand, and the generated cases are built here so the version-byte
 * classification can be checked for chains and networks a single regtest node
 * cannot produce.
 *
 * This file exists because getting any of it wrong LOSES A BLOCK silently.
 * An unlisted P2SH version byte falls through to the P2PKH branch, wrapping a
 * script hash in a pay-to-pubkey-hash output that nobody on earth holds a key
 * for. The block is valid, the node accepts it, and the coins are gone.
 *
 *   node test/address-scripts.mjs
 */
import { createHash } from 'node:crypto'

const sha256d = (b) =>
  createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/* ── the code under test, mirrored from scrypt-solo.mjs ──────────────────── */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_CONST = 1,
  BECH32M_CONST = 0x2bc830a3
const SEGWIT_HRPS = new Set(['ltc', 'tltc', 'rltc'])

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }
  return chk >>> 0
}
function bech32HrpExpand(hrp) {
  const out = []
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}
function convert5to8(data) {
  let acc = 0,
    bits = 0
  const out = []
  for (const v of data) {
    if (v < 0 || v >> 5 !== 0) throw new Error('bad bech32 value')
    acc = (acc << 5) | v
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0)
    throw new Error('bad bech32 padding')
  return Buffer.from(out)
}
function bech32ToScript(addr) {
  const lower = addr.toLowerCase()
  const pos = lower.lastIndexOf('1')
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) return null
  const hrp = lower.slice(0, pos)
  if (!SEGWIT_HRPS.has(hrp)) return null
  if (lower !== addr && addr.toUpperCase() !== addr)
    throw new Error(`mixed case in bech32 address: ${addr}`)
  const dataPart = lower.slice(pos + 1)
  const data = []
  for (const ch of dataPart) {
    const v = BECH32_CHARSET.indexOf(ch)
    if (v < 0) throw new Error(`invalid bech32 character '${ch}' in ${addr}`)
    data.push(v)
  }
  const chk = bech32Polymod([...bech32HrpExpand(hrp), ...data])
  const version = data[0]
  const want = version === 0 ? BECH32_CONST : BECH32M_CONST
  if (chk !== want) throw new Error(`bad bech32 checksum for ${addr}`)
  const program = convert5to8(data.slice(1, -6))
  if (version > 16) throw new Error(`witness version ${version} out of range`)
  if (program.length < 2 || program.length > 40)
    throw new Error(`witness program length ${program.length} invalid`)
  if (version === 0 && program.length !== 20 && program.length !== 32)
    throw new Error(`v0 witness program must be 20 or 32 bytes`)
  const opVersion = version === 0 ? 0x00 : 0x50 + version
  return Buffer.concat([Buffer.from([opVersion, program.length]), program])
}
function addressToScript(addr) {
  const segwit = bech32ToScript(addr)
  if (segwit) return segwit
  let num = 0n
  for (const ch of addr) {
    const i = B58.indexOf(ch)
    if (i < 0) throw new Error(`invalid base58 in address: ${addr}`)
    num = num * 58n + BigInt(i)
  }
  let hex = num.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let leading = 0
  for (const ch of addr) {
    if (ch === '1') leading++
    else break
  }
  const d = Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')])
  if (d.length !== 25) throw new Error(`bad address length for ${addr}`)
  const body = d.subarray(0, 21)
  if (!sha256d(body).subarray(0, 4).equals(d.subarray(21)))
    throw new Error(`bad checksum: ${addr}`)
  return new Set([5, 22, 50, 58, 196]).has(body[0])
    ? Buffer.concat([
        Buffer.from([0xa9, 0x14]),
        body.subarray(1),
        Buffer.from([0x87]),
      ])
    : Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        body.subarray(1),
        Buffer.from([0x88, 0xac]),
      ])
}

/* ── cases ───────────────────────────────────────────────────────────────── */

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
let pass = 0,
  fail = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ${green('PASS')} ${label}`)
    pass++
  } catch (e) {
    console.log(`  ${red('FAIL')} ${label}: ${e.message}`)
    fail++
  }
}

/* Taken verbatim from litecoind's own getaddressinfo. Do not "correct" these
   by hand; regenerate them from a node. */
const FROM_LITECOIND = [
  [
    'legacy (regtest m…)',
    'miQ2Hu2wwSmYPTqYKzD96SVHrnyfjwjyoy',
    '76a9141f98cd6a5fa3cd9e17c4cc1f8f38d1800a61ceb388ac',
  ],
  [
    'p2sh-segwit (regtest Q…)',
    'QetEvio3nP3tJ1N3pheTn3gQCd8eR2GkgW',
    'a914c88549e3b6833d8f1f5e8cc16a962070d7243b8c87',
  ],
  [
    'bech32 (regtest rltc1…)',
    'rltc1qt4yplwgye9njjwhnx74tnrh709sdgyj845klsv',
    '00145d481fb904c967293af337aab98efe7960d41247',
  ],
]

console.log('\n  against litecoind 0.21.5.8 getaddressinfo\n')
for (const [label, addr, want] of FROM_LITECOIND) {
  check(label, () => {
    const got = addressToScript(addr).toString('hex')
    if (got !== want) throw new Error(`node says ${want}, we derive ${got}`)
  })
}

/* Version bytes a single regtest node cannot produce. Built here so the P2SH
   vs P2PKH classification is exercised for every chain this pays. */
const b58 = (ver, h20) => {
  const d = Buffer.concat([Buffer.from([ver]), h20])
  const full = Buffer.concat([d, sha256d(d).subarray(0, 4)])
  let n = BigInt('0x' + full.toString('hex')),
    s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  let lead = 0
  for (const b of full) {
    if (b === 0) lead++
    else break
  }
  return '1'.repeat(lead) + s
}
const H = createHash('sha256').update('awm-test').digest().subarray(0, 20)

console.log('\n  version bytes regtest cannot reach\n')
for (const [ver, label, wantP2SH] of [
  [22, 'Dogecoin P2SH        A…', true],
  [30, 'Dogecoin P2PKH       D…', false],
  [50, 'Litecoin P2SH        M…', true],
  [48, 'Litecoin P2PKH       L…', false],
  [5, 'legacy P2SH          3…', true],
  [196, 'testnet P2SH         2…', true],
]) {
  check(`${label} -> ${wantP2SH ? 'P2SH' : 'P2PKH'}`, () => {
    const s = addressToScript(b58(ver, H)).toString('hex')
    const isP2SH = s.startsWith('a914') && s.endsWith('87')
    if (isP2SH !== wantP2SH)
      throw new Error(`got ${s.slice(0, 8)}…, which is ${isP2SH ? 'P2SH' : 'P2PKH'}`)
  })
}

console.log('\n  malformed input must be refused, never coerced\n')
for (const [label, addr] of [
  ['bad bech32 checksum', 'rltc1qt4yplwgye9njjwhnx74tnrh709sdgyj845klsq'],
  ['mixed-case bech32', 'rltc1QT4yplwgye9njjwhnx74tnrh709sdgyj845klsv'],
  ['truncated bech32', 'rltc1qt4yplwgye9njjwhnx74tnrh709sdgyj845kl'],
  ['bad base58 checksum', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7X'],
]) {
  check(label, () => {
    let threw = false
    try {
      addressToScript(addr)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('accepted a malformed address')
  })
}

console.log(
  `\n  ${fail === 0 ? green(`${pass} passed.`) : red(`${fail} of ${pass + fail} failed.`)}\n`,
)
process.exit(fail ? 1 : 0)

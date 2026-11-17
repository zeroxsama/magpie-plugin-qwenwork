// QwenWork provider. Chat completions are rewritten as QwenWork's own
// agent_chat_generation request by the vendored adapter (vendor/qoder.mjs):
// the host's tools ride along, tool calls come back structured, and the
// host agent keeps its loop. Magpie auth supplies the account; COSY signing,
// the request codec and the endpoint stay in the adapter.
import { createPublicKey, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
const pluginIcon = (() => {
  try { return `data:image/png;base64,${readFileSync(new URL('./icon.png', import.meta.url)).toString('base64')}` } catch { return '' }
})()

function setting(name) {
  const value = (process.env['QWENWORK_' + name] ?? defaults[name])?.trim()
  if (!value) throw new Error(`QWENWORK_${name} is not configured`)
  return value
}
function origin(name) {
  let url
  try { url = new URL(setting(name)) } catch { throw new Error(`QWENWORK_${name} must be an https address`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`QWENWORK_${name} must be an https origin`)
  return url.origin
}

// num renders a credit count as magpie shows one: no trailing zeros, at most
// two decimals (1982.1652 -> "1982.17", 2000 -> "2000").
const num = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(Math.round(n * 100) / 100)
}

// figure reads a credit count, plain or wrapped: QwenWork sometimes answers
// an amount as an object ({amount, value, total_balance, …}) rather than a
// number; the first finite field of the usual names is the count.
const figure = (v) => {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['amount', 'value', 'remaining', 'total_balance', 'totalBalance', 'balance', 'total', 'used']) {
      const n = figure(v[k])
      if (n !== undefined) return n
    }
    return undefined
  }
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// shape names a value's keys and types without echoing any value, so a quota
// the parser does not recognise can still be reported and identified.
const shape = (v, depth = 0) => {
  if (v === undefined || v === null) return 'none'
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v !== 'object') return typeof v
  if (depth > 2) return 'object'
  return Object.keys(v).map(k => `${k}:${shape(v[k], depth + 1)}`).join(', ') || '(empty)'
}

// walletPools names each credit pool's balance from /api/v1/adapter/user/
// wallets, as QwenWork's own client reads them (QwenWorkCN.app's
// fetchUserWallets / mergeWalletsIntoCreditBreakdown): daily_credits,
// monthly_credits, longterm_credits, each a total_balance. A personal
// account's quota gives only the remaining sum; the pools say where it
// sits, and their drop between two reads is what a run spent.
const walletPools = (w) => {
  const d = w?.data && typeof w.data === 'object' ? w.data : (w ?? {})
  const out = []
  for (const [key, name] of [['daily_credits', 'daily'], ['monthly_credits', 'monthly'], ['longterm_credits', 'long-term']]) {
    const b = Number(d?.[key]?.total_balance ?? d?.[key]?.totalBalance)
    if (Number.isFinite(b) && b > 0) out.push(`${name} ${num(b)}`)
  }
  return out
}

// spentSince logs the credits gone since the last usage read on stderr
// when QWENWORK_DEBUG_USAGE=1: the real per-run cost the gateway bills,
// which no per-request usage chunk carries.
let lastRemaining
function spentSince(left) {
  if (process.env.QWENWORK_DEBUG_USAGE !== '1' || left === undefined) return
  if (lastRemaining !== undefined && left < lastRemaining) console.error(`[qwenwork] credits spent since last read: ${num(lastRemaining - left)} (${num(lastRemaining)} -> ${num(left)})`)
  lastRemaining = left
}

// clientHeaders are the names QwenWork's own client puts on every gateway
// call outside a chat (its openApiJsonRequest), as the upstream plugin
// sends them: without them the call goes out as no client at all, which
// some gateway routes refuse or answer empty.
const clientHeaders = () => ({
  'User-Agent': 'qoderwork/1.2.1',
  'X-Request-Id': randomUUID(),
  'X-QwenWork-Version': '1.2.1',
  'X-QwenWork-Release-Version': '1.2.1-26092107',
  'X-QwenWork-Build': '26092107',
  'X-QwenWork-Platform': process.platform,
  'X-QwenWork-Arch': process.arch,
  'X-QwenWork-Channel': 'stable',
})

// usageSaid logs what a usage read gave, on stderr when
// QWENWORK_DEBUG_USAGE=1: the quota's shape and the windows built from it,
// so an empty balance can be told apart from a refused or empty read.
function usageSaid(what, detail) {
  if (process.env.QWENWORK_DEBUG_USAGE !== '1') return
  console.error(`[qwenwork] usage ${what}: ${detail}`)
}

// qwenworkUsage reads the account's credits for magpie's usage bar from the
// account-context the sign-in already uses. QwenWork's real response gives
// quota {total: null, used: null, remaining, exceeded} — only the remaining
// credits — plus plan {name, next_due_date | next_refresh_date}. A plan that
// does name total and used is shown as a used/limit window; otherwise magpie's
// balance window shows what is left (its own docs: "a prepaid wallet: what is
// left, in unit; no used or limit").
function qwenworkUsage(openapi) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim() || (a.expires > 0 && a.expires <= Date.now())) return { error: 'QwenWork: not signed in', signIn: 'expired' }
      const res = await fetch(`${openapi}/api/v1/adapter/user/account-context?include=user,plan,quota`, {
        headers: { Accept: 'application/json', ...clientHeaders(), Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { error: 'QwenWork: the sign-in lapsed — sign in again', signIn: 'expired' }
      if (!res.ok) return { error: `QwenWork: usage read failed (HTTP ${res.status})`, signIn }
      const env = await res.json()
      const ctx = env?.data && typeof env.data === 'object' ? env.data : (env ?? {})
      const q = ctx.quota ?? {}
      const out = { signIn }
      if (ctx.plan?.name) out.plan = String(ctx.plan.name)
      const due = ctx.plan?.next_refresh_date ?? ctx.plan?.next_due_date
      if (due) {
        const t = typeof due === 'string' && !/^\d+$/.test(due) ? Date.parse(due) : Number(due) * (Number(due) < 1e12 ? 1000 : 1)
        if (Number.isFinite(t)) out.until = new Date(t).toISOString()
      }
      const total = figure(q.total)
      const used = figure(q.used)
      const left = figure(q.remaining)
      if (total !== undefined && total > 0 && (used !== undefined || left !== undefined)) {
        const spent = used !== undefined ? used : total - left
        if (Number.isFinite(spent) && spent >= 0) out.windows = [{ name: 'Credits', used: Math.min(100, (100 * spent) / total), display: `${num(spent)} / ${num(total)} credits` }]
      }
      if (!out.windows && left !== undefined && left >= 0) {
        // the pools behind the balance, as the client asks for a personal
        // account's; a failed read leaves the balance without them
        let pools = []
        if (ctx.user?.is_biz !== true && ctx.user?.isBiz !== true) {
          try {
            const wres = await fetch(`${openapi}/api/v1/adapter/user/wallets`, {
              headers: { Accept: 'application/json', ...clientHeaders(), Authorization: `Bearer ${a.access}` },
              signal: AbortSignal.timeout(20_000),
            })
            if (wres.ok) pools = walletPools(await wres.json())
          } catch {}
        }
        out.balance = `${num(left)} credits${pools.length ? ` (${pools.join(' · ')})` : ''}`
        out.windows = [{ name: 'Credits', balance: left, display: `${num(left)} credits left${pools.length ? ` (${pools.join(' · ')})` : ''}`, unit: 'credits' }]
      }
      spentSince(left)
      if (!out.windows) out.error = `QwenWork: the account reports no credits (quota: ${shape(q)})`
      usageSaid(out.windows ? 'read' : 'EMPTY', `quota {${shape(q)}} -> ${out.windows ? JSON.stringify(out.windows) : out.error}`)
      return out
    } catch (e) {
      return { error: String(e?.message ?? e), signIn }
    }
  }
}

export async function QwenWorkAuthPlugin({ client }) {
  const clientId = setting('CLIENT_ID')
  const web = origin('WEB')
  const openapi = origin('OPENAPI')
  const api = origin('API')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  const site = {
    id: 'qwenwork', name: 'QwenWork', clientId, web, openapi, api, rsaKey: rsa,
    cosyVersion: setting('COSY_VERSION'), redirect: 'qwenwork-cn://',
    deviceOnly: true, deviceRefreshTarget: 'c', modelScene: 'qwork', listAllModels: true,
    clientType: '6', businessProduct: 'qoder_work', sessionType: 'qoder_work',
    userInfoPath: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
    normalizeUser: v => (v?.data ?? v)?.user ?? (v?.data ?? v),
    models: [],
    // The adapter prefixes this under the host's own system messages; worded
    // for QwenWork, not the Qoder brand the adapter was shared from.
    systemPrompt: 'You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.',
  }
  const { makePlugin } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })
  plugin.auth.usage = qwenworkUsage(openapi)
  plugin.auth.icon = pluginIcon
  return plugin
}

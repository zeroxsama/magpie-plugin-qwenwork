// QwenWork provider. Chat completions are rewritten as QwenWork's own
// agent_chat_generation request by the vendored adapter (vendor/qoder.mjs):
// the host's tools ride along, tool calls come back structured, and the
// host agent keeps its loop. Magpie auth supplies the account; COSY signing,
// the request codec and the endpoint stay in the adapter.
import { createPublicKey } from 'node:crypto'
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

// A finite number, even when the vendor wrote it as a string ("2000").
const figure = (v) => {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// The vendor has written the pool's total / used / remaining under several
// names. Pick the first finite one from a bucket, in that order.
const pick = (b, names) => {
  for (const k of names) {
    const n = figure(b?.[k])
    if (n !== undefined) return n
  }
  return undefined
}
const TOTAL = ['total', 'cap', 'totalCredit', 'total_credit', 'totalQuota', 'total_quota', 'quota', 'amount']
const USED = ['used', 'usedCredit', 'used_credit', 'usedQuota', 'used_quota', 'usage', 'spent']
const LEFT = ['remaining', 'remainingCredit', 'remaining_credit', 'remainingQuota', 'remaining_quota', 'balance', 'left', 'available']

// creditPool turns one object into a magpie window when it names a total and
// either a used count or a remaining count. Strings and camel-case aliases
// are as valid as plain numbers.
function creditPool(b, fallback = 'Credits') {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined
  const total = pick(b, TOTAL)
  const used = pick(b, USED)
  const left = pick(b, LEFT)
  if (total === undefined || total <= 0) return undefined
  const spent = used !== undefined ? used : (left !== undefined ? total - left : undefined)
  if (spent === undefined || spent < 0) return undefined
  return { name: b.name ?? b.displayName ?? fallback, used: Math.min(100, (100 * spent) / total), display: `${num(spent)} / ${num(total)} ${b.unit ?? 'credits'}` }
}

// findPools walks the account-context looking for objects that look like a
// credit pool. A plan has one pool (quota), but the allowance may sit under
// qoderUsage.userQuota, under a nested summary, or be a list of pools; the
// walk finds whichever the account actually returns. Depth is bounded.
function findPools(v, depth = 0, seen = new Set()) {
  if (depth > 6 || v === null || typeof v !== 'object' || seen.has(v)) return []
  seen.add(v)
  if (Array.isArray(v)) return v.flatMap(x => findPools(x, depth + 1, seen))
  const own = creditPool(v)
  if (own) return [own]
  const pools = []
  for (const k of Object.keys(v)) {
    // quota / qoderUsage / usage / a pool's own object all get walked; a
    // plan's refresh date is not a number and is skipped by creditPool.
    pools.push(...findPools(v[k], depth + 1, seen))
  }
  return pools
}

// shape names a value's keys and types without echoing any value, so a quota
// the parser does not recognise can still be reported and identified.
const shape = (v) => {
  if (Array.isArray(v)) return `[${v.length}]`
  if (!v || typeof v !== 'object') return v === undefined || v === null ? 'none' : typeof v
  return Object.keys(v).map(k => `${k}:${Array.isArray(v[k]) ? 'array' : v[k] && typeof v[k] === 'object' ? 'object' : typeof v[k]}`).join(', ') || '(empty)'
}

// qwenworkUsage reads the account's credits for magpie's usage bar. The
// account-context the sign-in already uses carries them: a quota pool of
// total / used / remaining credits, plus the plan's name and refresh time.
function qwenworkUsage(openapi) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim() || (a.expires > 0 && a.expires <= Date.now())) return { error: 'QwenWork: not signed in', signIn: 'expired' }
      const res = await fetch(`${openapi}/api/v1/adapter/user/account-context?include=user,plan,quota`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { error: 'QwenWork: the sign-in lapsed — sign in again', signIn: 'expired' }
      if (!res.ok) return { error: `QwenWork: usage read failed (HTTP ${res.status})`, signIn }
      const ctx = (await res.json())?.data ?? {}
      const account = ctx.qoderUsage ?? ctx.usage ?? ctx
      const out = { signIn }
      const plan = account.userType ?? account.user_type ?? ctx.plan?.name
      if (plan) out.plan = String(plan)
      const due = account.expiresAt ?? account.expires_at ?? ctx.plan?.next_refresh_date ?? ctx.plan?.next_due_date
      if (due) {
        const t = typeof due === 'string' && !/^\d+$/.test(due) ? Date.parse(due) : figure(due) * Number(figure(due) < 1e12 ? 1000 : 1)
        if (Number.isFinite(t)) out.until = new Date(t).toISOString()
      }
      const windows = findPools(account)
      const quotaNode = account.quota ?? account.userQuota ?? account.user_quota ?? (ctx.quota ?? undefined)
      if (windows.length) out.windows = windows
      else out.error = `QwenWork: the account reports no credits (data: ${shape(ctx)}, quota: ${shape(quotaNode)})`
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

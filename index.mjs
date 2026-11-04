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

const figure = (v) => {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean' || typeof v === 'object') return undefined
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
        headers: { Accept: 'application/json', Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { error: 'QwenWork: the sign-in lapsed — sign in again', signIn: 'expired' }
      if (!res.ok) return { error: `QwenWork: usage read failed (HTTP ${res.status})`, signIn }
      const ctx = (await res.json())?.data ?? {}
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
        out.windows = [{ name: 'Credits', balance: left, display: `${num(left)} credits left`, unit: 'credits' }]
      }
      if (!out.windows) out.error = `QwenWork: the account reports no credits (quota: ${shape(q)})`
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

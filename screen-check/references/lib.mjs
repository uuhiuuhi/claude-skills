// screen-check 공용 헬퍼(v0.2) — A(템플릿)·B(탐색) 스크립트가 같은 로그인·판정·기록을 쓴다.
// 사용: import { setup, judgeScreen, JARGON, RAW_ERROR } from './lib.mjs'
//   const t = await setup({ story, source: 'A', root: ROOT })   → { env, need, data, check, shot, login, wire, browser, BASE, STAMP, finish }
// 비밀번호는 여기서만 읽는다(워크트리 .env.local) — 로그·스크린샷·대화에 값을 남기지 않는다.
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { report } from './score.mjs'

export const BASE = process.env.SC_BASE ?? 'http://127.0.0.1:5174'
/** 사용자 화면에 노출되면 안 되는 개발 용어·원시 에러 */
export const JARGON = /에픽|스토리 \d|RPC|RLS|스프린트|PGRST|\bundefined\b|\bnull\b|\[object Object\]|TypeError|Error:/
export const RAW_ERROR = /Error|undefined|network|fetch|status code|exception/i
/** AccessDenied(3요소 + 홈으로 이동) 판정 — 권한 안내·없는 화면 둘 다 이 형태다 */
export const DENY = /(권한이 없습니다|볼 수 없습니다|열 수 없습니다|열립니다)[\s\S]{0,400}홈으로 이동/
export const NOT_FOUND = /주소에 해당하는 화면이 없습니다/
export const EMPTY_DEST = /아직 준비 중인 화면으로/
/** id·쿼리 없이 상세/수정 경로에 들어갔을 때의 정상 안내(오류 화면이 아니라 「고르라」는 안내) — 「화면 열림」 통과 근거로 쓰지 않는다(Astra 대조 지적 2026-09-09) */
export const GUIDED = /찾을 수 없습니다|불러오지 못했습니다|주소가 잘못|목록에서 (다시 )?(선택|골라)|먼저 (선택|골라)|선택해 주세요/
/** QA 계정 → 역할. 없는 역할은 「미측정」으로 남긴다(👤 가 .env.local 에 QA_<ROLE>_EMAIL/PASSWORD 를 더하면 자동 편입). */
export const ROLE_ACCOUNTS = [
  ['engineer', 'QA_TEST'],
  ['admin', 'QA_ADMIN'],
  ['team_lead', 'QA_TEAM_LEAD'],
  ['sales', 'QA_SALES'],
  ['office', 'QA_OFFICE'],
  ['executive', 'QA_EXECUTIVE'],
]

export function readEnv(root) {
  return Object.fromEntries(readFileSync(resolve(root, 'e2e-wt/.env.local'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
}

export async function setup({ story, source, root, headless = true }) {
  const env = readEnv(root)
  const need = (k) => { if (!env[k]) throw new Error(`${k} 없음(.env.local)`); return env[k] }
  const OUT = resolve(root, 'e2e-shots', `${source}-${story}`); mkdirSync(OUT, { recursive: true })
  const STAMP = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
  const local = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` }
  const data = { story, source, when: local(), results: [], manual: {}, unmeasured: [], leftovers: [], screenshots: OUT, roles: [] }
  const check = (cat, name, ok, detail = '', extra = {}) => {
    data.results.push({ cat, name, ok: !!ok, detail: String(detail).replace(/\s+/g, ' ').slice(0, 240), source, ...extra })
    console.log('[e2e]', ok ? '✓' : '✗', `[${cat}]`, name, String(detail).replace(/\s+/g, ' ').slice(0, 160))
  }
  const shot = (page, name, full = true) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: full }).catch(() => {})
  const pageErrors = []; const badResponses = []
  const wire = (p, tag) => {
    p.on('pageerror', (e) => pageErrors.push(`${tag} ${p.url().replace(BASE, '')}: ${e.message.slice(0, 120)}`))
    p.on('response', (r) => { if (r.status() >= 400 && !/rest\/v1\/rpc|auth\/v1|\/@fs\/|\/@vite|node_modules/.test(r.url())) badResponses.push(`${tag}@${p.url().replace(BASE, '').slice(0, 30)} ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 70)}`) })
  }
  async function login(page, roleKey) {
    const acct = ROLE_ACCOUNTS.find(([, k]) => k === roleKey || k === `QA_${roleKey.toUpperCase()}`) ?? [null, roleKey]
    const prefix = acct[1]
    await page.goto(`${BASE}/login`)
    await page.fill('#login-email', need(`${prefix}_EMAIL`))
    await page.fill('#login-password', need(`${prefix}_PASSWORD`))
    await page.click('button[type=submit]')
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25000 })
    await page.waitForLoadState('networkidle').catch(() => {})
  }
  /** 이 환경에서 로그인 가능한 역할 목록(계정이 있는 것만) */
  const availableRoles = () => ROLE_ACCOUNTS.filter(([, k]) => env[`${k}_EMAIL`] && env[`${k}_PASSWORD`]).map(([role, key]) => ({ role, key }))
  const browser = await chromium.launch({ channel: 'msedge', headless })
  async function finish({ exitOnFail = true } = {}) {
    await browser.close().catch(() => {})
    check('errors', 'pageerror 0', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '))
    check('errors', '예상 밖 4xx/5xx 0(인증·rpc·vite 제외)', badResponses.length === 0, badResponses.slice(0, 5).join(' | '))
    data.pageErrors = pageErrors; data.badResponses = badResponses
    writeFileSync(resolve(root, `e2e-tools/results-${source}-${story}.json`), JSON.stringify(data, null, 1), 'utf8')
    const md = report(data)
    writeFileSync(resolve(root, `e2e-tools/report-${source}-${story}.md`), md + '\n', 'utf8')
    console.log(md)
    if (exitOnFail) process.exit(data.results.some((r) => !r.ok) ? 1 : 0)
  }
  return { env, need, data, check, shot, login, wire, browser, BASE, STAMP, OUT, availableRoles, finish, pageErrors, badResponses }
}

/** 화면 표를 dev 서버에서 그대로 가져온다(TS 파싱 0 · vite 가 모듈을 준다). role 별 노출·상위 목적지도 같은 함수로. */
export async function loadDestinations(page, role) {
  return page.evaluate(async (r) => {
    const m = await import('/src/lib/routes.ts')
    const top = new Set(m.topLevelDestinations(r).map((d) => d.path))
    return m.SCREEN_DESTINATIONS.map((d) => ({ path: d.path, title: d.title, roles: d.roles ?? null, filledBy: d.filledBy ?? null, group: d.group, visible: !d.roles || d.roles.includes(r), top: top.has(d.path) }))
  }, role)
}

/** 화면 한 장 판정 — 이동 후 로딩이 끝나기를 기다리고 「막다른 골목」 3종(빈 화면 · 안내 없는 거절 · 타이틀 없음)을 가른다. */
export async function judgeScreen(page, dest, { timeout = 12000 } = {}) {
  await page.goto(`${BASE}${dest.path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('main', { timeout }).catch(() => {})
  await page.waitForFunction(() => { const m = document.querySelector('main'); return m && m.innerText.trim().length > 0 && !/불러오는 중|확인하는 중/.test(m.innerText) }, null, { timeout }).catch(() => {})
  await page.waitForTimeout(250)
  const s = await page.evaluate(() => {
    const m = document.querySelector('main')
    const text = (m?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const h1 = m?.querySelector('h1')?.textContent?.trim() ?? ''
    const interactive = m ? [...m.querySelectorAll('a,button,input,select,textarea,[role=button]')].filter((e) => e.getBoundingClientRect().height > 0).length : 0
    return { text, h1, interactive, title: document.title, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, hasMain: !!m }
  })
  const denied = DENY.test(s.text) && s.interactive <= 2
  const notFound = NOT_FOUND.test(s.text)
  const empty = EMPTY_DEST.test(s.text)
  const guided = !denied && !notFound && GUIDED.test(s.text) && s.interactive <= 4
  return { ...s, denied, notFound, empty, guided, blank: !s.hasMain || s.text.length < 12, titled: s.title.startsWith(dest.title) || s.h1.length > 0 }
}

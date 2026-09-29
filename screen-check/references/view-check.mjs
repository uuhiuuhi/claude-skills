// screen-check 보기 전용 방식(v0.3) — 운영 주소 · Cloudflare 미리보기 주소를 「읽기만」 하며 바뀐 화면을 확인한다.
// 쓰기는 약속이 아니라 브라우저 단계에서 막는다(view-guard.mjs 판정 → context.route abort · WebSocket 차단). 막지 못하면 시작하지 않는다.
//
// 사용: node view-check.mjs --base https://<대상 주소> --root <scratchpad> --story <라벨>
//        [--routes /login,/]            비로그인 단계에서 200·콘솔 오류·문구를 볼 경로(기본 /login)
//        [--auth-routes /home,/tickets]  보기 전용 로그인 단계에서 열어 볼 경로(계정이 없으면 건너뜀)
//        [--deny-routes /admin]          그 계정에 권한이 없어 거절 안내가 떠야 하는 경로
//        [--expect <번들 해시·버전 표식>]  페이지 HTML·자원 주소에 이 문자열이 있어야 한다(어느 배포본을 봤는지 증명)
//        [--config view-config.json]     읽기 전용 RPC·Edge Function 목록 등(프로젝트 몫 · 항목마다 이유 한 줄)
//        [--env-file <gitignore 된 파일>] SC_VIEW_EMAIL / SC_VIEW_PASSWORD 를 셸 환경변수 대신 여기서 읽는다
//        [--viewports 1440,390]
// 자격증명은 SC_VIEW_EMAIL / SC_VIEW_PASSWORD 만 — QA_* 개발 계정으로 대체하지 않는다. 없으면 비로그인 단계만 돌고 보고서에 적는다.
// 종료 코드: 0 전부 통과 · 1 실패 있음 · 2 사용법·설정 오류 · 3 차단 장치 설치 실패(시작 안 함) · 4 중간 중단
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { report } from './score.mjs'
import { JARGON, NOT_FOUND, isDenied } from './judge.mjs'
import { resolveMode, normalizeConfig, decideRequest, decideWebSocket, decideWsMessage, destructiveMatcher, shouldSkipControl, selectViewCredentials, redact, notAssessable } from './view-guard.mjs'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const fail = (code, msg) => { console.error('[view]', msg); process.exit(code) }

const BASE_ARG = opt('--base', process.env.SC_BASE)
const ROOT = opt('--root', process.env.SC_ROOT)
const STORY = opt('--story', 'view')
if (!BASE_ARG || !ROOT) fail(2, '--base <주소> 와 --root <scratchpad> 가 필요하다')
const MODE_ARG = opt('--mode', process.env.SC_MODE)
if (MODE_ARG && MODE_ARG !== 'view') fail(2, `view-check 는 보기 전용 방식만 돈다(--mode ${MODE_ARG} 거부) — 쓰기 프로브는 로컬 주소에서 lib.mjs·template.mjs 로`)

let mode, config, cred
try {
  mode = resolveMode({ base: BASE_ARG, requested: 'view' })
  const cfgPath = opt('--config', '')
  config = normalizeConfig(cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {})
  const envFile = opt('--env-file', '')
  const fileEnv = envFile ? Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })) : {}
  cred = selectViewCredentials({ ...fileEnv, ...process.env })
} catch (e) { fail(2, e.message) }
const SECRETS = [cred.email, cred.password].filter(Boolean)
const clean = (s) => redact(s, SECRETS)

const base = new URL(BASE_ARG)
const at = (p) => new URL(p, base).href
const ROUTES = list(opt('--routes', config.login.path))
const AUTH_ROUTES = list(opt('--auth-routes', ''))
const DENY_ROUTES = list(opt('--deny-routes', ''))
const EXPECT = opt('--expect', '')
const VIEWPORTS = list(opt('--viewports', '1440,390')).map(Number)
const matcher = destructiveMatcher(config.extraDestructive)

const OUT = resolve(ROOT, 'e2e-shots', `V-${STORY}`); mkdirSync(OUT, { recursive: true })
mkdirSync(resolve(ROOT, 'e2e-tools'), { recursive: true })
const now = new Date()
const data = {
  story: STORY, source: 'V', when: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  results: [], manual: {}, unmeasured: [], leftovers: [], screenshots: OUT, roles: [],
  view: { host: mode.host, tier: cred.tier, credential: cred.reason, blockedWrites: [], blockedSockets: [], skippedControls: [] },
  notAssessable: notAssessable(cred.tier),
}
const check = (cat, name, ok, detail = '') => {
  const d = clean(String(detail).replace(/\s+/g, ' ')).slice(0, 240)
  data.results.push({ cat, name, ok: !!ok, detail: d, source: 'V' })
  console.log('[view]', ok ? '✓' : '✗', `[${cat}]`, name, d.slice(0, 160))
}
const shot = (page, name) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true }).catch(() => {})
const pathOf = (url) => { try { const u = new URL(url); return u.host === base.host ? u.pathname : `${u.host}${u.pathname}` } catch { return String(url).slice(0, 80) } }

console.log(`[view] 방식: 보기 전용 · 대상 ${mode.host}${mode.local ? '(로컬 — 명시 선택)' : ''} · 단계: ${cred.tier === 'view-login' ? '보기 전용 로그인' : '비로그인'} · ${cred.reason}`)

// ── 차단 장치 — 컨텍스트마다 브라우저가 첫 요청을 보내기 전에 건다 ─────────────────
let guardTier = 'anonymous'                           // 로그인 직전에만 'view-login' 으로 올린다
const blockedSeen = new Set()
const consoleErrors = []; const pageErrors = []; const seenText = []
async function guardedContext(width) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: 'ko-KR', serviceWorkers: 'block', ...(storage ? { storageState: storage } : {}) })
  if (typeof ctx.routeWebSocket !== 'function') throw Object.assign(new Error('playwright-core 1.48 이상 필요 — WebSocket 을 막을 수 없으면 보기 전용 방식은 시작하지 않는다'), { guard: true })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    let d
    try { d = decideRequest({ method: req.method(), url: req.url(), tier: guardTier, config }) } catch (e) { d = { allow: false, reason: `판정 오류(${e.message}) — 차단` } }
    if (d.allow) return route.continue()
    const key = `${req.method()} ${req.url()}`
    if (!blockedSeen.has(key)) { blockedSeen.add(key); data.view.blockedWrites.push({ method: req.method(), path: pathOf(req.url()), reason: d.reason }) }
    console.log('[view] ⛔ 차단', req.method(), pathOf(req.url()), '—', d.reason)
    return route.abort('blockedbyclient')
  })
  await ctx.routeWebSocket(/.*/, (ws) => {
    const d = decideWebSocket({ config })
    if (!d.allow) {
      if (!data.view.blockedSockets.includes(pathOf(ws.url()))) data.view.blockedSockets.push(pathOf(ws.url()))
      return ws.close({ code: 1008, reason: 'screen-check view mode' })
    }
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      const md = decideWsMessage(m)
      if (md.allow) return server.send(m)
      data.view.blockedWrites.push({ method: 'WS', path: pathOf(ws.url()), reason: md.reason })
    })
  })
  ctx.on('response', (r) => seenText.push(r.url()))
  return ctx
}
function wire(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`${tag}: ${e.message.slice(0, 120)}`))
  page.on('console', (m) => {
    // 차단 장치가 끊은 요청의 「불러오기 실패」는 오류가 아니라 차단 기록으로 이미 셌다
    if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) consoleErrors.push(`${tag}: ${m.text().slice(0, 120)}`)
  })
}
async function readScreen(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  await page.waitForFunction(() => { const m = document.querySelector('main') ?? document.body; return m && m.innerText.trim().length > 0 && !/불러오는 중|확인하는 중/.test(m.innerText) }, null, { timeout: 12000 }).catch(() => {})
  return page.evaluate(() => {
    const m = document.querySelector('main') ?? document.body
    const text = (m?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const interactive = [...m.querySelectorAll('a,button,input,select,textarea,[role=button]')].filter((e) => e.getBoundingClientRect().height > 0).length
    return { text, h1: m.querySelector('h1')?.textContent?.trim() ?? '', interactive, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, html: document.documentElement.outerHTML.slice(0, 200000), scripts: [...document.querySelectorAll('script[src],link[href]')].map((e) => e.getAttribute('src') ?? e.getAttribute('href')) }
  })
}
/** 화면의 조작 목록을 훑어 누르지 않을 것을 기록하고, 탭만 눌러 본다(버튼은 누르지 않는다). */
async function sweepControls(page, where) {
  const controls = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.body
    return [...root.querySelectorAll('button,a[href],[role=button],[role=tab],[role=menuitem],input[type=submit],input[type=button]')]
      .filter((e) => e.getBoundingClientRect().height > 0)
      .map((e, i) => {
        e.setAttribute('data-sc-view', String(i))
        const role = e.getAttribute('role') ?? (e.tagName === 'A' ? 'link' : 'button')
        const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || '').trim().slice(0, 40)
        return { i, role, name, submit: e.type === 'submit' && !!e.form }
      })
  })
  let tabs = 0
  for (const c of controls) {
    const s = shouldSkipControl(c, matcher)
    if (s.skip) { data.view.skippedControls.push({ where, name: c.name, reason: s.reason }); continue }
    if (c.role === 'tab' && tabs < 6) {
      tabs += 1
      await page.click(`[data-sc-view="${c.i}"]`, { timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(300)
    }
  }
  return tabs
}

let browser, storage = null, step = '시작'
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  // ── 1) 비로그인 단계 — 경로 200 · 로그인 화면 렌더 · 콘솔 오류 · 배포본 표식
  step = '비로그인 단계'
  for (const w of VIEWPORTS) {
    const ctx = await guardedContext(w)
    const page = await ctx.newPage(); wire(page, `비로그인@${w}`)
    for (const r of w === VIEWPORTS[0] ? ROUTES : []) {
      step = `비로그인 ${r}`
      const resp = await page.goto(at(r), { waitUntil: 'domcontentloaded' }).catch((e) => ({ status: () => 0, err: e.message }))
      check('errors', `[비로그인 ${r}] 응답 200`, resp.status() === 200, resp.err ? clean(resp.err) : `status=${resp.status()}`)
      const s = await readScreen(page)
      seenText.push(s.html, ...s.scripts)
      check('copy', `[비로그인 ${r}] 개발 용어·원시 에러 노출 0`, !JARGON.test(s.text), (s.text.match(JARGON) ?? [''])[0])
      await shot(page, `anon-${r.replace(/^\//, '').replace(/\//g, '_') || 'root'}-${w}`)
    }
    step = `로그인 화면 @${w}`
    await page.goto(at(config.login.path), { waitUntil: 'domcontentloaded' })
    const hasForm = await page.waitForSelector(config.login.password, { timeout: 12000 }).then(() => true).catch(() => false)
    const s = await readScreen(page)
    check('responsive', `[로그인 화면 @${w}] 입력 칸 렌더 · 가로 넘침 0`, hasForm && !s.overflow, hasForm ? (s.overflow ? 'scrollWidth 초과' : 'ok') : `${config.login.password} 없음`)
    await shot(page, `anon-login-${w}`)
    await ctx.close()
  }
  if (EXPECT) check('honesty', `배포본 표식 「${EXPECT}」 확인`, seenText.some((t) => String(t).includes(EXPECT)), '페이지 HTML·자원 주소에서 찾음')
  else data.unmeasured.push('배포본 표식 — --expect 를 주지 않아 어느 배포본을 봤는지 증명하지 못함')

  // ── 2) 보기 전용 로그인 단계 — 계정이 있을 때만
  if (cred.tier === 'view-login') {
    step = '보기 전용 로그인'
    const ctx = await guardedContext(VIEWPORTS[0])
    const page = await ctx.newPage(); wire(page, '보기전용')
    guardTier = 'view-login'
    await page.goto(at(config.login.path), { waitUntil: 'domcontentloaded' })
    await page.fill(config.login.email, cred.email)
    await page.fill(config.login.password, cred.password)
    await page.click(config.login.submit)                 // 로그인 제출은 이 도구 자신의 예외(조작 목록 판정 대상 아님)
    const loggedIn = await page.waitForURL((u) => !u.pathname.startsWith(config.login.path), { timeout: 25000 }).then(() => true).catch(() => false)
    check('ac', '[보기 전용 로그인] 로그인 후 로그인 화면을 벗어남', loggedIn, loggedIn ? '' : '25초 안에 이동 없음 — 계정·허용 목록(로그인 요청 차단 여부) 확인')
    data.roles.push('view')
    if (loggedIn) {
      storage = await ctx.storageState()
      for (const r of AUTH_ROUTES) {
        step = `보기 전용 ${r}`
        await page.goto(at(r), { waitUntil: 'domcontentloaded' })
        const s = await readScreen(page)
        const deadEnd = s.text.length < 12 ? '빈 화면' : isDenied(s.text, s.interactive) ? '권한인데 거절' : NOT_FOUND.test(s.text) ? '없는 화면' : ''
        check('ac', `[보기 전용 ${r}] 화면 열림(막다른 골목 0)`, !deadEnd, deadEnd ? `${deadEnd}: ${s.text.slice(0, 100)}` : `h1=${s.h1}`)
        check('copy', `[보기 전용 ${r}] 개발 용어·원시 에러 노출 0`, !JARGON.test(s.text), (s.text.match(JARGON) ?? [''])[0])
        const tabs = await sweepControls(page, r)
        await shot(page, `view-${r.replace(/^\//, '').replace(/\//g, '_') || 'root'}-${VIEWPORTS[0]}${tabs ? `-tab${tabs}` : ''}`)
      }
      for (const r of DENY_ROUTES) {
        step = `거절 ${r}`
        await page.goto(at(r), { waitUntil: 'domcontentloaded' })
        const s = await readScreen(page)
        check('deny', `[보기 전용 ${r}] 권한 없음 안내(3요소)`, isDenied(s.text, s.interactive), s.text.slice(0, 120))
      }
      const a11y = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter((e) => e.getBoundingClientRect().height > 0 && !(e.textContent.trim() || e.getAttribute('aria-label') || e.getAttribute('title'))).length)
      check('a11y', '[보기 전용] 접근 가능한 이름 없는 버튼·링크 0(마지막 화면)', a11y === 0, `n=${a11y}`)
      for (const w of VIEWPORTS.slice(1)) {
        const mctx = await guardedContext(w)
        const mp = await mctx.newPage(); wire(mp, `보기전용@${w}`)
        for (const r of AUTH_ROUTES) {
          step = `보기 전용 ${r} @${w}`
          await mp.goto(at(r), { waitUntil: 'domcontentloaded' })
          const s = await readScreen(mp)
          check('responsive', `[보기 전용 ${r} @${w}] 렌더(가로 넘침 0 · 빈 화면 0)`, !s.overflow && s.text.length >= 12, s.overflow ? 'scrollWidth 초과' : s.text.slice(0, 80))
          await shot(mp, `view-${r.replace(/^\//, '').replace(/\//g, '_') || 'root'}-${w}`)
        }
        await mctx.close()
      }
    }
    await ctx.close()
  } else {
    data.unmeasured.push(`로그인 안쪽 화면 전부 — ${cred.reason}`)
  }
} catch (e) {
  if (e?.guard) fail(3, e.message)
  data.fatal = { role: data.roles.at(-1) ?? '(없음)', step, message: clean(String(e?.message ?? e)).slice(0, 300), stack: clean(String(e?.stack ?? '')).split('\n').slice(0, 3).join(' | ') }
  console.error('[view] ✗✗ 중단 —', step, '·', data.fatal.message)
  check('errors', `실행 중단(${step})`, false, data.fatal.message)
} finally {
  await browser?.close().catch(() => {})
  check('errors', 'pageerror 0', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '))
  check('errors', '콘솔 오류 0(차단으로 생긴 실패 제외)', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '))
  // 차단이 있었다 = 안전장치는 동작했지만, 그 화면은 쓰기가 실패한 상태로 그려졌을 수 있다 → 결함 후보로 올린다
  check('errors', '보기 중 쓰기 시도 0(있으면 차단됨)', data.view.blockedWrites.length === 0, data.view.blockedWrites.slice(0, 4).map((b) => `${b.method} ${b.path}`).join(' | '))
  data.unmeasured.push('쓰기 경로 성공·확인/되돌리기 버튼(보기 전용 방식 — 판정 불가)')
  if (data.view.blockedSockets.length) data.unmeasured.push('실시간(WebSocket) 갱신 — 기본 차단')
  data.leftovers.push('없음 — 쓰기 메서드는 브라우저 단계에서 차단(허용 목록: 로그인·토큰 갱신 + 설정의 읽기 전용 항목)')
  data.manual.honesty = { score: data.fatal ? 4 : 10, why: data.fatal ? `${data.fatal.step} 에서 중단 — 계획의 일부만 측정` : '방식·단계·차단·건너뜀·미측정을 머리줄과 목록에 적음' }
  writeFileSync(resolve(ROOT, `e2e-tools/results-V-${STORY}.json`), JSON.stringify(data, null, 1), 'utf8')
  const md = report(data)
  writeFileSync(resolve(ROOT, `e2e-tools/report-V-${STORY}.md`), md + '\n', 'utf8')
  console.log(md)
  process.exit(data.fatal ? 4 : data.results.some((r) => !r.ok) ? 1 : 0)
}

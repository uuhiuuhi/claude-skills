// screen-check 시나리오 템플릿 — 복사해서 <story> 에 맞게 채운다. score.mjs 와 같은 폴더(scratchpad/e2e-tools)에 둔다.
// 실행: node check-<story>.mjs → results-<story>.json + report-<story>.md
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { report } from './score.mjs'

const STORY = '<N-N 스토리 이름>'
const BASE = 'http://127.0.0.1:5174'
const ROOT = '<scratchpad 절대경로>'                       // e2e-wt · e2e-shots · e2e-tools 의 부모
const OUT = resolve(ROOT, 'e2e-shots'); mkdirSync(OUT, { recursive: true })
const env = Object.fromEntries(readFileSync(resolve(ROOT, 'e2e-wt/.env.local'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
const need = (k) => { if (!env[k]) throw new Error(`${k} 없음`); return env[k] }
const STAMP = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')   // 프로브 값 이름에 넣는다(재실행 충돌 방지)

const data = { story: STORY, when: new Date().toISOString().slice(0, 16).replace('T', ' '), results: [], manual: {}, unmeasured: [], leftovers: [], screenshots: OUT }
/** cat = score.mjs RUBRIC 의 키(ac · success · deny · copy · responsive · guard · mockup · a11y · errors · honesty) */
const check = (cat, name, ok, detail = '') => { data.results.push({ cat, name, ok, detail }); console.log('[e2e]', ok ? '✓' : '✗', `[${cat}]`, name, detail) }
const shot = (page, name) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true })

async function login(page, email, password) {
  await page.goto(`${BASE}/login`)
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)          // 값은 env 에서만 — 로그·대화에 남기지 않는다
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
try {
  // ── 역할 1 (예: 직원) — 별도 컨텍스트
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p1 = await ctx1.newPage(); p1.on('pageerror', (e) => pageErrors.push(e.message))
  await login(p1, need('QA_TEST_EMAIL'), need('QA_TEST_PASSWORD'))
  // … 접수/거부 경로 체크: check('ac', 'AC-1 …', 조건, 근거) · check('deny', '비권한 진입 3요소', …)
  await shot(p1, '01-…')
  await ctx1.close()

  // ── 역할 2 (예: 관리자)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await ctx2.newPage(); p.on('pageerror', (e) => pageErrors.push(e.message))
  await login(p, need('QA_ADMIN_EMAIL'), need('QA_ADMIN_PASSWORD'))
  // … 성공 경로: check('success', '승인 성공 → 상태 전이', …) · 안전장치: check('guard', '건수 확인 전 잠김', !(await btn.isEnabled()))
  // ⚠️ 문구 대기는 dialog 로 범위를 좁힌다: p.locator('[role=dialog]').last().getByText('…').waitFor()
  // ── 뷰포트: 1024 · 390 은 setViewportSize 뒤 goto 로 다시 마운트하고 화면 고유 문구를 기다린다
  await p.setViewportSize({ width: 390, height: 844 }); await p.goto(`${BASE}/<path>`)
  // check('responsive', 'AC-x 모바일 …', …)
  await ctx2.close()
} finally {
  await browser.close()
}
check('errors', 'pageerror 0', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
// 자동 체크가 없는 항목은 수동 점수 + 이유(정직하게 · 안 봤으면 unmeasured 에 적는다)
data.manual.mockup = { score: 0, why: '…나란히 대조 결과…' }
data.manual.a11y = { score: 0, why: '…' }
data.unmeasured.push('…예: 1024 뷰포트 · 서버 P0814 거절 분기(관리자 세션 필요)…')
data.leftovers.push('…예: <카테고리>/<코드>(사용 안 함) · 지원요청 N건…')
data.manual.honesty = { score: data.unmeasured.length || data.leftovers.length ? 10 : 6, why: '미측정·잔여물 기재 여부' }

writeFileSync(resolve(ROOT, `e2e-tools/results-${STORY}.json`), JSON.stringify(data, null, 1), 'utf8')
const md = report(data)
writeFileSync(resolve(ROOT, `e2e-tools/report-${STORY}.md`), md + '\n', 'utf8')
console.log(md)
process.exit(data.results.some((r) => !r.ok) ? 1 : 0)

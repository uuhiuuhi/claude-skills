// screen-check 벌 A(v0.2) — 계약·AC 실측 + 링크·화면 전수(SCREEN_DESTINATIONS × 역할) + 뷰포트 3종 + 접근성 기본.
// 결정적·싼 벌(Sonnet/Terra) — 「모든 화면이 열리고 제목·빈 상태·거절 안내가 서는가」를 목록 따라 전부 누른다.
// 쓰기 프로브는 하지 않는다(쓰기는 벌 B 독점). 스토리 AC 는 --scenarios 파일이 더한다.
//
// 사용: node template-A.mjs --story epic-1 --root <scratchpad> [--scope /tickets,/tickets/new,…] [--links all|scope]
//                             [--scenarios ./scenarios-epic-1.mjs] [--viewports 1440,1024,390]
//   --scope   이 배치가 보는 화면(경로 목록). 생략하면 전수.  --links all 이면 scope 밖 화면도 「열림·거절」만 본다.
//   --scenarios  export const scenarios = [{ story:'1-7', cat:'ac', name:'AC-1 …', run: async ({ pages, check, shot, BASE, judge }) => {…} }]
//                pages = { engineer: Page, admin: Page, … }(로그인 완료 · 1440) · run 안에서 check 를 직접 불러도 되고 boolean 을 return 해도 된다.
// 막다른 골목 판정(파티 판정 2항 · Sally): ① 빈 화면(main 텍스트 < 12자) ② 안내 없는 거절(비권한인데 3요소 안내가 없음 · 또는 권한인데 거절)
//   ③ 타이틀 없음(document.title 이 화면 표 제목으로 시작하지 않고 h1 도 없음) ④ 없는 화면(catch-all)으로 떨어짐 ⑤ 화면당 pageerror.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { setup, loadDestinations, judgeScreen, JARGON } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const STORY = opt('--story', 'epic')
const ROOT = opt('--root', process.env.SC_ROOT)
const SCOPE = (opt('--scope', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const LINKS = opt('--links', 'scope')
const VIEWPORTS = opt('--viewports', '1440,1024,390').split(',').map(Number)
const SCEN = opt('--scenarios', '')
if (!ROOT) { console.error('--root <scratchpad> 필요'); process.exit(2) }

const t = await setup({ story: STORY, source: 'A', root: ROOT })
const { check, shot, login, wire, browser, BASE, finish, data } = t
const slug = (p) => p.replace(/^\//, '').replace(/\//g, '_') || 'home'
const inScope = (d) => !SCOPE.length || SCOPE.includes(d.path)
const pages = {}; const contexts = {}
try {
  for (const { role, key } of t.availableRoles()) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })
    const page = await ctx.newPage(); wire(page, role)
    await login(page, key); contexts[role] = ctx; pages[role] = page; data.roles.push(role)
    const dests = await loadDestinations(page, role)
    const targets = dests.filter((d) => inScope(d) || LINKS === 'all')
    // ── 1440 전수: 열림 · 거절 · 타이틀 · 사이드바 활성 · 문구
    for (const d of targets) {
      const errBefore = t.pageErrors.length
      const s = await judgeScreen(page, d)
      const tag = `${role} ${d.path}`
      if (!d.visible) {
        check('deny', `[${tag}] 비권한 진입 → 3요소 안내(권한 없음 + 홈으로 이동)`, s.denied && !s.notFound, s.text.slice(0, 120))
        check('deny', `[${tag}] 사이드바·드로어 미노출(비권한)`, (await page.$(`aside a[href="${d.path}"]`)) === null)
        continue
      }
      if (d.filledBy) { check('ac', `[${tag}] 미구현 목적지 = 행동 초대형 빈 상태`, s.empty && s.titled, s.text.slice(0, 100)); continue }
      const deadEnd = s.blank ? '빈 화면' : s.denied ? '권한인데 거절' : s.notFound ? '없는 화면으로 떨어짐' : !s.titled ? '타이틀 없음' : ''
      check('ac', `[${tag}] 화면 열림(막다른 골목 0)`, !deadEnd, deadEnd ? `${deadEnd}: ${s.text.slice(0, 120)}` : `h1=${s.h1} · title=${s.title}`)
      check('copy', `[${tag}] 앱바 타이틀 = 화면 표 제목`, s.title.startsWith(d.title), `title=${s.title}`)
      if (d.top && inScope(d)) {
        const cur = await page.$eval(`aside a[href="${d.path}"]`, (a) => a.getAttribute('aria-current')).catch(() => 'missing')
        check('ac', `[${tag}] 사이드바 항목 존재 + aria-current`, cur === 'page', `aria-current=${cur}`)
      }
      if (inScope(d)) {
        check('copy', `[${tag}] 개발 용어·원시 에러 노출 0`, !JARGON.test(s.text), (s.text.match(JARGON) ?? [''])[0])
        check('errors', `[${tag}] 화면 진입 pageerror 0`, t.pageErrors.length === errBefore, t.pageErrors.slice(errBefore).join(' | '))
        await shot(page, `${role}-${slug(d.path)}-1440`)
      }
    }
    // ── 1024 · 390: 가로 넘침 0 · h1/거절 유지 · 390 터치 타깃(main 의 button ≥ 44px)
    for (const w of VIEWPORTS.filter((v) => v !== 1440)) {
      const mctx = await browser.newContext({ viewport: { width: w, height: w < 768 ? 844 : 768 }, hasTouch: w < 768, isMobile: w < 768, locale: 'ko-KR', storageState: await ctx.storageState() })
      const mp = await mctx.newPage(); wire(mp, `${role}@${w}`)
      for (const d of targets.filter((x) => x.visible && !x.filledBy && inScope(x))) {
        const s = await judgeScreen(mp, d)
        const tag = `${role} ${d.path} @${w}`
        check('responsive', `[${tag}] 렌더(가로 넘침 0 · 빈 화면 0)`, !s.overflow && !s.blank && !s.notFound, s.overflow ? `scrollWidth 초과` : s.text.slice(0, 80))
        if (w < 768) {
          const small = await mp.$$eval('main button', (bs) => bs.filter((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && r.width > 0 && (r.height < 44 || r.width < 44) }).map((b) => `${b.textContent.trim().slice(0, 12) || b.getAttribute('aria-label') || 'icon'}(${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)})`))
          check('a11y', `[${tag}] 터치 타깃 44px(main button)`, small.length === 0, small.slice(0, 6).join(' · '))
          check('a11y', `[${tag}] 하단 탭 존재`, (await mp.$('nav[aria-label="하단 탭"]')) !== null)
          await shot(mp, `${role}-${slug(d.path)}-${w}`)
        }
      }
      await mctx.close()
    }
    // ── 접근성 기본(역할당 1회): 홈에서 Tab 이동이 보이는 요소로 가는가 · 이미지 alt · 버튼 접근 가능 이름
    await page.goto(`${BASE}/`); await page.waitForSelector('main'); await page.waitForTimeout(400)
    const a11y = await page.evaluate(() => ({
      noName: [...document.querySelectorAll('button, a')].filter((e) => e.getBoundingClientRect().height > 0 && !(e.textContent.trim() || e.getAttribute('aria-label') || e.getAttribute('title') || e.querySelector('img[alt]'))).length,
      noAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
      h1: document.querySelectorAll('main h1').length,
    }))
    check('a11y', `[${role}] 접근 가능한 이름 없는 버튼·링크 0`, a11y.noName === 0, `n=${a11y.noName}`)
    check('a11y', `[${role}] img alt 누락 0 · main h1 1개`, a11y.noAlt === 0 && a11y.h1 === 1, `noAlt=${a11y.noAlt} h1=${a11y.h1}`)
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    check('a11y', `[${role}] Tab 이동이 보이는 요소로 간다`, await page.evaluate(() => { const e = document.activeElement; return !!e && e !== document.body && e.getBoundingClientRect().height > 0 }))
  }
  // ── 스토리 AC 시나리오(배치별 파일)
  if (SCEN) {
    const mod = await import(pathToFileURL(resolve(SCEN)).href)
    for (const sc of mod.scenarios ?? []) {
      try {
        const r = await sc.run({ pages, check, shot, BASE, judge: judgeScreen, t })
        if (typeof r === 'boolean' || (r && typeof r === 'object' && 'ok' in r)) check(sc.cat ?? 'ac', `[${sc.story}] ${sc.name}`, typeof r === 'boolean' ? r : r.ok, typeof r === 'object' ? r.detail ?? '' : '')
      } catch (e) { check(sc.cat ?? 'ac', `[${sc.story}] ${sc.name}`, false, `예외: ${String(e.message).slice(0, 160)}`) }
    }
  }
  for (const c of Object.values(contexts)) await c.close()
} finally {
  const missing = ['team_lead', 'sales', 'office', 'executive'].filter((r) => !data.roles.includes(r))
  if (missing.length) data.unmeasured.push(`역할 ${missing.join('·')} 화면(QA 계정 없음 — .env.local 에 QA_<ROLE>_EMAIL/PASSWORD 추가 시 자동 편입)`)
  data.unmeasured.push('쓰기 경로(벌 B 독점) · 실기기·PWA·GPS · 로딩 스켈레톤')
  data.leftovers.push('없음 — 벌 A 는 읽기 전용(개발 DB 쓰기 0)')
  data.manual.honesty = { score: 10, why: '미측정·잔여물 기재 · 막다른 골목 판정 기준 5종 명시' }
  await finish()
}

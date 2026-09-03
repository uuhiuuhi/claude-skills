// dev-status — 새 하네스 블록 렌더러 (순수 문자열 반환 · fs 접근 0)
//
// 승인된 목업(`night-batch-ops/references/hardening-2026-09-02/dashboard-mockup.html`)의
// 블록 순서·문구·색 토큰을 그대로 옮긴다. **클래스 이름만 `b-` 로 접두**했다 —
// 목업의 `.chip`·`.it`·`.act`·`.sec` 는 현행 build.mjs 의 필터 칩·항목 카드와 이름이 겹쳐서
// 그대로 쓰면 기존 화면이 깨진다(색 토큰 `--orange`·`--green`·`--lblue` 는 손대지 않았다).
//
// 원칙: 재료가 없으면 「없음」이라고 적는다. 손상이면 「읽지 못했습니다(파일 · 사유)」다.
// 어느 쪽도 GREEN 으로 그리지 않는다.

import { formatValue, formatDuration } from './daily-metrics.mjs'

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const arr = (v) => (Array.isArray(v) ? v : [])
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

/** 「읽지 못했습니다」 한 줄 — 원문 경로를 반드시 함께 적는다(추측 렌더 금지). */
export function renderError(error, { what = '' } = {}) {
  if (!error) return ''
  const head = error.kind === 'missing' ? '아직 없습니다'
    : error.kind === 'schema' ? '알 수 없는 형식입니다'
      : '읽지 못했습니다'
  return '<div class="b-none">' + (what ? esc(what) + ' — ' : '') + head +
    '<br><span class="b-mono">' + esc(error.file) + '</span> · ' + esc(error.why) + '</div>'
}

const sec = (title, badge, sub, body, { warn = false } = {}) =>
  '<section class="b-sec"><div class="b-sh"><h2>' + esc(title) + '</h2>' +
  (badge ? '<span class="b-n' + (warn ? ' warn' : '') + '">' + esc(badge) + '</span>' : '') +
  (sub ? '<span class="b-sub">' + esc(sub) + '</span>' : '') +
  '</div>' + body + '</section>'

const chip = (text, cls = '') => '<span class="b-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'

// ── ① 헤더 히어로 — 배포 판정 + 슬롯 심박 + 오늘의 숫자 ──────────────────────
export function renderHero({ verdict, heartbeat, lastNight = [], inbox = null, queue = null, blockers = 0 }) {
  const cls = { red: 'red', amber: 'amber', green: 'green', unknown: 'unknown' }[verdict.level] ?? 'unknown'
  const hbCls = heartbeat.state === 'ok' ? ' ok' : heartbeat.state === 'none' ? ' off' : ''
  const plannedBatches = queue ? arr(queue.batches).filter((b) => b.enabled).length : null
  const pairs = queue ? arr(queue.batches).filter((b) => b.enabled && b.stories.length >= 2).length : null
  const pending = arr(inbox?.pending).length
  const stats = [
    ['지난밤 배치', arr(lastNight).length + '건', false],
    ['결정 대기', pending + '건', pending > 0],
    ['오늘 예정', plannedBatches == null ? '—' : plannedBatches + '배치', false],
    ['병렬', pairs == null ? '—' : pairs + '쌍', false],
    ['배포 차단', blockers + '건', blockers > 0],
  ]
  // 배지 안은 「무엇인지」만, 이유 문장은 아래 한 줄이 맡는다 — 같은 문장을 두 번 적지 않는다.
  const tag = verdict.level === 'unknown' ? '재료 부족'
    : verdict.reasons.length ? verdict.level.toUpperCase() + ' — 막는 것 ' + verdict.reasons.length + '건'
      : verdict.level.toUpperCase()
  return '<section class="b-hero">' +
    '<div class="b-verdict ' + cls + '"><b>' + esc(verdict.label) + '</b><span>' + esc(tag) + '</span></div>' +
    '<div><div class="b-heros">' +
    '<span class="b-hbeat' + hbCls + '"><i></i>' + esc(heartbeat.label) + '</span>' +
    stats.map(([k, v, warn]) => '<span class="b-hs' + (warn ? ' warn' : '') + '">' + esc(k) + ' <b>' + esc(v) + '</b></span>').join('') +
    '</div><p class="b-why">' + esc(verdict.why) + (heartbeat.why ? ' · ' + esc(heartbeat.why) : '') + '</p></div>' +
    '</section>'
}

// ── ② 결정 인박스 ───────────────────────────────────────────────────────────
export function renderInbox(inbox) {
  if (inbox.error) return sec('② 오늘 정하실 것', null, '결정 대기의 단일 창구', renderError(inbox.error, { what: '결정 인박스' }))
  const v = inbox.value
  const wait = arr(v.pending).concat(arr(v.gates))
  const body = wait.length
    ? wait.map((it) => {
      const age = it.ageDays == null ? '등재일 미상' : it.ageDays === 0 ? '오늘 등재' : it.ageDays + '일 대기'
      return '<div class="b-dec"><div><b class="b-t">' + esc(it.title) + '</b>' +
        (it.summary ? '<p>' + esc(it.summary) + '</p>' : '') +
        (it.kind === 'gate' ? '<p class="b-opt">사람 게이트 — 코드가 아니라 승인이 막고 있습니다</p>' : '') +
        '</div><div><span class="b-age' + (it.old ? ' old' : '') + '">' + esc(age) + '</span></div></div>'
    }).join('')
    : '<div class="b-none">결정 대기 0건 — 오늘 정하실 것이 없습니다.</div>'
  const ackN = arr(v.ack).length
  const foot = ackN
    ? '<details class="b-more"><summary>사후 확인 ' + ackN + '건 (지금 하실 일 없음 · 눈으로만)</summary><ul>' +
      arr(v.ack).map((a) => '<li>' + esc(a.title) + '</li>').join('') + '</ul></details>'
    : ''
  return sec('② 오늘 정하실 것', wait.length + '건', '3일 이상 대기는 맨 위 · ✅ 확정분은 세지 않습니다', body + foot, { warn: wait.length > 0 })
}

// ── ④ 지난밤 배치 ───────────────────────────────────────────────────────────
const workerText = (w) => (!w ? '—' : ((w.provider ? providerName(w.provider) : '?') + (w.model ? ' / ' + w.model : '')))
const providerName = (p) => ({ claude: 'Claude', codex: 'Codex', local: '로컬' }[String(p).toLowerCase()] ?? String(p))

export function renderNight({ manifests = [], verifications = [], metrics = [], evidence = [], error = null }) {
  if (error) return sec('④ 지난밤 배치', null, '배치 매니페스트', renderError(error, { what: '지난밤 배치' }))
  if (!manifests.length) {
    return sec('④ 지난밤 배치', '없음', '배치 매니페스트 · 스토리 검증 매니페스트 · 계측 파일',
      '<div class="b-none">지난밤 배치 기록이 없습니다 — 아직 한 번도 돌지 않았거나 상태 폴더가 다릅니다.</div>')
  }
  const vByStory = new Map(verifications.map((v) => [v.story, v]))
  const mById = new Map(metrics.map((m) => [m.batchId, m]))
  const evByStory = new Map(evidence.map((e) => [e.story, e]))

  const cards = manifests.map((m) => {
    const met = mById.get(m.batchId) ?? null
    const integ = m.integration
    const integChip = !integ || !integ.ran ? chip('통합 게이트 미실행')
      : integ.result === 'pass' ? chip('통합 게이트 통과', 'ok')
        : chip('통합 게이트 ' + (integ.result === 'rollback' ? '되돌림' : '실패'), 'fill')
    const parallel = n(m.workers) >= 2 && arr(m.landing).length >= 2
    const rows = arr(m.stories).map((s) => {
      const v = vByStory.get(s) ?? null
      const land = arr(m.landing).find((l) => l.story === s)
      const fail = arr(m.failed).find((f) => f.story === s)
      const result = fail ? chip('중단 exit ' + fail.exit, 'warn')
        : v && v.checks && v.checks.qa === 'pass' ? chip('qa GREEN', 'ok')
          : v && v.checks && v.checks.qa === 'fail' ? chip('qa RED', 'fill') : chip('기록 없음')
      const high = v?.review?.high ?? 0
      return '<tr><td class="b-k">' + esc(s) + '</td>' +
        '<td><b>' + esc(arr(m.stages).join(' · ') || '—') + '</b></td>' +
        '<td>' + esc(workerText(v?.workers?.dev)) + '</td>' +
        '<td>' + esc(workerText(v?.workers?.review)) + '</td>' +
        '<td>' + result + (high > 0 ? ' ' + chip('리뷰 high ' + high, 'warn') : '') + '</td>' +
        '<td class="b-k">' + (land ? land.order + '번' : '—') +
        (integ && (integ.result === 'fail' || integ.result === 'rollback') && land ? ' → 되돌림' : '') + '</td></tr>'
    }).join('')

    const callout = integ && (integ.result === 'fail' || integ.result === 'rollback')
      ? '<div class="b-callout"><b>따로는 통과했는데 합치니 실패했습니다.</b><p>' +
        '얹은 ' + arr(m.landing).length + '건을 <span class="b-mono">' + esc(String(integ.landingBase).slice(0, 7)) + '</span> 로 ' +
        (integ.result === 'rollback' ? '되돌리고' : '처리하고') + ' 푸시를 ' + (m.pushed ? '했습니다(확인 필요)' : '막았습니다') +
        '. 산출물은 <span class="b-mono">archive/integration-fail-*</span> 태그에 남아 있습니다.</p></div>'
      : ''

    const evs = arr(m.stories).map((s) => evByStory.get(s)).filter(Boolean)
    const meta = []
    if (met?.retries) meta.push('<span><b>재시도</b> 수리 라운드 ' + n(met.retries.repairRounds) + ' · 프로바이더 전환 ' + n(met.retries.providerSwitches) + '</span>')
    if (met?.modelCalls?.length) {
      meta.push('<span><b>모델 호출</b> ' + esc(met.modelCalls
        .map((c) => c.provider + '/' + (c.model || '기본') + '×' + c.calls + (c.tokens ? '(' + c.tokens.toLocaleString('en-US') + 'tok)' : ''))
        .join(' · ')) + '</span>')
    }
    if (met && Number.isFinite(met.wallMs)) {
      meta.push('<span><b>벽시계</b> ' + esc(formatDuration(met.wallMs)) +
        ' · p50 ' + esc(formatDuration(met.p50Ms)) + ' · p95 ' + esc(formatDuration(met.p95Ms)) + '</span>')
    }
    for (const e of evs) meta.push('<span><b>증거</b> <a href="' + esc(fileUrl(e.dir)) + '">' + esc(e.dir) + '</a></span>')

    return '<div class="b-card"><div class="b-btop"><span class="b-label">' + esc(m.label || m.batchId) + '</span>' +
      (parallel ? chip('병렬 ' + m.workers + '폭 · 워크트리 분리', 'data') : chip('순차 단독')) +
      integChip + chip(m.pushed ? '푸시 완료' : '푸시 안 함', m.pushed ? '' : 'warn') +
      (m.at ? chip(String(m.at).slice(11, 16), 'mono') : '') + '</div>' +
      '<table class="b-tab"><thead><tr><th>스토리</th><th>단계</th><th>구현 (프로바이더/모델)</th>' +
      '<th>리뷰 (프로바이더/모델)</th><th>결과</th><th>landing</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      callout + (meta.length ? '<div class="b-meta">' + meta.join('') + '</div>' : '') + '</div>'
  }).join('')

  return sec('④ 지난밤 배치', manifests.length + '건',
    '배치 매니페스트 · 스토리 검증 매니페스트 · 계측 파일에서 읽었습니다', cards)
}

// ── ⑤ 오늘 예정 큐 ──────────────────────────────────────────────────────────
export function renderQueue(queue, { assign = null } = {}) {
  if (queue.error) {
    return sec('⑤ 오늘 밤 예정', null, '18:00 자동 편성',
      queue.error.kind === 'missing'
        ? '<div class="b-none">18:00 편성 전입니다 — 오늘 밤 큐가 아직 없습니다.</div>'
        : renderError(queue.error, { what: '오늘 예정 큐' }))
  }
  const q = queue.value
  const on = arr(q.batches).filter((b) => b.enabled)
  const src = q.planned === 'auto' ? '자동 편성(plan-queue)' : '수동 큐'
  const fallback = /fallback/i.test(String(q.updated))
  const head = '<div class="b-body"><div class="b-btop">' +
    chip('편성 방식 · ' + src, fallback ? 'warn' : 'data') +
    (q.validation && !q.validation.ok
      ? chip('검증 경고 ' + arr(q.validation.errors).length + '건', 'warn')
      : chip('검증 통과', 'ok')) +
    (q.plan ? chip('하루 상한 ' + (q.plan.cap ?? '—') + ' · 오늘 기편성 ' + (q.plan.alreadyPlannedToday ?? 0)) : '') +
    '</div>' +
    (q.validation && arr(q.validation.errors).length
      ? '<p class="b-note">' + esc(q.validation.errors.slice(0, 4).map((e) => (e.key ? e.key + ': ' : '') + e.msg).join(' · ')) + '</p>' : '') +
    (q.plan && arr(q.plan.excluded).length
      ? '<p class="b-note">빠진 스토리 ' + q.plan.excluded.length + '건 — ' +
        esc(q.plan.excluded.slice(0, 3).map((e) => e.key + '(' + e.why + ')').join(' · ')) + '</p>' : '') +
    '</div>'

  const whyOf = new Map(arr(q.plan?.picked).map((p) => [p.key, p.why]))
  const avoidOf = assign ?? new Map()

  const cards = on.length ? on.map((b, i) => {
    const models = b.models ?? {}
    const rows = b.stories.map((s) => {
      const av = avoidOf.get?.(s)
      const avoidTxt = av && av.avoid.length
        ? ' · 배정 기록상 ' + av.avoid.map((x) => providerName(x.provider) + ' ' + x.role + ' 연속 실패 ' + x.failStreak + '회') .join(', ') + ' 라 회피'
        : ''
      return '<tr><td class="b-k">' + esc(s) + '</td>' +
        '<td><b>' + esc(arr(b.stages).join(' · ') || 'dev · review') + '</b></td>' +
        '<td>' + esc(modelText(models.dev)) + '</td>' +
        '<td>' + esc(modelText(models.review)) + '</td>' +
        '<td>' + esc((whyOf.get(s) ?? '—') + avoidTxt) + '</td></tr>'
    }).join('')
    return '<div class="b-card"><div class="b-btop"><span class="b-label">' + (i + 1) + '번 — ' + esc(b.label) + '</span>' +
      (b.stories.length >= 2 ? chip('병렬 짝 · 파일 겹침 없음', 'data') : chip('순차 단독')) + '</div>' +
      '<table class="b-tab"><thead><tr><th>스토리</th><th>단계</th><th>구현 예정</th><th>리뷰 예정</th><th>배정 이유</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>'
  }).join('') : '<div class="b-none">켜진 배치가 없습니다 — 오늘 밤은 비어 있습니다.</div>'

  const storyN = on.reduce((a, b) => a + b.stories.length, 0)
  return sec('⑤ 오늘 밤 예정', on.length + '배치 · ' + storyN + '스토리',
    '18:00 자동 편성 · 지금 바꾸시려면 「밤샘 시작」이라고 말씀하시면 됩니다', head + cards,
    { warn: !!(q.validation && !q.validation.ok) })
}

const modelText = (spec) => {
  const s = String(spec ?? '').trim()
  if (!s) return 'Claude / 기본'
  if (/^codex(:|$)/i.test(s)) return 'Codex / ' + (s.split(':')[1] || '기본')
  return 'Claude / ' + s
}

// ── ⑥ 계측(지난 3일 · 하루 단위) ────────────────────────────────────────────
export function renderMetrics(table, { historyMissing = false, badLines = 0 } = {}) {
  if (historyMissing) {
    return sec('⑥ 얼마나 잘 돌았나 (지난 3일 · 하루 단위)', '없음', '계측 이력',
      '<div class="b-none">계측 이력(metrics-history.jsonl)이 아직 없습니다 — 새 하네스로 배치를 한 번 돌리면 채워집니다.</div>')
  }
  const totalBatches = table.days.reduce((a, d) => a + d.batches, 0)
  const th = table.days.map((d) => '<th>' + esc(d.label) +
    ' <span class="b-dim">(' + esc(d.sub) + ')</span></th>').join('')

  const cell = (d, r) => {
    if (d.empty) return '<td><span class="b-na">—</span><br><span class="b-dim">배치 없음</span></td>'
    const v = d[r.key]
    const warn = r.key === 'integrationFailRate' ? n(v) > 0 : r.key === 'reviewHigh' ? n(v) > 0 : false
    let extra = ''
    if (r.key === 'reviewHigh' && d.reviewMedium != null) extra = ' <span class="b-dim">(' + n(d.reviewMedium) + ')</span>'
    if (r.key === 'integrationFailRate' && d.integrationRuns > 0) extra = ' <span class="b-dim">(' + d.integrationRuns + ' 중 ' + d.integrationFail + ')</span>'
    if (r.key === 'firstPass' && d.firstPassTotal > 0) extra = ' <span class="b-dim">(' + d.firstPassOk + '/' + d.firstPassTotal + ' · 근사)</span>'
    return '<td><b class="b-v' + (warn ? ' warn' : '') + '">' + esc(formatValue(v, r.unit)) + '</b>' + extra +
      (d.excluded ? '<br><span class="b-dim">제외 ' + d.excluded + '</span>' : '') + '</td>'
  }

  const rows = table.rows.map((r) =>
    '<tr><td class="b-mkey"><b>' + esc(r.label) + '</b><br><span class="b-dim">' + esc(r.hint) + '</span></td>' +
    table.days.map((d) => cell(d, r)).join('') +
    '<td class="b-trend ' + r.trend.dir + '">' + esc(r.trend.label) + '</td></tr>').join('')

  const modelCells = table.modelRow.map((m) => (m.empty
    ? '<td><span class="b-na">—</span></td>'
    : '<td class="b-dim">' + (m.calls.length
      ? m.calls.map((c) => esc((c.provider ? c.provider + '/' : '') + (c.model || '기본') + ' ×' + c.calls +
        (c.tokens ? ' (' + c.tokens.toLocaleString('en-US') + 'tok)' : ''))).join('<br>')
      : '기록 없음') + '</td>')).join('')

  const body = '<table class="b-tab b-mtab"><thead><tr><th class="b-mkey">지표</th>' + th + '<th>추세</th></tr></thead><tbody>' +
    rows +
    '<tr><td class="b-mkey"><b>모델 호출량</b><br><span class="b-dim">프로바이더/모델 · 토큰은 Codex 만 집계</span></td>' +
    modelCells + '<td class="b-dim">—</td></tr>' +
    '</tbody></table>' +
    (badLines ? '<div class="b-none">계측 이력에서 읽지 못한 줄 ' + badLines + '개는 건너뛰었습니다(나머지는 그대로 셌습니다).</div>' : '')

  return sec('⑥ 얼마나 잘 돌았나 (지난 3일 · 하루 단위)', '배치 ' + totalBatches + '건',
    '하루 = 그날 밤 배치(18:00~아침) 합산 · 품질 게이트를 통과한 실행끼리만 비교 · 없는 날은 「—」', body)
}

// ── ⑦ 자율 마무리 진단 ──────────────────────────────────────────────────────
const TIER_LABEL = {
  1: '비밀정보 노출·데이터 손실·인증', 2: '빌드 실패·실행 불가', 3: '배포 차단',
  4: '핵심 흐름 미완', 5: '회귀·테스트 누락', 6: '성능·안정성·접근성', 7: '내부 구조·문서',
}
const TIER_MARK = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦']

export function renderDiagnosis({ diagnosis, backlog, readiness, report }) {
  if (!diagnosis.value && !backlog.value && !readiness.value) {
    return sec('⑦ 자율 마무리 진단', '미실행', '문서의 완료 표시가 아니라 실제 실행 결과로 판정합니다',
      '<div class="b-none">자율 마무리 진단을 아직 돌리지 않았습니다 — 그래서 위 배포 판정의 상한은 「조건부」입니다. ' +
      '확인하지 못한 것을 「이상 없음」으로 적지 않습니다.<br><span class="b-mono">' +
      esc(diagnosis.error?.file ?? '(경로 미상)') + '</span></div>')
  }
  const d = diagnosis.value
  const c = d?.counts ?? {}
  const pills = [
    ['완료', c.verifiedDone, false], ['부분 완료', c.partial, true], ['누락', c.missing, true],
    ['결함', c.defect, true], ['확인 못 함', c.notVerified, true],
  ].filter(([, v]) => v != null)
  const pillHtml = pills.length
    ? '<div class="b-dgrid">' + pills.map(([k, v, w]) =>
      '<div class="b-pill' + (w && n(v) > 0 ? ' warn' : '') + '"><b>' + n(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>'
    : ''

  const byTier = backlog.value?.byTier ?? d?.counts?.findings ?? null
  const maxT = byTier ? Math.max(1, ...Object.values(byTier).map((v) => n(v))) : 1
  const prio = byTier
    ? '<div class="b-prio">' + [1, 2, 3, 4, 5, 6, 7].map((t) => {
      const v = n(byTier[t] ?? byTier[String(t)])
      return '<div class="b-prow' + (t <= 4 && v > 0 ? ' hot' : '') + '"><span class="b-pn">' + TIER_MARK[t] + '</span>' +
        '<span class="b-pl">' + esc(TIER_LABEL[t]) + '</span>' +
        '<span class="b-pb"><i style="width:' + Math.round((v / maxT) * 100) + '%"></i></span>' +
        '<span class="b-pc">' + v + '</span></div>'
    }).join('') + '</div>'
    : ''

  const blockers = arr(readiness.value?.blockers)
  const blockHtml = blockers.length
    ? blockers.map((b, i) => '<div class="b-it"><div><b class="b-t">배포 차단 ' + (i + 1) + ' — ' + esc(b.label) + '</b>' +
      '<p>' + esc(b.why) + '</p><div class="b-src">기준 ' + esc(b.id) + ' · 근거 readiness.json</div></div></div>').join('')
    : (readiness.value ? '<div class="b-none">배포를 막는 항목 0건 — 판정 「' + esc(readiness.value.verdict) + '」</div>' : '')

  const nv = arr(readiness.value?.notVerified)
  const nvHtml = nv.length
    ? '<details class="b-more"><summary>확인 못 한 것 ' + nv.length + '건 (통과로 세지 않았습니다)</summary><ul>' +
      nv.map((x) => '<li>' + esc(x.what) + ' — ' + esc(x.why) + '</li>').join('') + '</ul></details>'
    : ''

  const headline = report.value?.headline ? '<p class="b-why">' + esc(report.value.headline) + '</p>' : ''
  const badge = blockers.length ? '배포 차단 ' + blockers.length + '건' : (readiness.value?.verdict ?? '진단 있음')
  return sec('⑦ 자율 마무리 진단', badge,
    '문서의 완료 표시가 아니라 실제 실행 결과 → 테스트 → 코드 순으로 판정합니다',
    (headline ? '<div class="b-body">' + headline + '</div>' : '') + pillHtml + prio + blockHtml + nvHtml,
    { warn: blockers.length > 0 })
}

// ── ⑧ 스토리 표 3열 — 값이 하나라도 있을 때만 열을 낸다 ──────────────────────
/**
 * 스토리 슬러그 → { worker, rounds, reviewer }.
 * `hasAny` 가 false 면 build.mjs 가 열 자체를 그리지 않는다(빈 열 3개는 화면만 좁힌다).
 */
export function storyExtras({ verifications = [], assignByStory = new Map() } = {}) {
  const map = {}
  let hasAny = false
  for (const v of verifications) {
    if (!v.story) continue
    const worker = v.workers?.dev ? workerText(v.workers.dev) : ''
    const reviewer = v.workers?.review?.provider ? providerName(v.workers.review.provider) : (v.review?.provider ? providerName(v.review.provider) : '')
    if (worker || reviewer) hasAny = true
    map[v.story] = { worker, reviewer, rounds: '' }
  }
  for (const [story, a] of assignByStory) {
    const rounds = a.rounds ? String(Math.round(a.rounds * 10) / 10) : ''
    if (rounds) hasAny = true
    map[story] = { worker: '', reviewer: '', ...(map[story] ?? {}), rounds }
  }
  return { map, hasAny }
}

// ── 티커 1칸 ────────────────────────────────────────────────────────────────
export function renderVerdictTick(verdict) {
  const color = verdict.level === 'green' ? 'var(--green)' : verdict.level === 'unknown' ? 'var(--t3)' : 'var(--orange)'
  return '<span class="tk">배포 판정 <b style="color:' + color + '">' +
    esc(verdict.level === 'unknown' ? '판정 불가' : verdict.level.toUpperCase()) + '</b></span>'
}

const fileUrl = (p) => 'file:///' + String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '')

// ── CSS — 목업 토큰 그대로, 클래스만 b- 접두 ────────────────────────────────
export const BATCH_CSS = `
.b-mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.b-hero{background:var(--ticker);border:1px solid var(--line);border-radius:8px;padding:16px 20px;
  display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:center;margin-bottom:16px}
@media(max-width:760px){.b-hero{grid-template-columns:1fr}}
.b-verdict{display:flex;flex-direction:column;gap:6px;padding:14px 18px;border-radius:8px;min-width:210px}
.b-verdict.red{background:var(--orange);color:#1A0700}
.b-verdict.amber{border:1px solid var(--orange);color:var(--orange)}
.b-verdict.green{border:1px solid var(--green);color:var(--green)}
.b-verdict.unknown{border:1px solid var(--line);color:var(--t3)}
.b-verdict b{font-size:22px;font-weight:800;letter-spacing:.04em}.b-verdict span{font-size:12px;opacity:.92}
.b-heros{display:flex;gap:8px 28px;flex-wrap:wrap;align-items:center}
.b-hs{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--t2)}
.b-hs b{font-size:18px;color:var(--t1);font-weight:600}.b-hs.warn b{color:var(--orange)}
.b-hbeat{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--orange);
  border:1px solid rgba(232,92,13,.55);border-radius:999px;padding:4px 12px}
.b-hbeat i{width:8px;height:8px;border-radius:50%;background:var(--orange);display:inline-block}
.b-hbeat.ok{color:var(--green);border-color:rgba(34,197,94,.45)}.b-hbeat.ok i{background:var(--green)}
.b-hbeat.off{color:var(--t3);border-color:var(--line)}.b-hbeat.off i{background:var(--t3)}
.b-why{font-size:12px;color:var(--t2);margin-top:8px;line-height:1.6}
.b-sec{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;overflow:hidden}
.b-sh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--line)}
.b-sh h2{font-size:16px;font-weight:600}
.b-n{font-family:var(--mono);font-size:12px;border-radius:999px;padding:3px 10px;color:var(--lblue);
  border:1px solid rgba(127,184,255,.45)}
.b-n.warn{color:var(--orange);border-color:rgba(232,92,13,.55)}
.b-sub{font-size:12px;color:var(--t2);margin-left:auto}
.b-body{padding:14px 16px}.b-none{padding:14px 16px;font-size:13px;color:var(--t3);line-height:1.7}
.b-note{font-size:12px;color:var(--t2);margin-top:8px;line-height:1.6}
.b-dec{display:grid;grid-template-columns:1fr 150px;gap:14px;padding:13px 16px;
  border-bottom:1px solid rgba(51,65,85,.5);align-items:start}
.b-dec:last-child{border-bottom:0}
.b-t{font-size:14px;font-weight:600;display:block;margin-bottom:5px}
.b-dec p{font-size:13px;color:var(--t2)}
.b-age{font-family:var(--mono);font-size:12px;border-radius:999px;padding:2px 9px;
  border:1px solid var(--line);color:var(--t3)}
.b-age.old{color:var(--orange);border-color:rgba(232,92,13,.55)}
.b-opt{font-size:12px;color:var(--t3);margin-top:5px}
.b-card{border-top:1px solid rgba(51,65,85,.5);padding:15px 16px}.b-card:first-child{border-top:0}
.b-btop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.b-label{font-size:14px;font-weight:600}
.b-chip{font-size:12px;border-radius:999px;padding:2px 9px;border:1px solid var(--line);color:var(--t2);
  display:inline-block;white-space:nowrap}
.b-chip.data{color:var(--lblue);border-color:rgba(127,184,255,.45)}
.b-chip.ok{color:var(--green);border-color:rgba(34,197,94,.55)}
.b-chip.warn{color:var(--orange);border-color:rgba(232,92,13,.55)}
.b-chip.fill{background:var(--orange);color:#1A0700;border-color:var(--orange);font-weight:600}
.b-chip.mono{font-family:var(--mono)}
.b-tab{width:100%;border-collapse:collapse;font-size:13px;margin-top:4px}
.b-tab th{text-align:left;font-size:12px;color:var(--t3);font-weight:600;padding:6px 10px 6px 0;
  border-bottom:1px solid rgba(51,65,85,.5)}
.b-tab td{padding:8px 10px 8px 0;border-bottom:1px solid rgba(51,65,85,.35);color:var(--t2);vertical-align:top}
.b-tab td b{color:var(--t1);font-weight:600}
.b-tab td.b-k{font-family:var(--mono);color:var(--t3);white-space:nowrap}
.b-meta{display:flex;gap:8px 22px;flex-wrap:wrap;font-size:12px;color:var(--t3);margin-top:10px}
.b-meta b{color:var(--t2);font-weight:600}
.b-callout{border-left:3px solid var(--orange);background:rgba(232,92,13,.08);padding:10px 14px;
  border-radius:0 6px 6px 0;margin-top:10px;font-size:13px;color:var(--t1)}
.b-callout p{color:var(--t2);font-size:12px;margin-top:4px}
.b-mtab{margin:0}
.b-mtab th{padding:10px 12px}.b-mtab td{padding:10px 12px}
.b-mkey{width:26%;padding-left:16px !important}
.b-v{font-family:var(--mono);font-size:18px;color:var(--lblue)}.b-v.warn{color:var(--orange)}
.b-na{color:var(--t3);font-family:var(--mono);font-size:16px}
.b-dim{color:var(--t3);font-size:12px;font-weight:400}
.b-trend{color:var(--t3);font-size:12px}.b-trend.improve{color:var(--green)}.b-trend.worse{color:var(--orange)}
.b-dgrid{display:flex;gap:8px;flex-wrap:wrap;padding:14px 16px}
.b-pill{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:112px}
.b-pill b{font-size:22px;font-family:var(--mono);display:block;color:var(--t1)}
.b-pill span{font-size:12px;color:var(--t2)}.b-pill.warn b{color:var(--orange)}
.b-prio{display:flex;flex-direction:column;gap:5px;padding:0 16px 14px}
.b-prow{display:flex;align-items:center;gap:10px;font-size:12px}
.b-pn{font-family:var(--mono);color:var(--t3);width:18px;flex:none}
.b-pl{color:var(--t2);width:190px;flex:none}
.b-pb{flex:1;height:8px;background:var(--elev);border-radius:4px;overflow:hidden}
.b-pb i{display:block;height:100%;background:var(--lblue)}.b-prow.hot .b-pb i{background:var(--orange)}
.b-pc{font-family:var(--mono);color:var(--t1);width:26px;text-align:right;flex:none}
.b-it{padding:13px 16px;border-bottom:1px solid rgba(51,65,85,.5)}.b-it:last-child{border-bottom:0}
.b-it p{font-size:13px;color:var(--t2)}
.b-src{font-size:12px;color:var(--t3);margin-top:5px;font-family:var(--mono)}
.b-more{padding:12px 16px;font-size:12px;color:var(--t2);border-top:1px solid rgba(51,65,85,.5)}
.b-more summary{cursor:pointer;color:var(--t3)}
.b-more ul{margin:8px 0 0 18px;display:grid;gap:4px}
`

// dev-status — 「이 화면이 지금을 반영하는가」 자가 검토 (순수 판정 · fs 접근 0)
//
// 왜 생겼나(원 프로젝트 2026-09-21 실측): 화면이 현재를 반영하지 못한 채 조용히 낡아 있었다.
//   · 읽는 폴더가 최신 main 이 아닌데 화면에는 아무 표시가 없었다
//   · 헤더의 「상태 파일 날짜」가 파일 머리 주석(같은 키가 20줄 넘게 쌓인다)을 읽어 실제보다 옛날이었다
//   · 지난밤 배치 기록이 며칠 전 것인데 「지난밤 0건」이 「진짜 0」과 구분되지 않았다
// 판정은 전부 규칙이다(LLM 0 · 네트워크 0). 재료는 scan.mjs 가 모으고 그림은 build.mjs 가 그린다.
//
// 원칙: **확인 못 한 것을 ok 로 적지 않는다** — 재료가 없으면 unknown 이다.
//
// 항목은 7개(F1·F2·F3·F4·F5·F7·F8)다. 원본 프로젝트의 **F6(DB 마이그레이션 실측 나이)** 은
// 외부 DB CLI 실프로브 산출물이 원천이라 이 스킬에 없다(SKILL.md 「이 스킬에 없는 기능」).
// 번호는 원본과 맞춰 두었다 — 빠진 자리를 감추면 다음 사람이 「F6 은 통과했나」로 오해한다.

const DAY = 86400000
const MIN = 60000

/** ISO 문자열 → epoch ms. 못 읽으면 null(어떤 비교에도 쓰이지 않게). */
export function ms(v) {
  const t = Date.parse(v ?? '')
  return Number.isFinite(t) ? t : null
}

/** 사람이 읽는 경과 — 「방금 · 37분 전 · 6시간 전 · 3일 전」. */
export function ago(fromMs, now) {
  if (fromMs == null) return '시각 모름'
  const d = Math.max(0, now - fromMs)
  if (d < 2 * MIN) return '방금'
  if (d < 90 * MIN) return Math.round(d / MIN) + '분 전'
  if (d < 2 * DAY) return Math.round(d / (60 * MIN)) + '시간 전'
  return Math.round(d / DAY) + '일 전'
}

/** 로컬 시각 기준 「2026-09-21 07:35」. */
export function stamp(v) {
  const t = ms(v)
  if (t == null) return '?'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

const check = (id, label, status, detail, action = '') => ({ id, label, status, detail, action })

// ── F1 읽는 폴더가 최신 main 인가 ───────────────────────────────────────────
// fetch 는 하지 않는다(새로고침 경로에 네트워크를 넣지 않는다) — **이미 받아 둔** origin/main 과만 견준다.
function f1(g, now) {
  const L = '읽는 폴더가 최신인가'
  if (!g || !g.available) {
    return check('F1', L, 'unknown',
      'git 정보를 읽지 못했습니다 — 이 화면이 어느 시점의 파일을 읽고 있는지 확인할 수 없습니다.',
      'git 이 있는 저장소 폴더에서 다시 만들어 주세요.')
  }
  const where = '지금 읽는 자리 ' + (g.branch || '(갈래 모름)') + ' ' + (g.headShort || '?') +
    ' · ' + stamp(g.headAt) + '(' + ago(ms(g.headAt), now) + ')'
  if (g.behind == null) {
    return check('F1', L, 'unknown',
      '받아 둔 원격 main 기록이 없어 최신인지 견줄 수 없습니다. ' + where,
      '한 번 `git fetch origin` 을 돌린 뒤 다시 여세요(이 화면은 스스로 받아오지 않습니다).')
  }
  if (g.behind > 0) {
    return check('F1', L, 'stale',
      '받아 둔 원격 main 보다 ' + g.behind + '커밋 뒤입니다 — 다른 폴더/갈래를 읽고 있습니다. ' + where,
      '최신 main 폴더에서 다시 열거나, 이 폴더를 최신으로 맞춘 뒤 새로고침하세요.')
  }
  const extra = (g.ahead ? ' · 원격보다 앞선 커밋 ' + g.ahead + '건(아직 안 올림)' : '')
  if (g.dirty) {
    return check('F1', L, 'warn',
      '받아 둔 원격 main 과 같은 자리지만 저장(커밋) 안 한 변경 ' + g.dirty + '건이 섞여 있습니다 — ' +
      '화면의 일부는 아직 아무 데도 안 올라간 내용입니다. ' + where + extra,
      '커밋하거나 되돌린 뒤 다시 보시면 화면과 저장소가 같아집니다.')
  }
  return check('F1', L, 'ok', '받아 둔 원격 main 과 같은 자리입니다. ' + where + extra)
}

// ── F2 상태 파일(sprint-status.yaml)이 언제 바뀌었나 ─────────────────────────
// 머리의 `# last_updated:` 주석은 사람이 손으로 적는 기록이라 최신이 아닐 수 있다 —
// 실제 근거(파일 시각 · 커밋 시각) 중 더 최근을 쓰고, 주석은 옆에 참고로만 적는다.
function f2(s, now) {
  const L = '상태 파일이 언제 바뀌었나'
  if (!s) return check('F2', L, 'unknown', '상태 파일 정보를 모으지 못했습니다.', '')
  const cand = [ms(s.gitAt), ms(s.mtime)].filter((x) => x != null)
  if (!cand.length) {
    return check('F2', L, 'unknown',
      '상태 파일의 변경 시각을 읽지 못했습니다 — 화면의 진척 숫자가 언제 것인지 알 수 없습니다.',
      '_bmad-output/implementation-artifacts/sprint-status.yaml 이 있는지 확인하세요.')
  }
  const at = Math.max(...cand)
  const days = (now - at) / DAY
  const note = '마지막 변경 ' + stamp(new Date(at).toISOString()) + '(' + ago(at, now) + ')' +
    ' · 파일 시각 ' + stamp(s.mtime) + ' · 커밋 시각 ' + (s.gitAt ? stamp(s.gitAt) : '모름') +
    (s.commentDate ? ' · 파일 머리 주석의 가장 최근 날짜 ' + s.commentDate +
      (s.commentCount > 1 ? '(같은 주석 ' + s.commentCount + '줄 중)' : '') : '')
  if (days > 3) {
    return check('F2', L, 'warn', note,
      '3일 넘게 그대로입니다 — 그사이의 배치·머지 결과가 아직 이 파일에 안 적혔는지 확인하세요.')
  }
  return check('F2', L, 'ok', note)
}

// ── F3 에픽 문서 ↔ 상태 파일 정합 ───────────────────────────────────────────
function f3(d) {
  const L = '에픽 문서와 상태 파일이 맞는가'
  if (!d || d.epics == null) {
    return check('F3', L, 'unknown', '에픽 문서를 읽지 못해 견줄 수 없습니다.', '')
  }
  const dup = (d.duplicateEpics ?? [])
  const dupText = dup.length
    ? ' · 에픽 하나가 문서에서 두 곳(요약 목록 + 본문)으로 나뉜 것 ' + dup.length + '개(' +
      dup.slice(0, 3).map((x) => 'Epic ' + x.num).join(' · ') +
      (dup.length > 3 ? ' 외 ' + (dup.length - 3) + '개' : '') + ' — 스토리는 합쳐서 셌습니다)'
    : ''
  const base = '에픽 ' + d.epics + '개 · 스토리 ' + d.stories + '건' +
    (d.hashStories ? '(그중 제목 단계가 한 칸 깊은 `#### Story` ' + d.hashStories + '건 — 함께 셌습니다)' : '') +
    ' · 상태 파일에만 있는 스토리 ' + d.sprintOnly + '건 · 에픽 문서에만 있는 스토리 ' + d.docOnly + '건' + dupText
  const gap = (d.sprintOnly ?? 0) + (d.docOnly ?? 0)
  if (gap > 0) {
    return check('F3', L, 'warn', base,
      '어느 한쪽에만 있는 스토리가 ' + gap + '건 있습니다 — 아래 「불일치 경고」 칸에서 어느 스토리인지 보고 문서나 상태 파일을 맞추세요.')
  }
  return check('F3', L, 'ok', base)
}

// ── F4 무인 러너 심박 ───────────────────────────────────────────────────────
function f4(hb, r) {
  const L = '무인 러너가 살아 있나'
  if (!hb || hb.state === 'none' || hb.ageMin == null) {
    return check('F4', L, 'unknown',
      (hb?.label ?? '러너 기록 없음') + ' — 러너가 도는지 이 화면에서는 알 수 없습니다.',
      '상태 폴더' + (r?.stateDir ? '(' + r.stateDir + ')' : '') + '의 slots.log 위치를 확인하세요.')
  }
  const tail = r?.lastLine ? ' · 마지막 기록 「' + r.lastLine + '」' : ''
  const base = hb.label + ' · 잠금 파일 ' + (r?.lockExists ? '있음(작업 중이라고 주장)' : '없음') + tail
  if (hb.state === 'alarm' || hb.ageMin > 75) {
    return check('F4', L, 'warn', base,
      (hb.why || '75분 넘게 조용합니다') + ' — 무인 배치를 깨우는 예약작업이 도는지 보고, 멈췄으면 다시 켜세요.')
  }
  return check('F4', L, 'ok', base)
}

// ── F5 지난밤 배치 재료 ─────────────────────────────────────────────────────
// 「지난밤 0건」이 **진짜 0** 인지 **재료를 못 찾은 것**인지 가른다.
//
// 원본 프로젝트는 여기서 **러너 클론(별도 폴더)의 산출물과 대조**한다 — 무인 러너가 다른
// 클론에서 돌아 그 매니페스트가 머지 전까지 이 폴더에 없기 때문이다. 그건 그 프로젝트의
// 러너 배치 방식에 붙은 기능이라 이 스킬에는 없다(SKILL.md 「이 스킬에 없는 기능」 · 필요하면
// 플러그인이 `freshness.manifests` 에 자기 자리를 얹으면 된다). 여기서는 **이 폴더의 기록만**
// 보고, 대조를 안 했다는 사실을 detail 에 적는다 — 안 한 것을 한 것처럼 적지 않는다.
function f5(m, now) {
  const L = '지난밤 배치 재료가 있나'
  const ONLY_HERE = ' · 러너가 다른 폴더에서 돈다면 그쪽 기록은 보지 않았습니다(이 스킬은 이 폴더만 읽습니다)'
  if (!m || m.count == null) {
    return check('F5', L, 'unknown', '배치 기록(매니페스트)을 하나도 찾지 못했습니다.', '')
  }
  if (!m.lastAt) {
    return check('F5', L, 'unknown',
      '이 폴더에는 배치 기록이 없습니다 — 화면의 「지난밤 배치 0건」이 진짜 0 인지 알 수 없습니다.' + ONLY_HERE,
      '무인 배치를 쓰는 프로젝트라면 auto-pipeline-logs 폴더에 매니페스트가 쌓이는지 확인하세요.')
  }
  const last = ms(m.lastAt)
  const detail = '이 폴더의 마지막 배치 ' + stamp(m.lastAt) + '(' + ago(last, now) +
    ' · 모두 ' + m.count + '건)' + ONLY_HERE
  if (last == null) return check('F5', L, 'unknown', detail, '')
  if (now - last > DAY) {
    return check('F5', L, 'warn', detail,
      '마지막 배치가 하루를 넘겼습니다 — 화면의 「지난밤 배치 0건」은 진짜 0 입니다(재료가 없어서가 아닙니다).')
  }
  return check('F5', L, 'ok', detail)
}

// ── F7 결정 인박스 최신 근거 ────────────────────────────────────────────────
function f7(i, now) {
  const L = '결정 인박스가 언제 바뀌었나'
  const cand = [ms(i?.gitAt), ms(i?.mtime)].filter((x) => x != null)
  if (!cand.length) {
    return check('F7', L, 'unknown',
      '결정 인박스(DECISIONS-INBOX.md)를 읽지 못했습니다 — 「오늘 정하실 것」이 언제 것인지 알 수 없습니다.',
      '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md 가 있는지 확인하세요.')
  }
  const at = Math.max(...cand)
  const base = '마지막 변경 ' + stamp(new Date(at).toISOString()) + '(' + ago(at, now) + ')'
  if ((now - at) / DAY > 7) {
    return check('F7', L, 'warn', base,
      '일주일 넘게 그대로입니다 — 그동안 AI 가 스스로 정한 것들이 아직 여기에 안 적혔는지 확인하세요.')
  }
  return check('F7', L, 'ok', base)
}

// ── F8 이 화면을 만든 시각 ──────────────────────────────────────────────────
function f8(generatedAt, now) {
  const L = '이 화면을 만든 시각'
  const at = ms(generatedAt)
  if (at == null) return check('F8', L, 'unknown', '화면 생성 시각을 읽지 못했습니다.', '')
  const base = stamp(generatedAt) + '(' + ago(at, now) + ') 에 만들어졌습니다'
  if (now - at > 10 * MIN) {
    return check('F8', L, 'warn', base, '열어 둔 지 오래됐습니다 — F5 로 새로고침하면 위 파일들에서 다시 만듭니다.')
  }
  return check('F8', L, 'ok', base)
}

/**
 * 7항목 판정. `data` 는 scan() 결과(재료는 `data.freshness`), `ctx.now` 는 기준 시각(ms).
 * @returns {{id:string,label:string,status:'ok'|'warn'|'stale'|'unknown',detail:string,action:string}[]}
 */
export function freshnessChecks(data, ctx = {}) {
  const now = ctx.now ?? Date.now()
  const F = data?.freshness ?? {}
  return [
    f1(F.git, now),
    f2(F.sprint, now),
    f3(F.docs),
    f4(data?.batch?.heartbeat, F.runner),
    f5(F.manifests, now),
    f7(F.inbox, now),
    f8(data?.generatedAt, now),
  ]
}

/**
 * 종합 판정 — stale 이 하나라도 있으면 🔴, warn 만 있으면 🟡, 전부 ok 면 🟢,
 * 재료가 없어 unknown 이 남으면 ⚪. **확인 못 한 것을 🟢 로 적지 않는다.**
 */
export function freshnessVerdict(checks) {
  const list = Array.isArray(checks) ? checks : []
  const counts = { ok: 0, warn: 0, stale: 0, unknown: 0 }
  for (const c of list) {
    if (Object.prototype.hasOwnProperty.call(counts, c?.status)) counts[c.status] += 1
  }
  if (!list.length) {
    return { level: 'unknown', label: '⚪ 판정 불가', why: '검토 항목이 하나도 없습니다.', counts }
  }
  if (counts.stale) {
    return {
      level: 'stale', label: '🔴 낡은 내용 포함 — 아래 항목부터',
      why: '이 화면의 일부는 지금이 아니라 예전 재료로 그려졌습니다. 주황색 항목을 먼저 푸세요.',
      counts,
    }
  }
  if (counts.warn) {
    return {
      level: 'warn', label: '🟡 일부 확인 필요',
      why: '크게 틀린 곳은 없지만 확인해 볼 항목이 있습니다.',
      counts,
    }
  }
  if (counts.unknown) {
    return {
      level: 'unknown', label: '⚪ 판정 불가',
      why: '재료가 없어 확인하지 못한 항목이 있습니다 — 확인 못 한 것을 「이상 없음」으로 적지 않습니다.',
      counts,
    }
  }
  return {
    level: 'ok', label: '🟢 현재 시점 반영',
    why: '읽는 폴더·상태 파일·배치 재료·실측이 모두 지금 것입니다.',
    counts,
  }
}

// 병렬 충돌 판정(확장) — 2026-09-02 「9점대 하네스」
//
// 왜 확장하나: 종전 판정은 **File List 겹침**(runner-rules.fileListConflicts)과
// **공유 툴체인**(runner-rules.parallelHazards = package.json/lock)만 봤다. 그런데 두 워크트리가
// 같은 파일을 만지지 않아도 충돌하는 부류가 있다 —
//   ① 둘 다 `supabase/migrations/` 에 **새 파일**을 만들면 번호가 경합한다(같은 접두사·다른 파일이라
//      File List 겹침으로는 안 잡힌다 · landing 후 순서가 뒤집힌다)
//   ② 생성물 스키마 파일(`src/types/database.ts` · `schema.sql` · `prisma/schema.prisma`)은 재생성이라
//      줄 단위 3-way 머지가 의미를 잃는다
//   ③ 공유 설정(tsconfig·vite/vitest/eslint·.env.example·wrangler)은 한쪽 변경이 다른 쪽 qa 판정을 바꾼다
//   ④ API 계약(`supabase/functions/**` · `src/api/**` · `openapi*` · `*contract*`)은 양쪽이 다른 파일을
//      고쳐도 계약이 갈라진다
//   ⑤ 테스트 환경(`tests/setup*` · `tests/db/**` 공유 픽스처 · `.github/workflows`)은 통합 게이트를 흔든다
//
// 판정은 **순수 함수**다. 충돌이면 병렬을 포기하고 **순차화**한다 — 자동으로 뭉개지 않는다.
// 러너 배선: `runner-rules.parallelHazards` 자리에 `parallelHazardsCompat` 를 주입하면
// 반환 형태(`{ ok, why }`)가 같아 호출부를 고치지 않아도 된다(워커 R 소유 파일이라 여기서는 배선하지 않는다).

/** 거의 모든 dev 가 함께 만지는 장부 — 겹침 판정에서 뺀다(landing 이 union 으로 합친다). */
export const SHARED_BOOKKEEPING_DEFAULT = Object.freeze([
  '_bmad-output/implementation-artifacts/sprint-status.yaml',
  '_bmad-output/implementation-artifacts/deferred-work.md',
  '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md',
])

const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
const base = (p) => p.split('/').pop() ?? ''

/**
 * 범주표 — 위에서부터 **처음 맞는 범주 하나**로 분류한다(중복 계상 금지).
 *  mode 'any'   = 한쪽만 만져도 병렬 불가(공유 자원이라 상대가 안 만져도 흔들린다)
 *  mode 'multi' = 둘 이상이 만질 때만 충돌(한쪽만이면 서로 다른 파일이라 안전)
 */
export const CONFLICT_RULES = Object.freeze([
  {
    id: 'toolchain', mode: 'any',
    label: '공유 툴체인',
    why: 'node_modules 를 junction 으로 공유해 한쪽 의존성 변경이 다른 쪽 qa 를 흔든다',
    test: (p) => ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(base(p)),
  },
  {
    id: 'migration', mode: 'multi',
    label: '마이그레이션',
    why: '둘 다 새 마이그레이션을 만들면 번호가 경합한다(다른 파일이라 겹침 판정에 안 걸린다)',
    test: (p) => /(^|\/)supabase\/migrations\//.test(p) || /(^|\/)migrations\/[^/]+\.sql$/.test(p),
  },
  {
    id: 'schema', mode: 'multi',
    label: '스키마 생성물',
    why: '재생성 파일이라 줄 단위 3-way 머지가 뜻을 잃는다',
    test: (p) => /(^|\/)src\/types\/database\.ts$/.test(p) || /(^|\/)schema\.sql$/.test(p) || /(^|\/)prisma\/schema\.prisma$/.test(p),
  },
  {
    id: 'api-contract', mode: 'multi',
    label: 'API 계약',
    why: '서로 다른 파일을 고쳐도 계약이 갈라진다(엣지 함수·API 라우트·openapi·contract 타입)',
    test: (p) => /(^|\/)supabase\/functions\//.test(p) || /(^|\/)src\/api\//.test(p) ||
      /(^|\/)openapi[^/]*\.(json|ya?ml)$/i.test(p) || /(^|\/)src\/types\/[^/]*contract[^/]*\.[a-z]+$/i.test(p),
  },
  {
    id: 'shared-config', mode: 'multi',
    label: '공유 설정',
    why: '한쪽 설정 변경이 다른 쪽 qa·빌드 판정을 바꾼다',
    test: (p) => /(^|\/)tsconfig[^/]*\.json$/.test(p) || /(^|\/)(vite|vitest)\.config\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/.test(p) ||
      /(^|\/)\.env\.example$/.test(p) || /(^|\/)wrangler\.[a-z]+$/.test(p),
  },
  {
    id: 'test-env', mode: 'multi',
    label: '테스트 환경',
    why: '공유 픽스처·워크플로가 바뀌면 통합 게이트 판정이 흔들린다',
    test: (p) => /(^|\/)tests\/setup[^/]*$/.test(p) || /(^|\/)tests\/db\//.test(p) ||
      /(^|\/)\.github\/workflows\//.test(p),
  },
])

/** 경로 → 범주 id(없으면 null). 위 표의 **첫 일치**만 돌려준다. */
export function classifyPath(path) {
  const p = norm(path)
  if (!p) return null
  for (const r of CONFLICT_RULES) if (r.test(p)) return r.id
  return null
}

/**
 * 병렬 가능 판정 — 스토리별 File List 배열을 받아 범주별로 판정한다.
 * 반환 `{ parallelOk, reasons[], why }` · reasons 는 결정적 순서(직접 겹침 → 범주표 순).
 * opts.shared = 겹침 판정에서 뺄 공유 장부(기본 SHARED_BOOKKEEPING_DEFAULT).
 * opts.rules  = 범주표 교체(테스트·프로젝트 예외용).
 */
export function parallelHazardsExtended(lists, opts = {}) {
  const shared = opts.shared ?? SHARED_BOOKKEEPING_DEFAULT
  const rules = opts.rules ?? CONFLICT_RULES
  const arrays = (lists ?? []).map((l) => [...new Set((l ?? []).map(norm).filter(Boolean))].sort())
  const reasons = []

  // ① 직접 겹침 — 서로 다른 스토리가 같은 파일(공유 장부 제외)을 만진다
  const owner = new Map()
  const dup = new Map()
  for (let i = 0; i < arrays.length; i++) {
    for (const f of arrays[i]) {
      if (shared.includes(f)) continue
      if (owner.has(f) && owner.get(f) !== i) {
        const set = dup.get(f) ?? new Set([owner.get(f)])
        set.add(i)
        dup.set(f, set)
      } else if (!owner.has(f)) owner.set(f, i)
    }
  }
  for (const f of [...dup.keys()].sort()) {
    const st = [...dup.get(f)].sort((a, b) => a - b).map((i) => i + 1)
    reasons.push({ category: 'file-overlap', files: [f], stories: st, why: `스토리 ${st.join('·')} 가 같은 파일(${f}) 을 만진다` })
  }

  // ② 범주표
  for (const rule of rules) {
    const hits = arrays.map((files) => files.filter((f) => !shared.includes(f) && rule.test(f)))
    const idx = []
    for (let i = 0; i < hits.length; i++) if (hits[i].length > 0) idx.push(i)
    const tripped = rule.mode === 'any' ? idx.length >= 1 : idx.length >= 2
    if (!tripped) continue
    const files = [...new Set(idx.flatMap((i) => hits[i]))].sort()
    const st = idx.map((i) => i + 1)
    reasons.push({
      category: rule.id,
      files,
      stories: st,
      why: `${rule.label} 충돌 — 스토리 ${st.join('·')} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ' 외' : ''}): ${rule.why}`,
    })
  }

  return { parallelOk: reasons.length === 0, reasons, why: reasons.map((r) => r.why).join(' · ') }
}

/** 러너 주입용 어댑터 — `runner-rules.parallelHazards` 와 **같은 반환 형태**(`{ ok, why }`). */
export function parallelHazardsCompat(lists, opts = {}) {
  const r = parallelHazardsExtended(lists, opts)
  return { ok: r.parallelOk, why: r.parallelOk ? '' : r.reasons[0].why }
}

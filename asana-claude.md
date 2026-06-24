# Asana ↔ Claude Code 자동 워크플로우 — 설계 노트

## 목표

너가 Asana만 사용하고, Claude Code는 백그라운드에서 자동으로 작업을 받아 처리하는 양방향 루프 구축. cmux/터미널을 직접 안 만져도 동작.

```
[Asana 태스크/댓글] ─webhook─→ [로컬 브리지] ─tmux send-keys─→ [Claude Code]
                                                                 │
[Asana 댓글/첨부/하위티켓] ←──── MCP (Asana, Playwright, GitLab) ─┘
```

핵심 통찰: 참고 PoC(사내 PoC)가 이미 비슷한 문제를 풀었음. 단, **사용자가 `/my`, `/setup-asana auto`, `/merge` 3개를 수동 입력**. 이걸 **Asana webhook으로 트리거**해서 0개로 줄이는 게 우리의 차이점.

---

## 참고 PoC에서 가져올 핵심 패턴

### 1) 명령어 자동 체이닝 (`auto` 모드)
- `/setup-asana {GID} auto` → setup → analyze → build → done까지 자동 진행
- 사용자는 검토 게이트에서만 개입
- **우리 적용**: webhook이 `auto` 옵션 붙은 프롬프트 주입. 라벨이나 커스텀 필드로 모드 결정

### 2) 태스크 상태 파일 (.claude/task-state/{GID}.json)
- 작업 단계 영속화 (재개 가능, 재실행 감지)
- **우리 적용 필수**. 서버 죽거나 세션 끊겨도 상태 복원

### 3) Analyze 단계의 자체 검토 (3단계)
- 1차: 요구사항 누락 / 2차: 검토 정확성 / 3차: 과도 설계
- **우리 적용**: 요약 LLM 단계에서 자동 적용. 우리의 `주요 결정/주요 질문` 섹션과 결합

### 4) AI 리뷰봇 3단계 분류 (자동수정 / 확인 / 스킵)
- lint·오타·미사용 → 자동 수정
- 설계 의견 → 사용자 확인
- 단순 요약 → 스킵
- **우리 적용**: GitLab/GitHub 리뷰봇 외 일반 PR 댓글에도 적용

### 5) 12단계 셀프 코드리뷰 체크리스트
- 빌드·목적 부합·버그/보안·재사용·사이드 이펙트·재검토 등
- **우리 적용**: build 단계에서 항상 자동 수행. 결과를 PR 본문에 첨부

### 6) git worktree 병렬 작업
- 태스크별 독립 폴더 → 브랜치 충돌 없음
- **우리 적용 필수**. 동시다발 webhook이 같은 repo 다른 태스크여도 안전

### 7) Asana 칸반 7개 섹션 자동 이동
- 작업전 → 셋업완료 → 분석중 → 개발중 → 코드리뷰 → QA → 완료
- **우리 적용**: 시각적 진행상황 그대로 동기화

### 8) 파트별 분기 구조
- BX(프론트오피스) vs 버티컬: 태그·레포·배포 방식 다름
- **우리 적용**: Asana 프로젝트/태그/커스텀 필드 → 로컬 repo 매핑 config

### 9) REST API 직접 호출 (MCP 의존도 ↓)
- 안정성·속도 확보
- **우리 적용**: 핵심 경로(태스크 조회, 댓글 작성, 첨부)는 직접 curl. MCP는 보조

### 10) Auto 성공률 50% 인정
- 나머지 50%는 사용자 협업
- **우리 적용**: Auto가 막히면 사용자에게 명확히 인계 (어디서 막혔는지, 무엇이 필요한지)

---

## purplemux에서 가져올 패턴

### 1) PWA + Web Push 알림
- 폰에서 진행 모니터링, 자동 작업 완료/막힘 알림
- **우리 적용**: 이미 만든 viewer를 PWA로. 알림 트리거 추가

### 2) 권한 프롬프트 감지/포워딩
- "Allow this?" 식 차단 자동 감지
- **우리 적용 필수**. tmux pane 출력 정규식 매칭. 매칭 시 슬랙/푸시 알림 + Asana 댓글 "사용자 승인 필요"

### 3) 토큰 사용량/비용 분석
- 프로젝트별 비용 추적
- **우리 적용**: 우리 viewer가 트랜스크립트 다 갖고 있으니 추가 가능. 자동 작업의 비용을 Asana 태스크에 기록

### 4) 세션 지속성 (tmux 기반)
- 브라우저 닫아도 세션 유지
- **이미 우리 모델의 핵심**. tmux session = 영속 일꾼

### 5) 모든 데이터 로컬 (`~/.purplemux/`)
- 외부 전송 X
- **우리 적용**: 자동 작업 로그도 로컬만. 보안·프라이버시

---

## 참고 PoC에 없는 — 우리가 추가해야 할 것

참고 PoC는 사용자가 명령어를 수동 입력. 우리는 webhook 기반 무인 동작이라 다음이 추가 필요:

### A. Webhook 인입·검증·라우팅
- Asana X-Hook-Secret 핸드셰이크
- HMAC 검증
- 이벤트 종류별 라우팅 (task created / comment added / assignment changed)
- 중복 이벤트 idempotency (webhook은 재시도됨)

### B. 트리거 조건 필터
- 모든 이벤트 처리하면 노이즈. 명확한 트리거만:
  - `@claude` 멘션이 댓글에 있음
  - 특정 라벨(`auto-claude`)이 태스크에 붙음
  - 특정 섹션(`자동처리 대기`)에 들어감
  - 본인 할당 + 우선순위 P0
- **여러 조건 조합 가능**. config로 정의

### C. 세션 라우팅 정책
- task_gid 기반 1세션 1태스크 (격리)
- 같은 repo 동시 작업 시 직렬화 (git 충돌 방지)
- 동시 한도(MAX_CONCURRENT) 큐잉
- 참고 PoC의 worktree 패턴 그대로

### D. "작업 끝났다" 신호
- Claude가 명시적 토큰 출력 (`TASK_COMPLETE_<gid>`)
- 보조: idle timeout (last-prompt 후 N분)
- **둘 다** 구현하고 OR 조건

### E. 권한 차단·막힘 회복
- tmux pane 출력 모니터링
- "Allow this?" "[Y/n]" "비밀번호" 등 패턴 감지
- 차단 시: Asana 태스크에 댓글 "사용자 입력 필요: <상황>" + 푸시 알림
- 사용자가 cmux 들어가서 직접 처리 → 작업 재개

### F. 안전장치 — 라벨 기반 권한 게이트
- `auto-execute`: 코드 수정·커밋·push까지 자동
- `auto-analyze`: 분석·계획만, 코드 수정 안 함 (사용자 검토 후 진행)
- `read-only`: 댓글로 답변만, 파일 수정 X
- 라벨 없으면 read-only 기본

### G. 감사 로그 (audit trail)
- 자동 작업이 한 모든 것 기록: 어떤 명령, 어떤 파일 수정, 어떤 커밋, 어떤 댓글
- Asana 태스크 본문에 자동 append (footer 영역)
- 우리 viewer에서 자동 작업 세션 별도 필터로 표시

### H. 비용 한도
- 태스크당 최대 토큰/달러 한도
- 초과 시 작업 중단 + 사용자 확인 요청
- 일/주 한도 (예: 일 $5)

### I. 작업 인계 모드
- 사용자가 "그만 해, 내가 할게"라고 Asana 댓글 달면 자동 작업 즉시 중단
- 트리거: `@claude stop`, `@claude takeover`
- 진행 중인 commit·push만 마무리하고 손 뗌

### J. 복구·재시도 전략
- Claude Code 크래시 → 헬스체크 + 자동 재시작
- 작업 시도 3회 실패 → 사용자 인계 (Asana 댓글 + 푸시)
- 동일 webhook 재처리 방지 (이벤트 ID idempotency)

---

## 실패 모드·엣지케이스 정리

참고 PoC가 안 다룬 것 + 무인 운영 특유 위험:

| 시나리오 | 위험 | 대응 |
|---|---|---|
| 동일 task 댓글 5초 안에 3개 | 키 입력 끼어들어 깨짐 | 브리지 측 task_gid 큐, 직렬 처리 |
| 같은 repo 두 태스크 동시 | git 충돌, 빌드 흔들림 | repo 락. 한 태스크 끝날 때까지 다른 거 큐잉 |
| Claude 무한 루프/멈춤 | 자원 점유 | hard timeout (60min) → 강제 kill + 인계 |
| 권한 프롬프트에서 멈춤 | stuck silent | 출력 모니터 + 알림 (E 항목) |
| Asana webhook 7일 무응답 | 자동 비활성화 | 최소 200 응답 보장. 처리 실패해도 200 + 별도 큐 |
| 중복 webhook (재시도) | 같은 작업 2번 실행 | event_id 또는 (task_gid + ts) 기반 dedup |
| Claude가 파괴적 명령(rm -rf) | 데이터 손실 | settings.local.json에서 위험 명령 차단. CLAUDE.md에 "destructive ops require confirm" |
| Cloudflare Tunnel 끊김 | webhook 못 받음 | systemd/launchd로 자동 재시작. 끊김 알림 |
| 자동 작업이 잘못된 코드 push | PR 머지 시 사고 | auto는 `auto-approve` 안 함. 사람 리뷰 필수 |
| 태스크 GID 잘못 매핑 | 다른 repo에서 작업 | 매핑 테이블에 명시되지 않은 task는 거부 |
| Asana 멘션이 사실 다른 사람 | 잘못 트리거 | 멘션 대상이 너 본인일 때만 처리 |
| 토큰 비용 폭발 | 청구 사고 | 일일 한도 + 단일 작업 한도 (H 항목) |
| 동시 작업 5개 → 메모리 부족 | OOM | MAX_CONCURRENT 보수적, 머신 사양 기반 조정 |
| 한 작업 안에 multiple repos | 어느 worktree에서? | 메인 worktree 결정 후 repo별 sub-task로 분할 |
| Slack 봇 없이 Asana만 사용 | 알림 부족 | 푸시 알림(우리 viewer PWA) + email fallback |
| 자동 작업 중 사용자가 직접 cmux 사용 | 입력 충돌 | 별도 세션 풀. 자동용 vs 수동용 분리 |

---

## 추가하면 가치 큰 기능 (참고 PoC + purplemux 합성)

### 1. **Asana 통합 인박스** (우리 viewer 신규 페이지)
- 자동 작업으로 처리된 모든 태스크 시간순
- 상태별 필터 (진행중/막힘/완료/사용자 인계)
- 각 항목 클릭 → 해당 세션 전체 트랜스크립트
- **목적**: 무인 작업이지만 내가 무엇이 일어났는지 한 번에 파악

### 2. **자동 학습 — 결정 → 룰 변환**
- 사용자가 자주 같은 결정 내림 (예: "API 변경 시 항상 테스트 추가")
- 우리 viewer의 `/decisions` 누적 데이터 분석
- N회 이상 반복된 결정 → CLAUDE.md 자동 추가 제안
- 참고 PoC의 "작업 히스토리 학습" 강화

### 3. **태스크 분해 자동 제안**
- 큰 태스크(예상 작업 시간 > 4h) 감지
- LLM이 "이걸 X, Y, Z로 나눠야 병렬 처리 가능"
- 사용자 확인 후 Asana subtask 자동 생성
- 참고 PoC의 "병렬 실행" 전제 조건

### 4. **재실행 감지 (참고 PoC `/done` 재실행)**
- QA 피드백 후 재배포 자동 분기
- 같은 task_gid의 두 번째 작업 webhook → 이전 컨텍스트 + 추가 변경만
- 우리 case: 같은 task의 후속 댓글이 코드 변경 요청 → 자동 재실행

### 5. **PR 본문 자동 작성 (참고 PoC 패턴)**
- 작업 요약 / 변경 파일 / 셀프 리뷰 체크리스트 결과
- Asana 태스크 링크 자동 첨부
- AI 리뷰봇 댓글 처리 결과 명시

### 6. **Pre-flight check**
- webhook 받으면 먼저 검증:
  - 매핑된 repo 존재?
  - git status clean?
  - 의존성 설치 필요?
  - 권한 충분?
- 한 가지라도 실패 → Asana 댓글로 인계

### 7. **타임라인 비주얼라이저**
- "오늘 자동 작업" 캘린더 뷰
- 어떤 webhook 언제 들어와서 어떤 결과 났는지
- 우리 viewer의 `/decisions` 옆에 신규 `/timeline` 페이지

### 8. **메타-체크: 자동 작업 자체의 품질**
- 자동 작업이 만든 PR 머지율, 롤백률, 리뷰어 코멘트 수
- 패턴 발견: "이 종류 작업은 자동으로 잘 됨/잘 안됨"
- config 자동 조정 (이런 라벨은 read-only로 강등 등)

---

## 단계적 구현 로드맵

### v0 (PoC, 1일)
- Cloudflare Tunnel 셋업
- 100줄 브리지 (단일 세션, 트리거: comment_added with `@claude`)
- tmux send-keys로 너의 Claude Code에 프롬프트 주입
- Claude Code가 Asana MCP로 직접 답글
- **목표**: "댓글 → 자동 답글" 1회 동작 시연

### v1 (실용, 1주)
- task_gid 기반 세션 라우팅 (B + C 항목)
- worktree 통합 (참고 PoC 패턴)
- 라벨 기반 권한 게이트 (F 항목)
- TASK_COMPLETE 신호 + idle timeout (D 항목)
- 권한 프롬프트 감지·알림 (E 항목)
- viewer에 자동 작업 인박스 (#1)

### v2 (안정 운영, 2~3주)
- repo 락, 동시성 제어
- 비용 한도 (H)
- 감사 로그 (G)
- 헬스체크·재시도 (J)
- viewer PWA + 푸시 알림 (purplemux 패턴 #1)
- 권한 프롬프트 자동 응답 (안전한 명령만)

### v3 (학습형, 추후)
- 결정 → 룰 변환 (#2)
- 태스크 분해 (#3)
- 메타-체크 (#8)
- 다른 시스템 (GitLab/GitHub/Linear) webhook 추가

---

## 결정 필요한 항목

다음은 너가 정해야 사용성이 명확해지는 것들:

1. **트리거 룰**: `@claude` 멘션? 라벨 `auto-claude`? 둘 다? — 너의 일하는 방식 기준
2. **권한 기본값**: 라벨 없을 때 read-only / auto-analyze / auto-execute 중?
3. **Asana 프로젝트 ↔ repo 매핑 위치**: 정적 config 파일 / Asana 커스텀 필드?
4. **사용자 인계 신호**: `@claude stop`만? 라벨 변경도? 슬랙 명령?
5. **알림 채널**: viewer PWA만 / Slack도 / email도?
6. **비용 한도 단위**: 일/주/월? 작업당? 태스크당?
7. **동시 작업 한도**: 머신 사양·테스트 후 결정. 일단 3?

---

## 참고

- 참고 PoC 상세: ax.md (별도 위치, 외부 문서)
- purplemux: https://github.com/subicura/purplemux
- 우리 viewer: `apps/viewer/`
- 우리 viewer 사용 가이드: `apps/viewer/README.md`

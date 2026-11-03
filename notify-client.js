// ============================================================
// AI암산튜터 notify-client.js — 알림관리 2a단계 (앱 쪽 학습 기록)
// 독립 네임스페이스: notif*
// 역할: 서버 알림 판단에 쓸 "오늘 학습 상태" 기록을 남긴다.
//   - 학습중(시작): 문제 푸는 화면에 들어가면 그날 1번 activity_start 기록
//   - 학습함(완료): 결과 화면이 뜨거나 기존 서버 기록(syncProgressEvent)이 나가면 완료로 봄
//                   기존 서버 기록이 없던 날에만 activity 기록 1번 추가
//   - 앱 시작 시 기기 시간대·언어를 서버에 저장 (하루 1번)
//   - 시작/완료 기록은 서버가 받아줬을 때만 "오늘 보냄" 표시 — 실패하면 다음 화면 전환 때 재시도
//     (2026-10-27: 저장 키 notifDay_ → notifDay2_ — 서버 CHECK 제한으로 실패했던 기존 표시 무효화)
//
// 기존 코드와의 관계 (2026-10-26 사용자 승인):
//   - app.html 기존 함수 내용은 한 줄도 바꾸지 않음.
//   - lrnShowScreen / showScreen / syncProgressEvent 를 "바깥에서 감싸기"만 함.
//     원래 함수를 먼저 그대로 실행하고, 반환값도 그대로 돌려줌.
//     덧붙인 기록 로직은 전부 try/catch — 여기서 오류가 나도 원래 동작에는 영향 없음.
//   - app.html 맨 끝(</body> 바로 앞)에서 로드해야 함 (함수들이 다 정의된 뒤에 감쌈).
//   - 게스트·devkey 모드(studentId 없음)는 아무것도 보내지 않음 (syncProgressEvent와 동일).
//
// 서버: supabase_notify_01_tables.sql, supabase_notify_02_client.sql 적용 필요
// ============================================================

// 문제 푸는 화면 = 들어가면 "학습중"
const NOTIF_PLAY_SCREENS = new Set([
  'scr-add-problem',   // 덧셈 문제
  'scr-mental',        // 호산·암산 (단원 테스트·연습 공용)
  'scr-guide-anim',    // 곱셈 따라하기 / 스피드 게임
  'scr-lowbead',       // 위아래알 퀴즈
  'scr-make5',         // 5 모으기·가르기
  'scr-comp10',        // 10 보수
  'scr-learn',         // 구구단 학습
  'scr-gugu1',         // 구구단 거듭 더하기
  'scr-gtest',         // 구구단 테스트
  'scr-divq',          // 나눗셈
  'scr-add-yeonsan',   // 연산 워크시트
  'scr-add-tier-play', // 덧뺄셈 중급·고급
  'scr-flash-add-1', 'scr-flash-mult-1', 'scr-flash-div-1' // 플래시암산 플레이
]);

// 결과 화면 = 뜨면 "학습함"
const NOTIF_RESULT_SCREENS = new Set([
  'scr-done', 'scr-add-test-result', 'scr-add-tier-result', 'scr-speed-result'
]);

// 기존 서버 기록 중 "완료"로 치는 종류 (서버 notif_day_status 와 동일 기준)
const NOTIF_DONE_EVENT_TYPES = new Set(['lesson_round', 'unit_test', 'speed_game', 'activity']);

let notifOrigSync = null;   // 감싸기 전 원래 syncProgressEvent

function notifStudentId(){
  try { return (typeof gateState !== 'undefined' && gateState && gateState.studentId) || null; }
  catch(e){ return null; }
}

// 기기 현지 날짜 'YYYY-MM-DD'
function notifLocalDate(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 학생별 오늘 기록 상태 {date, start, done, hello}
function notifDayLoad(sid){
  try {
    const v = JSON.parse(localStorage.getItem('notifDay2_' + sid) || 'null');
    if (v && v.date === notifLocalDate()) return v;
  } catch(e){}
  return { date: notifLocalDate(), start: false, done: false, hello: false };
}
function notifDaySave(sid, v){
  try { localStorage.setItem('notifDay2_' + sid, JSON.stringify(v)); } catch(e){}
}

// 학습 기록 전송 — 서버가 받아줬는지(res.ok) 돌려줌
//   기존 syncProgressEvent 는 실패를 조용히 무시하므로, 시작/완료 기록은 직접 보내서 성공 여부를 확인함
//   (성공했을 때만 "오늘 보냄" 표시 → 실패하면 다음 화면 전환 때 다시 시도)
const notifSending = {};
async function notifPostEvent(sid, unitId, eventType){
  try {
    const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/progress_events`, {
      method: 'POST',
      headers: {
        'apikey': GATE_SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ student_id: sid, unit_id: unitId, event_type: eventType })
    });
    return res.ok;
  } catch(e){ return false; }
}

// 시작 기록 — 그날 첫 시작 때 1번만 (성공할 때까지 재시도)
async function notifMarkStart(screenId){
  const sid = notifStudentId(); if (!sid) return;
  if (notifDayLoad(sid).start || notifSending.start) return;
  notifSending.start = true;
  const ok = await notifPostEvent(sid, 'screen:' + screenId, 'activity_start');
  notifSending.start = false;
  if (ok){ const day = notifDayLoad(sid); day.start = true; notifDaySave(sid, day); }
}

// 완료 기록 — 기존 서버 기록이 이미 나갔으면(alreadySent) 표시만, 아니면 activity 1번 전송
async function notifMarkDone(source, alreadySent){
  const sid = notifStudentId(); if (!sid) return;
  if (notifDayLoad(sid).done || notifSending.done) return;
  if (alreadySent){ const day = notifDayLoad(sid); day.done = true; notifDaySave(sid, day); return; }
  notifSending.done = true;
  const ok = await notifPostEvent(sid, source, 'activity');
  notifSending.done = false;
  if (ok){ const day = notifDayLoad(sid); day.done = true; notifDaySave(sid, day); }
}

// 화면이 실제로 보이고 있는지 (lrnShowScreen 은 초기화 전엔 무시하고 돌아가므로 확인)
function notifScreenVisible(id){
  const el = document.getElementById(id);
  return !!(el && !el.classList.contains('off'));
}

function notifOnScreen(id){
  if (!notifScreenVisible(id)) return;
  if (NOTIF_PLAY_SCREENS.has(id))   notifMarkStart(id);
  if (NOTIF_RESULT_SCREENS.has(id)) notifMarkDone('screen:' + id, false);
}

// 기기 시간대·언어 서버 저장 — 하루 1번
async function notifHello(){
  const sid = notifStudentId(); if (!sid) return;
  const day = notifDayLoad(sid);
  if (day.hello) return;
  let tz = 'Asia/Seoul';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch(e){}
  const lang = ((navigator.language || 'ko').slice(0, 2).toLowerCase());
  try {
    const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/rpc/notif_client_hello`, {
      method: 'POST',
      headers: {
        'apikey': GATE_SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_student_id: sid, p_tz: tz, p_lang: lang })
    });
    if (res.ok){ day.hello = true; notifDaySave(sid, day); }
  } catch(e){ /* 다음 접속 때 다시 시도 */ }
}

// ── 감싸기 ──
function notifInstall(){
  try {
    if (typeof syncProgressEvent === 'function' && !syncProgressEvent._notifWrapped){
      notifOrigSync = syncProgressEvent;
      const wrapped = function(unitId, eventType, opts){
        const ret = notifOrigSync.apply(this, arguments);   // 원래 동작 먼저, 반환값 그대로
        try { if (NOTIF_DONE_EVENT_TYPES.has(eventType)) notifMarkDone(unitId, true); } catch(e){}
        return ret;
      };
      wrapped._notifWrapped = true;
      syncProgressEvent = wrapped;
    }
    ['lrnShowScreen', 'showScreen'].forEach(name => {
      const orig = window[name];
      if (typeof orig !== 'function' || orig._notifWrapped) return;
      const wrapped = function(id){
        const ret = orig.apply(this, arguments);            // 원래 동작 먼저, 반환값 그대로
        try { notifOnScreen(id); } catch(e){}
        return ret;
      };
      wrapped._notifWrapped = true;
      window[name] = wrapped;
    });
  } catch(e){ /* 감싸기 실패 시 기록만 안 될 뿐, 앱 동작은 그대로 */ }

  // 접속코드 확인(gateBoot)이 끝나 studentId가 생기면 시간대 저장 — 최대 60초 대기
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const ready = (typeof gateState !== 'undefined') && gateState && gateState.ready;
    if (ready || tries >= 60){
      clearInterval(timer);
      if (notifStudentId()) notifHello();
    }
  }, 1000);
}

notifInstall();

// ════════════════════════════════════════════════════════════
// 알림관리 2b-2 — 오늘 할 일(today_task) 계산·저장
//   · 계산은 앱 안의 기존 진도 판정 함수를 읽기만 함 (addGate*·addStage*·divGate*) — 선수단원 체인은 앱 한 곳에만
//   · 서버 progress_state(key='today_task')에 저장 → 서버 알림(12시 지시·19시 리마인드)과 홈 카드가 같은 값을 씀
//   · 계산 시점: 부팅 후(서버 진도 로드 대기) 1회 + 기록이 나갈 때마다(조금 기다렸다가) — 내용이 바뀐 경우만 저장
//   · 나이 규칙: 서버 notif_age_track → parallel(출생년도+8년 3월 1일부터) = 덧뺄셈 매일 + 곱셈·나눗셈 번갈아
//                                    young/unknown = 덧뺄셈(초급) + 구구단
//   · 곱셈 안내 기준은 보류 중 → mult = { pending:true } 로만 저장
// ════════════════════════════════════════════════════════════
let notifAgeTrack = null;          // 'parallel' | 'young' | 'unknown' (서버값, 하루 1번 조회)
let notifTaskTimer = null;
let notifTaskLastJson = null;

async function notifLoadAgeTrack(){
  const sid = notifStudentId(); if (!sid) return null;
  try {
    const cached = JSON.parse(localStorage.getItem('notifAge_' + sid) || 'null');
    if (cached && cached.date === notifLocalDate()) return (notifAgeTrack = cached.v);
  } catch(e){}
  try {
    const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/rpc/notif_age_track`, {
      method:'POST',
      headers:{ 'apikey':GATE_SUPABASE_ANON_KEY, 'Authorization':`Bearer ${GATE_SUPABASE_ANON_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ p_student_id: sid })
    });
    if (!res.ok) return null;
    const v = await res.json();
    notifAgeTrack = (typeof v === 'string') ? v : null;
    try { localStorage.setItem('notifAge_' + sid, JSON.stringify({ date: notifLocalDate(), v: notifAgeTrack })); } catch(e){}
    return notifAgeTrack;
  } catch(e){ return null; }
}

// ── 덧뺄셈 초급 레슨 완료 기록 (2026-10-30) ──
//   레슨 완료 = 그 레슨에서 lesson_round 한 판을 합격(passed)으로 끝냄 (모드 무관)
//   출처: 서버 progress_events(부팅 때 1번) + 이번 접속에서 끝낸 판(기기에도 보관)
let notifLessonServer = null;      // Set — 서버에서 읽은 완료 레슨
let notifLessonLoading = null;
function notifLessonLocalKey(sid){ return 'notifLessonDone_' + sid; }
function notifLessonLocal(sid){
  try { return new Set(JSON.parse(localStorage.getItem(notifLessonLocalKey(sid)) || '[]')); } catch(e){ return new Set(); }
}
function notifLessonMark(unitId){
  const sid = notifStudentId(); if (!sid || typeof unitId !== 'string') return;
  const s = notifLessonLocal(sid); if (s.has(unitId)) return;
  s.add(unitId);
  try { localStorage.setItem(notifLessonLocalKey(sid), JSON.stringify([...s])); } catch(e){}
}
function notifLessonDone(unitId){
  const sid = notifStudentId(); if (!sid) return false;
  return (notifLessonServer && notifLessonServer.has(unitId)) || notifLessonLocal(sid).has(unitId);
}
function notifLoadLessons(){
  if (notifLessonServer) return Promise.resolve();
  if (notifLessonLoading) return notifLessonLoading;
  const sid = notifStudentId(); if (!sid || typeof GATE_SUPABASE_URL === 'undefined') return Promise.resolve();
  notifLessonLoading = (async () => {
    try {
      const url = `${GATE_SUPABASE_URL}/rest/v1/progress_events?student_id=eq.${sid}&event_type=eq.lesson_round`
        + `&passed=is.true&unit_id=like.add_*&select=unit_id&limit=20000`;
      const res = await fetch(url, { headers:{ 'apikey':GATE_SUPABASE_ANON_KEY, 'Authorization':`Bearer ${GATE_SUPABASE_ANON_KEY}` } });
      if (res.ok) notifLessonServer = new Set(((await res.json()) || []).map(r => r.unit_id));
    } catch(e){ /* 실패 — 기기 기록으로만 판정 */ }
    notifLessonLoading = null;
  })();
  return notifLessonLoading;
}

// 관문 테스트 앞의 레슨 묶음: 같은 목록에서 바로 앞 테스트(또는 스피드 게임) 다음부터 이 테스트 전까지
//   묶음(children)은 펼쳐서 순서대로 봄. 각 레슨에 소단원 이름(group)을 붙임
function notifBegLessons(testId){
  if (typeof ADD_SUB_UNITS === 'undefined') return [];
  for (const subKey of Object.keys(ADD_SUB_UNITS)){
    const flat = []; let group = ADD_SUB_UNITS[subKey].title || '';   // 소단원 구분이 없는 목록(1.5·1.6)은 단원 이름
    ADD_SUB_UNITS[subKey].units.forEach(u => {
      if (u.isSubSection){
        group = u.name;
        (u.children || []).forEach(c => flat.push(Object.assign({ group }, c)));
      } else flat.push(Object.assign({ group }, u));
    });
    const i = flat.findIndex(x => x.id === testId);
    if (i < 0) continue;
    const out = [];
    for (let j = i - 1; j >= 0; j--){
      const x = flat[j];
      if (x.isTest || x.isFinal || x.isSpeed) break;
      if (x.id) out.unshift({ id:x.id, name:x.name, sub:x.sub || '', group:x.group });
    }
    return out;
  }
  return [];
}

// 덧뺄셈 초급: 첫 미통과 관문(비필수 (4) 50까지 제외). 다 통과면 null
//   ① 테스트를 해 봤는데 미통과 → 테스트 "다시 도전"
//   ② 아직 안 해 봤고, 앞 레슨 중 안 한 게 있으면 → 안 한 첫 레슨으로 안내 (lesson)
//   ③ 레슨을 다 했으면 → 테스트 안내
function notifTaskAddBeginner(){
  if (typeof ADD_GATE_ORDER === 'undefined' || typeof addGatePassed !== 'function') return null;
  const SKIP = ['add_1_1_4_test'];                       // 비필수
  const u = ADD_GATE_ORDER.find(id => !SKIP.includes(id) && !addGatePassed(id));
  if (!u) return null;
  let retry = false;
  try {
    const t = ADD_GATE_TESTS[u];
    const arr = (JSON.parse(localStorage.getItem(t.hk) || '{}') || {})[t.m];
    retry = Array.isArray(arr) && arr.length > 0;        // 이미 시도했는데 아직 미통과
  } catch(e){}
  const r = { kind:'beg', unitId:u, name: addGateDisplayName(u), retry };
  if (!retry){
    const ls = notifBegLessons(u);
    const left = ls.filter(l => !notifLessonDone(l.id));
    if (ls.length){
      r.lessons = { total: ls.length, done: ls.length - left.length };
      if (left.length) r.lesson = left[0];               // { id, name, sub, group }
    }
  }
  return r;
}

function notifTaskStageItem(it){
  if (!it) return null;
  return { tier:it.tier, stage:it.stage, mode:it.mode, op:it.op, digits:it.digits, rows:it.rows, level:it.level,
           n:it.n, p:it.p, needN:it.needN, needP:it.needP, warmup: !!it.warmup, name: addStageItemName(it) };
}

function notifTaskAdd(){
  const beg = notifTaskAddBeginner();
  if (beg) return beg;
  if (typeof addStageStatus !== 'function') return null;
  const s = addStageStatus('soroban'), m = addStageStatus('mental');
  const track = st => st.done ? { done:true } : { stage: st.stage, tier: st.tier, next: notifTaskStageItem(st.next) };
  return { kind:'tier', soroban: track(s), mental: track(m), done: s.done && m.done };
}

// 나눗셈: 첫 미통과 단계. 곱셈 관문(구구단·큰 수 구구)이 먼저 필요하면 그것을 표시
function notifTaskDiv(){
  if (typeof DIV_GATE_ORDER === 'undefined' || typeof divGatePassed !== 'function') return null;
  const m = DIV_GATE_ORDER.find(x => !divGatePassed(x));
  if (!m) return { done:true };
  const need = divGateFirstUnmet(m);
  if (need && need.kind !== 'div') return { mode:m, name: divGateName(m), needFirst: need.kind };  // 'gugu' | 'bignum'
  const last = (typeof lrnProgress !== 'undefined' && lrnProgress) ? lrnProgress[`div_${m}_lastScore`] : null;
  return { mode:m, name: divGateName(m), retry: typeof last === 'number' && last < 16 };
}

// ════════════════════════════════════════════════════════════
// 곱셈 안내 (2026-11-02 확정)
//   · 구구단: 단 순서 강제 없음 — "구구단 외우기"로 안내(외운 단은 단 테스트까지), 단 테스트 통과 n/8 표시
//     8개 단 테스트 다 통과 → 전체 테스트(81)로 안내. 전체 테스트 통과(이전 방식 포함) = 구구단 완료
//   · 완료 후: 최근 7일 안에 전체 테스트 통과 기록이 없으면 전체 테스트(확인) 안내 — 아이가 원하는 날
//   · 초2(parallel)부터: 큰 수 구구(테스트 16개, 첫 미통과) → 곱셈 연습 단계(표 확정 후 — 주산·암산 트랙 분리)
//   · 나눗셈은 곱셈 연습 주산 3×1 단계 통과 후부터 안내(표 확정 전까지는 안내 안 함). 나눗셈 잠금은 그대로
//   · 초2 전(young): 덧뺄셈 초급 + 구구단(외우기·테스트·확인)만
// ════════════════════════════════════════════════════════════
const NOTIF_GUGU_DANS = [2,3,4,5,6,7,8,9];
const NOTIF_REVIEW_DAYS = 7;
let notifGuguLastServer = null;    // 서버: 전체 테스트(gugu_test) 마지막 통과 시각(ms)
let notifGuguLoading = null;
function notifLoadGuguLast(){
  if (notifGuguLastServer !== null) return Promise.resolve();
  if (notifGuguLoading) return notifGuguLoading;
  const sid = notifStudentId(); if (!sid || typeof GATE_SUPABASE_URL === 'undefined') return Promise.resolve();
  notifGuguLoading = (async () => {
    try {
      const url = `${GATE_SUPABASE_URL}/rest/v1/progress_events?student_id=eq.${sid}&unit_id=eq.gugu_test`
        + `&event_type=eq.unit_test&passed=is.true&select=created_at&order=created_at.desc&limit=1`;
      const res = await fetch(url, { headers:{ 'apikey':GATE_SUPABASE_ANON_KEY, 'Authorization':`Bearer ${GATE_SUPABASE_ANON_KEY}` } });
      if (res.ok){
        const rows = await res.json();
        notifGuguLastServer = (rows && rows[0]) ? (Date.parse(rows[0].created_at) || 0) : 0;
      }
    } catch(e){ /* 실패 — 기기 기록으로만 */ }
    notifGuguLoading = null;
  })();
  return notifGuguLoading;
}
function notifGuguHist(){
  try { return (typeof lrnProgress !== 'undefined' && lrnProgress && lrnProgress.gugu_test_history) || []; } catch(e){ return []; }
}
// 단 테스트(9문제) 통과 — 서버 'gugu_test_d{단}' / 기기 기록(scope '{단}')
function notifGuguDanPassed(d){
  try { if (typeof addGateServerSet !== 'undefined' && addGateServerSet.has(`gugu_test_d${d}|`)) return true; } catch(e){}
  return notifGuguHist().some(r => r && String(r.scope) === String(d) && (r.passed === true || (r.total > 0 && r.score >= Math.ceil(r.total * 0.8))));
}
function notifGuguLastFullPass(){
  let t = notifGuguLastServer || 0;
  notifGuguHist().forEach(r => {
    if (r && r.scope === 'all' && (r.passed === true || (r.total > 0 && r.score >= Math.ceil(r.total * 0.8))) && r.date > t) t = r.date;
  });
  return t;
}
function notifTaskGugu(){
  if (typeof multGateGuguAllPassed !== 'function') return null;
  if (!multGateGuguAllPassed()){
    const passed = NOTIF_GUGU_DANS.filter(notifGuguDanPassed).length;
    if (passed < NOTIF_GUGU_DANS.length) return { kind:'memorize', passed, total: NOTIF_GUGU_DANS.length };
    const tried = notifGuguHist().some(r => r && r.scope === 'all');
    return { kind:'full', retry: tried };
  }
  const last = notifGuguLastFullPass();
  const due = !last || (Date.now() - last) >= NOTIF_REVIEW_DAYS * 86400000;
  return { kind:'review', due, last: last || null };
}
// 큰 수 구구: 첫 미통과 테스트 (16개)
function notifTaskBignum(){
  if (typeof multGateFirstDanTest !== 'function') return null;
  const t = multGateFirstDanTest();
  if (!t) return { done:true };
  let passed = 0;
  try { MULT_GATE_DANS.forEach(d => MULT_GATE_ORDERS.forEach(o => { if (multGateDanTestPassed(d, o)) passed++; })); } catch(e){}
  return { dan: t.dan, order: t.order, passed, total: 16 };
}
// 오늘 곱셈 줄: 구구단 미완료 → 구구단 / 확인 테스트 날 → 확인 / (초2부터) 큰 수 구구 → 곱셈 연습(표 확정 후)
function notifTaskMult(parallel){
  const gugu = notifTaskGugu();
  const r = { gugu, bignum: null, practice: { pending:true }, today: null };
  if (!gugu) return r;
  if (gugu.kind !== 'review'){ r.today = 'gugu'; return r; }
  if (gugu.due){ r.today = 'review'; }
  if (parallel){
    r.bignum = notifTaskBignum();
    if (!r.today && r.bignum && !r.bignum.done) r.today = 'bignum';
  }
  return r;
}

function notifComputeTask(){
  const age = notifAgeTrack || 'unknown';
  const parallel = age === 'parallel';
  const add = notifTaskAdd();
  const mult = notifTaskMult(parallel);
  const div = parallel ? notifTaskDiv() : null;
  // 두 번째 과목: 곱셈(구구단은 나이 무관). 나눗셈은 곱셈 연습 주산 3×1 통과 후부터 번갈아 — 표 확정 전까지 안내 안 함
  const second = mult.today ? 'mult' : null;
  return { v:2, age, add, mult, div, second };
}

async function notifSaveTask(){
  const sid = notifStudentId(); if (!sid) return;
  if (notifAgeTrack === null) await notifLoadAgeTrack();
  await notifLoadLessons();
  await notifLoadGuguLast();
  let task;
  try { task = notifComputeTask(); } catch(e){ return; }
  const json = JSON.stringify(task);
  if (json === notifTaskLastJson) return;                // 바뀐 게 없으면 저장 안 함
  notifTaskLastJson = json;
  try { localStorage.setItem('notifTask_' + sid, json); } catch(e){}
  if (typeof syncProgressState === 'function')
    syncProgressState('today_task', Object.assign({ at: new Date().toISOString() }, task));
}
// 기록이 나간 뒤 기기 저장·화면 정리가 끝날 때까지 잠깐 기다렸다가 다시 계산
function notifScheduleTask(ms){
  if (notifTaskTimer) clearTimeout(notifTaskTimer);
  notifTaskTimer = setTimeout(() => { notifTaskTimer = null; notifSaveTask(); }, ms);
}
// 홈 카드(2c)·디버깅용: 지금 계산값
function notifTodayTask(){ try { return notifComputeTask(); } catch(e){ return null; } }

(function notifInstallTask(){
  try {
    if (typeof syncProgressEvent === 'function'){
      const prev = syncProgressEvent;
      const wrapped = function(unitId, eventType, opts){
        const ret = prev.apply(this, arguments);
        try { if (eventType === 'lesson_round' && opts && opts.passed && /^add_/.test(unitId)) notifLessonMark(unitId); } catch(e){}
        try { notifScheduleTask(1500); } catch(e){}
        return ret;
      };
      wrapped._notifWrapped = true;
      syncProgressEvent = wrapped;
    }
  } catch(e){}
  // 부팅: 접속코드 확인 후 서버 진도(addGateLoadServer·addStageLoadServer)가 들어올 시간을 두고 계산
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    const ready = (typeof gateState !== 'undefined') && gateState && gateState.ready;
    if (ready || tries >= 60){
      clearInterval(t);
      if (notifStudentId()) notifScheduleTask(2500);
    }
  }, 1000);
})();

// ════════════════════════════════════════════════════════════
// 알림관리 2c → "🧮 주산 놀이" (2026-11-02 개편)
//   · "오늘 할 일" 대신 "이번 시간" — 하루에 여러 단계를 나아갈 수 있게, 일(work) 느낌의 말은 쓰지 않음
//   · 박스: 🧮 주산 놀이 — ✅ 지난 시간 / 🚩 이번 시간 [시작 ▶] / ⬜ 다음 시간 (한 과목씩, 시간표 순서)
//     시간표 = 덧뺄셈(초급 또는 주산 → 암산) → 곱셈 → 나눗셈. 한 판 끝 → 한 칸 앞으로, 한 바퀴 돌면 덧뺄셈부터 다시
//   · 목표·"끝" 표시 없음(부담이 되지 않게). 음성 없음
//   · 박스와 접힌 한 줄은 홈의 메뉴 영역(제목 ~ 과목 버튼) 안에만 — 주판 영역에 겹치지 않음, 홈 배치는 그대로
//   · 펼침: 그날 처음 홈 / 알림 링크(?today=1) / 한 판 끝내고 홈에 돌아왔을 때(✅ 잘했어!). ✕·바깥 탭 → 한 줄로 접힘
//   · 다른 것(시간표에 없는 것)만 한 아이는 붙잡지 않음
// ════════════════════════════════════════════════════════════
const NOTIF_TRACK_LABEL = { beg:'덧뺄셈', soroban:'주산', mental:'암산', mult:'곱셈', div:'나눗셈' };

// today_task → 시간표 (순서대로: 덧뺄셈 → 곱셈 → 나눗셈)
function notifBuildDayItems(task){
  const items = [];
  const add = task && task.add;
  if (add && add.kind === 'beg'){
    if (add.lesson){
      // 레슨 먼저: 안 한 첫 레슨으로 (제목 = 소단원 레슨, 아래 = 그 레슨 이름 · 진행)
      const Ls = add.lesson, P = add.lessons || { done:0, total:1 };
      items.push({ track:'beg', title: `${Ls.group} 레슨`,
        sub: `${Ls.sub ? Ls.sub + ' ' : ''}${Ls.name} · 레슨 ${P.done}/${P.total}`,
        speak: `${Ls.group} 레슨`, go:{ type:'beg', unitId: Ls.id } });
    } else {
      items.push({ track:'beg', title: add.name,
        sub: add.retry ? '다시 도전!' : (add.lessons ? '레슨 끝! 이제 테스트 도전' : '테스트 도전'),
        speak: add.name.replace(/\(.*?\)/g, ''), go:{ type:'beg', unitId: add.unitId } });
    }
  } else if (add && add.kind === 'tier'){
    ['soroban','mental'].forEach(tr => {
      const t = add[tr];
      if (!t || t.done || !t.next) return;
      const it = t.next;
      const mname = it.mode === 'mental' ? '암산' : (it.mode === 'hosan' ? '보고놓기' : '불러놓기');
      const op = it.op === 'add' ? '덧셈' : '덧뺄셈';
      const dl = (typeof addTierDigitLabel === 'function') ? addTierDigitLabel(it.digits) : it.digits + '자리';
      const tierL = it.tier === 'mid' ? '중급' : '고급';
      items.push({ track: tr,
        title: `${mname} ${op} ·\u00A0${String(dl).replace(/ /g, '\u00A0')}\u00A0${it.rows}행`,   // '두 자리 2행'이 줄바꿈으로 갈라지지 않게
        sub: it.warmup ? `${tierL} 몸풀기` : `${tierL} ${it.stage}단계 · 연습 ${Math.min(it.n, it.needN)}/${it.needN} · 합격 ${Math.min(it.p, it.needP)}/${it.needP}`,
        speak: `${mname} ${op}`,
        go:{ type:'stage', item: it } });
    });
  }
  if (task && task.second === 'mult' && task.mult){
    const M = task.mult, G = M.gugu;
    if (M.today === 'gugu' && G && G.kind === 'memorize'){
      items.push({ track:'mult', title:'구구단 외우기', sub:`외운 단은 단 테스트까지! · 통과 ${G.passed}/${G.total}`,
        speak:'구구단 외우기', go:{ type:'gugu' } });
    } else if (M.today === 'gugu' && G && G.kind === 'full'){
      items.push({ track:'mult', title:'구구단 전체 테스트', sub: G.retry ? '81문제 · 다시 도전!' : '단 테스트 8개 통과! 81문제 도전',
        speak:'구구단 전체 테스트', go:{ type:'gtest' } });
    } else if (M.today === 'review'){
      items.push({ track:'mult', title:'구구단 전체 테스트', sub:'이번 주 확인 테스트 · 81문제',
        speak:'구구단 확인 테스트', go:{ type:'gtest' } });
    } else if (M.today === 'bignum' && M.bignum){
      const B = M.bignum, ol = (typeof MULT_GATE_ORDER_LABEL !== 'undefined' && MULT_GATE_ORDER_LABEL[B.order]) || '';
      items.push({ track:'mult', title:`큰 수의 구구 ${B.dan}단 테스트`, sub:`${ol} · 통과 ${B.passed}/${B.total}`,
        speak:'큰 수의 구구', go:{ type:'bignum', dan: B.dan } });
    }
  }
  if (task && task.second === 'div' && task.div && !task.div.done && !task.div.needFirst){
    items.push({ track:'div', title: task.div.name, sub: task.div.retry ? '다시 도전!' : '나눗셈 연습', speak: task.div.name, go:{ type:'div', mode: task.div.mode } });
  }
  return items;
}

// 오늘 순서(시간표) — 덧뺄셈(초급 또는 주산→암산) → 곱셈 → 나눗셈. 판마다 다시 계산(고정하지 않음)
function notifPlayItems(){
  try { return notifBuildDayItems(notifComputeTask()); } catch(e){ return []; }
}
function notifPlayKey(sid){ return 'notifPlay_' + sid; }
// 상태: { date, done:{track:true} (이번 바퀴에 한 과목), last:{title,sub,track}, opened(그날 처음 펼침), praise(끝내고 돌아옴) }
function notifPlayLoad(sid){
  let v = null;
  try { v = JSON.parse(localStorage.getItem(notifPlayKey(sid)) || 'null'); } catch(e){}
  if (!v || typeof v !== 'object') v = { last:null };
  if (v.date !== notifLocalDate()){ v.date = notifLocalDate(); v.done = {}; v.opened = false; v.praise = false; }   // 새 날 = 덧뺄셈부터
  if (!v.done) v.done = {};
  return v;
}
function notifPlaySave(sid, v){ try { localStorage.setItem(notifPlayKey(sid), JSON.stringify(v)); } catch(e){} }

// 지난 / 이번 / 다음 시간
function notifPlayView(sid){
  const items = notifPlayItems();
  const P = notifPlayLoad(sid);
  if (!items.length) return { P, cur:null, next:null, items };
  let i = items.findIndex(it => !P.done[it.track]);
  if (i < 0){ P.done = {}; notifPlaySave(sid, P); i = 0; }     // 한 바퀴 다 돌았으면 덧뺄셈부터 다시 (진도는 이미 나아간 상태)
  const cur = items[i];
  let next = items.slice(i + 1).find(it => !P.done[it.track]) || null;
  if (!next && items.length > 1 && items[0] !== cur) next = items[0];
  if (!next) next = notifPlaySameTrackNext(cur);
  return { P, cur, next, items };
}
// 과목이 하나뿐일 때 다음 시간 = 같은 과목의 다음 것(초급 레슨 묶음에서 알 수 있는 경우만)
function notifPlaySameTrackNext(cur){
  try {
    if (!cur || cur.track !== 'beg') return null;
    const task = notifComputeTask(), A = task && task.add;
    if (!A || A.kind !== 'beg') return null;
    const ls = notifBegLessons(A.unitId);
    if (A.lesson){
      const k = ls.findIndex(l => l.id === A.lesson.id);
      const after = ls.slice(k + 1).find(l => !notifLessonDone(l.id));
      if (after) return { track:'beg', title: `${after.sub ? after.sub + ' ' : ''}${after.name}` };
      return { track:'beg', title: A.name };                    // 레슨 다음 = 확인 테스트
    }
  } catch(e){}
  return null;
}

// 기록(unit_id + mode) → 아이가 알아볼 이름 — "지난 시간"에 씀
function notifUnitName(unitId, mode){
  try {
    if (typeof unitId !== 'string') return '';
    let m;
    if ((m = unitId.match(/^add_(mid|adv)_L(\d+)_(add|addsub|[a-z]+?)(?:_d(\d))?$/))){
      const tl = typeof addTierLabel === 'function' ? addTierLabel(m[1]) : '';
      const mn = mode === 'mental' ? '암산' : (mode === 'hosan' ? '보고놓기' : (mode === 'listen' ? '불러놓기' : ''));
      const op = m[3] === 'add' ? '덧셈' : '덧뺄셈';
      const dg = m[4] && typeof addTierDigitLabel === 'function' ? ' ' + addTierDigitLabel(+m[4]) : '';
      return `${tl} ${mn ? mn + ' ' : ''}${op}${dg} 레벨 ${m[2]}`.replace(/\s+/g, ' ').trim();
    }
    if (/^add_/.test(unitId)){
      if (typeof ADD_GATE_TESTS !== 'undefined' && ADD_GATE_TESTS[unitId] && typeof addGateDisplayName === 'function') return addGateDisplayName(unitId);
      if (typeof addGateLocate === 'function'){
        const loc = addGateLocate(unitId);
        if (loc && loc.u){
          let group = '';
          if (loc.group) group = loc.group.name;
          else if (loc.subKey && typeof ADD_SUB_UNITS !== 'undefined'){
            const us = ADD_SUB_UNITS[loc.subKey].units; group = ADD_SUB_UNITS[loc.subKey].title || '';
            for (let k = loc.idx; k >= 0; k--) if (us[k].isSubSection){ group = us[k].name; break; }
          }
          if (loc.u.isSpeed) return `${group ? group + ' ' : ''}스피드 게임`;
          return `${loc.u.sub ? loc.u.sub + ' ' : ''}${loc.u.name}`;
        }
      }
      return '덧뺄셈';
    }
    if (unitId === 'gugu_test') return '구구단 전체 테스트';
    if ((m = unitId.match(/^gugu_test_d(\d)$/))) return `구구단 ${m[1]}단 테스트`;
    if ((m = unitId.match(/^d(\d)$/))){
      if (mode === 'count') return `${m[1]}단 거듭 더하기`;
      if (mode === 'danFirst' || mode === 'numFirst') return `큰 수의 구구 ${m[1]}단 테스트`;
      return `구구단 ${m[1]}단`;
    }
    if ((m = unitId.match(/^mult(\d)x(\d)$/))) return `곱셈 연습 ${m[1]}자리×${m[2]}자리${mode === 'mental' ? ' (암산)' : mode === 'soroban' ? ' (주산)' : ''}`;
    if (unitId === 'division') return (typeof divGateName === 'function' ? divGateName(mode) : '나눗셈');
    if (/^flash_/.test(unitId)) return '플래시암산';
  } catch(e){}
  return '';
}
// 서버: 가장 최근에 끝낸 한 판 (기기에 지난 시간 기록이 없을 때 — 새 기기·새 설치)
let notifLastServerTried = false;
async function notifLoadLastServer(){
  if (notifLastServerTried) return; notifLastServerTried = true;
  const sid = notifStudentId(); if (!sid || typeof GATE_SUPABASE_URL === 'undefined') return;
  const P = notifPlayLoad(sid); if (P.last) return;
  try {
    const url = `${GATE_SUPABASE_URL}/rest/v1/progress_events?student_id=eq.${sid}`
      + `&event_type=in.(lesson_round,unit_test,speed_game)&select=unit_id,mode,created_at&order=created_at.desc&limit=5`;
    const res = await fetch(url, { headers:{ 'apikey':GATE_SUPABASE_ANON_KEY, 'Authorization':`Bearer ${GATE_SUPABASE_ANON_KEY}` } });
    if (!res.ok) return;
    const rows = await res.json();
    const r = (rows || []).find(x => notifUnitName(x.unit_id, x.mode));
    if (!r) return;
    const P2 = notifPlayLoad(sid);
    if (!P2.last){ P2.last = { title: notifUnitName(r.unit_id, r.mode), track:null }; notifPlaySave(sid, P2); }
  } catch(e){}
}

// 한 판 끝 → 그 과목은 이번 바퀴에서 끝, 지난 시간으로 기록 (syncProgressEvent 감싸기에서 호출)
function notifMarkTrackDone(unitId, mode){
  const sid = notifStudentId(); if (!sid || typeof unitId !== 'string') return;
  let tr = null;
  if (/^add_(mid|adv)_L/.test(unitId)){
    const st = (typeof addTierState !== 'undefined') ? addTierState : null;
    tr = (st && st.mode === 'mental') ? 'mental' : 'soroban';
  } else if (/^add_/.test(unitId)) tr = 'beg';
  else if (unitId === 'division') tr = 'div';
  else if (/^(gugu_test|d\d|mult\d)/.test(unitId)) tr = 'mult';   // 구구단 테스트·큰 수 구구·곱셈 연습
  const P = notifPlayLoad(sid);
  const name = notifUnitName(unitId, mode);
  if (name) P.last = { title: name, track: tr };                 // 지난 시간 = 방금 끝낸 것 (시간표 밖의 것도)
  const items = notifPlayItems();
  const it = tr ? items.find(x => x.track === tr) : null;
  if (it){                                                       // 시간표에 있는 과목이면 한 칸 앞으로 + 잘했어
    P.done[tr] = true;
    P.praise = true;
    if (items.every(x => P.done[x.track])) P.done = {};          // 한 바퀴 끝 → 다음 바퀴 (목표·끝 표시는 하지 않음)
  }
  notifPlaySave(sid, P);
}

// 메뉴 화면 영역(제목 ~ 과목 버튼) — 주판 영역에는 절대 겹치지 않게
function notifMenuRect(){
  const scr = document.getElementById('scr-sel');
  const t = document.getElementById('sel-title'), s = document.getElementById('sel-sub'), m = document.getElementById('home-menu');
  const aba = document.getElementById('home-aba-wrap');
  if (!scr || !t || !m) return null;
  const R = scr.getBoundingClientRect(), rt = t.getBoundingClientRect(), rs = (s || t).getBoundingClientRect(), rm = m.getBoundingClientRect();
  const limit = aba ? aba.getBoundingClientRect().top : rm.bottom;
  return { R, top: rt.top - R.top, subBottom: rs.bottom - R.top, menuTop: rm.top - R.top, bottom: Math.min(rm.bottom, limit) - R.top, width: R.width };
}

function notifInjectCss(){
  if (document.getElementById('notif-today-css')) return;
  const st = document.createElement('style'); st.id = 'notif-today-css';
  st.textContent = `
#notif-play-catch{position:absolute;inset:0;z-index:8990;background:rgba(0,0,0,.35);}
#notif-play-box{position:absolute;z-index:9000;left:50%;transform:translateX(-50%);box-sizing:border-box;overflow-y:auto;
 width:min(420px,calc(100% - 24px));padding:12px 12px 10px;border-radius:16px;
 background:linear-gradient(180deg,rgba(74,46,18,.98),rgba(42,26,10,.98));border:2px solid rgba(255,217,138,.6);
 box-shadow:0 4px 18px rgba(0,0,0,.55);font-family:'Noto Sans KR',sans-serif;color:#FFD98A;}
#notif-play-box .np-h{font-size:17px;font-weight:800;margin:0 40px 8px 2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
#notif-play-box .np-h small{font-size:13px;font-weight:700;color:#7EE2A0;}
#notif-play-box .np-x{position:absolute;top:8px;right:8px;width:34px;height:34px;border-radius:17px;border:1.5px solid rgba(255,217,138,.45);
 background:rgba(0,0,0,.3);color:#FFD98A;font-size:18px;font-weight:800;line-height:30px;text-align:center;cursor:pointer;padding:0;}
#notif-play-box .np-row{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-top:6px;border-radius:12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,217,138,.2);}
#notif-play-box .np-row.now{background:rgba(0,0,0,.38);border:1.5px solid rgba(255,217,138,.65);padding:10px;}
#notif-play-box .np-row.past,#notif-play-box .np-row.later{opacity:.72;}
#notif-play-box .np-when{font-size:12px;font-weight:800;white-space:nowrap;min-width:64px;color:rgba(255,217,138,.85);}
#notif-play-box .np-tag{font-size:11.5px;font-weight:700;padding:2px 7px;border-radius:8px;background:#3AB86A;color:#08200F;white-space:nowrap;}
#notif-play-box .np-tag.mental{background:#5AA8FF;color:#071a33;}
#notif-play-box .np-tag.beg{background:#FFB84D;color:#2a1600;}
#notif-play-box .np-tag.mult{background:#5AE0B0;color:#062018;}
#notif-play-box .np-tag.div{background:#C58BFF;color:#1d0833;}
#notif-play-box .np-txt{flex:1;min-width:0;word-break:keep-all;overflow-wrap:anywhere;font-size:14px;font-weight:700;color:#FFE9C2;line-height:1.3;}
#notif-play-box .np-row.now .np-txt{font-size:15px;}
#notif-play-box .np-txt small{display:block;font-size:11.5px;font-weight:500;color:rgba(255,217,138,.75);margin-top:2px;}
#notif-play-box .np-go{font-family:inherit;font-size:15px;font-weight:800;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;
 background:linear-gradient(180deg,#5AE08A,#2E9A55);color:#08200F;white-space:nowrap;}
#notif-play-pill{position:absolute;z-index:8980;left:50%;transform:translateX(-50%);max-width:calc(100% - 24px);box-sizing:border-box;
 display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:18px;cursor:pointer;white-space:nowrap;overflow:hidden;
 background:rgba(42,26,10,.92);border:1.5px solid rgba(255,217,138,.55);box-shadow:0 2px 8px rgba(0,0,0,.45);
 font-family:'Noto Sans KR',sans-serif;font-size:14px;font-weight:700;color:#FFE9C2;}
#notif-play-pill b{color:#FFD98A;font-weight:800;}
#notif-play-pill span{overflow:hidden;text-overflow:ellipsis;}`;
  document.head.appendChild(st);
}

// 펼친 박스 닫기(→ 한 줄로 접힘)
function notifHidePopup(){
  ['notif-play-box','notif-play-catch'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  notifRenderPill();
}

// 접힌 한 줄 — 홈(메뉴 화면)의 제목 아래 빈 자리에만
function notifRenderPill(){
  const old = document.getElementById('notif-play-pill'); if (old) old.remove();
  const sid = notifStudentId(); if (!sid) return;
  const scr = document.getElementById('scr-sel'); if (!scr || scr.classList.contains('off')) return;
  if (document.getElementById('notif-play-box')) return;
  const V = notifPlayView(sid); if (!V.cur) return;
  const M = notifMenuRect(); if (!M) return;
  notifInjectCss();
  const pill = document.createElement('div'); pill.id = 'notif-play-pill';
  pill.innerHTML = `🧮 <b>이번 시간</b><span>${notifEsc(V.cur.title)}</span>▼`;
  pill.onclick = () => { try { playTick(); } catch(e){} notifShowPopup(); };
  scr.appendChild(pill);
  notifPlayPlace();
  notifPlayWatch();
}

// 위치 다시 맞추기 — 홈 배치가 늦게 정해지는 경우(글꼴 로딩·layoutSelect)를 따라감. 홈 배치 자체는 건드리지 않음
function notifPlayPlace(){
  const M = notifMenuRect(); if (!M) return;
  const pill = document.getElementById('notif-play-pill');
  if (pill){
    const h = pill.offsetHeight || 34;
    // 제목 아래 ~ 과목 버튼 위 빈 자리 가운데. 자리가 좁으면 과목 버튼 위쪽 끝에 걸치되 주판 영역으로는 내려가지 않음
    let top = M.subBottom + Math.max(4, (M.menuTop - M.subBottom - h) / 2);
    top = Math.min(top, M.bottom - h - 4);
    pill.style.top = Math.max(M.top, top) + 'px';
  }
  const box = document.getElementById('notif-play-box');
  if (box){
    box.style.top = Math.max(4, M.top) + 'px';
    box.style.maxHeight = Math.max(120, M.bottom - Math.max(4, M.top) - 4) + 'px';   // 주판 영역 위까지만
  }
}
let notifPlayWatchOn = false;
function notifPlayWatch(){
  [50, 300, 1000, 2500].forEach(ms => setTimeout(notifPlayPlace, ms));
  if (notifPlayWatchOn) return; notifPlayWatchOn = true;
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => notifPlayPlace()); } catch(e){}
  try {
    if (typeof layoutSelect === 'function' && !layoutSelect._notifWrapped){
      const orig = layoutSelect;
      const w = function(){ const r = orig.apply(this, arguments); try { setTimeout(notifPlayPlace, 30); } catch(e){} return r; };
      w._notifWrapped = true;
      window.layoutSelect = w;
    }
  } catch(e){}
  try {
    if (window.ResizeObserver){
      const ro = new ResizeObserver(() => notifPlayPlace());
      ['sel-title','sel-sub','home-menu','home-content-zone','home-aba-wrap'].forEach(id => { const e = document.getElementById(id); if (e) ro.observe(e); });
      document.querySelectorAll('#scr-sel .home-flex-spacer').forEach(e => ro.observe(e));   // 주판 크기가 정해지면서 메뉴 위치가 바뀌는 경우
    }
  } catch(e){}
}

// 펼친 박스 — 메뉴 화면 영역 안에만
function notifShowPopup(praise){
  const sid = notifStudentId(); if (!sid) return;
  const scr = document.getElementById('scr-sel'); if (!scr || scr.classList.contains('off')) return;
  const V = notifPlayView(sid); if (!V.cur) return;
  const M = notifMenuRect(); if (!M) return;
  notifInjectCss();
  ['notif-play-box','notif-play-catch','notif-play-pill'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  const catcher = document.createElement('div'); catcher.id = 'notif-play-catch';
  catcher.onclick = () => notifHidePopup();                        // 바깥 탭 → 접기
  const box = document.createElement('div'); box.id = 'notif-play-box';
  const tag = it => `<span class="np-tag ${it.track}">${NOTIF_TRACK_LABEL[it.track] || ''}</span>`;
  let html = `<div class="np-h">🧮 주산 놀이${praise ? ' <small>✅ 잘했어!</small>' : ''}</div><button class="np-x" aria-label="접기">✕</button>`;
  html += `<div class="np-row past"><span class="np-when">✅ 지난 시간</span><div class="np-txt">${V.P.last ? notifEsc(V.P.last.title) : '처음 시작! 반가워 👋'}</div></div>`;
  html += `<div class="np-row now"><span class="np-when">🚩 이번 시간</span>${tag(V.cur)}
    <div class="np-txt">${notifEsc(V.cur.title)}<small>${notifEsc(V.cur.sub || '')}</small></div>
    <button class="np-go">시작 ▶</button></div>`;
  if (V.next) html += `<div class="np-row later"><span class="np-when">⬜ 다음 시간</span>${tag(V.next)}<div class="np-txt">${notifEsc(V.next.title)}</div></div>`;
  box.innerHTML = html;
  box.querySelector('.np-x').onclick = () => { try { playTick(); } catch(e){} notifHidePopup(); };
  box.querySelector('.np-go').onclick = () => {
    try { playTick(); } catch(e){}
    ['notif-play-box','notif-play-catch'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    notifGo(V.cur);
  };
  scr.appendChild(catcher);
  scr.appendChild(box);
  notifPlayPlace();
  notifPlayWatch();
}

// 홈에 왔을 때: 접힌 한 줄은 항상, 펼치기는 ① 그날 처음 ② 알림 링크 ③ 한 판 끝내고 돌아왔을 때(잘했어!)
function notifHomeCheck(force){
  const sid = notifStudentId(); if (!sid) return;
  if (!_notifFirstListDone) return;                 // 부팅 첫 계산(서버 진도·나이·지난 시간) 전에는 띄우지 않음
  const scr = document.getElementById('scr-sel'); if (!scr || scr.classList.contains('off')) return;
  const P = notifPlayLoad(sid);
  const praise = !!P.praise;
  if (force || !P.opened || praise){
    P.opened = true; P.praise = false; notifPlaySave(sid, P);
    notifShowPopup(praise);
  } else notifRenderPill();
}

function notifEsc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 시작 ▶ — 해당 화면으로 이동 (기존 이동 함수 재사용)
function notifGo(it){
  if (!it || !it.go) return;
  try {
    if (it.go.type === 'stage' && typeof addStageGoTo === 'function') addStageGoTo(it.go.item);
    else if (it.go.type === 'beg' && typeof addGateGoTo === 'function') addGateGoTo(it.go.unitId);
    else if (it.go.type === 'gugu') lrnShowScreen('scr-dan');                       // 구구단 외우기 (단 목록)
    else if (it.go.type === 'gtest'){ openGuguTestSetup(); gtestPickScope('all', true); }   // 전체 테스트 선택된 상태
    else if (it.go.type === 'bignum'){                                               // 큰 수 구구 그 단 화면 (잠금 안내 카드와 같은 이동)
      const sel = document.getElementById('app-dan-select');
      if (sel) sel.value = String(it.go.dan);
      openMultDanHub(it.go.dan);
    }
    else if (it.go.type === 'div'){
      lrnShowScreen('scr-div');
      setTimeout(() => {
        const el = document.getElementById(DIV_GATE_WRAP[it.go.mode]);
        if (!el) return;
        try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
        el.classList.remove('addgate-flash'); void el.offsetWidth; el.classList.add('addgate-flash');
      }, 120);
    }
  } catch(e){}
}

// 알림 링크(?today=1)로 들어왔는지 — 한 번만 쓰고 주소에서 지움
const NOTIF_OPEN_FROM_LINK = (() => {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('today') !== '1') return false;
    u.searchParams.delete('today');
    history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    return true;
  } catch(e){ return false; }
})();

(function notifInstallToday(){
  try {
    // 한 판 끝 → 트랙 완료 표시
    if (typeof syncProgressEvent === 'function'){
      const prev = syncProgressEvent;
      const wrapped = function(unitId, eventType, opts){
        const ret = prev.apply(this, arguments);
        try { if (eventType !== 'activity' && eventType !== 'activity_start') notifMarkTrackDone(unitId, opts && opts.mode); } catch(e){}
        return ret;
      };
      wrapped._notifWrapped = true;
      syncProgressEvent = wrapped;
    }
    // 홈으로 돌아올 때 판단
    ['lrnShowScreen', 'showScreen'].forEach(name => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      const w = function(id){
        const ret = orig.apply(this, arguments);
        try {
          if (id === 'scr-sel') setTimeout(() => notifHomeCheck(false), 300);
          else ['notif-play-box','notif-play-catch'].forEach(x => { const e = document.getElementById(x); if (e) e.remove(); });   // 홈을 떠나면 펼친 박스는 접어 둠
        } catch(e){}
        return ret;
      };
      w._notifWrapped = true;
      window[name] = w;
    });
  } catch(e){}
})();

// 시간표 저장(notifSaveTask) 뒤 — 부팅 첫 계산 때 홈이면 펼치기, 그 뒤엔 한 줄 갱신
const _notifSaveTaskOrig = notifSaveTask;
let _notifFirstListDone = false;
notifSaveTask = async function(){
  await _notifSaveTaskOrig();
  try {
    const sid = notifStudentId(); if (!sid) return;
    if (!_notifFirstListDone){
      await notifLoadLastServer();
      _notifFirstListDone = true;                   // 새 기기면 서버의 마지막 기록으로 지난 시간 채움
      notifHomeCheck(NOTIF_OPEN_FROM_LINK);         // 앱을 연 직후 (음성 없음)
      // 화면 크기가 바뀌면(회전·액자 손잡이) 위치 다시 계산
      window.addEventListener('resize', () => setTimeout(() => {
        if (document.getElementById('notif-play-box')) notifShowPopup(false); else notifRenderPill();
      }, 200));
    } else notifRenderPill();                       // 판이 끝나 시간표가 바뀌었으면 한 줄도 갱신
  } catch(e){}
};

// ════════════════════════════════════════════════════════════
// 알림관리 6a — 서비스 워커 등록 (sw.js: 설치 가능 조건 + 푸시 받기, 캐시 없음)
//   보안 연결(https)·지원 브라우저에서만. 실패해도 앱 동작엔 영향 없음
// ════════════════════════════════════════════════════════════
(function notifRegisterSW(){
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    if (window.top !== window) return;                   // index.html(가상 폰 프레임) 안에서는 등록 안 함
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    });
    if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  } catch(e){}
})();

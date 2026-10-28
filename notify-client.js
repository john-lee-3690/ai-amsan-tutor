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

// 덧뺄셈 초급: 첫 미통과 관문(비필수 (4) 50까지 제외). 다 통과면 null
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
  return { kind:'beg', unitId:u, name: addGateDisplayName(u), retry };
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

function notifComputeTask(){
  const age = notifAgeTrack || 'unknown';
  const parallel = age === 'parallel';
  const add = notifTaskAdd();
  const div = parallel ? notifTaskDiv() : null;
  // 병행: 덧뺄셈은 매일, 곱셈·나눗셈은 하루씩 번갈아 — 곱셈 보류 중이라 지금은 나눗셈만 후보
  let second = null;
  if (parallel){
    const cands = [];
    // if (mult 안내 가능) cands.push('mult');   ← 곱셈 기준 확정 후
    if (div && !div.done) cands.push('div');
    if (cands.length){
      const dayNo = Math.floor(Date.parse(notifLocalDate() + 'T00:00:00Z') / 86400000);
      second = cands[dayNo % cands.length];
    }
  }
  return { v:1, age, add, mult:{ pending:true }, div, second };
}

async function notifSaveTask(){
  const sid = notifStudentId(); if (!sid) return;
  if (notifAgeTrack === null) await notifLoadAgeTrack();
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
      const wrapped = function(){
        const ret = prev.apply(this, arguments);
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
      if (notifStudentId()) notifScheduleTask(4000);
    }
  }, 1000);
})();

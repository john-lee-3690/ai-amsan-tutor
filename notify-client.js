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
  await notifLoadLessons();
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
// 알림관리 2c — 홈 "오늘 할 일" 팝업 (2026-10-28 확정)
//   · 따로 여는 버튼 없음. 저절로 뜨는 경우: ① 그날 처음 홈에 왔을 때 ② 알림 링크(?today=1)로 들어왔을 때
//     ③ 오늘 할 일 하나를 끝내고 홈으로 돌아왔을 때(✅ + 남은 것) ④ 다 끝내고 돌아왔을 때 "오늘 할 일 끝! 🎉" 1번
//   · 다른 것만 하고 있는 아이는 다시 붙잡지 않음
//   · 오늘 할 일 목록은 그날 처음 계산한 것으로 고정(책갈피가 판마다 움직여도 목록은 그대로)
//   · "했다" = 그 트랙에서 한 판이라도 끝까지 (주산 = 보고·불러 아무거나, 암산, 초급 = 초급 단원 아무거나, 나눗셈)
//   · ✕ 버튼 + 바깥 탭으로 닫기. 음성은 '다 끝냈을 때'만 (앱 열 때 음성 없음)
//   · 화면 위에 덮는 팝업이라 홈 메뉴·주판 위치는 바뀌지 않음
// ════════════════════════════════════════════════════════════
const NOTIF_TRACK_LABEL = { beg:'덧뺄셈', soroban:'주산', mental:'암산', div:'나눗셈' };

const NOTIF_DAYLIST_VER = 2;       // 2 = 초급 레슨 먼저 안내 (2026-10-30)
function notifDayListKey(sid){ return 'notifTodayList_' + sid; }
function notifDayListLoad(sid){
  try {
    const v = JSON.parse(localStorage.getItem(notifDayListKey(sid)) || 'null');
    if (v && v.date === notifLocalDate() && v.ver === NOTIF_DAYLIST_VER) return v;   // 목록 규칙이 바뀌면 그날 목록 새로 만듦
  } catch(e){}
  return null;
}
function notifDayListSave(sid, v){ try { localStorage.setItem(notifDayListKey(sid), JSON.stringify(v)); } catch(e){} }

// today_task → 오늘 할 일 목록(최대 3줄)
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
  if (task && task.second === 'div' && task.div && !task.div.done && !task.div.needFirst){
    items.push({ track:'div', title: task.div.name, sub: task.div.retry ? '다시 도전!' : '나눗셈 연습', speak: task.div.name, go:{ type:'div', mode: task.div.mode } });
  }
  return items;
}

// 오늘 목록 만들기(그날 처음 한 번) — notifSaveTask 뒤에 호출
function notifEnsureDayList(sid, task){
  let L = notifDayListLoad(sid);
  if (!L){
    L = { ver: NOTIF_DAYLIST_VER, date: notifLocalDate(), items: notifBuildDayItems(task), done:{}, shown:false, shownDone:{}, celebrated:false };
    notifDayListSave(sid, L);
  }
  return L;
}

// 한 판 끝 → 트랙 완료 표시 (syncProgressEvent 감싸기에서 호출 — 게스트·오프라인도 동작)
function notifMarkTrackDone(unitId){
  const sid = notifStudentId(); if (!sid) return;
  const L = notifDayListLoad(sid); if (!L) return;
  let tr = null;
  if (typeof unitId !== 'string') return;
  if (/^add_(mid|adv)_L/.test(unitId)){
    const st = (typeof addTierState !== 'undefined') ? addTierState : null;
    tr = (st && st.mode === 'mental') ? 'mental' : 'soroban';
  } else if (/^add_/.test(unitId)) tr = 'beg';
  else if (unitId === 'division') tr = 'div';
  if (!tr || L.done[tr]) return;
  if (!L.items.some(i => i.track === tr)) return;
  L.done[tr] = true;
  notifDayListSave(sid, L);
}

// 홈에 왔을 때 띄울지 판단
function notifHomeCheck(force, silent){
  const sid = notifStudentId(); if (!sid) return;
  const home = document.getElementById('scr-sel');
  if (!home || home.classList.contains('off')) return;
  const L = notifDayListLoad(sid); if (!L || !L.items.length) return;
  const allDone = L.items.every(i => L.done[i.track]);
  const newlyDone = L.items.some(i => L.done[i.track] && !L.shownDone[i.track]);
  if (force || !L.shown){
    notifShowPopup(L, !allDone ? 'first' : 'celebrate', silent);
  } else if (allDone && !L.celebrated){
    notifShowPopup(L, 'celebrate', silent);
  } else if (newlyDone){
    notifShowPopup(L, 'progress');
  } else return;
  L.shown = true;
  L.items.forEach(i => { if (L.done[i.track]) L.shownDone[i.track] = true; });
  if (allDone) L.celebrated = true;
  notifDayListSave(sid, L);
}

function notifInjectCss(){
  if (document.getElementById('notif-today-css')) return;
  const st = document.createElement('style'); st.id = 'notif-today-css';
  st.textContent = `
#notif-today-ov{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;}
#notif-today-card{position:relative;max-width:420px;width:calc(100% - 32px);padding:14px 14px 12px;border-radius:16px;
 background:linear-gradient(180deg,rgba(74,46,18,.97),rgba(42,26,10,.97));border:2px solid rgba(255,217,138,.6);
 box-shadow:0 4px 18px rgba(0,0,0,.55);font-family:'Noto Sans KR',sans-serif;color:#FFD98A;}
#notif-today-card .nt-t{font-size:17px;font-weight:800;margin:0 36px 8px 2px;display:flex;align-items:center;gap:6px;}
#notif-today-card .nt-x{position:absolute;top:8px;right:8px;width:34px;height:34px;border-radius:17px;border:1.5px solid rgba(255,217,138,.45);
 background:rgba(0,0,0,.3);color:#FFD98A;font-size:18px;font-weight:800;line-height:30px;text-align:center;cursor:pointer;padding:0;}
#notif-today-card .nt-row{display:flex;align-items:center;gap:10px;padding:9px 10px;margin-top:6px;border-radius:12px;background:rgba(0,0,0,.28);border:1px solid rgba(255,217,138,.25);}
#notif-today-card .nt-row.done{opacity:.6;}
#notif-today-card .nt-tag{font-size:12px;font-weight:700;padding:3px 8px;border-radius:8px;background:#3AB86A;color:#08200F;white-space:nowrap;}
#notif-today-card .nt-tag.mental{background:#5AA8FF;color:#071a33;}
#notif-today-card .nt-tag.beg{background:#FFB84D;color:#2a1600;}
#notif-today-card .nt-tag.div{background:#C58BFF;color:#1d0833;}
#notif-today-card .nt-txt{flex:1;font-size:14.5px;font-weight:700;color:#FFE9C2;line-height:1.3;}
#notif-today-card .nt-txt small{display:block;font-size:11.5px;font-weight:500;color:rgba(255,217,138,.75);margin-top:2px;}
#notif-today-card .nt-go{font-family:inherit;font-size:15px;font-weight:800;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;
 background:linear-gradient(180deg,#5AE08A,#2E9A55);color:#08200F;white-space:nowrap;}
#notif-today-card .nt-ok{font-size:15px;font-weight:800;padding:8px 6px;white-space:nowrap;}
#notif-today-card .nt-msg{font-size:15px;font-weight:700;color:#FFE9C2;text-align:center;padding:14px 4px 6px;}`;
  document.head.appendChild(st);
}

function notifHidePopup(){
  const ov = document.getElementById('notif-today-ov');
  if (ov) ov.remove();
}

function notifShowPopup(L, kind, silent){
  notifInjectCss();
  notifHidePopup();
  const ov = document.createElement('div'); ov.id = 'notif-today-ov';
  ov.addEventListener('click', e => { if (e.target === ov) notifHidePopup(); });   // 바깥 탭으로 닫기
  const card = document.createElement('div'); card.id = 'notif-today-card';
  const remain = L.items.filter(i => !L.done[i.track]);
  const title = kind === 'celebrate' ? '🎉 오늘 할 일 끝!' : '📌 오늘 할 일';
  let html = `<div class="nt-t">${title}</div><button class="nt-x" aria-label="닫기">✕</button>`;
  if (kind === 'celebrate') html += `<div class="nt-msg">오늘 할 일을 다 했어! 정말 잘했어 👏</div>`;
  html += L.items.map((it, idx) => {
    const done = !!L.done[it.track];
    return `<div class="nt-row${done ? ' done' : ''}">
      <span class="nt-tag ${it.track}">${NOTIF_TRACK_LABEL[it.track] || ''}</span>
      <div class="nt-txt">${notifEsc(it.title)}<small>${notifEsc(it.sub || '')}</small></div>
      ${done ? '<span class="nt-ok">✅</span>' : `<button class="nt-go" data-idx="${idx}">시작 ▶</button>`}
    </div>`;
  }).join('');
  card.innerHTML = html;
  card.querySelector('.nt-x').onclick = () => { try { playTick(); } catch(e){} notifHidePopup(); };
  card.querySelectorAll('.nt-go').forEach(b => b.onclick = () => {
    try { playTick(); } catch(e){}
    notifHidePopup();
    notifGo(L.items[+b.dataset.idx]);
  });
  ov.appendChild(card);
  document.body.appendChild(ov);
  // 음성 안내 — 다 했을 때만 (앱을 열자마자 나오는 음성은 넣지 않음, 2026-10-28 결정)
  try {
    if (!silent && kind === 'celebrate' && typeof speakKo === 'function') speakKo('오늘 할 일 끝! 정말 잘했어!');
  } catch(e){}
}

function notifEsc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 시작 ▶ — 해당 화면으로 이동 (기존 이동 함수 재사용)
function notifGo(it){
  if (!it || !it.go) return;
  try {
    if (it.go.type === 'stage' && typeof addStageGoTo === 'function') addStageGoTo(it.go.item);
    else if (it.go.type === 'beg' && typeof addGateGoTo === 'function') addGateGoTo(it.go.unitId);
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
      const wrapped = function(unitId){
        const ret = prev.apply(this, arguments);
        try { notifMarkTrackDone(unitId); } catch(e){}
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
        try { if (id === 'scr-sel') setTimeout(() => notifHomeCheck(false), 300); } catch(e){}
        return ret;
      };
      w._notifWrapped = true;
      window[name] = w;
    });
  } catch(e){}
})();

// 오늘 할 일 저장(notifSaveTask) 뒤에 목록 만들고 홈이면 띄우기 — 부팅 첫 계산 때 한 번
const _notifSaveTaskOrig = notifSaveTask;
let _notifFirstListDone = false;
notifSaveTask = async function(){
  await _notifSaveTaskOrig();
  try {
    const sid = notifStudentId(); if (!sid) return;
    const task = notifComputeTask();
    notifEnsureDayList(sid, task);
    if (!_notifFirstListDone){
      _notifFirstListDone = true;
      notifHomeCheck(NOTIF_OPEN_FROM_LINK, true);   // 앱을 연 직후 — 음성 없이
    }
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

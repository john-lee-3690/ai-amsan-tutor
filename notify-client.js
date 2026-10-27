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

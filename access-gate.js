// ============================================================
// 셈틀 access-gate.js
// 독립 네임스페이스: gate*
// 역할: URL 코드 검증 → tier/만료/진도상한 판정 → 유닛 진입 통제
// 주의: 기존 v32의 주판 동작/채점 로직은 전혀 건드리지 않음.
//       각 유닛 진입 버튼의 onclick만 gateCheckAndEnter()로 감싸서 연결.
// ============================================================

// ---- 설정: 실제 프로젝트 값으로 교체 필요 ----
const GATE_SUPABASE_URL = 'https://vuiuthguigppbqswsyta.supabase.co';
const GATE_SUPABASE_ANON_KEY = 'sb_publishable_YeqnVAg5Lb2_yBesz2UcRQ_dSPkYlLf';

// ---- 유닛별 필요 레벨 정의 (진도 순서. 새 유닛 추가 시 여기만 갱신) ----
// 값이 낮을수록 먼저 언락되는 유닛. unlocked_unit이 이 값 이상이면 접근 허용.
const GATE_UNIT_LEVELS = {
  'addsub-1.1': 1, 'addsub-1.2': 2, 'addsub-1.3': 3,
  'addsub-1.4': 4, 'addsub-1.5': 5, 'addsub-1.6': 6,
  'mult-2x2': 7, 'mult-3x1': 8,
  'division-mental': 9, 'division-abacus': 10
};

// 홍보(tier='홍보') 사용자는 레벨과 무관하게 이 유닛들만 허용
const GATE_PROMO_ALLOWED = ['addsub-1.1', 'addsub-1.2', 'addsub-1.3'];

// ---- 내부 상태 ----
let gateState = {
  ready: false,      // 검증 완료 여부
  valid: false,      // 통과 여부
  tier: null,        // '재원생' | '퇴원생' | '홍보' | 'dev'
  unlockedLevel: 0,  // GATE_UNIT_LEVELS 기준 상한
  reason: null,       // 실패 사유 (안내 문구용)
  studentId: null     // 서버 students.id — 진도 동기화 시 사용
};

// ---- 개발자 우회 모드 판정 ----
function gateIsDevMode(){
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.')) return true;
  const devkey = new URLSearchParams(location.search).get('devkey');
  return devkey === 'sk-dev-7f2c9a'; // 실제 배포 전 반드시 값 교체
}

// ---- 코드 읽기: URL 우선, 없으면 저장된 값 ----
function gateResolveCode(){
  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl) {
    localStorage.setItem('gateCode', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('gateCode');
}

// ---- Supabase REST API 직접 호출 (SDK 미사용 - 메모리/로딩 부담 최소화) ----
async function gateFetchCode(code){
  const url = `${GATE_SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code)}&select=*`;
  const res = await fetch(url, {
    headers: {
      'apikey': GATE_SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`
    }
  });
  if (!res.ok) throw new Error('gateFetchCode failed: ' + res.status);
  const rows = await res.json();
  return (rows && rows.length > 0) ? rows[0] : null;
}

async function gateUpdateCode(code, patch){
  const url = `${GATE_SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': GATE_SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
}

// ---- 기기 식별자 (기기별 고유 UUID, localStorage 저장) ----
function gateGetDeviceId(){
  let id = localStorage.getItem('gateDeviceId');
  if (!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : 'dev-'+Date.now()+'-'+Math.random().toString(36).slice(2));
    localStorage.setItem('gateDeviceId', id);
  }
  return id;
}

// ---- student_id 조회/생성 — 기기가 아니라 코드(access_codes)에 매달림 ----
// 형제자매가 태블릿을 같이 써도, 아이가 폰/태블릿을 오가도 코드만 같으면 항상 같은 student_id.
async function gateFetchOrCreateStudent(code, data){
  if (data.student_id) return data.student_id;
  // 최초 사용: 새 student 생성. 체험(홍보)은 기기 1대, 재원생/퇴원생은 2대 기본 한도.
  const maxDevices = (data.tier === '홍보') ? 1 : 2;
  const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/students`, {
    method: 'POST',
    headers: {
      'apikey': GATE_SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ max_devices: maxDevices, is_academy_student: (data.tier === '재원생') })
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const studentId = rows && rows[0] && rows[0].id;
  if (studentId){
    await gateUpdateCode(code, { student_id: studentId }); // 실패해도 다음 접속 때 재시도됨
  }
  return studentId;
}

// ---- 기기 등록 확인/등록 — 한도 초과 시 false(호출부에서 guest로 소프트 강등) ----
async function gateCheckDevice(studentId){
  const deviceId = gateGetDeviceId();
  const listRes = await fetch(
    `${GATE_SUPABASE_URL}/rest/v1/registered_devices?student_id=eq.${studentId}&select=device_id`,
    { headers: { 'apikey': GATE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}` } }
  );
  if (!listRes.ok) return true; // 조회 실패 시 차단하지 않음(네트워크 오류는 별도 처리 원칙과 일관)
  const devices = await listRes.json();

  if (devices.some(d => d.device_id === deviceId)){
    // 이미 등록된 기기 — 최근 사용 시각만 갱신(실패해도 무시, 진입엔 영향 없음)
    fetch(`${GATE_SUPABASE_URL}/rest/v1/registered_devices?student_id=eq.${studentId}&device_id=eq.${deviceId}`, {
      method: 'PATCH',
      headers: { 'apikey': GATE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ last_seen_at: new Date().toISOString() })
    }).catch(()=>{});
    return true;
  }

  const stuRes = await fetch(
    `${GATE_SUPABASE_URL}/rest/v1/students?id=eq.${studentId}&select=max_devices`,
    { headers: { 'apikey': GATE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}` } }
  );
  const stuRows = stuRes.ok ? await stuRes.json() : [];
  const maxDevices = (stuRows[0] && stuRows[0].max_devices) || 2;
  if (devices.length >= maxDevices) return false; // 한도 초과 — 새 기기 등록 거부

  await fetch(`${GATE_SUPABASE_URL}/rest/v1/registered_devices`, {
    method: 'POST',
    headers: { 'apikey': GATE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ student_id: studentId, device_id: deviceId })
  });
  return true;
}

// ════════════════════════════════════════════════════════════
// 진도 서버 동기화 — app.html의 각 저장 지점에서 호출
// 실패해도 로컬 저장(localStorage)엔 전혀 영향 없음 (fire-and-forget)
// gateState.studentId가 없으면(게스트 등) 조용히 스킵
// ════════════════════════════════════════════════════════════

// 원자료 이벤트 하나 기록 (append-only 로그) — 라운드/퀴즈/테스트 결과마다 호출
// opts: {mode, score, maxScore, wrong, elapsedSec, passed, payload}
async function syncProgressEvent(unitId, eventType, opts = {}){
  const studentId = gateState && gateState.studentId;
  if (!studentId) return;
  try {
    await fetch(`${GATE_SUPABASE_URL}/rest/v1/progress_events`, {
      method: 'POST',
      headers: {
        'apikey': GATE_SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        student_id: studentId,
        unit_id: unitId,
        event_type: eventType,
        mode: opts.mode ?? null,
        score: opts.score ?? null,
        max_score: opts.maxScore ?? null,
        wrong: opts.wrong ?? null,
        elapsed_sec: opts.elapsedSec ?? null,
        passed: opts.passed ?? null,
        payload: opts.payload ?? null
      })
    });
  } catch(e) { /* 네트워크 실패 — 로컬 저장은 이미 끝났으니 조용히 무시 */ }
}

// 최신 상태 스냅샷 upsert — lrnProgress[key]=value 저장할 때 같이 호출
async function syncProgressState(key, value){
  const studentId = gateState && gateState.studentId;
  if (!studentId) return;
  try {
    await fetch(`${GATE_SUPABASE_URL}/rest/v1/progress_state`, {
      method: 'POST',
      headers: {
        'apikey': GATE_SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ student_id: studentId, key, value })
    });
  } catch(e) { /* 조용히 무시 */ }
}

// 리포트 링크 자동 생성 — 지금은 개발자 모드 테스트 편의용.
// 실제 배포 시엔 이 함수를 직접 호출하지 말고 서버(Edge Function)에서만 발급하도록 전환할 것.
async function gateEnsureReportLink(studentId){
  const token = 'dev-' + Math.random().toString(36).slice(2, 10);
  try {
    const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/report_links`, {
      method: 'POST',
      headers: {
        'apikey': GATE_SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ token, student_id: studentId })
    });
    if (!res.ok) return null;
    return token;
  } catch(e) { return null; }
}

// ---- 메인 검증 함수: 앱 시작 시 1회 호출 ----
// 설계 원칙(2026-08): 구독 권한이 없어도 앱 진입 자체는 막지 않는다.
//   코드 없음/무효/비활성/만료 → 모두 tier='guest'로 자동 배정 → 대기실(GATE_PROMO_ALLOWED)까지 자유 이용.
//   진짜 확인 불가(네트워크 오류)일 때만 안전하게 차단(NETWORK_ERROR).
async function gateVerify(){
  if (gateIsDevMode()){
    gateState = { ready:true, valid:true, tier:'dev', unlockedLevel:999, reason:null };
    return gateState;
  }

  const code = gateResolveCode();
  if (!code){
    gateState = { ready:true, valid:true, tier:'guest', unlockedLevel:0, reason:null };
    return gateState;
  }

  try{
    const data = await gateFetchCode(code);

    if (!data){
      // 무효 코드 → 대기실 손님으로 배정 (하드 차단 안 함)
      gateState = { ready:true, valid:true, tier:'guest', unlockedLevel:0, reason:null };
      return gateState;
    }

    if (data.status !== 'active'){
      // 비활성(퇴원처리 등) → 대기실 손님으로 배정
      gateState = { ready:true, valid:true, tier:'guest', unlockedLevel:0, reason:null };
      return gateState;
    }

    // 홍보용: 최초 접속 시각 서버에 기록 + 만료일 계산
    let expiresAt = data.expires_at;
    if (data.tier === '홍보' && !data.first_used_at){
      const now = new Date();
      const exp = new Date(now.getTime() + 7*24*60*60*1000);
      expiresAt = exp.toISOString();
      await gateUpdateCode(code, { first_used_at: now.toISOString(), expires_at: expiresAt });
    }

    if (expiresAt && new Date(expiresAt) < new Date()){
      // 만료(구독 종료 등) → 대기실 손님으로 배정, 하드 차단 안 함
      gateState = { ready:true, valid:true, tier:'guest', unlockedLevel:0, reason:null };
      return gateState;
    }

    const unlockedLevel = GATE_UNIT_LEVELS[data.unlocked_unit] || 0;

    // student_id 조회/생성 + 기기 등록 확인 (실패해도 하드 차단하지 않고 guest로 소프트 강등)
    const studentId = await gateFetchOrCreateStudent(code, data);
    let deviceOk = true;
    if (studentId){
      deviceOk = await gateCheckDevice(studentId);
    }
    if (!deviceOk){
      // 기기 한도 초과 — 이 코드로는 더 이상 새 기기에서 못 들어옴, 대기실로
      gateState = { ready:true, valid:true, tier:'guest', unlockedLevel:0, reason:'DEVICE_LIMIT', studentId:null };
      return gateState;
    }

    gateState = { ready:true, valid:true, tier:data.tier, unlockedLevel, reason:null, studentId };
    return gateState;

  } catch(e){
    // 네트워크 오류 등 확인 자체가 불가능한 경우만 예외적으로 차단 (보안상 안전한 기본값)
    gateState = { ready:true, valid:false, tier:null, unlockedLevel:0, reason:'NETWORK_ERROR' };
    return gateState;
  }
}

// ---- 유닛 접근 허용 여부 판정 ----
function gateIsUnitAllowed(unitId){
  if (!gateState.valid) return false;
  if (gateState.tier === 'dev') return true;
  if (gateState.tier === '홍보' || gateState.tier === 'guest') return GATE_PROMO_ALLOWED.includes(unitId);

  const requiredLevel = GATE_UNIT_LEVELS[unitId];
  if (requiredLevel == null) return false; // 등록 안 된 유닛은 기본 차단
  return gateState.unlockedLevel >= requiredLevel;
}

// ---- 잠긴 단원 클릭 시 안내 문구 (구독 유도) ----
// TODO(추후 반영): 계좌이체 안내, 카톡 채널/연락처 링크 등 실제 전환 장치 추가 예정
function gateLockedUnitMessage(){
  return '더 배우고 싶다면 구독이 필요해요.<br>학원으로 문의해주세요.';
}

// ---- 기존 onclick="lrnShowScreen('scr-xxx')" 를
//      onclick="gateCheckAndEnter('unit-id','scr-xxx')" 로만 교체해서 사용 ----
function gateCheckAndEnter(unitId, screenId){
  if (gateIsUnitAllowed(unitId)){
    lrnShowScreen(screenId); // 기존 함수 그대로 호출, 내부 로직 무변경
  } else {
    // 잠김 안내 화면 (별도로 scr-locked 화면 하나만 HTML에 추가 필요)
    if (typeof lrnShowScreen === 'function' && document.getElementById('scr-locked')){
      const msgEl = document.getElementById('scr-locked-msg');
      if (msgEl) msgEl.innerHTML = gateLockedUnitMessage();
      lrnShowScreen('scr-locked');
    } else {
      alert('더 배우고 싶다면 구독이 필요해요. 학원으로 문의해주세요.');
    }
  }
}

// ---- 차단 사유별 안내 문구 (gate-overlay-msg에 표시) ----
function gateBlockedMessage(state){
  const msgs = {
    NO_CODE: '접속 코드가 필요합니다.<br>학원에서 받은 링크로 다시 접속해주세요.',
    INVALID_CODE: '유효하지 않은 코드입니다.<br>학원으로 문의해주세요.',
    INACTIVE: '이 코드는 더 이상 사용할 수 없습니다.<br>학원으로 문의해주세요.',
    EXPIRED: (state.tier === '재원생')
      ? '이용 기간이 만료되었습니다.<br>학원으로 문의해주세요.'
      : '체험/구독 기간이 만료되었습니다.<br>구독을 원하시면 학원으로 문의해주세요.',
    NETWORK_ERROR: '네트워크 연결을 확인해주세요.<br>잠시 후 다시 시도해주세요.'
  };
  return msgs[state.reason] || '접속할 수 없습니다.<br>학원으로 문의해주세요.';
}

// ---- 앱 시작 시 게이트 화면 제어 ----
// 사용법: body 로드 시 gateBoot() 호출 → 검증 끝나면 콜백으로 scr-sel 노출
async function gateBoot(onPass, onFail){
  await gateVerify();
  if (gateState.valid){
    onPass(gateState);
  } else {
    onFail(gateState);
  }
}

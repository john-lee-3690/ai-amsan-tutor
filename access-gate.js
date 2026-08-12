// ============================================================
// 셈틀 access-gate.js
// 독립 네임스페이스: gate*
// 역할: URL 코드 검증 → tier/만료/진도상한 판정 → 유닛 진입 통제
// 주의: 기존 v32의 주판 동작/채점 로직은 전혀 건드리지 않음.
//       각 유닛 진입 버튼의 onclick만 gateCheckAndEnter()로 감싸서 연결.
// ============================================================

// ---- 설정: 실제 프로젝트 값으로 교체 필요 ----
const GATE_SUPABASE_URL = 'https://vuiuthguigppbqswsyta.supabase.co';
const GATE_SUPABASE_ANON_KEY = '﻿sb_publishable_YeqnVAg5Lb2_yBesz2UcRQ_dSPkYlLf';

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
  reason: null        // 실패 사유 (안내 문구용)
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

// ---- 메인 검증 함수: 앱 시작 시 1회 호출 ----
async function gateVerify(){
  if (gateIsDevMode()){
    gateState = { ready:true, valid:true, tier:'dev', unlockedLevel:999, reason:null };
    return gateState;
  }

  const code = gateResolveCode();
  if (!code){
    gateState = { ready:true, valid:false, tier:null, unlockedLevel:0, reason:'NO_CODE' };
    return gateState;
  }

  try{
    const sb = supabase.createClient(GATE_SUPABASE_URL, GATE_SUPABASE_ANON_KEY);
    const { data, error } = await sb
      .from('access_codes')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (error || !data){
      gateState = { ready:true, valid:false, tier:null, unlockedLevel:0, reason:'INVALID_CODE' };
      return gateState;
    }

    if (data.status !== 'active'){
      gateState = { ready:true, valid:false, tier:data.tier, unlockedLevel:0, reason:'INACTIVE' };
      return gateState;
    }

    // 홍보용: 최초 접속 시각 서버에 기록 + 만료일 계산
    let expiresAt = data.expires_at;
    if (data.tier === '홍보' && !data.first_used_at){
      const now = new Date();
      const exp = new Date(now.getTime() + 7*24*60*60*1000);
      expiresAt = exp.toISOString();
      await sb.from('access_codes')
        .update({ first_used_at: now.toISOString(), expires_at: expiresAt })
        .eq('code', code);
    }

    if (expiresAt && new Date(expiresAt) < new Date()){
      gateState = { ready:true, valid:false, tier:data.tier, unlockedLevel:0, reason:'EXPIRED' };
      return gateState;
    }

    const unlockedLevel = GATE_UNIT_LEVELS[data.unlocked_unit] || 0;
    gateState = { ready:true, valid:true, tier:data.tier, unlockedLevel, reason:null };
    return gateState;

  } catch(e){
    // 네트워크 오류 등: 안전하게 차단 (열어주지 않음)
    gateState = { ready:true, valid:false, tier:null, unlockedLevel:0, reason:'NETWORK_ERROR' };
    return gateState;
  }
}

// ---- 유닛 접근 허용 여부 판정 ----
function gateIsUnitAllowed(unitId){
  if (!gateState.valid) return false;
  if (gateState.tier === 'dev') return true;
  if (gateState.tier === '홍보') return GATE_PROMO_ALLOWED.includes(unitId);

  const requiredLevel = GATE_UNIT_LEVELS[unitId];
  if (requiredLevel == null) return false; // 등록 안 된 유닛은 기본 차단
  return gateState.unlockedLevel >= requiredLevel;
}

// ---- 기존 onclick="lrnShowScreen('scr-xxx')" 를
//      onclick="gateCheckAndEnter('unit-id','scr-xxx')" 로만 교체해서 사용 ----
function gateCheckAndEnter(unitId, screenId){
  if (gateIsUnitAllowed(unitId)){
    lrnShowScreen(screenId); // 기존 함수 그대로 호출, 내부 로직 무변경
  } else {
    // 잠김 안내 화면 (별도로 scr-locked 화면 하나만 HTML에 추가 필요)
    if (typeof lrnShowScreen === 'function' && document.getElementById('scr-locked')){
      lrnShowScreen('scr-locked');
    } else {
      alert('아직 열리지 않은 단원입니다.');
    }
  }
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

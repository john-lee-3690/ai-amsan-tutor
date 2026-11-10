// ============================================================
// AI암산튜터 grade-client.js — 🏅 급수 도전: 급수표 · 급 판정 · 서버 저장 (2026-11-09, 1단계)
//   2단계: 급수 도전 화면(scr-grade) + 홈 버튼 (파일 아래쪽). 시험·결과·축하는 다음 단계.
//   2026-11-10: 덧뺄셈 주산·암산(16~1급)·나눗셈(14~1급) 급수표 추가, 권장 선행 여러 개 지원
//
// 규칙 (사용자 결정 — claude/급수체계_설계.md)
//   · 트랙: 덧뺄셈 주산 / 덧뺄셈 암산 / 곱셈 주산 / 곱셈 암산 / 나눗셈(암산)
//   · 한 판 합격 = 점수 ≥ 80% 그리고 제한 시간 안에 끝냄 (끝까지 풀게 두고, 시간 안에 끝냈을 때만 합격)
//   · 승급 = 그 급에서 "서로 다른 날" 합격 2번 (곱셈 주산 13급은 5번)
//   · 한 번 합격한 급은 유지. 급 번호가 작을수록 높은 급 (13급 → 1급)
//   · 중간에 나간 판은 기록하지 않음(무효) — 시험 화면이 끝까지 푼 판만 gradeRecord 호출
// 서버: supabase_grade_01.sql 의 grade_record / grade_status (anon RPC)
// 기기: gradeCache_<학생> (서버 상태 사본 — 화면을 바로 그리기 위함), gradePending_<학생> (못 보낸 기록, 다음에 다시 보냄)
// ============================================================

// 급수표 — 엑셀 "급수 체계 (전체)" 시트(2026-11-10)가 원본. 시간은 초 (덧뺄셈·나눗셈 10분은 임시값)
//   grade: { type, label, limit, count, passPct, need }   recommend: { 급: [{track, grade}] } — 권장만(막지 않음)
const GRADE_TRACKS = (() => {
  const base = v => Object.assign({ count: 20, passPct: 80, need: 2 }, v);
  // 곱셈
  const steps = (type, from, secs) => secs.map((sec, i) => [from - i, { type, limit: sec }]);
  const multBody = [
    ...steps('2x1', 12, [300, 240, 180, 120]),
    ...steps('3x1',  8, [300, 240, 180, 120]),
    ...steps('2x2',  4, [300, 240, 180, 120]),
  ];
  const mk = (list) => Object.fromEntries(list.map(([g, v]) => [g, base(v)]));
  // 덧뺄셈 (주산·암산 같은 표) — 한 판 = 덧셈 10 + 뺄셈 섞인 것 10
  const ADD = [
    [16, 'add1r2_simple',  '1위 2행 · 위아래알 단순 덧뺄셈'],
    [15, 'add1r3_simple',  '1위 3행 · 위아래알 단순 덧뺄셈'],
    [14, 'add2r2_lt50',    '2위 2행 · 결과값 50 미만의 단순 덧뺄셈'],
    [13, 'add1r2_five',    '1위 2행 · 5를 이용한 덧뺄셈'],
    [12, 'add1r2_carry',   '1위 2행 · 받아올림/내림 덧뺄셈'],
    [11, 'add1r2_fiveten', '1위 2행 · 5와 10을 이용한 덧뺄셈'],
    [10, 'add1r3_mix',     '1위 3행 · 한자리 수 종합 덧뺄셈'],
    [ 9, 'add1r4_mix',     '1위 4행 · 한자리 수 종합 덧뺄셈'],
    [ 8, 'add2r2_lt100',   '2위 2행 · 결과값 100 미만의 두자리 수 덧뺄셈'],
    [ 7, 'add2r2_gt100',   '2위 2행 · 결과값 100이 넘는 두자리 수 덧뺄셈'],
    [ 6, 'add2r3',         '2위 3행 · 두자리 수 덧뺄셈'],
    [ 5, 'add2r4',         '2위 4행 · 두자리 수 덧뺄셈'],
    [ 4, 'add3r2_lt1000',  '3위 2행 · 결과값 1000 미만의 세자리 수 덧뺄셈'],
    [ 3, 'add3r2_gt1000',  '3위 2행 · 결과값 1000이 넘는 세자리 수 덧뺄셈'],
    [ 2, 'add3r3',         '3위 3행 · 세자리 수 덧뺄셈'],
    [ 1, 'add3r4',         '3위 4행 · 세자리 수 덧뺄셈'],
  ].map(([g, type, label]) => [g, { type, label, limit: 600 }]);
  // 나눗셈 (암산)
  const DIV = [
    [14, 'div_gugu',      '곱셈구구 나눗셈 (나머지 없음) · 21÷7'],
    [13, 'div_gugu_r',    '곱셈구구 나눗셈 (나머지 있음) · 29÷7=4···1'],
    [12, 'div21_q2',      '2자리÷1자리, 몫 두 자리 · 84÷4'],
    [11, 'div21_q2_r',    '2자리÷1자리, 몫 두 자리 (나머지 있음)'],
    [10, 'div31_q2',      '3자리÷1자리, 몫 두 자리 · 441÷7'],
    [ 9, 'div31_q3',      '3자리÷1자리, 몫 세 자리 · 852÷4'],
    [ 8, 'div31_r',       '3자리÷1자리 (나머지 있음)'],
    [ 7, 'div32_q1',      '3자리÷2자리, 몫 한 자리 · 252÷36'],
    [ 6, 'div32_q2',      '3자리÷2자리, 몫 두 자리 · 864÷36'],
    [ 5, 'div32_r',       '3자리÷2자리 (나머지 있음)'],
    [ 4, 'div42',         '4자리÷2자리 (몫 두·세 자리 반반)'],
    [ 3, 'div42_r',       '4자리÷2자리 (나머지 있음)'],
    [ 2, 'div52',         '5자리÷2자리 (몫 세·네 자리 반반)'],
    [ 1, 'div52_r',       '5자리÷2자리 (나머지 있음)'],
  ].map(([g, type, label]) => [g, { type, label, limit: 600 }]);
  // 덧뺄셈 암산 권장 = 주산보다 두 급 아래 유지 → 암산 n급 ← 덧뺄셈 주산 (n-2)급 (1급 아래로는 1급)
  const addMentalRec = Object.fromEntries(ADD.map(([g]) => [g, [{ track: 'add_soroban', grade: Math.max(1, g - 2) }]]));
  return {
    add_soroban: { label: '덧뺄셈 주산', op: 'add', mode: 'soroban', grades: mk(ADD) },
    add_mental:  { label: '덧뺄셈 암산', op: 'add', mode: 'mental',  grades: mk(ADD), recommend: addMentalRec },
    mult_soroban: {
      label: '곱셈 주산', op: 'mult', mode: 'soroban',
      grades: mk([[13, { type: 'gugu20', limit: 60, need: 5 }], ...multBody]),
      recommend: { 12: [{ track: 'add_soroban', grade: 7 }] },      // 큰 수의 구구부터 = 두 자리 덧뺄셈 2행(100 넘는 것까지)
    },
    mult_mental: {
      label: '곱셈 암산', op: 'mult', mode: 'mental',
      grades: mk(multBody),
      recommend: { 12: [{ track: 'mult_soroban', grade: 10 }] },
    },
    div: {
      label: '나눗셈', op: 'div', mode: 'mental', grades: mk(DIV),
      recommend: { 14: [{ track: 'mult_soroban', grade: 8 }], 13: [{ track: 'add_soroban', grade: 7 }] },   // 13급: + 구구단 전체 테스트(5단계에서 연결)
    },
  };
})();
const GRADE_TYPE_LABEL = { gugu20: '구구단 1~9단 섞어서', '2x1': '2자리 × 1자리', '3x1': '3자리 × 1자리', '2x2': '2자리 × 2자리' };

function gradeSid(){ try { return (typeof gateState !== 'undefined' && gateState && gateState.studentId) || null; } catch(e){ return null; } }
function gradeToday(){ const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function gradeHeaders(){ return { 'apikey': GATE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${GATE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' }; }

// ── 상태 (서버 사본) ──
//   { achieved: { track: { grade: achieved_at } }, progress: { track: { grade: {days, tries, best_ms, last_date, localDays:[날짜..]} } } }
function gradeEmpty(){ return { achieved: {}, progress: {} }; }
function gradeCacheKey(sid){ return 'gradeCache_' + sid; }
function gradeState(){
  const sid = gradeSid(); if (!sid) return gradeEmpty();
  try { return JSON.parse(localStorage.getItem(gradeCacheKey(sid)) || 'null') || gradeEmpty(); } catch(e){ return gradeEmpty(); }
}
function gradeSaveState(st){ const sid = gradeSid(); if (!sid) return; try { localStorage.setItem(gradeCacheKey(sid), JSON.stringify(st)); } catch(e){} }
function gradeFromServer(js){
  const st = gradeEmpty();
  (js && js.achieved || []).forEach(a => { (st.achieved[a.track] = st.achieved[a.track] || {})[a.grade] = a.achieved_at || true; });
  (js && js.progress || []).forEach(p => { (st.progress[p.track] = st.progress[p.track] || {})[p.grade] =
    { days: p.days || 0, tries: p.tries || 0, best_ms: p.best_ms == null ? null : p.best_ms, last_date: p.last_date || null, last_pass_date: p.last_pass_date || null }; });
  return st;
}

// ── 조회 ──
// 지금 급 = 합격한 급 중 가장 높은 급(번호가 가장 작은 것), 없으면 null
function gradeCurrent(track){
  const a = gradeState().achieved[track] || {};
  const gs = Object.keys(a).map(Number);
  return gs.length ? Math.min(...gs) : null;
}
// 다음 도전할 급 = 지금 급 바로 위(번호 -1), 아직 없으면 그 트랙의 첫 급, 1급까지 다 했으면 null
function gradeNext(track){
  const T = GRADE_TRACKS[track]; if (!T) return null;
  const first = Math.max(...Object.keys(T.grades).map(Number));
  const cur = gradeCurrent(track);
  if (cur == null) return first;
  return cur > 1 ? cur - 1 : null;
}
function gradeSpec(track, grade){ const T = GRADE_TRACKS[track]; return T ? T.grades[grade] || null : null; }
function gradeProgress(track, grade){ return ((gradeState().progress[track] || {})[grade]) || { days: 0, tries: 0, best_ms: null, last_date: null }; }
// 권장 선행 — 다 채웠으면 null, 아니면 { label: "덧뺄셈 주산 7급", items: [...] }
function gradeRecommendUnmet(track, grade){
  const T = GRADE_TRACKS[track];
  let list = T && T.recommend && T.recommend[grade];
  if (!list) return null;
  if (!Array.isArray(list)) list = [list];
  const unmet = list.filter(r => { const cur = gradeCurrent(r.track); return !(cur != null && cur <= r.grade); })
                    .map(r => ({ track: r.track, grade: r.grade, label: `${GRADE_TRACKS[r.track].label} ${r.grade}급` }));
  return unmet.length ? { label: unmet.map(u => u.label).join(' · '), items: unmet } : null;
}
// 한 판 합격 판정 (앱에서 바로 보여주기용 — 서버도 같은 규칙으로 다시 판정)
function gradeJudge(track, grade, score, total, elapsedMs){
  const S = gradeSpec(track, grade); if (!S) return false;
  return score * 100 >= S.passPct * total && elapsedMs <= S.limit * 1000;
}

// ── 서버 ──
let gradeLoading = null;
function gradeLoad(){
  if (gradeLoading) return gradeLoading;
  const sid = gradeSid(); if (!sid || typeof GATE_SUPABASE_URL === 'undefined') return Promise.resolve(gradeState());
  gradeLoading = (async () => {
    await gradeFlushPending();
    try {
      const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/rpc/grade_status`, { method: 'POST', headers: gradeHeaders(), body: JSON.stringify({ p_student_id: sid }) });
      if (res.ok){ const st = gradeFromServer(await res.json()); gradeMergePendingInto(st); gradeSaveState(st); }
    } catch(e){ /* 오프라인 — 기기 사본 그대로 */ }
    gradeLoading = null;
    return gradeState();
  })();
  return gradeLoading;
}
function gradePendingKey(sid){ return 'gradePending_' + sid; }
function gradePendingList(sid){ try { return JSON.parse(localStorage.getItem(gradePendingKey(sid)) || '[]'); } catch(e){ return []; } }
function gradePendingSave(sid, list){ try { localStorage.setItem(gradePendingKey(sid), JSON.stringify(list)); } catch(e){} }
async function gradeSend(sid, rec){
  const S = gradeSpec(rec.track, rec.grade);
  const res = await fetch(`${GATE_SUPABASE_URL}/rest/v1/rpc/grade_record`, { method: 'POST', headers: gradeHeaders(), body: JSON.stringify({
    p_student_id: sid, p_track: rec.track, p_grade: rec.grade, p_score: rec.score, p_total: rec.total,
    p_elapsed_ms: Math.round(rec.elapsedMs), p_limit_ms: S.limit * 1000, p_pass_pct: S.passPct, p_need: S.need,
    p_local_date: rec.date }) });
  if (!res.ok) throw new Error('grade_record ' + res.status);
  const js = await res.json();
  if (!js || js.ok === false) throw new Error('grade_record ' + (js && js.error));
  return js;
}
async function gradeFlushPending(){
  const sid = gradeSid(); if (!sid) return;
  const list = gradePendingList(sid); if (!list.length) return;
  const left = [];
  for (const rec of list){ try { await gradeSend(sid, rec); } catch(e){ left.push(rec); } }
  gradePendingSave(sid, left);
}
// 못 보낸 기록도 기기 화면에는 반영 (합격한 날 수 계산)
function gradeMergePendingInto(st){
  const sid = gradeSid(); if (!sid) return;
  gradePendingList(sid).forEach(rec => gradeApplyLocal(st, rec, rec.date));
}
function gradeApplyLocal(st, rec, date){
  const S = gradeSpec(rec.track, rec.grade); if (!S) return { days: 0, promoted: false };
  const P = ((st.progress[rec.track] = st.progress[rec.track] || {})[rec.grade] =
    st.progress[rec.track][rec.grade] || { days: 0, tries: 0, best_ms: null, last_date: null });
  P.tries++;
  const passed = rec.score * 100 >= S.passPct * rec.total && rec.elapsedMs <= S.limit * 1000;
  if (rec.score * 100 >= S.passPct * rec.total && (P.best_ms == null || rec.elapsedMs < P.best_ms)) P.best_ms = Math.round(rec.elapsedMs);
  // 같은 날 두 번째 합격은 세지 않음 ("서로 다른 날")
  if (passed && P.last_pass_date !== date){ P.days++; P.last_pass_date = date; }
  P.last_date = date;
  const A = (st.achieved[rec.track] = st.achieved[rec.track] || {});
  let promoted = false;
  if (!A[rec.grade] && P.days >= S.need){ A[rec.grade] = new Date().toISOString(); promoted = true; }
  return { passed, days: P.days, promoted };
}

// 시험 한 판(끝까지 푼 판)을 기록 → { passed, days, need, promoted, achieved, offline }
//   서버가 되면 서버 판정, 안 되면 기기에서 같은 규칙으로 판정하고 기록은 나중에 다시 보냄
async function gradeRecord(track, grade, score, total, elapsedMs){
  const sid = gradeSid(); const S = gradeSpec(track, grade);
  if (!sid || !S) return null;
  const rec = { track, grade, score, total, elapsedMs, date: gradeToday() };
  const prevBest = gradeProgress(track, grade).best_ms;
  try {
    const js = await gradeSend(sid, rec);
    const st = gradeState();
    const P = ((st.progress[track] = st.progress[track] || {})[grade] = st.progress[track][grade] || { days: 0, tries: 0, best_ms: null, last_date: null });
    P.days = js.days; P.tries++; P.last_date = js.local_date || rec.date;
    if (js.passed) P.last_pass_date = js.local_date || rec.date;
    if (score * 100 >= S.passPct * total && (P.best_ms == null || elapsedMs < P.best_ms)) P.best_ms = Math.round(elapsedMs);
    if (js.achieved){ (st.achieved[track] = st.achieved[track] || {})[grade] = st.achieved[track][grade] || new Date().toISOString(); }
    gradeSaveState(st);
    return Object.assign({ offline: false, prevBest }, js);
  } catch(e){
    const list = gradePendingList(sid); list.push(rec); gradePendingSave(sid, list);
    const st = gradeState(); const r = gradeApplyLocal(st, rec, rec.date); gradeSaveState(st);
    return { offline: true, passed: r.passed, days: r.days, need: S.need, promoted: r.promoted, achieved: !!(st.achieved[track] || {})[grade], prevBest };
  }
}

// 앱이 켜지고 학생이 정해지면 한 번 불러옴
(function gradeBoot(){
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (gradeSid()){ clearInterval(t); gradeLoad(); }
    else if (tries > 60) clearInterval(t);
  }, 1000);
})();

// ════════════════════════════════════════════════════════════
// 2단계 (2026-11-09) — 🏅 급수 도전 화면(scr-grade) + 홈 버튼
//   · 홈: 부제목 아래 [🧮 이번 시간 ▼] 오른쪽 같은 줄에 [🏅 급수 도전] — 덮어 놓기만 함(홈 배치·주판은 그대로)
//   · 화면: 트랙마다 내 급 · 다음 도전 급과 조건 · 합격 n/2(서로 다른 날) · 최고 기록 · 권장 안내
//   · 도전은 바로 다음 급 하나만. [도전 ▶]은 3단계(시험 화면)에서 열림
// ════════════════════════════════════════════════════════════

function gradeEsc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function gradeFmtTime(ms){ const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function gradeFmtLimit(sec){ return sec % 60 === 0 ? `${sec / 60}분` : `${Math.floor(sec / 60)}분 ${sec % 60}초`; }

function gradeInjectCss(){
  if (document.getElementById('grade-css')) return;
  const st = document.createElement('style'); st.id = 'grade-css';
  st.textContent = `
#grade-home-btn{position:absolute;z-index:8980;box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:6px 12px;border-radius:18px;
 cursor:pointer;white-space:nowrap;background:rgba(42,26,10,.92);border:1.5px solid rgba(255,200,90,.75);box-shadow:0 2px 8px rgba(0,0,0,.45);
 font-family:'Noto Sans KR',sans-serif;font-size:14px;font-weight:800;color:#FFD36A;}
#scr-grade{background:var(--bp);}
#scr-grade .grade-list{flex:1;display:flex;flex-direction:column;gap:10px;padding:12px 14px 76px;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;}
#scr-grade .grade-intro{font-size:13px;line-height:1.5;color:rgba(255,232,160,.8);word-break:keep-all;padding:0 2px;}
#scr-grade .grade-card{border-radius:14px;padding:12px;background:linear-gradient(180deg,rgba(74,46,18,.95),rgba(42,26,10,.95));border:1.5px solid rgba(255,217,138,.45);color:#FFE9C2;}
#scr-grade .grade-card.soon{opacity:.5;padding:10px 12px;}
#scr-grade .gc-top{display:flex;align-items:center;gap:8px;}
#scr-grade .gc-name{font-family:'Noto Serif KR',serif;font-size:17px;font-weight:700;color:var(--go);flex:1;}
#scr-grade .gc-mine{font-size:13px;font-weight:800;padding:3px 10px;border-radius:10px;background:rgba(0,0,0,.35);color:#FFD36A;white-space:nowrap;}
#scr-grade .gc-mine.none{color:rgba(255,232,160,.6);font-weight:700;}
#scr-grade .gc-next{margin-top:10px;padding:10px;border-radius:12px;background:rgba(0,0,0,.28);border:1px solid rgba(255,217,138,.25);}
#scr-grade .gc-goal{font-size:16px;font-weight:800;color:#FFE9C2;}
#scr-grade .gc-rule{margin-top:4px;font-size:13px;line-height:1.45;color:rgba(255,232,160,.85);word-break:keep-all;}
#scr-grade .gc-prog{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:700;color:#FFE9C2;}
#scr-grade .gc-dot{width:14px;height:14px;border-radius:7px;border:1.5px solid rgba(255,217,138,.6);box-sizing:border-box;}
#scr-grade .gc-dot.on{background:#5AE08A;border-color:#5AE08A;}
#scr-grade .gc-sub{font-size:12px;font-weight:500;color:rgba(255,232,160,.7);}
#scr-grade .gc-rec{margin-top:8px;font-size:12.5px;line-height:1.45;color:#FFC98A;word-break:keep-all;}
#scr-grade .gc-go{margin-top:10px;width:100%;font-family:inherit;font-size:16px;font-weight:800;padding:10px;border-radius:12px;border:none;cursor:pointer;
 background:linear-gradient(180deg,#FFD36A,#D89838);color:#2a1600;}
#scr-grade .gc-go:disabled{background:rgba(255,255,255,.12);color:rgba(255,232,160,.55);cursor:default;}
#scr-grade .gc-done{margin-top:10px;font-size:15px;font-weight:800;color:#7EE2A0;}`;
  document.head.appendChild(st);
}

// ── 급수 도전 화면 ──
function gradeEnsureScreen(){
  let scr = document.getElementById('scr-grade');
  if (scr) return scr;
  const ref = document.getElementById('scr-mult') || document.getElementById('scr-sel');
  if (!ref || !ref.parentNode) return null;
  gradeInjectCss();
  scr = document.createElement('div'); scr.id = 'scr-grade'; scr.className = 'screen off';
  scr.innerHTML = `<div class="lrn-header"><button class="lrn-back" id="grade-back">← 뒤로</button><div class="lrn-title">🏅 급수 도전</div></div>
    <div class="grade-list" id="grade-list"></div>`;
  ref.parentNode.appendChild(scr);
  scr.querySelector('#grade-back').onclick = () => { showScreen('scr-sel'); layoutSelect(); };
  return scr;
}

function gradeCardHtml(track){
  const T = GRADE_TRACKS[track];
  const cur = gradeCurrent(track), nx = gradeNext(track);
  let h = `<div class="grade-card" data-track="${track}"><div class="gc-top"><div class="gc-name">${gradeEsc(T.label)}</div>`
        + (cur == null ? `<div class="gc-mine none">아직 급 없음</div>` : `<div class="gc-mine">내 급 ${cur}급</div>`) + `</div>`;
  if (nx == null){ return h + `<div class="gc-done">🎉 1급까지 모두 합격했어!</div></div>`; }
  const S = gradeSpec(track, nx), P = gradeProgress(track, nx);
  const need = Math.ceil(S.count * S.passPct / 100);
  const days = Math.min(P.days || 0, S.need);
  const dots = Array.from({ length: S.need }, (_, i) => `<span class="gc-dot${i < days ? ' on' : ''}"></span>`).join('');
  const passedToday = P.last_pass_date && P.last_pass_date === gradeToday();
  h += `<div class="gc-next"><div class="gc-goal">🎯 ${nx}급 도전</div>`
     + `<div class="gc-rule">${gradeEsc(S.label || GRADE_TYPE_LABEL[S.type] || S.type)} · ${S.count}문제 · ${gradeFmtLimit(S.limit)} 안에 ${need}개 이상 맞히면 합격</div>`
     + `<div class="gc-prog">합격 ${days}/${S.need} ${dots} <span class="gc-sub">(서로 다른 날)</span></div>`;
  if (P.best_ms != null) h += `<div class="gc-sub" style="margin-top:4px">내 최고 기록 ${gradeFmtTime(P.best_ms)}</div>`;
  if (passedToday) h += `<div class="gc-sub" style="margin-top:4px;color:#7EE2A0">오늘 합격했어! 다른 날 한 번 더 합격하면 돼</div>`;
  h += `</div>`;
  const rec = gradeRecommendUnmet(track, nx);
  if (rec) h += `<div class="gc-rec">💡 ${gradeEsc(rec.label)}을 먼저 합격하면 더 쉬워요 (그래도 도전할 수 있어)</div>`;
  h += (typeof gxSupported === 'function' && gxSupported(S))
    ? `<button class="gc-go" onclick="gxIntro('${track}')">도전 ▶</button></div>`
    : `<button class="gc-go" disabled>도전 ▶ (곧 열려요)</button></div>`;
  return h;
}

function gradeRenderScreen(){
  const list = document.getElementById('grade-list'); if (!list) return;
  gsInjectCss();
  let h = `<button class="gs-open" onclick="openGradeStatus()">📋 내 급수 현황</button><div class="grade-intro">바로 다음 급에 도전할 수 있어. 서로 다른 날 정해진 횟수(보통 2번)만큼 합격하면 급이 올라가! 한 번 딴 급은 그대로 남아.</div>`;
  h += Object.keys(GRADE_TRACKS).map(gradeCardHtml).join('');
  list.innerHTML = h;
}

function openGradeHome(){
  if (!gradeEnsureScreen()) return;
  gradeRenderScreen();
  lrnShowScreen('scr-grade');
  gradeLoad().then(() => { const s = document.getElementById('scr-grade'); if (s && !s.classList.contains('off')) gradeRenderScreen(); }).catch(() => {});
}

// ── 홈 버튼: [🧮 이번 시간 ▼] 오른쪽 같은 줄 (덮어 놓기만 — 홈 배치는 그대로) ──
function gradeHomeRender(){
  const scr = document.getElementById('scr-sel');
  if (!scr || !gradeSid()) return;
  gradeInjectCss();
  let btn = document.getElementById('grade-home-btn');
  if (!btn){
    btn = document.createElement('div'); btn.id = 'grade-home-btn';
    btn.innerHTML = '🏅 급수 도전'; btn.setAttribute('role', 'button');
    btn.onclick = () => openGradeHome();
    scr.appendChild(btn);
  }
  gradeHomePlace();
  gradeHomeWatch();
}
function gradeHomePlace(){
  const btn = document.getElementById('grade-home-btn'); if (!btn) return;
  const scr = document.getElementById('scr-sel'); if (!scr || scr.classList.contains('off')) return;
  const M = typeof notifMenuRect === 'function' ? notifMenuRect() : null; if (!M) return;
  const pill = document.getElementById('notif-play-pill');
  const bw = btn.offsetWidth, bh = btn.offsetHeight || 34, gap = 8;
  if (pill){
    const pw = pill.offsetWidth, ph = pill.offsetHeight || 34;
    const left = Math.max(8, (M.width - (pw + gap + bw)) / 2);
    pill.style.left = left + 'px'; pill.style.transform = 'none';     // 한 줄을 왼쪽으로 비켜 같은 줄에 나란히
    const ptop = parseFloat(pill.style.top) || 0;
    btn.style.left = (left + pw + gap) + 'px';
    btn.style.top = (ptop + (ph - bh) / 2) + 'px';
  } else {
    // 시간표 한 줄이 없을 때(또는 펼친 박스가 열려 있을 때) — 같은 자리 가운데
    let top = M.subBottom + Math.max(4, (M.menuTop - M.subBottom - bh) / 2);
    top = Math.min(top, M.bottom - bh - 4);
    btn.style.left = Math.max(8, (M.width - bw) / 2) + 'px';
    btn.style.top = Math.max(M.top, top) + 'px';
  }
}
let gradeHomeWatchOn = false;
function gradeHomeWatch(){
  [50, 300, 1000, 2500].forEach(ms => setTimeout(gradeHomePlace, ms));
  if (gradeHomeWatchOn) return; gradeHomeWatchOn = true;
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => gradeHomePlace()); } catch(e){}
  window.addEventListener('resize', () => setTimeout(gradeHomePlace, 260));
  try {
    if (window.ResizeObserver){
      const ro = new ResizeObserver(() => gradeHomePlace());
      ['sel-title','sel-sub','home-menu','home-content-zone','home-aba-wrap'].forEach(id => { const e = document.getElementById(id); if (e) ro.observe(e); });
    }
  } catch(e){}
  // 한 줄(이번 시간)이 새로 그려지거나 옮겨질 때 따라감
  try {
    const mo = new MutationObserver(() => gradeHomePlace());
    const scr = document.getElementById('scr-sel');
    if (scr) mo.observe(scr, { childList: true });
  } catch(e){}
}

// 홈으로 돌아올 때 / 앱을 켰을 때
(function gradeHomeBoot(){
  try {
    ['lrnShowScreen', 'showScreen'].forEach(name => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      const w = function(id){
        const ret = orig.apply(this, arguments);
        try { if (id === 'scr-sel') setTimeout(gradeHomeRender, 320); } catch(e){}
        return ret;
      };
      w._gradeWrapped = true;
      window[name] = w;
    });
  } catch(e){}
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (gradeSid() && document.getElementById('scr-sel')){ clearInterval(t); gradeHomeRender(); }
    else if (tries > 60) clearInterval(t);
  }, 1000);
})();

// 급수 도전 화면 터치 스크롤 — 앱 전체 touchmove가 기본 스크롤을 막아서(주판 조작용) mult-list와 같은 방식으로 직접 스크롤 (2026-11-10)
(function(){
  let startY = 0, startScroll = 0;
  document.addEventListener('touchstart', function(e){
    const el = e.target.closest && e.target.closest('#grade-list, #gs-list');
    if (!el) return;
    startY = e.touches[0].clientY;
    startScroll = el.scrollTop;
  }, { passive: true });
  document.addEventListener('touchmove', function(e){
    const el = e.target.closest && e.target.closest('#grade-list, #gs-list');
    if (!el) return;
    el.scrollTop = startScroll + (startY - e.touches[0].clientY);
    e.stopPropagation();
  }, { passive: true });
})();

// ════════════════════════════════════════════════════════════
// 3단계 (2026-11-10) — 🏅 급수 도전 시험 화면
//   규칙 (claude/급수체계_설계.md "시험 화면 규칙")
//   · 주산 트랙: 기존 학습 주판(scr-learn)으로 계산 → 문제의 [✏️] 칸을 누르면 키패드가 주판 위로 올라옴 → 답 입력
//     (주판 위치·색·민감도 그대로. 자동 판정·힌트는 시험 중에만 꺼 둠)
//   · 암산 트랙: 주판 없이 문제 + 키패드
//   · 문제마다 정오 표시 없음 / 답 없이 확인 = 틀림 / 앞 문제로 돌아가기 없음
//   · 타이머: 남은 시간 → 0 지나면 빨간 "+0:15" (끊지 않음, 시간 넘기면 불합격)
//   · 나가기: "지금 나가면 이번 판은 무효야" 확인 → 기록 없음
//   · 끝: 점수·시간·합격 여부 + 틀린 문제 (축하·급수증은 4단계)
//   이번에 여는 유형: 곱셈 2×1 · 3×1 · 2×2 (랜덤 판), 곱셈 주산 13급 구구단 섞기(2026-11-10, 키패드), 덧뺄셈 주산·암산 16~1급(가로셈·세로셈 반반), 나눗셈 14~1급(나머지 = 몫 → 나머지 차례로)
// ════════════════════════════════════════════════════════════
const GX = { on: false, track: null, grade: null, spec: null, mode: null, qs: [], idx: 0, answers: [], start: 0, timer: null, input: '' };
// 곱셈 주산 13급: 구구단 1~9단 섞어서 20문제 (같은 문제 겹치지 않게) — 외워서 푸는 문제라 주판 없이 키패드로
function gxGenGugu20(){
  const pool = [];
  for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) pool.push({ dispA: a, dispB: b, answer: a * b });
  for (let i = pool.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 20);
}
// ── 덧뺄셈 문제 (2026-11-10) — 기존 단원 문제(addGenProblems·종합 테스트 풀·flashmathGenProblems)는 가져다 쓰기만, 없는 유형만 새로 ──
//   반환: 숫자 배열 [첫 수, ±수, ...]  (뺄셈은 음수)
function gxShuf(a){ for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function gxRnd(lo, hi){ return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function gxPick(pool, n){ const seen = new Set(); const u = pool.filter(q => { const k = q.join(','); if (seen.has(k)) return false; seen.add(k); return true; }); return gxShuf(u).slice(0, n); }   // 같은 문제 겹치지 않게
function gxPoolOf(ids){ let p = []; ids.forEach(id => { try { p.push(...addGenProblems(id)); } catch(e){} }); return p; }
function gxUniq(make, n){ const seen = new Set(), out = []; let t = 0; while (out.length < n && t++ < 2000){ const q = make(); const k = q.join(','); if (!seen.has(k)){ seen.add(k); out.push(q); } } return out; }
function gxFlash(rows, digits, n, mix){
  return gxUniq(() => {
    for (let t = 0; t < 50; t++){ const q = flashmathGenSeq(rows, digits, mix ? 'mix' : 'add').nums; if (!mix || q.some(v => v < 0)) return q; }
    return flashmathGenSeq(rows, digits, 'add').nums;
  }, n);
}
const GX_ADD_GEN = {
  add1r2_simple:  () => [...gxPick(addGenProblems('add_1_2_1'), 10), ...gxPick(addGenProblems('add_1_2_2'), 10)],
  add1r3_simple:  () => gxPick(addGenProblems('add_1_2_3'), 20),
  add2r2_lt50:    () => [...gxPick(addGenProblems('add_1_1_4_1'), 10), ...gxPick(addGenProblems('add_1_1_4_2'), 10)],
  add1r2_five:    () => {                                   // 새로: 5를 이용 2행 — 덧셈 a<5,b<5,a+b≥5 / 뺄셈 5≤a≤8, b≤4, a-5<b (가능한 조합 전부 = 10 + 10)
    const A = [], S = [];
    for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) if (a + b >= 5) A.push([a, b]);
    for (let a = 5; a <= 8; a++) for (let b = 1; b <= 4; b++) if (a - 5 < b) S.push([a, -b]);
    return [...A, ...S];
  },
  add1r2_carry:   () => { const ns = [2,3,4,5,6,7,8,9,10];
    return [...gxPick(gxPoolOf(ns.map(n => `add_1_3_${n}_1`)), 10), ...gxPick(gxPoolOf(ns.map(n => `add_1_3_${n}_2`)), 10)]; },
  add1r2_fiveten: () => { const ns = [1,2,3,4];
    return [...gxPick(gxPoolOf(ns.map(n => `add_1_4_${n}_1`)), 10), ...gxPick(gxPoolOf(ns.map(n => `add_1_4_${n}_2`)), 10)]; },
  add1r3_mix:     () => [...gxPick(finalTestPool12(2), 7), ...gxPick(finalTestPool13(2), 7), ...gxPick(finalTestPool14(2), 6)],
  add1r4_mix:     () => [...gxPick(finalTestPool12(3), 7), ...gxPick(finalTestPool13(3), 7), ...gxPick(finalTestPool14(3), 6)],
  add2r2_lt100:   () => [                                   // 새로
    ...gxUniq(() => { let a, b; do { a = gxRnd(10, 89); b = gxRnd(10, 89); } while (a + b >= 100); return [a, b]; }, 10),
    ...gxUniq(() => { let a, b; do { a = gxRnd(20, 99); b = gxRnd(10, 98); } while (b >= a); return [a, -b]; }, 10)],
  add2r2_gt100:   () => [                                   // 새로: 덧셈 합 100 넘음 / 뺄셈 100 넘는 수에서 빼서 100 아래로
    ...gxUniq(() => { let a, b; do { a = gxRnd(10, 99); b = gxRnd(10, 99); } while (a + b <= 100); return [a, b]; }, 10),
    ...gxUniq(() => { let a, b; do { a = gxRnd(101, 198); b = gxRnd(10, 99); } while (a - b >= 100); return [a, -b]; }, 10)],
  add2r3:         () => [...gxFlash(3, 2, 10, false), ...gxFlash(3, 2, 10, true)],
  add2r4:         () => [...gxFlash(4, 2, 10, false), ...gxFlash(4, 2, 10, true)],
  add3r2_lt1000:  () => [                                   // 새로
    ...gxUniq(() => { let a, b; do { a = gxRnd(100, 899); b = gxRnd(100, 899); } while (a + b >= 1000); return [a, b]; }, 10),
    ...gxUniq(() => { let a, b; do { a = gxRnd(200, 999); b = gxRnd(100, 998); } while (b >= a); return [a, -b]; }, 10)],
  add3r2_gt1000:  () => [                                   // 새로: 덧셈 합 1000 넘음 / 뺄셈 1000 넘는 수에서 빼서 1000 아래로
    ...gxUniq(() => { let a, b; do { a = gxRnd(100, 999); b = gxRnd(100, 999); } while (a + b <= 1000); return [a, b]; }, 10),
    ...gxUniq(() => { let a, b; do { a = gxRnd(1001, 1998); b = gxRnd(100, 999); } while (a - b >= 1000); return [a, -b]; }, 10)],
  add3r3:         () => [...gxFlash(3, 3, 10, false), ...gxFlash(3, 3, 10, true)],
  add3r4:         () => [...gxFlash(4, 3, 10, false), ...gxFlash(4, 3, 10, true)],
};
// 덧뺄셈은 가로셈·세로셈 반반 (사용자 결정 2026-11-10)
function gxGenAdd(type){
  const qs = GX_ADD_GEN[type]().slice(0, 20).map(nums => ({ nums, ans: nums.reduce((x, y) => x + y, 0) }));
  const lay = gxShuf(qs.map((_, i) => i < Math.ceil(qs.length / 2) ? 'h' : 'v'));
  return gxShuf(qs).map((q, i) => Object.assign(q, { layout: lay[i] }));
}
// ── 나눗셈 문제 (2026-11-10) — 전부 새로 (기존 나눗셈 단원 코드는 건드리지 않음). 나머지 있는 급은 모든 문제에 나머지 ──
//   반환: { a(나뉠 수), d(나누는 수), q(몫), r(나머지) }
function gxDivMake(dLo, dHi, qLo, qHi, aLo, aHi, withR){
  for (let t = 0; t < 500; t++){
    const d = gxRnd(dLo, dHi); if (dHi > 9 && d % 10 === 0) continue;        // 두 자리로 나눌 때 몇십(20, 30…)은 빼기
    // 나누는 수를 먼저 고르고, 그 수로 가능한 몫 범위 안에서 고름 (큰 수로 나누는 문제가 덜 나오는 치우침 방지)
    const qmin = Math.max(qLo, Math.ceil((aLo - (withR ? d - 1 : 0)) / d)), qmax = Math.min(qHi, Math.floor((aHi - (withR ? 1 : 0)) / d));
    if (qmin > qmax) continue;
    const q = gxRnd(qmin, qmax), r = withR ? gxRnd(1, d - 1) : 0, a = d * q + r;
    if (a >= aLo && a <= aHi) return { a, d, q, r };
  }
  return null;
}
function gxDivSet(n, specs){   // specs: [[개수, dLo,dHi,qLo,qHi,aLo,aHi,withR], ...] — 한 판 안 같은 문제 없음
  const seen = new Set(), out = [];
  specs.forEach(([cnt, ...a]) => { let t = 0, got = 0;
    while (got < cnt && t++ < 3000){ const x = gxDivMake(...a); if (!x) continue; const k = x.a + '/' + x.d; if (seen.has(k)) continue; seen.add(k); out.push(x); got++; } });
  return gxShuf(out).slice(0, n);
}
const GX_DIV_GEN = {
  div_gugu:   () => gxDivSet(20, [[20, 2, 9, 1, 9, 1, 81, false]]),
  div_gugu_r: () => gxDivSet(20, [[20, 2, 9, 1, 9, 1, 89, true]]),
  div21_q2:   () => gxDivSet(20, [[20, 2, 9, 10, 49, 10, 99, false]]),
  div21_q2_r: () => gxDivSet(20, [[20, 2, 9, 10, 49, 10, 99, true]]),
  div31_q2:   () => gxDivSet(20, [[20, 2, 9, 12, 99, 100, 999, false]]),
  div31_q3:   () => gxDivSet(20, [[20, 2, 9, 100, 499, 100, 999, false]]),
  div31_r:    () => gxDivSet(20, [[10, 2, 9, 12, 99, 100, 999, true], [10, 2, 9, 100, 499, 100, 999, true]]),
  div32_q1:   () => gxDivSet(20, [[20, 11, 99, 2, 9, 100, 999, false]]),
  div32_q2:   () => gxDivSet(20, [[20, 11, 99, 10, 90, 100, 999, false]]),
  div32_r:    () => gxDivSet(20, [[10, 11, 99, 2, 9, 100, 999, true], [10, 11, 99, 10, 90, 100, 999, true]]),
  div42:      () => gxDivSet(20, [[10, 11, 99, 11, 99, 1000, 9999, false], [10, 11, 99, 100, 909, 1000, 9999, false]]),   // 몫 두·세 자리 반반
  div42_r:    () => gxDivSet(20, [[10, 11, 99, 11, 99, 1000, 9999, true], [10, 11, 99, 100, 909, 1000, 9999, true]]),
  div52:      () => gxDivSet(20, [[10, 11, 99, 102, 999, 10000, 99999, false], [10, 11, 99, 1000, 9090, 10000, 99999, false]]), // 몫 세·네 자리 반반
  div52_r:    () => gxDivSet(20, [[10, 11, 99, 102, 999, 10000, 99999, true], [10, 11, 99, 1000, 9090, 10000, 99999, true]]),
};
const GX_TYPES = { gugu20: gxGenGugu20, '2x1': () => genProblems2x1(20), '3x1': () => genProblems3x1(20, 1), '2x2': () => genProblems2x2(20, 1) };
const GX_KEYPAD_ONLY = { gugu20: true };   // 주산 트랙이어도 주판 없이 키패드로 (시험 규칙 1번)
function gxSupported(S){ return !!(S && (GX_TYPES[S.type] || GX_ADD_GEN[S.type] || GX_DIV_GEN[S.type]) && S.count === 20); }
function gxGen(S){
  if (GX_ADD_GEN[S.type]) return gxGenAdd(S.type);
  if (GX_DIV_GEN[S.type]) return GX_DIV_GEN[S.type]().map(x => ({ div: true, a: x.a, b: x.d, op: '÷', ans: x.q, rem: x.r, hasR: x.r > 0, layout: 'h' }));
  return GX_TYPES[S.type]().map(q => ({ a: q.dispA, b: q.dispB, op: '×', ans: q.answer }));
}
// ── 문제 그리기: 곱셈 = 가로 한 줄 / 덧뺄셈 = 가로셈(h) 또는 세로셈(v). 주어진 칸에 맞춰 글씨 크기 조절 ──
const GX_MINUS = '−';
function gxQAsk(q){ return q.nums ? q.nums.map((v, i) => i === 0 ? String(v) : (v < 0 ? ` ${GX_MINUS} ${-v}` : ` + ${v}`)).join('') : `${q.a} ${q.op} ${q.b}`; }
function gxAnsText(q){ return q.hasR ? `${q.ans} ··· ${q.rem}` : String(q.ans); }
function gxQText(q){
  if (q.nums) return q.nums.map((v, i) => i === 0 ? String(v) : (v < 0 ? ` ${GX_MINUS} ${-v}` : ` + ${v}`)).join('') + ` = ${q.ans}`;
  return `${q.a} ${q.op} ${q.b} = ${q.ans}`;
}
function gxRenderQ(el, q, availW, availH, maxFs){
  if (!el) return;
  el.style.letterSpacing = '0';
  if (q.nums && q.layout === 'v'){
    const rows = q.nums.map((v, i) => `<div class="gx-vr"><span class="gx-vs">${i === 0 ? '' : (v < 0 ? GX_MINUS : '+')}</span><span>${Math.abs(v)}</span></div>`).join('');
    el.innerHTML = `<div class="gx-v">${rows}<div class="gx-vline"></div><div class="gx-vr gx-va">${gxBlankHtml()}</div></div>`;
    const lines = q.nums.length + 1.4;
    const chars = Math.max(...q.nums.map(v => String(Math.abs(v)).length)) + 1.6;
    el.style.fontSize = Math.max(16, Math.min(maxFs, availH / (lines * 1.18), availW / (chars * 0.72))) + 'px';
  } else if (q.div && q.hasR){
    // 나머지 있는 나눗셈: 몫 칸 → 나머지 칸 차례로 (지금 넣는 칸만 id gx-blank)
    const qb = GX.stage === 'r' ? `<span class="gx-blank">${GX.qv == null ? '·' : GX.qv}</span>` : gxBlankHtml();
    const rb = GX.stage === 'r' ? gxBlankHtml() : `<span class="gx-blank empty" style="opacity:.45">□</span>`;
    const txt = `${q.a} ÷ ${q.b}`;
    el.innerHTML = `<span class="gx-hz">${txt} = ${qb}<span style="margin:0 .15em">···</span>${rb}</span>`;
    const chars = txt.length + 10;
    el.style.fontSize = Math.max(14, Math.min(maxFs, availW / (chars * 0.7), availH / 1.4)) + 'px';
  } else {
    const txt = q.nums ? q.nums.map((v, i) => i === 0 ? String(v) : (v < 0 ? ` ${GX_MINUS} ${-v}` : ` + ${v}`)).join('') : `${q.a} ${q.op} ${q.b}`;
    el.innerHTML = `<span class="gx-hz">${txt} = ${gxBlankHtml()}</span>`;   // (gx-h는 시작 안내 제목 class라 이름 겹치지 않게)
    const chars = txt.length + 5;
    el.style.fontSize = Math.max(14, Math.min(maxFs, availW / (chars * 0.6), availH / 1.4)) + 'px';
  }
  const b = el.querySelector('#gx-blank'); if (b && GX.mode !== 'soroban') b.onclick = () => gxKpOpen();
}

function gxInjectCss(){
  if (document.getElementById('gx-css')) return;
  const st = document.createElement('style'); st.id = 'gx-css';
  st.textContent = `
#scr-gexam{background:radial-gradient(ellipse at 50% 35%,#2E1408 0%,#080402 100%);}
#scr-gexam .gx-top{display:flex;align-items:center;gap:10px;padding:12px 14px 8px;border-bottom:1px solid rgba(180,100,28,.2);flex-shrink:0;}
#scr-gexam .gx-title{flex:1;font-family:'Noto Serif KR',serif;font-weight:700;color:var(--go);font-size:clamp(14px,4.6vw,18px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gx-timer{font-family:'Noto Sans KR',sans-serif;font-weight:800;font-size:15px;color:#FFE9C2;white-space:nowrap;font-variant-numeric:tabular-nums;}
.gx-timer.over{color:#FF5A5A;}
#scr-gexam .gx-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 16px;gap:12px;overflow-y:auto;font-family:'Noto Sans KR',sans-serif;color:#FFE9C2;}
#scr-gexam .gx-prog{font-size:14px;font-weight:700;color:rgba(255,232,160,.8);}
#scr-gexam .gx-eq{font-size:clamp(30px,10vw,46px);font-weight:800;color:#FFE9C2;white-space:nowrap;}
.gx-hz{white-space:nowrap;}
.gx-v{display:inline-flex;flex-direction:column;align-items:stretch;font-variant-numeric:tabular-nums;line-height:1.12;}
.gx-vr{display:flex;justify-content:flex-end;gap:.3em;white-space:nowrap;}
.gx-vs{min-width:.8em;text-align:left;margin-right:auto;}
.gx-vline{border-top:3px solid currentColor;margin:.08em 0 .12em;opacity:.8;}
.gx-va .gx-blank{margin-left:0;border-bottom:none;min-width:2em;text-align:right;}
.gx-blank{display:inline-block;min-width:2.6em;padding:0 .25em;margin-left:.15em;border-bottom:3px solid #FFD36A;color:#FFD36A;text-align:center;cursor:pointer;}
.gx-blank.empty{color:rgba(255,211,106,.55);}
/* 주산 트랙: 답 칸을 버튼처럼 (누르면 키패드) — 2026-11-10 실기기 보고 "키패드가 없네" */
.gx-blank.gx-tap{border:2px dashed #FFD36A;border-radius:.3em;padding:0 .3em;background:rgba(255,211,106,.12);font-size:.8em;line-height:1.3;animation:gxPulse 1.4s ease-in-out infinite;}
.gx-blank.gx-tap:not(.empty){border-style:solid;animation:none;font-size:1em;}
#gx-strip{margin-top:auto;width:100%;box-sizing:border-box;padding:6px 8px 8px;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;touch-action:none;}
#gx-strip .gx-k{font-family:'Noto Sans KR',sans-serif;font-size:clamp(18px,5.6vw,24px);font-weight:800;height:clamp(38px,6.2vh,50px);border-radius:10px;border:1px solid rgba(255,217,138,.3);
 background:linear-gradient(180deg,#6A4420,#4A2E14);color:#FFE9C2;padding:0;letter-spacing:0;}
#gx-strip .gx-k.ok{background:linear-gradient(180deg,#5AE08A,#2E9A55);color:#08200F;font-size:clamp(15px,4.4vw,19px);}
#gx-strip .gx-k:active{filter:brightness(1.3);}
@keyframes gxPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,211,106,.0);}50%{box-shadow:0 0 0 .18em rgba(255,211,106,.35);}}
#scr-gexam .gx-card{width:min(420px,100%);box-sizing:border-box;padding:16px;border-radius:16px;background:linear-gradient(180deg,rgba(74,46,18,.95),rgba(42,26,10,.95));border:1.5px solid rgba(255,217,138,.45);}
#scr-gexam .gx-h{font-size:20px;font-weight:800;color:var(--go);margin-bottom:8px;}
#scr-gexam .gx-p{font-size:14.5px;line-height:1.6;color:#FFE9C2;word-break:keep-all;}
#scr-gexam .gx-p small{color:rgba(255,232,160,.7);font-size:12.5px;}
#scr-gexam .gx-big{font-size:28px;font-weight:900;margin:4px 0 8px;}
#scr-gexam .gx-big.pass{color:#7EE2A0;} #scr-gexam .gx-big.fail{color:#FFC98A;}
#scr-gexam .gx-wrong{margin-top:10px;font-size:13.5px;line-height:1.7;color:#FFE9C2;}
#scr-gexam .gx-wrong b{color:#7EE2A0;} #scr-gexam .gx-wrong s{color:#FF8A8A;text-decoration:none;}
.gx-btn{font-family:'Noto Sans KR',sans-serif;font-size:17px;font-weight:800;padding:12px 18px;border-radius:12px;border:none;cursor:pointer;background:linear-gradient(180deg,#FFD36A,#D89838);color:#2a1600;}
.gx-btn.sub{background:rgba(255,255,255,.12);color:#FFE9C2;}
#gx-kp{position:fixed;left:0;right:0;bottom:0;z-index:10000;display:none;flex-direction:column;box-sizing:border-box;padding:8px 10px 10px;gap:6px;
 background:linear-gradient(180deg,#3A220E,#1E1006);border-top:2px solid rgba(255,217,138,.5);box-shadow:0 -6px 18px rgba(0,0,0,.5);touch-action:none;}
#gx-kp .gx-kp-bar{display:flex;align-items:center;gap:8px;min-height:30px;}
#gx-kp .gx-kp-val{flex:1;font-family:'Noto Sans KR',sans-serif;font-size:22px;font-weight:800;color:#FFD36A;text-align:center;}
#gx-kp .gx-kp-close{font-family:'Noto Sans KR',sans-serif;font-size:13px;font-weight:700;padding:5px 10px;border-radius:14px;border:1px solid rgba(255,217,138,.45);background:rgba(0,0,0,.3);color:#FFE9C2;}
#gx-kp .gx-kp-keys{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
#gx-kp .gx-k{font-family:'Noto Sans KR',sans-serif;font-size:clamp(20px,6.5vw,28px);font-weight:800;border-radius:12px;border:1px solid rgba(255,217,138,.3);
 background:linear-gradient(180deg,#6A4420,#4A2E14);color:#FFE9C2;padding:0;touch-action:none;}
#gx-kp .gx-k.ok{background:linear-gradient(180deg,#5AE08A,#2E9A55);color:#08200F;font-size:clamp(17px,5vw,22px);}
#gx-kp .gx-k.del{font-size:clamp(18px,5.5vw,24px);}
#gx-kp .gx-k:active{filter:brightness(1.3);}
#gx-confirm{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;}
#gx-confirm .gx-card{width:min(340px,calc(100% - 40px));text-align:center;padding:20px 16px;border-radius:16px;background:linear-gradient(180deg,rgba(74,46,18,.98),rgba(42,26,10,.98));border:2px solid rgba(255,217,138,.6);font-family:'Noto Sans KR',sans-serif;}
#gx-confirm .gx-p{font-size:16px;font-weight:700;color:#FFE9C2;line-height:1.6;word-break:keep-all;}
#gx-confirm .gx-row{display:flex;gap:10px;justify-content:center;margin-top:16px;}`;
  document.head.appendChild(st);
}

function gxEnsureScreen(){
  let scr = document.getElementById('scr-gexam');
  if (scr) return scr;
  const ref = document.getElementById('scr-mult') || document.getElementById('scr-sel');
  if (!ref || !ref.parentNode) return null;
  gxInjectCss();
  scr = document.createElement('div'); scr.id = 'scr-gexam'; scr.className = 'screen off';
  scr.innerHTML = `<div class="gx-top"><button class="lrn-back" id="gx-back">← 나가기</button><div class="gx-title" id="gx-title"></div><span class="gx-timer" id="gx-timer-m"></span></div>
    <div class="gx-body" id="gx-body"></div>`;
  ref.parentNode.appendChild(scr);
  scr.querySelector('#gx-back').onclick = () => { if (GX.on) gxAskExit(); else openGradeHome(); };
  return scr;
}

// ── 시작 안내 ──
function gxIntro(track){
  const grade = gradeNext(track), S = gradeSpec(track, grade);
  if (!gxSupported(S) || !gxEnsureScreen()) return;
  try { playTick(); } catch(e){}
  const T = GRADE_TRACKS[track], need = Math.ceil(S.count * S.passPct / 100);
  document.getElementById('gx-title').textContent = `🏅 ${T.label} ${grade}급 도전`;
  document.getElementById('gx-timer-m').textContent = '';
  document.getElementById('gx-body').innerHTML = `<div class="gx-card">
    <div class="gx-h">🎯 ${T.label} ${grade}급</div>
    <div class="gx-p">${gradeEsc(S.label || GRADE_TYPE_LABEL[S.type])} · ${S.count}문제<br>
      <b>${gradeFmtLimit(S.limit)}</b> 안에 <b>${need}개 이상</b> 맞히면 합격!<br>
      <small>${GX_KEYPAD_ONLY[S.type] ? '외운 구구단으로 바로 답을 써. 빠르게!' : T.mode === 'soroban' ? '주판으로 계산하고 ✏️ 칸을 눌러 답을 써.' : '머릿속으로 계산해서 답을 써.'}<br>
      문제마다 맞았는지는 끝나고 알려줄게. 중간에 나가면 이번 판은 무효야.</small></div>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:14px">
      <button class="gx-btn sub" id="gx-cancel">다음에</button><button class="gx-btn" id="gx-go">시작 ▶</button></div></div>`;
  document.getElementById('gx-cancel').onclick = () => openGradeHome();
  document.getElementById('gx-go').onclick = () => gxStart(track, grade);
  lrnShowScreen('scr-gexam');
}

// ── 시험 ──
function gxStart(track, grade){
  const S = gradeSpec(track, grade); if (!gxSupported(S)) return;
  Object.assign(GX, { on: true, track, grade, spec: S, mode: GX_KEYPAD_ONLY[S.type] ? 'mental' : GRADE_TRACKS[track].mode, qs: gxGen(S), idx: 0, answers: [], input: '' });
  GX.start = Date.now();
  clearInterval(GX.timer); GX.timer = setInterval(gxTick, 250);
  if (GX.mode === 'soroban'){
    try { lrnMode = 'gradeExam'; } catch(e){}               // 학습 화면 회전 처리 등이 예전 모드(mult2x1 등)로 동작하지 않게
    lrnShowScreen('scr-learn');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { multHideSubmit(); } catch(e){}
      lrnBuildAbacus(); lrnResetAbacus(true);
      const fb = document.getElementById('lrn-fb'); if (fb) fb.classList.remove('show');
      document.getElementById('lrn-hearts').innerHTML = '<span class="gx-timer" id="gx-timer-l"></span>';
      document.getElementById('lrn-ctx').textContent = `🏅 ${GRADE_TRACKS[track].label} ${grade}급`;
      gxStripEnsure();
      document.getElementById('lrn-hint').style.display = 'none';
      gxShow();
    }));
  } else {
    document.getElementById('gx-title').textContent = `🏅 ${GRADE_TRACKS[track].label} ${grade}급 도전`;
    lrnShowScreen('scr-gexam');
    gxShow();
  }
  gxTick();
}
function gxTick(){
  if (!GX.on) return;
  const left = GX.spec.limit * 1000 - (Date.now() - GX.start);
  const txt = left >= 0 ? `⏱ ${gradeFmtTime(Math.ceil(left / 1000) * 1000)}` : `⏱ +${gradeFmtTime(-left)}`;
  document.querySelectorAll('.gx-timer').forEach(el => { el.textContent = txt; el.classList.toggle('over', left < 0); });
}
function gxBlankHtml(){ const tap = false; return `<span class="gx-blank${GX.input ? '' : ' empty'}${tap ? ' gx-tap' : ''}" id="gx-blank">${GX.input || (GX.mode === 'soroban' ? '?' : '✏️')}</span>`; }
function gxShow(){
  const q = GX.qs[GX.idx], n = GX.qs.length;
  GX.input = ''; GX.stage = 'q'; GX.qv = null;
  if (GX.mode === 'soroban'){
    document.getElementById('lrn-prog-text').textContent = `${GX.idx + 1}/${n}`;
    document.getElementById('lrn-prog-fill').style.width = `${(GX.idx / n) * 100}%`;
    gxRenderSoroban();
  } else {
    document.getElementById('gx-body').innerHTML = `<div class="gx-prog">${GX.idx + 1} / ${n}</div><div class="gx-eq" id="gx-eq"></div>`;
    gxKpOpen();
    gxRenderMental();
  }
}
// 주산 트랙: 문제를 위로 올리고, 문제 칸 아래쪽에 숫자 키 두 줄을 항상 (주판은 그대로) — 2026-11-10 사용자 요청
function gxStripEnsure(){
  const prob = document.getElementById('lrn-prob'); if (!prob) return;
  prob.style.justifyContent = 'flex-start'; prob.style.paddingTop = '6px';
  let st = document.getElementById('gx-strip');
  if (!st){
    st = document.createElement('div'); st.id = 'gx-strip';
    st.innerHTML = [1,2,3,4,5,6,7,8,9,0].map(d => `<button class="gx-k" data-k="${d}">${d}</button>`).join('')
      + `<button class="gx-k del" data-k="del">⌫</button><button class="gx-k ok" data-k="ok">확인</button>`;
    st.addEventListener('touchstart', e => { e.stopPropagation(); e.preventDefault(); const b = e.target.closest('button'); if (b) gxKey(b.dataset.k); }, { passive: false });
    ['touchmove', 'touchend'].forEach(ev => st.addEventListener(ev, e => { e.stopPropagation(); e.preventDefault(); }, { passive: false }));
    st.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); gxKey(b.dataset.k); });
    st.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
  }
  prob.appendChild(st);
}
function gxStripRemove(){
  const st = document.getElementById('gx-strip'); if (st) st.remove();
  const prob = document.getElementById('lrn-prob'); if (prob){ prob.style.justifyContent = ''; prob.style.paddingTop = ''; }
}
function gxRenderSoroban(){
  const q = GX.qs[GX.idx]; if (!q) return;
  const prob = document.getElementById('lrn-prob'), ctx = document.getElementById('lrn-ctx'), st = document.getElementById('gx-strip');
  const availH = (prob ? prob.clientHeight : 200) - (ctx ? ctx.offsetHeight + 4 : 20) - (st ? st.offsetHeight : 0) - 14;
  gxRenderQ(document.getElementById('lrn-eq'), q, window.innerWidth - 28, availH, 52);
}
function gxRenderMental(){
  const q = GX.qs[GX.idx]; if (!q) return;
  const body = document.getElementById('gx-body'), kp = document.getElementById('gx-kp');
  const top = body ? body.getBoundingClientRect().top : 60;
  const bottom = kp && kp.style.display !== 'none' ? kp.getBoundingClientRect().top : window.innerHeight;
  gxRenderQ(document.getElementById('gx-eq'), q, window.innerWidth - 32, bottom - top - 60, 46);
}
function gxRefreshBlank(){
  // 화면마다 답 칸이 따로 있어서(숨은 학습 화면에 예전 칸이 남을 수 있음) 지금 화면 것만
  const b = document.querySelector(GX.mode === 'soroban' ? '#lrn-eq #gx-blank' : '#gx-eq #gx-blank'); if (b){ b.textContent = GX.input || (GX.mode === 'soroban' ? '?' : '✏️'); b.classList.toggle('empty', !GX.input); }

}

// ── 키패드 (시험 전용 — 기존 공용 키패드와 따로) ──
function gxKpEnsure(){
  let kp = document.getElementById('gx-kp'); if (kp) return kp;
  gxInjectCss();
  kp = document.createElement('div'); kp.id = 'gx-kp';
  kp.innerHTML = `<div class="gx-kp-bar"><span class="gx-kp-val" id="gx-kp-val"> </span><button class="gx-kp-close" id="gx-kp-close">▼ 주판 보기</button></div>
    <div class="gx-kp-keys">${[7,8,9,4,5,6,1,2,3].map(d => `<button class="gx-k" data-k="${d}">${d}</button>`).join('')}
    <button class="gx-k del" data-k="del">⌫</button><button class="gx-k" data-k="0">0</button><button class="gx-k ok" data-k="ok">확인</button></div>`;
  // 터치: touchstart에서 바로 처리하고 preventDefault → 뒤따르는 click이 생기지 않음
  //   (마지막 [확인]에서 키패드가 사라진 뒤 같은 자리의 다른 버튼(예: 📊 리포트)이 눌리는 문제 방지, 2026-11-10)
  const press = b => { if (b.id === 'gx-kp-close'){ gxKpHide(); return; } gxKey(b.dataset.k); };
  kp.addEventListener('touchstart', e => {
    e.stopPropagation(); e.preventDefault();
    const b = e.target.closest('button'); if (b) press(b);
  }, { passive: false });
  ['touchmove', 'touchend'].forEach(ev => kp.addEventListener(ev, e => { e.stopPropagation(); e.preventDefault(); }, { passive: false }));   // 주판·화면 터치 처리로 안 넘김
  kp.addEventListener('mousedown', e => {                    // PC(마우스)용
    const b = e.target.closest('button'); if (!b) return;
    e.preventDefault(); press(b);
  });
  kp.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
  document.body.appendChild(kp);
  return kp;
}
function gxKpOpen(){
  if (!GX.on) return;
  const kp = gxKpEnsure();
  const vh = window.innerHeight;
  let h;
  if (GX.mode === 'soroban'){
    const aw = document.getElementById('lrn-aba-wrap');
    const top = aw ? aw.getBoundingClientRect().top : vh * 0.45;
    h = Math.max(240, Math.min(vh - top, 380));            // 주판 영역을 덮음 (주판은 그대로)
  } else {
    h = Math.max(240, Math.min(Math.round(vh * 0.5), 360));
    const body = document.getElementById('gx-body'); if (body) body.style.paddingBottom = h + 'px';
  }
  kp.style.height = h + 'px';
  const bar = kp.querySelector('.gx-kp-bar'); if (bar) bar.style.display = 'none';   // 답은 문제의 답 칸에만 표시
  kp.style.display = 'flex';
  gxRefreshBlank();
}
function gxKpHide(){ const kp = document.getElementById('gx-kp'); if (kp) kp.style.display = 'none'; }
function gxKey(k){
  if (!GX.on) return;
  try { playTick(); } catch(e){}
  if (k === 'del'){
    if (GX.input === '' && GX.stage === 'r'){ GX.stage = 'q'; GX.input = GX.qv == null ? '' : String(GX.qv); GX.qv = null; return gxRenderMental(); }   // 나머지 칸이 비었을 때 ⌫ → 몫 고치기
    GX.input = GX.input.slice(0, -1);
  }
  else if (k === 'ok') return gxSubmit();
  else if (GX.input.length < 6) GX.input = (GX.input === '0' ? '' : GX.input) + k;
  gxRefreshBlank();
}
function gxSubmit(){
  const q = GX.qs[GX.idx];
  const v = GX.input === '' ? null : parseInt(GX.input, 10);
  if (q.hasR && GX.stage !== 'r'){ GX.qv = v; GX.stage = 'r'; GX.input = ''; gxRenderMental(); return; }   // 몫 → 나머지 칸으로
  if (q.hasR) GX.answers.push({ q, v: GX.qv, rv: v, ok: GX.qv === q.ans && v === q.rem });
  else GX.answers.push({ q, v, ok: v === q.ans });            // 정오 표시 없이 바로 다음
  GX.idx++;
  if (GX.idx >= GX.qs.length) return gxFinish();
  if (GX.mode === 'soroban'){ try { lrnResetAbacus(true); } catch(e){} }
  gxShow();
}

// ── 나가기 (무효) ──
function gxAskExit(){
  gxInjectCss();
  if (document.getElementById('gx-confirm')) return;
  const ov = document.createElement('div'); ov.id = 'gx-confirm';
  ov.innerHTML = `<div class="gx-card"><div class="gx-p">지금 나가면 이번 판은 무효야.<br>나갈래?</div>
    <div class="gx-row"><button class="gx-btn sub" id="gx-c-stay">계속 풀기</button><button class="gx-btn" id="gx-c-exit">나가기</button></div></div>`;
  ['touchstart', 'touchmove'].forEach(ev => ov.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
  document.body.appendChild(ov);
  ov.querySelector('#gx-c-stay').onclick = () => ov.remove();
  ov.querySelector('#gx-c-exit').onclick = () => { ov.remove(); gxCleanup(); openGradeHome(); };
}
function gxCleanup(){
  GX.on = false; clearInterval(GX.timer); GX.timer = null;
  gxKpHide();
  const body = document.getElementById('gx-body'); if (body) body.style.paddingBottom = '';
  const hint = document.getElementById('lrn-hint'); if (hint) hint.style.display = '';   // 학습 화면 원래대로
  gxStripRemove();
  document.querySelectorAll('[id="gx-blank"]').forEach(el => el.removeAttribute('id'));   // 다음 판에 예전 답 칸이 잡히지 않게
  const c = document.getElementById('gx-confirm'); if (c) c.remove();
}

// ── 끝 ──
async function gxFinish(){
  const elapsed = Date.now() - GX.start;
  const { track, grade, spec: S, answers } = GX;
  const score = answers.filter(x => x.ok).length, total = answers.length;
  const need = Math.ceil(total * S.passPct / 100);
  const prevDays = gradeProgress(track, grade).days || 0;
  gxCleanup();
  gxEnsureScreen();
  document.getElementById('gx-title').textContent = `🏅 ${GRADE_TRACKS[track].label} ${grade}급 결과`;
  document.getElementById('gx-timer-m').textContent = '';
  document.getElementById('gx-body').innerHTML = `<div class="gx-card"><div class="gx-p">채점하는 중…</div></div>`;
  lrnShowScreen('scr-gexam');
  let r = null;
  try { r = await gradeRecord(track, grade, score, total, elapsed); } catch(e){}
  const passed = r ? !!r.passed : gradeJudge(track, grade, score, total, elapsed);
  const scoreOk = score >= need, timeOk = elapsed <= S.limit * 1000;
  let head, msg;
  if (passed){
    head = `<div class="gx-big pass">✅ 합격!</div>`;
    if (r && r.promoted) msg = `🎉 <b>${grade}급</b>이 됐어! 다음은 ${grade > 1 ? (grade - 1) + '급 도전!' : '모든 급 완료!'}`;
    else if (r && r.days === prevDays) msg = `오늘은 이미 합격했어. <b>다른 날</b> 한 번 더 합격하면 돼! (합격 ${r.days}/${r.need || S.need})`;
    else msg = `합격 ${r ? r.days : prevDays + 1}/${S.need} — <b>다른 날</b> ${Math.max(0, S.need - (r ? r.days : prevDays + 1))}번 더 합격하면 ${grade}급!`;
  } else {
    head = `<div class="gx-big fail">아쉬워! 다시 도전해 봐</div>`;
    const parts = [];
    if (!scoreOk) parts.push(`${need - score}개만 더 맞히면`);
    if (!timeOk) parts.push(`시간만 ${gradeFmtTime(elapsed - S.limit * 1000)} 줄이면`);
    msg = `${score}개 맞혔어! ${parts.join(', ')} 합격이야.`;
  }
  const wrong = answers.filter(x => !x.ok);
  const wrongHtml = wrong.length ? `<div class="gx-wrong">틀린 문제<br>${wrong.map(x => `${gradeEsc(gxQAsk(x.q))} = <b>${gxAnsText(x.q)}</b> <s>(${x.v == null ? '빈칸' : x.v}${x.q.hasR ? ' ··· ' + (x.rv == null ? '빈칸' : x.rv) : ''})</s>`).join('<br>')}</div>` : '';
  document.getElementById('gx-body').innerHTML = `<div class="gx-card">${head}
    <div class="gx-p">${total}문제 중 <b>${score}개</b> 맞힘 (합격 ${need}개)<br>걸린 시간 <b>${gradeFmtTime(elapsed)}</b> (제한 ${gradeFmtLimit(S.limit)})<br>${msg}
    ${r && r.offline ? '<br><small>인터넷이 연결되면 기록을 보낼게.</small>' : ''}</div>${wrongHtml}
    <div style="text-align:center;margin-top:14px"><button class="gx-btn" id="gx-done">확인</button></div></div>`;
  document.getElementById('gx-done').onclick = () => openGradeHome();
  try { (passed ? playDing : playTick)(); } catch(e){}
}

// 시험 중에는 학습 주판의 자동 판정을 끄고, 학습 화면 ← 나가기는 무효 확인으로 (기존 함수는 그대로 두고 감쌈)
(function gxWrap(){
  try {
    const oc = lrnOnChange;
    lrnOnChange = function(){ if (GX.on && GX.mode === 'soroban') return; return oc.apply(this, arguments); };
    const ex = exitLearn;
    exitLearn = function(){ if (GX.on && GX.mode === 'soroban'){ gxAskExit(); return; } return ex.apply(this, arguments); };
  } catch(e){}
  // 화면 크기가 바뀌면(회전 등) 키패드 위치 다시
  window.addEventListener('resize', () => setTimeout(() => {
    if (GX.on){ const kp = document.getElementById('gx-kp'); if (kp && kp.style.display !== 'none') gxKpOpen();
      if (GX.mode === 'soroban') gxRenderSoroban(); else gxRenderMental(); }
  }, 400));
})();


// ════════════════════════════════════════════════════════════
// 나의 급수 현황 (2026-11-10) — 급수 도전 화면 [📋 내 급수 현황] → 한 화면에
//   덧뺄셈 창(주산·암산 칼럼) / 곱셈 창(주산·암산) / 나눗셈 창(암산 칼럼 하나)
//   칼럼마다: 내 급(메달) · 급 사다리(합격한 급 색칠, 도전 중인 급 테두리) · 도전 중 급 합격 n/필요 · 최고 기록
// ════════════════════════════════════════════════════════════
function gsInjectCss(){
  if (document.getElementById('gs-css')) return;
  const st = document.createElement('style'); st.id = 'gs-css';
  st.textContent = `
.gs-open{display:block;width:100%;font-family:'Noto Sans KR',sans-serif;font-size:15px;font-weight:800;padding:10px;border-radius:12px;cursor:pointer;
 background:rgba(255,211,106,.14);border:1.5px solid rgba(255,211,106,.6);color:#FFD36A;}
#scr-gstat{background:var(--bp);}
#gs-list{flex:1;display:flex;flex-direction:column;gap:12px;padding:12px 12px 76px;overflow-y:auto;touch-action:pan-y;font-family:'Noto Sans KR',sans-serif;color:#FFE9C2;}
#scr-gstat .gs-panel{border-radius:14px;padding:10px;background:linear-gradient(180deg,rgba(74,46,18,.95),rgba(42,26,10,.95));border:1.5px solid rgba(255,217,138,.45);}
#scr-gstat .gs-ptitle{font-family:'Noto Serif KR',serif;font-size:17px;font-weight:700;color:var(--go);margin:0 2px 8px;}
#scr-gstat .gs-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
#scr-gstat .gs-cols.one{grid-template-columns:1fr;}
#scr-gstat .gs-col{border-radius:12px;padding:8px;background:rgba(0,0,0,.28);border:1px solid rgba(255,217,138,.2);min-width:0;}
#scr-gstat .gs-cname{font-size:13px;font-weight:700;color:rgba(255,232,160,.75);text-align:center;}
#scr-gstat .gs-medal{text-align:center;font-size:22px;font-weight:900;color:#FFD36A;margin:2px 0 6px;white-space:nowrap;}
#scr-gstat .gs-medal.none{font-size:14px;font-weight:700;color:rgba(255,232,160,.55);padding:6px 0;}
#scr-gstat .gs-ladder{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;}
#scr-gstat .gs-cols.one .gs-ladder{grid-template-columns:repeat(7,1fr);}
#scr-gstat .gs-cell{font-size:12px;font-weight:800;text-align:center;padding:5px 0;border-radius:7px;background:rgba(255,255,255,.06);color:rgba(255,232,160,.4);border:1.5px solid transparent;}
#scr-gstat .gs-cell.got{background:linear-gradient(180deg,#FFD36A,#D89838);color:#2a1600;}
#scr-gstat .gs-cell.now{border-color:#7EE2A0;color:#7EE2A0;}
#scr-gstat .gs-info{margin-top:6px;font-size:12px;line-height:1.5;color:#FFE9C2;text-align:center;word-break:keep-all;}
#scr-gstat .gs-info small{color:rgba(255,232,160,.65);font-size:11.5px;}
#scr-gstat .gs-legend{font-size:11.5px;color:rgba(255,232,160,.7);text-align:center;}
#scr-gstat .gs-legend span{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin:0 3px 0 8px;}`;
  document.head.appendChild(st);
}
function gsEnsureScreen(){
  let scr = document.getElementById('scr-gstat');
  if (scr) return scr;
  const ref = document.getElementById('scr-mult') || document.getElementById('scr-sel');
  if (!ref || !ref.parentNode) return null;
  gradeInjectCss(); gsInjectCss();
  scr = document.createElement('div'); scr.id = 'scr-gstat'; scr.className = 'screen off';
  scr.innerHTML = `<div class="lrn-header"><button class="lrn-back" id="gs-back">← 뒤로</button><div class="lrn-title">📋 내 급수 현황</div></div><div id="gs-list"></div>`;
  ref.parentNode.appendChild(scr);
  scr.querySelector('#gs-back').onclick = () => openGradeHome();
  return scr;
}
function gsColHtml(track, name){
  const T = GRADE_TRACKS[track]; if (!T) return '';
  const cur = gradeCurrent(track), nx = gradeNext(track);
  const grades = Object.keys(T.grades).map(Number).sort((a, b) => b - a);
  const ach = gradeState().achieved[track] || {};
  const cells = grades.map(g => `<div class="gs-cell${ach[g] || (cur != null && g >= cur) ? ' got' : g === nx ? ' now' : ''}">${g}</div>`).join('');
  let info = '';
  if (nx == null) info = '🎉 1급까지 모두 합격!';
  else {
    const S = gradeSpec(track, nx), P = gradeProgress(track, nx);
    info = `도전 중 <b>${nx}급</b> · 합격 ${Math.min(P.days || 0, S.need)}/${S.need}`;
    if (P.best_ms != null) info += `<br><small>최고 기록 ${gradeFmtTime(P.best_ms)} (제한 ${gradeFmtLimit(S.limit)})</small>`;
  }
  return `<div class="gs-col"><div class="gs-cname">${name}</div>`
    + (cur == null ? `<div class="gs-medal none">아직 급 없음</div>` : `<div class="gs-medal">🏅 ${cur}급</div>`)
    + `<div class="gs-ladder">${cells}</div><div class="gs-info">${info}</div></div>`;
}
function gsRender(){
  const list = document.getElementById('gs-list'); if (!list) return;
  list.innerHTML = `<div class="gs-legend"><span style="background:#E8B450"></span>합격한 급<span style="border:1.5px solid #7EE2A0"></span>도전 중</div>`
    + `<div class="gs-panel"><div class="gs-ptitle">➕➖ 덧뺄셈</div><div class="gs-cols">${gsColHtml('add_soroban', '주산')}${gsColHtml('add_mental', '암산')}</div></div>`
    + `<div class="gs-panel"><div class="gs-ptitle">✖️ 곱셈</div><div class="gs-cols">${gsColHtml('mult_soroban', '주산')}${gsColHtml('mult_mental', '암산')}</div></div>`
    + `<div class="gs-panel"><div class="gs-ptitle">➗ 나눗셈</div><div class="gs-cols one">${gsColHtml('div', '암산')}</div></div>`;
}
function openGradeStatus(){
  if (!gsEnsureScreen()) return;
  try { playTick(); } catch(e){}
  gsRender();
  lrnShowScreen('scr-gstat');
  gradeLoad().then(() => { const s = document.getElementById('scr-gstat'); if (s && !s.classList.contains('off')) gsRender(); }).catch(() => {});
}

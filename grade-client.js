// ============================================================
// AI암산튜터 grade-client.js — 🏅 급수 도전: 급수표 · 급 판정 · 서버 저장 (2026-11-09, 1단계)
//   화면(급수 도전 화면·시험·결과·축하)은 다음 단계에서 이 파일의 함수를 씀.
//
// 규칙 (사용자 결정 — claude/급수체계_설계.md)
//   · 트랙: 곱셈 주산 / 곱셈 암산 (덧뺄셈 주산·암산, 나눗셈은 급수표가 오면 추가)
//   · 한 판 합격 = 점수 ≥ 80% 그리고 제한 시간 안에 끝냄 (끝까지 풀게 두고, 시간 안에 끝냈을 때만 합격)
//   · 승급 = 그 급에서 "서로 다른 날" 합격 2번 (곱셈 주산 13급은 5번)
//   · 한 번 합격한 급은 유지. 급 번호가 작을수록 높은 급 (13급 → 1급)
//   · 중간에 나간 판은 기록하지 않음(무효) — 시험 화면이 끝까지 푼 판만 gradeRecord 호출
// 서버: supabase_grade_01.sql 의 grade_record / grade_status (anon RPC)
// 기기: gradeCache_<학생> (서버 상태 사본 — 화면을 바로 그리기 위함), gradePending_<학생> (못 보낸 기록, 다음에 다시 보냄)
// ============================================================

// 급수표 — 엑셀 "급수분류" 시트(2026-11-05 사용자 초안)가 원본. 시간은 초.
const GRADE_TRACKS = (() => {
  const steps = (type, from, secs) => secs.map((sec, i) => [from - i, { type, limit: sec }]);
  const body = [
    ...steps('2x1', 12, [300, 240, 180, 120]),
    ...steps('3x1',  8, [300, 240, 180, 120]),
    ...steps('2x2',  4, [300, 240, 180, 120]),
  ];
  const mk = (extra) => Object.fromEntries([...extra, ...body].map(([g, v]) =>
    [g, Object.assign({ count: 20, passPct: 80, need: 2 }, v)]));
  return {
    mult_soroban: {
      label: '곱셈 주산', op: 'mult', mode: 'soroban',
      grades: mk([[13, { type: 'gugu20', limit: 60, need: 5 }]]),
    },
    mult_mental: {
      label: '곱셈 암산', op: 'mult', mode: 'mental',
      grades: mk([]),
      // 12급 권장 선행 = 곱셈 주산 10급 (권장만 — 막지 않음)
      recommend: { 12: { track: 'mult_soroban', grade: 10 } },
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
  (js && js.achieved || []).forEach(a => { (st.achieved[a.track] = st.achieved[a.track] || {})[a.grade] = a.achieved_at; });
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
// 권장 선행 — 채웠으면 null, 아니면 { track, grade, label }
function gradeRecommendUnmet(track, grade){
  const r = GRADE_TRACKS[track] && GRADE_TRACKS[track].recommend && GRADE_TRACKS[track].recommend[grade];
  if (!r) return null;
  const cur = gradeCurrent(r.track);
  if (cur != null && cur <= r.grade) return null;
  return { track: r.track, grade: r.grade, label: `${GRADE_TRACKS[r.track].label} ${r.grade}급` };
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

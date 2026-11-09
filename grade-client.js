// ============================================================
// AI암산튜터 grade-client.js — 🏅 급수 도전: 급수표 · 급 판정 · 서버 저장 (2026-11-09, 1단계)
//   2단계: 급수 도전 화면(scr-grade) + 홈 버튼 (파일 아래쪽). 시험·결과·축하는 다음 단계.
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

// ════════════════════════════════════════════════════════════
// 2단계 (2026-11-09) — 🏅 급수 도전 화면(scr-grade) + 홈 버튼
//   · 홈: 부제목 아래 [🧮 이번 시간 ▼] 오른쪽 같은 줄에 [🏅 급수 도전] — 덮어 놓기만 함(홈 배치·주판은 그대로)
//   · 화면: 트랙마다 내 급 · 다음 도전 급과 조건 · 합격 n/2(서로 다른 날) · 최고 기록 · 권장 안내
//   · 도전은 바로 다음 급 하나만. [도전 ▶]은 3단계(시험 화면)에서 열림
// ════════════════════════════════════════════════════════════
const GRADE_SOON_TRACKS = ['덧뺄셈 주산', '덧뺄셈 암산', '나눗셈'];

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
     + `<div class="gc-rule">${gradeEsc(GRADE_TYPE_LABEL[S.type] || S.type)} ${S.count}문제 · ${gradeFmtLimit(S.limit)} 안에 ${need}개 이상 맞히면 합격</div>`
     + `<div class="gc-prog">합격 ${days}/${S.need} ${dots} <span class="gc-sub">(서로 다른 날)</span></div>`;
  if (P.best_ms != null) h += `<div class="gc-sub" style="margin-top:4px">내 최고 기록 ${gradeFmtTime(P.best_ms)}</div>`;
  if (passedToday) h += `<div class="gc-sub" style="margin-top:4px;color:#7EE2A0">오늘 합격했어! 다른 날 한 번 더 합격하면 돼</div>`;
  h += `</div>`;
  const rec = gradeRecommendUnmet(track, nx);
  if (rec) h += `<div class="gc-rec">💡 ${gradeEsc(rec.label)}을 먼저 합격하면 더 쉬워요 (그래도 도전할 수 있어)</div>`;
  h += `<button class="gc-go" disabled>도전 ▶ (곧 열려요)</button></div>`;
  return h;
}

function gradeRenderScreen(){
  const list = document.getElementById('grade-list'); if (!list) return;
  let h = `<div class="grade-intro">바로 다음 급에 도전할 수 있어. 서로 다른 날 정해진 횟수(보통 2번)만큼 합격하면 급이 올라가! 한 번 딴 급은 그대로 남아.</div>`;
  h += Object.keys(GRADE_TRACKS).map(gradeCardHtml).join('');
  h += GRADE_SOON_TRACKS.map(n => `<div class="grade-card soon"><div class="gc-top"><div class="gc-name">${n}</div><div class="gc-mine none">준비 중</div></div></div>`).join('');
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

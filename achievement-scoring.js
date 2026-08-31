/* ════════════════════════════════════════════════════════════
 * achievement-scoring.js
 * progress_events 원자료 배열을 받아서 진도/이해도/배지를 계산.
 * 순수 함수만 있음 — Supabase 접근이나 DOM 조작 없음.
 * 사용법: 리포트 페이지에서 progress_events를 fetch한 뒤 이 함수들에 넘기면 됨.
 * ════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────
 * 공통 유틸: unit_id별로 이벤트를 시간순 그룹화
 * ──────────────────────────────────────────── */
function groupEventsByUnit(events) {
  const groups = {};
  for (const e of events) {
    if (!groups[e.unit_id]) groups[e.unit_id] = [];
    groups[e.unit_id].push(e);
  }
  for (const key in groups) {
    groups[key].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return groups;
}

/* ────────────────────────────────────────────
 * 1. 진도 (Progress)
 * requiredUnits: 이 챕터의 필수 unit_id 목록 (비필수 확장 콘텐츠 제외하고 넘겨야 함)
 * 반환: { done: 완료수, total: 전체수, pct: 0~100 }
 * ──────────────────────────────────────────── */
function computeProgress(events, requiredUnits) {
  const byUnit = groupEventsByUnit(events);
  let done = 0;
  for (const unitId of requiredUnits) {
    const unitEvents = byUnit[unitId] || [];
    if (unitEvents.some(e => e.passed === true)) done++;
  }
  const total = requiredUnits.length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/* 구구단 진도는 별도 — "맞추기(quiz) 80%+ 통과 기록이 있는 단"의 개수로 계산 */
function computeGuguProgress(events, dans /* 예: [2,3,4,5,6,7,8,9] */) {
  const byUnit = groupEventsByUnit(events);
  let done = 0;
  for (const dan of dans) {
    const unitId = `d${dan}`;
    const unitEvents = (byUnit[unitId] || []).filter(e => e.event_type === 'quiz');
    if (unitEvents.some(e => e.passed === true)) done++;
  }
  return { done, total: dans.length, pct: Math.round((done / dans.length) * 100) };
}

/* ────────────────────────────────────────────
 * 2. 이해도 (Comprehension)
 * 반환: { recentAvg: 최근5회 평균점수, avgAttemptsToPass: 평균 통과 소요횟수, trend: [최근5개 score] }
 * ──────────────────────────────────────────── */
function computeComprehension(events) {
  // score가 있는 이벤트만 (lesson_round, quiz, unit_test 등)
  const scored = events.filter(e => typeof e.score === 'number')
                        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const recent5 = scored.slice(-5);
  const recentAvg = recent5.length
    ? Math.round(recent5.reduce((s, e) => s + normalizeScore(e), 0) / recent5.length)
    : null;

  // 단원별로 "몇 번째 시도에 처음 통과했는지" 평균
  const byUnit = groupEventsByUnit(events);
  const attemptsList = [];
  for (const unitId in byUnit) {
    const unitEvents = byUnit[unitId];
    const firstPassIdx = unitEvents.findIndex(e => e.passed === true);
    if (firstPassIdx >= 0) attemptsList.push(firstPassIdx + 1); // 1-based
  }
  const avgAttemptsToPass = attemptsList.length
    ? Math.round((attemptsList.reduce((a, b) => a + b, 0) / attemptsList.length) * 10) / 10
    : null;

  return {
    recentAvg,
    avgAttemptsToPass,
    trend: recent5.map(e => normalizeScore(e))
  };
}

// score/max_score가 섞여있어도(18점만점, 81점만점, 100점만점) 항상 0~100 스케일로 정규화
function normalizeScore(e) {
  if (e.max_score && e.max_score > 0) return Math.round((e.score / e.max_score) * 100);
  return e.score; // max_score 없으면 이미 0~100 스케일이라고 가정
}

/* ────────────────────────────────────────────
 * 3. 배지 4종
 * ──────────────────────────────────────────── */

// 명중왕 — 완료한 단원 중 "첫 시도"에 통과한 비율 ≥ 70%
function checkBadge_명중왕(events) {
  const byUnit = groupEventsByUnit(events);
  let passedUnits = 0, firstTryPassed = 0;
  for (const unitId in byUnit) {
    const unitEvents = byUnit[unitId];
    if (unitEvents.some(e => e.passed === true)) {
      passedUnits++;
      if (unitEvents[0].passed === true) firstTryPassed++;
    }
  }
  const ratio = passedUnits > 0 ? firstTryPassed / passedUnits : 0;
  const earned = passedUnits >= 3 && ratio >= 0.7;
  // 근접도: 표본이 부족하면 표본 채우는 게 우선, 표본 있으면 비율 기준
  const closeness = passedUnits < 3 ? passedUnits / 3 : Math.min(1, ratio / 0.7);
  const message = earned
    ? `이미 받았어요! (${Math.round(ratio*100)}%)`
    : passedUnits < 3
      ? `단원 ${3 - passedUnits}개만 더 완료하면 확인할 수 있어요`
      : `지금 ${Math.round(ratio*100)}%예요, 70%를 넘으면 받아요`;
  return { earned, ratio: Math.round(ratio * 100), sampleSize: passedUnits, closeness, message };
}
// sampleSize 최소 3단원 조건 추가 — 1~2개 단원만으로 70% 판정하면 통계적으로 무의미해서 임의로 넣음

// 점프왕 — 최근 5회 평균이 직전 5회 평균보다 30%p 이상 상승 (최소 10회 기록 필요)
function checkBadge_점프왕(events) {
  const scored = events.filter(e => typeof e.score === 'number')
                        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (scored.length < 10) {
    return {
      earned: false, reason: 'NOT_ENOUGH_DATA', have: scored.length, need: 10,
      closeness: scored.length / 10,
      message: `${10 - scored.length}번만 더 풀면 확인할 수 있어요`
    };
  }
  const last10 = scored.slice(-10);
  const older5 = last10.slice(0, 5).map(normalizeScore);
  const newer5 = last10.slice(5, 10).map(normalizeScore);
  const avgOlder = older5.reduce((a, b) => a + b, 0) / 5;
  const avgNewer = newer5.reduce((a, b) => a + b, 0) / 5;
  const delta = Math.round(avgNewer - avgOlder);
  const earned = delta >= 30;
  const closeness = Math.max(0, Math.min(1, delta / 30));
  const message = delta >= 0
    ? `지금 ${delta}%p 올랐어요, 30%p면 받아요`
    : `조금 더 풀어보면 상승세를 만들 수 있어요`;
  return { earned, delta, avgOlder: Math.round(avgOlder), avgNewer: Math.round(avgNewer), closeness, message };
}

// 뚝심왕 — 같은 단원(unit_id)에서 5회 연속 통과 (중간에 실패하면 그 단원은 리셋)
function checkBadge_뚝심왕(events) {
  const byUnit = groupEventsByUnit(events);
  let bestStreak = 0, bestUnit = null;
  for (const unitId in byUnit) {
    const unitEvents = byUnit[unitId];
    let streak = 0, maxStreak = 0;
    for (const e of unitEvents) {
      if (e.passed === true) { streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0; // 실패하면 리셋
    }
    if (maxStreak > bestStreak) { bestStreak = maxStreak; bestUnit = unitId; }
  }
  const earned = bestStreak >= 5;
  const closeness = Math.min(1, bestStreak / 5);
  const message = bestStreak > 0
    ? `지금 ${bestStreak}연속이에요, ${5 - bestStreak}번만 더 연속 통과하면 받아요`
    : `한 단원을 연속으로 통과해보면 받을 수 있어요`;
  return { earned, bestStreak, bestUnit, closeness, message };
}

// 마무리왕 — 3회 이상 재시도해서 결국 통과해낸 단원이 있는지 (포기 없이 끝까지)
function checkBadge_마무리왕(events) {
  const byUnit = groupEventsByUnit(events);
  let qualifyingUnits = 0;
  let bestInProgress = 0; // 아직 통과 못했지만 재시도 중인 단원의 최대 시도횟수
  for (const unitId in byUnit) {
    const unitEvents = byUnit[unitId];
    const firstPassIdx = unitEvents.findIndex(e => e.passed === true);
    if (firstPassIdx >= 2) qualifyingUnits++;
    else if (firstPassIdx === -1) bestInProgress = Math.max(bestInProgress, unitEvents.length);
  }
  const earned = qualifyingUnits >= 1;
  const closeness = earned ? 1 : Math.min(1, bestInProgress / 3);
  const message = earned
    ? `이미 받았어요! (${qualifyingUnits}개 단원)`
    : bestInProgress > 0
      ? `포기하지 않고 계속 도전하면 곧 받을 수 있어요`
      : `어려운 단원을 여러 번 도전해보면 받을 수 있어요`;
  return { earned, qualifyingUnits, closeness, message };
}

/* 배지를 하나도 못 받았을 때 — 가장 가까운 배지 하나를 골라 격려 문구로 보여줌 */
function pickEncouragingBadgeMessage(badges) {
  const entries = Object.entries(badges).filter(([name, b]) => !b.earned);
  if (entries.length === 0) return null; // 이미 다 받음
  entries.sort((a, b) => b[1].closeness - a[1].closeness);
  const [name, best] = entries[0];
  return { badgeName: name, message: best.message, closeness: best.closeness };
}

/* ────────────────────────────────────────────
 * 4. 통합 — 리포트 페이지에서 이거 하나만 부르면 됨
 * ──────────────────────────────────────────── */
function computeAchievementReport(events, config) {
  // config: { requiredUnits: [...], guguDans: [2..9] }
  const badges = {
    명중왕: checkBadge_명중왕(events),
    점프왕: checkBadge_점프왕(events),
    뚝심왕: checkBadge_뚝심왕(events),
    마무리왕: checkBadge_마무리왕(events)
  };
  return {
    progress: {
      lesson: computeProgress(events, config.requiredUnits),
      gugu: computeGuguProgress(events, config.guguDans)
    },
    comprehension: computeComprehension(events),
    badges,
    encouragement: pickEncouragingBadgeMessage(badges) // 배지 0개일 때만 값이 있음
  };
}

import { db } from './index.js';

function localDateStr(d) {
    // 'YYYY-MM-DD' in the server's own local TZ (compose.yaml sets
    // TZ=Europe/Amsterdam) -- deliberately NOT toISOString(), which is UTC
    // and would file a session under the wrong calendar day near midnight.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Idempotent: a 2nd/3rd session the same day is a no-op for the log.
export function logSessionDay(userId, now = new Date()) {
    db.prepare('INSERT OR IGNORE INTO session_log (user_id, date) VALUES (?, ?)').run(userId, localDateStr(now));
}

export function getSessionDates(userId) {
    return new Set(db.prepare('SELECT date FROM session_log WHERE user_id = ?').all(userId).map((r) => r.date));
}

// Current streak: consecutive days ending today, OR ending yesterday if
// today hasn't happened yet (today isn't "missed" until it's actually
// over) -- so the streak doesn't drop to 0 first thing in the morning
// before you've had a chance to review.
export function getStreak(userId, now = new Date()) {
    const dates = getSessionDates(userId);
    const cursor = new Date(now);
    if (!dates.has(localDateStr(cursor))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (dates.has(localDateStr(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}

// Calendar grid data for one month: every day 1..N with whether a session
// happened that day. month is 0-indexed (JS Date convention) to match how
// callers will already have it from a Date object.
export function getMonthCalendar(userId, year, month) {
    const dates = getSessionDates(userId);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(year, month, day);
        days.push({ day, done: dates.has(localDateStr(d)), isToday: localDateStr(d) === localDateStr(new Date()) });
    }
    return days;
}

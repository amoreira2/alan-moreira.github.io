/* ============================================================
   BEHAVIOR TRACKER — shared data layer
   Used by behavior/index.html (phone logger) and behavior/wall.html (big screen).

   Everything hangs off one global: BX.

   WHY A SHARED FILE: the metric logic has to produce identical
   numbers on the phone and on the wall screen. Duplicated in two
   HTML files it would drift, and a wrong number on the wall is the
   one bug that discredits the whole tool.
   ============================================================ */

/* ------------------------------------------------------------
   FIREBASE
   Reuses the existing star-tracker project, but writes to its own
   subtree (families/{CODE}/behavior) so it can't disturb the
   potty-tracker or routine-tracker data.
   ------------------------------------------------------------ */
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAAkzMXByWPdJ2kve26-fu1XD75NU4S9Ho",
    authDomain: "star-tracker-9b5d6.firebaseapp.com",
    databaseURL: "https://star-tracker-9b5d6-default-rtdb.firebaseio.com",
    projectId: "star-tracker-9b5d6",
    storageBucket: "star-tracker-9b5d6.firebasestorage.app",
    appId: "1:456025896569:web:2835f1bf031e0f80f846a8"
};

/* ------------------------------------------------------------
   SECURITY RULES — paste into Firebase console when you want to
   lock this down. Console > Realtime Database > Rules.

   Right now the database is almost certainly wide open: anyone who
   learns the family code (or just guesses a short one) can read and
   write. The code is the only secret. That is why the code this app
   generates is 10 characters rather than the 6 the old trackers use.

   Step 1 — cheap, no code change. Require a minimum code length and
   stop anyone enumerating the whole families/ tree:

     {
       "rules": {
         "families": {
           "$code": {
             ".read":  "$code.length >= 10",
             ".write": "$code.length >= 10"
           }
         }
       }
     }

   Step 2 — real protection. Turn on Anonymous Auth in the console
   (Authentication > Sign-in method > Anonymous), then:

     {
       "rules": {
         "families": {
           "$code": {
             ".read":  "auth != null && $code.length >= 10",
             ".write": "auth != null && $code.length >= 10",
             "behavior": {
               "events": {
                 "$id": {
                   ".validate": "newData.hasChildren(['kid','tag','pol','ts','day'])"
                 }
               }
             }
           }
         }
       }
     }

   Step 2 needs one extra line in this file (firebase.auth().signInAnonymously())
   before the first read. Ask me and it's a two-minute change.
   ------------------------------------------------------------ */

const DB_PATH = "behavior";
const CODE_KEY = "behavior-tracker-code";
const CACHE_PREFIX = "behavior-cache-";
const OUTBOX_PREFIX = "behavior-outbox-";

const KIDS = {
    laura: { name: "Laura", initial: "L", hue: 340 },
    julia: { name: "Julia", initial: "J", hue: 210 }
};

/* ------------------------------------------------------------
   DEFAULT CATALOG
   Your four negatives and their positive opposites. Positives are
   ordered first on purpose — see note in the plan. `order` controls
   display; custom tags added later sort after these.
   ------------------------------------------------------------ */
const DEFAULT_CATALOG = {
    kind_sister:   { label: "Kind to sister",   emoji: "🤝", pol:  1, order: 10 },
    gentle:        { label: "Gentle & calm",    emoji: "🕊️", pol:  1, order: 11 },
    good_attitude: { label: "Good attitude",    emoji: "☀️", pol:  1, order: 12 },
    cooperative:   { label: "Cooperative",      emoji: "✅", pol:  1, order: 13 },

    bickering:     { label: "Bickering",        emoji: "😾", pol: -1, order: 20 },
    aggressive:    { label: "Aggressive",       emoji: "💥", pol: -1, order: 21 },
    complaining:   { label: "Complaining",      emoji: "🌧️", pol: -1, order: 22 },
    uncooperative: { label: "Won't cooperate",  emoji: "⛔", pol: -1, order: 23 }
};

/* ------------------------------------------------------------
   DATE HELPERS — all in Eastern Time so a 9pm log and an 00:30 log
   land on the days you'd expect.

   Note: addDays does its arithmetic in UTC. The equivalent helper in
   routine-tracker/index.html builds a *local* Date then calls
   toISOString(), which shifts the date by one west of Greenwich. This
   version doesn't have that bug.
   ------------------------------------------------------------ */
function todayStr() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
}

function addDays(dayStr, n) {
    const [y, m, d] = dayStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
    const [ay, am, ad] = a.split("-").map(Number);
    const [by, bm, bd] = b.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function shortDate(dayStr) {
    const [y, m, d] = dayStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d))
        .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function relativeTime(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days === 1 ? "yesterday" : days + "d ago";
}

/* ============================================================
   BX — state, sync, and metrics
   ============================================================ */
const BX = {
    code: "",
    remote: {},     // events synced from Firebase, keyed by push id
    outbox: {},     // events written locally but not yet confirmed
    catalog: {},
    ready: false,
    online: false,
    onChange: null  // set by the page; called whenever data changes
};

/* ---------- persistence ---------- */

function cacheSave() {
    try {
        localStorage.setItem(CACHE_PREFIX + BX.code, JSON.stringify({
            events: BX.remote, catalog: BX.catalog
        }));
        localStorage.setItem(OUTBOX_PREFIX + BX.code, JSON.stringify(BX.outbox));
    } catch (e) { /* quota or private mode — the app still works this session */ }
}

function cacheLoad() {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + BX.code);
        if (raw) {
            const d = JSON.parse(raw);
            BX.remote = d.events || {};
            BX.catalog = d.catalog || {};
        }
        const ob = localStorage.getItem(OUTBOX_PREFIX + BX.code);
        BX.outbox = ob ? JSON.parse(ob) : {};
    } catch (e) {
        BX.remote = {}; BX.catalog = {}; BX.outbox = {};
    }
}

BX.savedCode = function () {
    try { return localStorage.getItem(CODE_KEY) || ""; } catch (e) { return ""; }
};

BX.generateCode = function () {
    // 10 chars, no lookalike glyphs. Longer than the old 6-char codes
    // because with open database rules the code IS the security.
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    const buf = new Uint32Array(10);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (let i = 0; i < 10; i++) out += chars[buf[i] % chars.length];
    return out;
};

/* ---------- init & sync ---------- */

BX.init = function (code, onChange) {
    BX.code = code;
    BX.onChange = onChange;
    try { localStorage.setItem(CODE_KEY, code); } catch (e) {}

    cacheLoad();
    if (!Object.keys(BX.catalog).length) BX.catalog = JSON.parse(JSON.stringify(DEFAULT_CATALOG));
    BX.ready = true;
    if (BX.onChange) BX.onChange();   // paint immediately from cache, no spinner

    try {
        firebase.initializeApp(FIREBASE_CONFIG);
    } catch (e) {
        console.warn("Firebase init failed — running local-only:", e);
        return;
    }

    const base = firebase.database().ref("families/" + code + "/" + DB_PATH);

    base.child("events").on("value", snap => {
        BX.remote = snap.val() || {};
        /* Deliberately NOT clearing the outbox here. The RTDB SDK fires
           this listener optimistically for our own writes before the
           server has seen them (latency compensation), so a snapshot
           containing an event is not evidence the server stored it.
           Clearing on that signal loses events if the page reloads while
           offline: the SDK's queue dies with the page and the outbox has
           already forgotten them. The outbox is cleared by the write
           acknowledgement in writeEvent() instead. */
        cacheSave();
        if (BX.onChange) BX.onChange();
    });

    base.child("catalog").on("value", snap => {
        const remoteCat = snap.val();
        if (remoteCat && Object.keys(remoteCat).length) {
            BX.catalog = remoteCat;
        } else {
            // First run on this code: seed the defaults so every phone agrees.
            base.child("catalog").update(DEFAULT_CATALOG);
        }
        cacheSave();
        if (BX.onChange) BX.onChange();
    });

    firebase.database().ref(".info/connected").on("value", snap => {
        BX.online = !!snap.val();
        if (BX.online) flushOutbox();
        if (BX.onChange) BX.onChange();
    });
};

function flushOutbox() {
    if (!BX.online) return;
    for (const id in BX.outbox) writeEvent(id, BX.outbox[id]);
}

/* The completion callback fires only once the server has acknowledged
   the write, which is the only trustworthy signal that it is safe to
   forget the event locally. While offline the SDK simply holds the
   callback, so the event stays in the outbox and survives a reload. */
function writeEvent(id, ev) {
    try {
        firebase.database()
            .ref("families/" + BX.code + "/" + DB_PATH + "/events/" + id)
            .set(ev, err => {
                if (!err) { delete BX.outbox[id]; cacheSave(); }
            });
    } catch (e) { /* stays in the outbox, retried on next connect */ }
}

/* ---------- writes ----------
   Every event gets its own Firebase key via push(). We never call
   .set() on the whole events object — that is exactly the pattern
   that makes routine-tracker and potty-tracker lose data when two
   phones write at once.

   push() generates its key on the client, so this works offline too:
   the event goes into the outbox under its final key and is written
   under that same key when the connection comes back. No duplicates.
   ------------------------------------------------------------ */

BX.log = function (kid, tagId, note) {
    const tag = BX.catalog[tagId];
    if (!tag) return null;

    const ev = {
        kid: kid,
        tag: tagId,
        pol: tag.pol,
        ts: Date.now(),
        day: todayStr()
    };
    if (note) ev.note = note;

    let id;
    try {
        id = firebase.database().ref().push().key;
    } catch (e) {
        id = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    BX.outbox[id] = ev;          // optimistic: visible instantly
    cacheSave();
    if (BX.onChange) BX.onChange();

    writeEvent(id, ev);
    return id;
};

BX.remove = function (id) {
    delete BX.outbox[id];
    delete BX.remote[id];
    cacheSave();
    if (BX.onChange) BX.onChange();
    try {
        firebase.database()
            .ref("families/" + BX.code + "/" + DB_PATH + "/events/" + id)
            .remove();
    } catch (e) {}
};

BX.addTag = function (label, pol, emoji) {
    const id = "custom_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24)
             + "_" + Math.random().toString(36).slice(2, 5);
    const maxOrder = Math.max(30, ...Object.values(BX.catalog).map(t => t.order || 0));
    const tag = {
        label: label.slice(0, 28),
        emoji: emoji || (pol > 0 ? "⭐" : "•"),
        pol: pol,
        order: maxOrder + 1,
        custom: true
    };
    BX.catalog[id] = tag;
    cacheSave();
    if (BX.onChange) BX.onChange();
    try {
        // update() on the catalog path only — can't clobber events.
        firebase.database()
            .ref("families/" + BX.code + "/" + DB_PATH + "/catalog")
            .update({ [id]: tag });
    } catch (e) {}
    return id;
};

/* ---------- reads ---------- */

BX.events = function (kid) {
    const all = [];
    for (const id in BX.remote) all.push(Object.assign({ id }, BX.remote[id]));
    for (const id in BX.outbox) if (!BX.remote[id]) all.push(Object.assign({ id, pending: true }, BX.outbox[id]));
    const filtered = kid ? all.filter(e => e.kid === kid) : all;
    return filtered.sort((a, b) => b.ts - a.ts);
};

BX.tags = function () {
    return Object.keys(BX.catalog)
        .map(id => Object.assign({ id }, BX.catalog[id]))
        .sort((a, b) => (a.order || 99) - (b.order || 99));
};

/* ------------------------------------------------------------
   TIME-OF-DAY
   Every event has always carried a full ts; only the date was being
   used. These read the clock time back out in Eastern Time so a 7pm
   entry reads as 7pm regardless of where the phone thinks it is.
   ------------------------------------------------------------ */
function etParts(ts) {
    const f = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    });
    const o = {};
    for (const part of f.formatToParts(new Date(ts))) o[part.type] = part.value;
    return o;
}

BX.etHour = function (ts) {
    const p = etParts(ts);
    return Number(p.hour) + Number(p.minute) / 60;
};

BX.etClock = function (ts) {
    return new Date(ts).toLocaleTimeString("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
    });
};

BX.etLongDate = function (ts) {
    return new Date(ts).toLocaleDateString("en-US", {
        timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric"
    });
};

/* Events in the trailing window, carried with their day offset and clock
   hour — the input to the time-of-day scatter. */
BX.eventPoints = function (kid, days, asOf) {
    asOf = asOf || todayStr();
    const start = addDays(asOf, -(days - 1));
    return BX.events(kid)
        .filter(e => e.day >= start && e.day <= asOf)
        .map(e => ({
            id: e.id, kid: e.kid, tag: e.tag, pol: e.pol, ts: e.ts, day: e.day,
            dx: daysBetween(start, e.day),
            hour: BX.etHour(e.ts)
        }));
};

/* ---------- CSV ----------
   Chronological, one row per event, ISO timestamp plus split date/time
   columns so it drops straight into pandas or a spreadsheet without
   parsing work. */
function csvCell(v) {
    v = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

BX.toCSV = function (kid) {
    const rows = [["timestamp_et", "date", "time", "weekday", "kid",
                   "behavior", "polarity", "note"]];
    const evs = BX.events(kid).slice().sort((a, b) => a.ts - b.ts);
    for (const e of evs) {
        const p = etParts(e.ts);
        const tag = BX.catalog[e.tag] || {};
        rows.push([
            `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`,
            e.day,
            `${p.hour}:${p.minute}`,
            new Date(e.ts).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" }),
            (KIDS[e.kid] || {}).name || e.kid,
            tag.label || e.tag,
            e.pol,
            e.note || ""
        ]);
    }
    return rows.map(r => r.map(csvCell).join(",")).join("\n");
};

BX.downloadCSV = function (kid) {
    const csv = BX.toCSV(kid);
    const name = "behavior-" + (kid || "all") + "-" + todayStr() + ".csv";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    return csv.split("\n").length - 1;
};

/* ============================================================
   METRICS

   Headline number is the POSITIVE SHARE over a trailing 7 days:
       share = positives / (positives + negatives)

   Not the net count. Net counts confound the girls' behavior with
   how much the parent felt like logging: a week where you were
   short-tempered and logged everything looks identical to a week
   where they actually regressed. Share is scale-free, so it moves
   only when the *mix* changes. Raw volume is still returned (as .n)
   and the wall screen displays it, so a logging spike stays visible
   as a logging spike rather than masquerading as behavior.
   ============================================================ */

const MIN_EVENTS = 5;      // below this, refuse to show a mood
const MIN_SHIFT = 0.05;    // ignore changes too small to care about
const Z_THRESHOLD = 1.2;   // ...and too small to distinguish from noise

/* Two-proportion z-test on this week's share vs last week's.

   Why not just a fixed threshold: a week holds roughly 20 entries, so
   the standard error on a 50% share is about 11 points and the SE on the
   *difference* between two weeks is about 15. Any fixed dead band small
   enough to ever fire (5 points, say) sits deep inside that noise, and
   the screen would swing between "better" and "harder" at random while
   nothing had actually changed. Worse, it would do so most violently in
   the weeks with the fewest entries.

   So the direction has to clear two bars: big enough to care about
   (MIN_SHIFT) and big enough to distinguish from sampling noise
   (Z_THRESHOLD). z = 1.2 is a deliberately loose bar — about 77% one-
   sided confidence rather than the usual 95%. At n ~ 20 per week, 95%
   would need a swing of roughly 30 points and the page would essentially
   never move. 1.2 fires on a real 20-point swing and stays quiet for a
   10-point wobble, which is the right trade for a family tracker: the
   cost of a false "harder week" is a bad conversation, and the cost of a
   false "steady" is only a week's delay. */
function zStat(p1, n1, p2, n2) {
    if (!n1 || !n2) return 0;
    const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    return se ? (p1 - p2) / se : 0;
}

function windowCounts(events, fromDay, toDay) {
    let pos = 0, neg = 0;
    const byTag = {};
    for (const e of events) {
        if (e.day < fromDay || e.day > toDay) continue;
        if (e.pol > 0) pos++; else neg++;
        if (!byTag[e.tag]) byTag[e.tag] = { pos: 0, neg: 0 };
        if (e.pol > 0) byTag[e.tag].pos++; else byTag[e.tag].neg++;
    }
    const n = pos + neg;
    return { pos, neg, n, byTag, share: n ? pos / n : null };
}

BX.MIN_EVENTS = MIN_EVENTS;

BX.metrics = function (kid, asOf) {
    asOf = asOf || todayStr();
    const events = BX.events(kid);

    const cur = windowCounts(events, addDays(asOf, -6), asOf);
    const prev = windowCounts(events, addDays(asOf, -13), addDays(asOf, -7));

    // Mood
    let mood, delta = null, z = null;
    if (cur.n < MIN_EVENTS) {
        mood = "insufficient";
    } else if (prev.n < MIN_EVENTS) {
        mood = "steady";               // nothing honest to compare against yet
    } else {
        delta = cur.share - prev.share;
        z = zStat(cur.share, cur.n, prev.share, prev.n);
        const real = Math.abs(delta) > MIN_SHIFT && Math.abs(z) >= Z_THRESHOLD;
        mood = real ? (delta > 0 ? "up" : "down") : "steady";
    }

    // Focus: biggest week-over-week rise in negatives. Drives the
    // worsening screen, which names one thing instead of listing five.
    let focus = null;
    for (const tagId in cur.byTag) {
        const now = cur.byTag[tagId].neg;
        if (!now) continue;
        const before = (prev.byTag[tagId] || {}).neg || 0;
        const rise = now - before;
        if (!focus || rise > focus.rise || (rise === focus.rise && now > focus.now)) {
            focus = { tag: tagId, now, before, rise };
        }
    }

    // Win: biggest week-over-week rise in positives. Drives the improving screen.
    let win = null;
    for (const tagId in cur.byTag) {
        const now = cur.byTag[tagId].pos;
        if (!now) continue;
        const before = (prev.byTag[tagId] || {}).pos || 0;
        const rise = now - before;
        if (!win || rise > win.rise || (rise === win.rise && now > win.now)) {
            win = { tag: tagId, now, before, rise };
        }
    }

    return { asOf, cur, prev, mood, delta, z, focus, win };
};

/* Rolling 7-day share evaluated once per day — the sparkline series.
   Returns [{day, share|null, n}] over the trailing `days` days. */
BX.shareSeries = function (kid, days, asOf) {
    asOf = asOf || todayStr();
    const events = BX.events(kid);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const end = addDays(asOf, -i);
        const w = windowCounts(events, addDays(end, -6), end);
        out.push({ day: end, share: w.n >= 3 ? w.share : null, n: w.n });
    }
    return out;
};

/* Per-day net (positives − negatives) — the calendar strip. */
BX.daySeries = function (kid, days, asOf) {
    asOf = asOf || todayStr();
    const events = BX.events(kid);
    const map = {};
    for (const e of events) {
        if (!map[e.day]) map[e.day] = { pos: 0, neg: 0 };
        if (e.pol > 0) map[e.day].pos++; else map[e.day].neg++;
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = addDays(asOf, -i);
        const d = map[day] || { pos: 0, neg: 0 };
        out.push({ day, pos: d.pos, neg: d.neg, net: d.pos - d.neg, n: d.pos + d.neg });
    }
    return out;
};

/* Has the parent logged only negatives lately? Drives the nudge on
   the logger. Not nagging — just a quiet counterweight, because a
   log that only ever records failure stops being useful to the kid. */
BX.negativeStreak = function (kid, lookback) {
    const evs = BX.events(kid).slice(0, lookback || 6);
    if (evs.length < (lookback || 6)) return 0;
    return evs.every(e => e.pol < 0) ? evs.length : 0;
};

/* ------------------------------------------------------------
   DEMO SEED — wall.html?demo=up|down|steady|thin
   Generates a synthetic history so the three visual states can be
   checked without waiting weeks for real data. Writes nothing:
   it replaces BX.remote in memory only.
   ------------------------------------------------------------ */
BX.seedDemo = function (kind) {
    BX.catalog = JSON.parse(JSON.stringify(DEFAULT_CATALOG));
    BX.remote = {};
    BX.outbox = {};

    // Morning rush, after school, and the bedtime hour.
    const HOUR_POOL = [7, 7.4, 7.8, 8.1, 15.5, 16, 16.6, 17.2, 17.8, 18.4, 19, 19.5, 20, 20.4];
    const posTags = ["kind_sister", "gentle", "good_attitude", "cooperative"];
    const negTags = ["bickering", "aggressive", "complaining", "uncooperative"];
    const today = todayStr();
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    /* The last two weeks get explicit rates; earlier weeks drift, so the
       sparkline has a history to show. A purely linear 8-week drift would
       leave consecutive weeks only ~11 points apart, which the z-test
       correctly refuses to call a direction — so the demo would never
       exercise the up/down screens. */
    const profile = {
        up:      { cur: 0.80, prev: 0.34, from: 0.28, to: 0.45, perDay: 3.5 },
        down:    { cur: 0.24, prev: 0.68, from: 0.62, to: 0.70, perDay: 3.5 },
        steady:  { cur: 0.54, prev: 0.50, from: 0.48, to: 0.52, perDay: 5 },
        thin:    { cur: 0.50, prev: 0.50, from: 0.50, to: 0.50, perDay: 0.2 }
    }[kind] || { cur: 0.5, prev: 0.5, from: 0.5, to: 0.5, perDay: 3 };

    for (let i = 55; i >= 0; i--) {
        const day = addDays(today, -i);
        const t = (55 - i) / 55;
        const posRate = i <= 6  ? profile.cur
                      : i <= 13 ? profile.prev
                      : profile.from + (profile.to - profile.from) * t;
        const count = Math.round(profile.perDay * (0.5 + rnd()));
        // Fix the realized share rather than drawing it. Bernoulli draws
        // would put sampling noise on top of the intended rate, and at
        // ~25 events a week that noise is big enough to flip the demo
        // into the wrong mood — which is the very thing the z-test exists
        // to guard against on real data.
        const nPos = Math.round(count * posRate);
        for (let k = 0; k < count; k++) {
            const isPos = k < nPos;
            // Make one negative category clearly dominant in the down case,
            // so the "one thing to fix" headline has something real to name.
            let tag;
            if (isPos) {
                tag = posTags[Math.floor(rnd() * posTags.length)];
            } else if (kind === "down") {
                tag = rnd() < 0.55 ? "bickering" : negTags[Math.floor(rnd() * negTags.length)];
            } else {
                tag = negTags[Math.floor(rnd() * negTags.length)];
            }
            /* Plausible clock times so the time-of-day chart demonstrates
               what it is for: a morning rush, an after-school stretch and
               a bedtime cluster, which is where this stuff actually happens. */
            const slot = HOUR_POOL[Math.floor(rnd() * HOUR_POOL.length)];
            const hh = Math.floor(slot), mm = Math.floor((slot % 1) * 60 + rnd() * 25);
            const [yy, mo, dd] = day.split("-").map(Number);
            BX.remote["demo" + i + "_" + k] = {
                kid: "laura", tag, pol: isPos ? 1 : -1, day,
                ts: Date.UTC(yy, mo - 1, dd, hh + 4, Math.min(59, mm))
            };
        }
    }
    BX.ready = true;
};

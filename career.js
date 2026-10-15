// Career page: a typeracerdata-style profile built from the TypeGG public API.
// Pure stats math (computeStats) sits at the top so career.test.js can run it
// under node; everything below the `typeof document` guard is page code.

const DAY_MS = 86_400_000;

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// API definition of a win: a finished multiplayer race where the user holds the
// highest WPM among finishers (bots and guests count as opponents).
function isWin(r) {
  const finishers = (r.match?.players || []).filter((p) => p.completionType === "finished");
  return finishers.length > 0 && r.wpm >= Math.max(...finishers.map((p) => p.wpm));
}

// races: API race objects (any order, may include quits); bests: quote-bests list.
function computeStats(races, bests) {
  const rs = races.filter((r) => r.completionType === "finished")
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const wpms = rs.map((r) => r.wpm);
  const lang = new Map(bests.map((b) => [b.quote.quoteId, b.quote.language]));

  let bestLast10 = 0;
  for (let i = 9; i < rs.length; i++) bestLast10 = Math.max(bestLast10, avg(wpms.slice(i - 9, i + 1)));

  // Most races inside any 24h window (two pointers over sorted timestamps).
  const marathon = { races: 0, start: null };
  for (let i = 0, j = 0; j < rs.length; j++) {
    const tj = Date.parse(rs[j].timestamp);
    while (tj - Date.parse(rs[i].timestamp) >= DAY_MS) i++;
    if (j - i + 1 > marathon.races) marathon.races = j - i + 1, marathon.start = rs[i].timestamp;
  }

  const mean = avg(wpms);
  const sd = Math.sqrt(avg(wpms.map((w) => (w - mean) ** 2)));
  const multi = rs.filter((r) => r.match);
  const perfect = rs.filter((r) => r.accuracy === 1);

  const months = new Map();
  const langs = new Map();
  for (const r of rs) {
    const k = monthKey(r.timestamp);
    const m = months.get(k) || { month: k, races: 0, wpm: 0, best: 0, wins: 0, multi: 0, solo: 0, pp: 0, acc: 0, timeMs: 0 };
    m.races++; m.wpm += r.wpm; m.best = Math.max(m.best, r.wpm); m.pp += r.pp; m.acc += r.accuracy; m.timeMs += r.duration;
    if (r.match) { m.multi++; if (isWin(r)) m.wins++; } else m.solo++;
    months.set(k, m);

    const l = lang.get(r.quoteId) || "Unknown";
    const g = langs.get(l) || { language: l, races: 0, best: 0, quotes: 0, bestsWpm: 0, last: null };
    g.races++; g.best = Math.max(g.best, r.wpm); g.last = r.timestamp;
    langs.set(l, g);
  }
  for (const b of bests) {
    const g = langs.get(b.quote.language);
    if (g) { g.quotes++; g.bestsWpm += b.bestRace.wpm; }
  }

  return {
    races: rs.length,
    avgWpm: mean,
    bestWpm: Math.max(0, ...wpms),
    bestLast10,
    fastest10: avg([...wpms].sort((a, b) => b - a).slice(0, 10)),
    accuracy: avg(rs.map((r) => r.accuracy)),
    perfectAvg: avg(perfect.map((r) => r.wpm)),
    perfectShare: rs.length ? perfect.length / rs.length : 0,
    sd,
    cov: mean ? sd / mean : 0,
    wins: multi.filter(isWin).length,
    multi: multi.length,
    quoteBestsAvg: avg(bests.map((b) => b.bestRace.wpm)),
    quotes: bests.length,
    marathon,
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    languages: [...langs.values()].sort((a, b) => b.races - a.races),
    last20: rs.slice(-20).reverse(),
  };
}

if (typeof module !== "undefined") module.exports = { computeStats, isWin, monthKey };

if (typeof document !== "undefined") {
  const API = "https://api.typegg.io/v1";
  const FULL_REFETCH_MS = 7 * DAY_MS;  // pp rebalances rewrite old races
  const EVICT_MS = 30 * DAY_MS;        // drop histories not opened for a month
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const f = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n) => `${f(n * 100)}%`;
  const date = (ts) => new Date(ts).toLocaleString();
  const hours = (ms) => `${f(ms / 3_600_000, 1)} h`;
  const flag = (cc) => (cc || "").toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  const status = (msg) => { $("status").textContent = msg; };

  // ── IndexedDB cache: one record per user+view ──
  const db = new Promise((res, rej) => {
    const req = indexedDB.open("gt-career", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("users", { keyPath: "key" });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const tx = async (mode, fn) => {
    const store = (await db).transaction("users", mode).objectStore("users");
    return new Promise((res, rej) => { const r = fn(store); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  };
  async function evictOld() {
    for (const rec of await tx("readonly", (s) => s.getAll())) {
      if (Date.now() - rec.lastOpened > EVICT_MS) await tx("readwrite", (s) => s.delete(rec.key));
    }
  }

  // The site session lives in an httpOnly cookie; its name is not documented,
  // so take any typegg.io cookie whose value is (or wraps) a JWT.
  async function sessionToken() {
    const jwt = /^[\w-]+\.[\w-]+\.[\w-]+$/;
    for (const c of await chrome.cookies.getAll({ domain: "typegg.io" })) {
      const v = decodeURIComponent(c.value);
      if (jwt.test(v)) return v;
      try { const t = JSON.parse(v)?.token; if (jwt.test(t)) return t; } catch {}
    }
    return null;
  }

  async function api(path, token) {
    // A tripped per-IP limit comes back without CORS headers, so fetch rejects instead of returning 429.
    const r = await fetch(API + path, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
      .catch(() => { throw new Error("TypeGG API unreachable (usually the rate limit) — wait a minute and reload."); });
    if (r.status === 429) throw new Error("TypeGG rate limit hit — wait a minute and reload.");
    if (!r.ok) throw Object.assign(new Error(`${path} → HTTP ${r.status}`), { status: r.status });
    return r.json();
  }

  // Sequential paging keeps us well under the per-IP rate limit.
  async function allPages(path, field, token, label) {
    const out = [];
    for (let page = 1, total = 1; page <= total; page++) {
      status(`Loading ${label} (page ${page}/${total})…`);
      const d = await api(`${path}${path.includes("?") ? "&" : "?"}perPage=1000&page=${page}`, token);
      out.push(...d[field]);
      total = d.totalPages || 1;
    }
    return out;
  }

  async function load(username, forceFull) {
    const { gtAuthUser } = await chrome.storage.local.get("gtAuthUser");
    const own = !!gtAuthUser && gtAuthUser.toLowerCase() === username.toLowerCase();
    let token = own ? await sessionToken() : null;
    const u = encodeURIComponent(username);

    let user;
    try { user = await api(`/users/${u}`, token); }
    catch (e) { if (e.status !== 401 || !token) throw e; token = null; user = await api(`/users/${u}`); }

    const key = `${username.toLowerCase()}|${token ? "auth" : "public"}`;
    let rec = await tx("readonly", (s) => s.get(key));
    if (forceFull || !rec || Date.now() - rec.savedAt > FULL_REFETCH_MS) rec = null;

    const keep = (r) => r.completionType === "finished"; // quits/DNFs never count
    let races, bests;
    if (rec) {
      const from = Math.max(0, ...rec.races.map((r) => r.raceNumber || 0)) + 1;
      const fresh = (await allPages(`/users/${u}/races?startNumber=${from}`, "races", token, "new races")).filter(keep);
      races = rec.races.concat(fresh);
      bests = fresh.length ? await allPages(`/users/${u}/quotes?status=any`, "quotes", token, "quote bests") : rec.bests;
    } else {
      races = (await allPages(`/users/${u}/races`, "races", token, "races")).filter(keep);
      bests = await allPages(`/users/${u}/quotes?status=any`, "quotes", token, "quote bests");
    }
    const rankings = await api(`/users/${u}/quote-rankings?maxRank=100`, token);
    const savedAt = rec ? rec.savedAt : Date.now();
    await tx("readwrite", (s) => s.put({ key, races, bests, savedAt, lastOpened: Date.now() }));
    return { user, races, bests, rankings, authed: !!token, savedAt };
  }

  function chart(months) {
    const ms = [...months].reverse();
    if (ms.length < 2) return "";
    const W = 900, H = 260, P = 36, n = ms.length;
    const maxW = Math.max(...ms.map((m) => m.best)) * 1.05, maxR = Math.max(...ms.map((m) => m.races));
    const x = (i) => P + (i * (W - 2 * P)) / (n - 1);
    const y = (v) => H - P - (v / maxW) * (H - 2 * P);
    const line = (fn) => ms.map((m, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(fn(m)).toFixed(1)}`).join("");
    const bw = Math.max(2, (W - 2 * P) / n - 2);
    const bars = ms.map((m, i) => `<rect class="bar" x="${(x(i) - bw / 2).toFixed(1)}" width="${bw.toFixed(1)}" y="${(H - P - (m.races / maxR) * (H - 2 * P) * 0.4).toFixed(1)}" height="${((m.races / maxR) * (H - 2 * P) * 0.4).toFixed(1)}"><title>${m.month}: ${m.races} races</title></rect>`).join("");
    const step = Math.ceil(n / 12);
    const labels = ms.map((m, i) => (i % step ? "" : `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${m.month}</text>`)).join("");
    const grid = [0.25, 0.5, 0.75, 1].map((t) => `<line x1="${P}" x2="${W - P}" y1="${y(maxW * t)}" y2="${y(maxW * t)}"/><text x="4" y="${y(maxW * t) + 4}">${Math.round(maxW * t)}</text>`).join("");
    const dots = ms.map((m, i) => `<circle cx="${x(i)}" cy="${y(m.wpm / m.races)}" r="3"><title>${m.month}: avg ${f(m.wpm / m.races)} · best ${f(m.best)}</title></circle>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly average and best WPM, with race counts as bars">
      <g class="grid">${grid}</g>${bars}
      <path class="best" d="${line((m) => m.best)}"/><path class="avg" d="${line((m) => m.wpm / m.races)}"/>${dots}
      <g class="labels">${labels}</g></svg>
      <div class="legend"><span class="k avg"></span>Average WPM <span class="k best"></span>Best WPM <span class="k bar"></span>Races</div>`;
  }

  // Ranked and unranked races are separate tabs, never mixed: unranked quotes
  // (and custom lobby text, quoteId null) would skew the ranked career.
  function render(data, view = "ranked") {
    const { user, rankings, authed, savedAt } = data;
    const ranked = view === "ranked";
    const bests = data.bests.filter((b) => !!b.quote.ranked === ranked);
    const ids = new Set(data.bests.filter((b) => b.quote.ranked).map((b) => b.quote.quoteId));
    const races = data.races.filter((r) => ids.has(r.quoteId) === ranked);
    const s = computeStats(races, bests);
    const st = user.stats;
    const quoteText = new Map(bests.map((b) => [b.quote.quoteId, b.quote.text]));
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    const note = authed ? "" : `<p class="note">Public data: TypeGG only exposes this player's best solo race per quote, so non-PB solo races are missing (multiplayer is complete).</p>`;
    const ranks = Object.entries(rankings.positionCounts || {}).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]);
    const maxRank = Math.max(1, ...ranks.map((r) => r[1]));

    document.title = `${user.username} — TypeGG career`;
    $("content").innerHTML = `
      <h1>${flag(user.country)} <a href="https://typegg.io/user/${encodeURIComponent(user.username)}" target="_blank">${esc(user.displayName || user.username)}</a></h1>
      <p class="sub">Joined ${new Date(user.joinDate).toLocaleDateString()} · global rank #${user.globalRank} · history cached ${date(savedAt)}</p>
      ${note}
      <nav class="tabs">${["ranked", "unranked"].map((v) => `<button data-view="${v}" class="${v === view ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</nav>
      <section><h2>Summary</h2><table class="kv">
        ${row("Races", `${s.races.toLocaleString()} <small>(API total ${(ranked ? st.races : st.unrankedRaces || 0).toLocaleString()})</small>`)}
        ${row("Best last 10 races", `${f(s.bestLast10)} wpm`)}
        ${row("Best single race", `${f(s.bestWpm)} wpm`)}
        ${row("Average of fastest 10", `${f(s.fastest10)} wpm`)}
        ${row("Quote bests average", `${f(s.quoteBestsAvg)} wpm (${s.quotes.toLocaleString()} quotes)`)}
        ${row("Wins", `${s.wins.toLocaleString()} of ${s.multi.toLocaleString()} multiplayer (${pct(s.multi ? s.wins / s.multi : 0)})`)}
        ${ranked ? row("Total pp", f(st.totalPp)) + row("nWPM", f(st.nWpm)) : ""}
        ${row("Average career speed", `${f(s.avgWpm)} wpm`)}
        ${row("Accuracy", pct(s.accuracy))}
        ${row("100% accuracy races", `${f(s.perfectAvg)} wpm average (${pct(s.perfectShare)} of races)`)}
        ${row("Standard deviation", `${f(s.sd)} wpm`)}
        ${row("Coefficient of variation", pct(s.cov))}
        ${row("Top marathon", s.marathon.start ? `${s.marathon.races} races in 24 hours, starting ${date(s.marathon.start)}` : "—")}
        ${ranked ? row("Quote firsts / podiums / top 10", `${st.firsts} / ${st.podiums} / ${st.topTens}`) : ""}
        ${row("Daily quote streak", `${st.dailyQuotes?.streak ?? 0} (best ${st.dailyQuotes?.bestStreak ?? 0}, ${st.dailyQuotes?.completed ?? 0} done)`)}
      </table></section>
      <section><h2>Career by month</h2>${chart(s.months)}
        <table><thead><tr><th>Month</th><th>Average</th><th>Best</th><th>Races</th><th>Wins</th><th>Win %</th>${ranked ? "<th>Avg pp</th>" : ""}<th>Acc.</th><th>Time</th><th>Solo / Multi</th></tr></thead><tbody>
        ${s.months.map((m) => `<tr><td>${m.month}</td><td>${f(m.wpm / m.races)}</td><td>${f(m.best)}</td><td>${m.races}</td><td>${m.wins}</td><td>${m.multi ? pct(m.wins / m.multi) : "—"}</td>${ranked ? `<td>${f(m.pp / m.races)}</td>` : ""}<td>${pct(m.acc / m.races)}</td><td>${hours(m.timeMs)}</td><td>${m.solo} / ${m.multi}</td></tr>`).join("")}
        </tbody></table></section>
      <section><h2>Last 20 races</h2><table><thead><tr><th>Race</th><th>Date</th><th>WPM</th><th>Quote</th><th>Outcome</th><th>Acc.</th>${ranked ? "<th>pp</th>" : ""}</tr></thead><tbody>
        ${s.last20.map((r) => {
          const me = r.match?.players.find((p) => p.userId === r.userId);
          const outcome = r.match ? `${isWin(r) ? "Win" : "No win"} (${me?.placement ?? "?"} of ${r.match.players.length})` : "Solo";
          const text = quoteText.get(r.quoteId) || r.quoteId || "custom text";
          return `<tr><td>${r.raceNumber}</td><td>${date(r.timestamp)}</td><td>${f(r.wpm)}</td><td class="quote"><a href="https://typegg.io/solo/${encodeURIComponent(r.quoteId || "")}" target="_blank">${esc(text.slice(0, 60))}${text.length > 60 ? "…" : ""}</a></td><td>${outcome}</td><td>${pct(r.accuracy)}</td>${ranked ? `<td>${f(r.pp)}</td>` : ""}</tr>`;
        }).join("")}
        </tbody></table></section>
      <section><h2>Languages</h2><table><thead><tr><th>Language</th><th>Races</th><th>Best race</th><th>Quote bests avg</th><th>Quotes</th><th>Last race</th></tr></thead><tbody>
        ${s.languages.map((l) => `<tr><td>${esc(l.language)}</td><td>${l.races}</td><td>${f(l.best)}</td><td>${l.quotes ? f(l.bestsWpm / l.quotes) : "—"}</td><td>${l.quotes}</td><td>${date(l.last)}</td></tr>`).join("")}
        </tbody></table></section>
      ${ranked ? `<section><h2>Quote leaderboard placements</h2><p class="sub">How many quotes you place #1…#100 on (${(rankings.quotesTyped || 0).toLocaleString()} quotes typed).</p>
        <div class="hist">${ranks.map(([k, v]) => `<div class="col" title="#${k}: ${v} quotes"><div style="height:${(v / maxRank) * 100}%"></div></div>`).join("")}</div>
        <div class="hist-axis"><span>#1</span><span>#${ranks.at(-1)?.[0] ?? 100}</span></div></section>` : ""}`;
    for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => render(data, b.dataset.view);
  }

  async function show(forceFull) {
    const params = new URLSearchParams(location.search);
    const username = params.get("user") || (await chrome.storage.local.get("gtAuthUser")).gtAuthUser;
    $("user").value = username || "";
    if (!username) return status("Log in on typegg.io once (so the extension learns your name), or type a username.");
    try {
      const data = await load(username, forceFull);
      render(data);
      status(data.authed ? "Full history (logged in as this player)." : "");
    } catch (e) {
      status(`Error: ${e.message}`);
    }
  }

  $("go").addEventListener("submit", (e) => {
    e.preventDefault();
    location.search = `?user=${encodeURIComponent($("user").value.trim())}`;
  });
  $("refresh").addEventListener("click", () => show(true));
  evictOld().catch(() => {});
  show(false);
}

// node career.test.js — checks computeStats month buckets, win rule, quit/solo exclusion, marathon.
const assert = require("node:assert");
const { computeStats } = require("./career.js");

const p = (wpm, completionType = "finished") => ({ wpm, completionType });
const race = (n, ts, wpm, extra = {}) => ({ raceNumber: n, timestamp: ts, wpm, pp: 100, accuracy: 1, duration: 10_000, completionType: "finished", quoteId: "q1", ...extra });
const races = [
  race(1, "2026-01-10T10:00:00", 100),                                                       // solo: excluded
  race(2, "2026-01-10T12:00:00", 120, { match: { players: [p(120), p(110)] } }),           // win
  race(3, "2026-01-11T09:00:00", 90, { match: { players: [p(90), p(95)] } }),              // loss
  race(4, "2026-01-12T09:00:00", 200, { match: { players: [p(200), p(250, "quit")] } }),   // win: quitter ignored
  race(null, "2026-02-01T10:00:00", 50, { completionType: "quit" }),                        // excluded
  race(5, "2026-02-01T10:00:00", 80, { accuracy: 0.9 }),                                  // solo: excluded
];
const bests = [{ quote: { quoteId: "q1", language: "English" }, bestRace: { wpm: 200 } }];
const s = computeStats(races, bests);

assert.equal(s.races, 3);
assert.deepEqual(s.months.map((m) => [m.month, m.races, m.wins]), [["2026-01", 3, 2]]);
assert.equal(s.wins, 2);
assert.equal(s.bestWpm, 200);
assert.equal(s.avgWpm, 410 / 3);
assert.deepEqual(s.marathon, { races: 2, start: "2026-01-10T12:00:00" }); // race 4 is exactly 24h after race 3
assert.equal(s.perfectShare, 1);
assert.equal(s.languages[0].language, "English");
assert.equal(s.languages[0].races, 3);
assert.equal(s.last20[0].raceNumber, 4);
console.log("career.test.js: ok");

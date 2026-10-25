// ─────────────────────────────────────────────────────────────
// SENDWIZE — scripts/import-cases.mjs
// Builds the review list of every published ICO, ASA and CMA case that
// bears on marketing, straight from each regulator's own records:
//
//   ICO  the civil monetary penalties register (CSV on ico.org.uk)
//   CMA  every consumer enforcement case (GOV.UK search + content APIs)
//   ASA  every formal ruling, upheld or upheld in part (asa.org.uk)
//
// RULES
//   · Names, dates, amounts and summaries are copied from the regulator's
//     record. Nothing is written by AI and nothing is filled from memory.
//   · An amount is only taken from a structured field (ICO register) or
//     from the sentence where the CMA says it imposed a penalty. If that
//     sentence isn't there, the case has no amount.
//   · Finding types come from fixed rules (CAP Code rules cited, words in
//     the regulator's own description). A case no rule matches is held.
//   · Every case is checked against its source page. Any case that fails
//     is held with the reason.
//   · Nothing here goes live. The output is data/case-review.json; cases
//     only reach the product once approved (data/case-approvals.json) and
//     published by scripts/publish-cases.mjs.
//
// Run in CI (the regulator sites are reachable there):
//   node scripts/import-cases.mjs [--only=ico,cma,asa] [--from=2010]
// ─────────────────────────────────────────────────────────────
import { CASES } from '../api/_case-library.js';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = (arg('only') || 'ico,cma,asa').split(',');
const FROM_YEAR = Number(arg('from')) || 2008;
const UA = 'Mozilla/5.0 (compatible; SendwizeCaseImport/1.0; +https://sendwize.co.uk)';

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (r.status >= 500 && i < tries) throw new Error('HTTP ' + r.status);
      return { ok: r.ok, status: r.status, url: r.url, text: await r.text() };
    } catch (e) {
      if (i >= tries) return { ok: false, status: 0, url, text: '', error: e.message };
      await new Promise(res => setTimeout(res, 1500 * i));
    }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}
const ENT = { amp: '&', pound: '£', nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', quot: '"', apos: "'" };
const decode = t => t.replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const plain = t => decode(t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function isoFromWords(s) { // "18 December 2024" -> 2024-12-18
  const m = String(s).match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  const mo = m && MONTHS.indexOf(m[2].toLowerCase());
  return m && mo >= 0 ? `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const money = s => { const n = Number(String(s).replace(/[£,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
// Up to the last full sentence, so a cut-off listing summary never ends mid-thought
const wholeSentences = s => { s = String(s).trim(); if (!/(\.\.\.|…)$/.test(s)) return s; const i = s.lastIndexOf('. '); return i > 0 ? s.slice(0, i + 1) : s.replace(/(\.\.\.|…)$/, '…'); };
const lc = s => String(s).toLowerCase();

// Words a name must appear as on the source page (first distinctive word)
const matchFor = name => String(name).split(/[\s(]/).find(w => w.replace(/[^\w]/g, '').length > 1)?.replace(/^[^\w]+|[^\w]+$/g, '') || name;
const squash = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Shared tagging rules: regulator wording → Sendwize finding types ──
const TEXT_RULES = [
  [/time[- ]limited|countdown|urgen|pressure (sell|selling|tactic)|limited time/, 'fake_urgency'],
  [/drip|hidden (exit )?(fee|charge|cost)|booking fee|mandatory fee|mandatory charge|optional charge|pre-ticked|headline price|price transparen|additional (fee|charge)|delivery charge/, 'drip_pricing'],
  [/fake review|online review|review(s)? (were|was) (fake|not genuine)|consumer review|customer review|misleading review/, 'fake_reviews'],
  [/reference pric|was price|savings? claim|discount claim|price comparison|sale price|price promotion|pricing practice/, 'misleading_reference_price'],
  [/greenwash|green claim|environmental (claim|impact|benefit)|eco[- ]friendly|sustainab|carbon neutral|recyclable/, 'misleading_claim'],
  [/not (obviously )?identifiable as|hidden advertising|ad disclosure|#ad\b|affiliate link|paid[- ]for endorsement|endorsements on social media|clearly labelled/, 'undisclosed_ad'],
];
const textTypes = s => TEXT_RULES.filter(([re]) => re.test(lc(s))).map(([, t]) => t);

// ── ICO: civil monetary penalties register ──
const ICO_CSV = 'https://ico.org.uk/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv';
function csvRows(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(r => r.some(Boolean));
}
// Fines under the data protection laws only count when they are about marketing
const ICO_MARKETING = /\bmarketing|unsolicited|nuisance|wealth screening|data matching|data sharing|profil|lead gen|sold (personal )?data|selling (personal )?data/;
function icoTypes(nature, pecr) {
  const n = lc(nature), t = new Set();
  if (/unsolicited|tps|telephone preference|without (the required |valid )?consent|not consented|had not consented|nuisance|direct marketing|marketing (call|text|email|message)s?|automated call/.test(n)) t.add('consent_missing');
  if (/third[- ]part(y|ies)|purchased|bought|supplier|list broker|lead gen/.test(n)) t.add('third_party_list');
  if (/concealed|withheld|withholding|caller line|did not identify|failed to identify|spoof/.test(n)) t.add('affiliate_sender_identity_breach');
  if (/wealth screening|data matching|profil/.test(n)) { t.add('legitimate_interest_abuse'); t.add('data_quality'); }
  if (/data sharing|\bsold\b.{0,40}(data|details|records)|selling.{0,40}(data|details|records)|traded/.test(n)) t.add('dpa_breach');
  if (/breach reporting|personal data breach/.test(n)) return []; // PECR security rules, not marketing
  if (!t.size && pecr && /\bmarketing|call|text|email|message|regulation 2[1-3]\b/.test(n)) t.add('consent_missing');
  return [...t];
}
function icoSector(s) {
  s = lc(s);
  if (/financ|insurance|credit|pension|claims/.test(s)) return 'finance';
  if (/charit|voluntary/.test(s)) return 'charity';
  if (/health/.test(s)) return 'health';
  if (/retail/.test(s)) return 'ecommerce';
  if (/media|telecom|online tech|communications provider/.test(s)) return 'media';
  return null;
}
async function importIco(held) {
  const r = await get(ICO_CSV);
  if (!r.ok) throw new Error('ICO register did not load: ' + (r.error || r.status));
  const [head, ...rows] = csvRows(r.text);
  const col = name => head.findIndex(h => lc(h).trim() === name);
  const C = { name: col('data controller'), sector: col('sector'), nature: col('nature'), date: col('date of final notice'), dpa: col('dpa fine'), pecr: col('pecr fine') };
  if (Object.values(C).some(i => i < 0)) throw new Error('ICO register columns changed: ' + head.join(' | '));
  const out = [];
  for (const row of rows) {
    const name = row[C.name], nature = row[C.nature] || '', pecr = money(row[C.pecr]), dpa = money(row[C.dpa]);
    const dm = String(row[C.date]).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const base = { regulator: 'ICO', name, source: 'ICO penalties register', url: ICO_CSV };
    if (!name) continue;
    if (!pecr && !ICO_MARKETING.test(lc(nature))) continue; // security breaches, FOI and the like
    if (!dm || !(pecr || dpa)) { held.push({ ...base, reason: 'register row has no readable date or amount', raw: row.slice(0, 6) }); continue; }
    const date = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    const types = icoTypes(nature, pecr);
    const c = {
      id: `ico_${slug(name)}_${dm[3]}`, ...base, match: name, date, penalty: pecr || dpa,
      law: pecr ? 'PECR' : 'UK GDPR / DPA', volume: null, sector: icoSector(row[C.sector]),
      summary: nature.length > 400 ? wholeSentences(nature.slice(0, 400) + '...') : nature, types,
      evidence: { register_row: row.slice(0, 8) },
    };
    if (!types.length) { held.push({ ...c, reason: 'no finding-type rule matched the ICO description' }); continue; }
    if (!c.summary) c.summary = `${c.law} penalty recorded in the ICO register.`;
    out.push(c);
  }
  return out;
}

// ── CMA: consumer enforcement cases on GOV.UK ──
const CMA_OUTCOME = {
  'consumer-enforcement-undertakings': 'Gave undertakings to the CMA',
  'consumer-enforcement-court-order': 'Court order obtained by the CMA',
  'consumer-enforcement-changes-to-business-practices-agreed': 'Agreed to change its business practices',
};
function cmaSector(s) {
  s = lc([].concat(s || []).join(' '));
  if (/financ|insurance|banking|pension/.test(s)) return 'finance';
  if (/health|pharma|medical/.test(s)) return 'health';
  if (/clothing|household|retail|consumer-goods|electronics|furniture|food/.test(s)) return 'ecommerce';
  if (/media|communication|telecom|broadcast/.test(s)) return 'media';
  return null;
}
// The sentence where the CMA records a penalty, e.g.
// "12 October 2026: The CMA has given a Final Infringement Notice to Wayfair and has imposed a financial penalty of £4,800,000"
const CMA_PENALTY = /(?:(\d{1,2} [A-Z][a-z]+ \d{4}):[^.]{0,300}?)?(?:imposed|issued|given|fined)[^.]{0,120}?(?:financial )?(?:penalty|fine) of £([\d,]+(?:\.\d+)?)\s*(million|m\b)?/;
async function importCma(held) {
  const list = [];
  for (let start = 0; ; start += 200) {
    const r = await get(`https://www.gov.uk/api/search.json?filter_format=cma_case&filter_case_type=consumer-enforcement&count=200&start=${start}&fields=title,link,description,case_state,outcome_type,opened_date,closed_date,market_sector`);
    if (!r.ok) throw new Error('GOV.UK search did not load: ' + (r.error || r.status));
    const j = JSON.parse(r.text); list.push(...j.results);
    if (j.results.length < 200) break;
  }
  const out = [];
  await pool(list, 4, async x => {
    const name = x.title.split(':')[0].trim(), url = 'https://www.gov.uk' + x.link;
    const base = { regulator: 'CMA', name, source: 'GOV.UK CMA case page', url };
    const outcomeType = [].concat(x.outcome_type || [])[0];
    if (outcomeType === 'consumer-enforcement-no-action') return;
    const r = await get('https://www.gov.uk/api/content' + x.link);
    if (!r.ok) { held.push({ ...base, reason: 'case page did not load: ' + (r.error || r.status) }); return; }
    const body = plain(JSON.parse(r.text).details?.body || '');
    const multi = /,| and /.test(name); // several firms: a single amount can't be pinned to one of them
    const pm = !multi && body.match(CMA_PENALTY);
    const penalty = pm ? Math.round(money(pm[2]) * (pm[3] ? 1e6 : 1)) : null;
    // The date the penalty was recorded: the last dated entry before the penalty sentence
    const before = pm ? [...body.slice(Math.max(0, pm.index - 800), pm.index + pm[0].length).matchAll(/\d{1,2} [A-Z][a-z]+ \d{4}/g)].pop() : null;
    const date = (pm && pm[1] && isoFromWords(pm[1])) || (before && isoFromWords(before[0])) || x.closed_date || null;
    // Before April 2014 these cases were the Office of Fair Trading's
    const oft = date && date < '2014-04-01';
    const outcome = penalty ? null : (CMA_OUTCOME[outcomeType] || '').replace('the CMA', oft ? 'the OFT' : 'the CMA') || null;
    const tagText = `${x.title} ${x.description} ${body.slice(0, 1500)}`;
    const types = [...new Set([...textTypes(tagText), ...(/\bmisleading\b/i.test(tagText) ? ['misleading_claim'] : [])])];
    const c = {
      id: `cma_${slug(name)}_${(date || x.opened_date || '').slice(0, 4)}`, ...base, match: matchFor(name), date, penalty, outcome,
      law: 'Consumer protection law', volume: null, refunds: null, sector: cmaSector(x.market_sector),
      summary: x.description, types, evidence: { outcome_type: outcomeType || null, case_state: x.case_state, penalty_sentence: pm ? pm[0] : null },
    };
    if (!penalty && !outcome) { held.push({ ...c, reason: 'no outcome published yet (open investigation, no finding made)' }); return; }
    if (!date) { held.push({ ...c, reason: 'no decision date in the record' }); return; }
    if (!types.length) { held.push({ ...c, reason: 'no finding-type rule matched the CMA description' }); return; }
    out.push(c);
  });
  return out;
}

// ── ASA: formal rulings ──
// CAP Code (Edition 12) rules cited in the ruling → finding types
function capTypes(rules) {
  const t = new Set();
  for (const r of rules) {
    const [s, n] = r.split('.').map(Number);
    if (s === 2) t.add('undisclosed_ad');                                 // recognising marketing communications
    if (s === 3 && (n <= 17 || (n >= 53))) t.add('misleading_claim');      // misleading, substantiation, qualification, price statements
    if (s === 3 && n >= 18 && n <= 22) t.add('drip_pricing');               // quoted prices must include taxes and non-optional charges
    if (s === 3 && n >= 31 && n <= 32) t.add('fake_urgency');               // urgency of decision
    if (s === 3 && n >= 39 && n <= 44) t.add('misleading_reference_price'); // price comparisons
    if (s === 3 && n >= 45 && n <= 52) t.add('fake_reviews');               // endorsements and testimonials
    if (s === 8) t.add('misleading_claim');                                 // promotional marketing
    if (s === 10) t.add('consent_missing');                                 // database practice
    if (s === 11 || s === 14) t.add('misleading_claim');                    // environmental, financial products
    if (s === 12 || s === 13 || s === 15) { t.add('misleading_claim'); t.add('asa_liability'); } // health, weight, food claims
  }
  return [...t];
}
const ASA_LIST = 'https://www.asa.org.uk/codes-and-rulings/rulings.html';
function asaItems(html) {
  const tab = html.split('id="tab-1"')[1]?.split('id="tab-2"')[0] || '';
  return tab.split('<li class="icon-listing-item">').slice(1).map(h => {
    const url = (h.match(/href="(https:\/\/www\.asa\.org\.uk\/rulings\/[^"]+\.html)"/) || [])[1];
    const name = plain((h.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '');
    const caps = [...h.matchAll(/<span class="caption">([\s\S]*?)<\/span>/g)].map(x => plain(x[1]));
    const summary = plain((h.match(/<p>([\s\S]*?)<\/p>/) || [])[1] || '');
    return { url, name, decision: caps[0], media: caps[1], dateText: caps[caps.length - 1], summary };
  }).filter(x => x.url);
}
async function importAsa(held) {
  const items = [], years = [];
  for (let y = FROM_YEAR; y <= new Date().getFullYear(); y++) {
    const q = `${ASA_LIST}?q=&sort_order=recent&from_date=01/01/${y}&to_date=31/12/${y}`;
    const first = await get(q);
    if (!first.ok) throw new Error(`ASA listing for ${y} did not load: ${first.error || first.status}`);
    const total = Number((first.text.match(/Rulings <span[^>]*>\((\d+)\)/) || [])[1] || 0);
    const pages = Number((first.text.match(/data-total-page="(\d+)" data-tab="tab-1"/) || [])[1] || 1);
    const got = asaItems(first.text);
    for (let p = 2; p <= pages; p++) got.push(...asaItems((await get(`${q}&page=${p}`)).text));
    years.push({ year: y, listed: total, read: got.length });
    items.push(...got);
  }
  const seen = new Set(), out = [];
  const upheld = items.filter(x => /^upheld/i.test(x.decision || '') && !seen.has(x.url) && seen.add(x.url));
  await pool(upheld, 4, async x => {
    const base = { regulator: 'ASA', name: x.name, source: 'ASA ruling', url: x.url };
    const date = isoFromWords(x.dateText);
    const r = await get(x.url);
    if (!r.ok) { held.push({ ...base, reason: 'ruling page did not load: ' + (r.error || r.status) }); return; }
    const page = plain(r.text);
    const code = page.match(/CAP Code \(Edition \d+\)((?:\s+\d+\.\d+)+)/) || page.match(/BCAP Code((?:\s+\d+\.\d+)+)/);
    const rules = code ? code[1].trim().split(/\s+/) : [];
    const topic = (page.match(/More on ([A-Z][^.]{2,60}?) [A-Z][\w&'’ .-]* \d/) || [])[1] || null;
    const types = capTypes(code && /^CAP Code \(Edition 12\)/.test(code[0]) ? rules : []);
    for (const t of textTypes(x.summary)) if (t !== 'misleading_claim' || !types.length) types.push(t);
    const c = {
      id: `asa_${slug(x.name)}_${(x.url.match(/-(a\d{2}-\d+)-/i) || [, date?.slice(0, 4)])[1]}`.toLowerCase(), ...base,
      match: matchFor(x.name), date, penalty: null, outcome: /in part/i.test(x.decision) ? 'ASA ruling upheld in part' : 'Upheld ASA ruling',
      law: code ? code[0].split(/\s+\d/)[0] : 'ASA ruling', volume: null, sector: null, media: x.media || null,
      summary: wholeSentences(x.summary), types: [...new Set(types)], evidence: { rules, topic, decision: x.decision },
    };
    const problems = [];
    if (!squash(page).includes(squash(c.match))) problems.push(`ruling page does not mention "${c.match}"`);
    if (!/ASA Ruling on/i.test(page) || !/upheld/i.test(page)) problems.push('ruling page does not read as an upheld ASA ruling');
    if (!date) problems.push('no ruling date in the listing');
    if (!c.summary) problems.push('no summary in the listing');
    if (problems.length) { held.push({ ...c, reason: problems.join('; ') }); return; }
    if (!c.types.length) { held.push({ ...c, reason: 'not a Sendwize finding type (e.g. harm, offence, alcohol, gambling)' }); return; }
    out.push(c);
  });
  return { out, years };
}

// ── Source check for ICO and CMA cases (ASA is checked as it is read) ──
const amountForms = n => {
  const f = [n.toLocaleString('en-GB'), String(n)];
  if (n % 1000 === 0 && n < 1e6) f.push(`${n / 1000}k`);
  if (n >= 1e6) { const m = String(n / 1e6); f.push(`${m} million`, `${m}m`, `${m}M`); }
  return f;
};
const pageCache = new Map();
async function verify(c) {
  if (!pageCache.has(c.url)) pageCache.set(c.url, get(c.url).then(r => ({ ...r, text: r.url.endsWith('.csv') ? r.text : plain(r.text) })));
  const r = await pageCache.get(c.url);
  const p = [];
  if (!r.ok) return ['source did not load: ' + (r.error || r.status)];
  if (!/^https:\/\/(www\.)?(ico\.org\.uk|asa\.org\.uk|gov\.uk)\//.test(r.url)) p.push('source redirected off the regulator site');
  if (!squash(r.text).includes(squash(c.match))) p.push(`source does not mention "${c.match}"`);
  if (c.penalty && !amountForms(c.penalty).some(f => r.text.includes(f))) p.push(`source does not state £${c.penalty.toLocaleString('en-GB')}`);
  return p;
}

// ── Run ──
const held = [], found = [], report = {};
const knownAsa = new Set(CASES.filter(c => c.regulator === 'ASA').map(c => c.url));
const isKnown = c => c.regulator === 'ASA' ? knownAsa.has(c.url)
  : CASES.some(k => k.regulator === c.regulator && k.penalty && k.penalty === c.penalty && lc(k.name).split(/[\s(]/)[0] === lc(c.name).split(/[\s(]/)[0]);

if (ONLY.includes('ico')) { const x = await importIco(held); report.ICO = x.length; found.push(...x); }
if (ONLY.includes('cma')) { const x = await importCma(held); report.CMA = x.length; found.push(...x); }
if (ONLY.includes('asa')) { const x = await importAsa(held); report.ASA = x.out.length; report.asaYears = x.years; found.push(...x.out); }

const ids = new Map();
const ready = [], already = [];
await pool(found, 6, async c => {
  if (isKnown(c)) { already.push(c.id); return; }
  if (c.regulator !== 'ASA') { const p = await verify(c); if (p.length) { held.push({ ...c, reason: p.join('; ') }); return; } }
  ready.push(c);
});
for (const c of ready) { const n = (ids.get(c.id) || 0) + 1; ids.set(c.id, n); if (n > 1) c.id += '_' + n; }
const order = (a, b) => a.regulator.localeCompare(b.regulator) || String(b.date).localeCompare(String(a.date));
ready.sort(order); held.sort(order);

const counts = { ready: {}, held: {} };
for (const c of ready) counts.ready[c.regulator] = (counts.ready[c.regulator] || 0) + 1;
for (const c of held) counts.held[c.regulator] = (counts.held[c.regulator] || 0) + 1;
const reasons = {};
for (const c of held) reasons[c.reason] = (reasons[c.reason] || 0) + 1;

mkdirSync('data', { recursive: true });
writeFileSync('data/case-review.json', JSON.stringify({
  generated: new Date().toISOString(),
  note: 'Imported from regulator records. Not live: cases reach the product only once approved in data/case-approvals.json and published.',
  counts, alreadyInLibrary: already.length, asaYears: report.asaYears || null, heldReasons: reasons, ready, held,
}, null, 1) + '\n');

const line = `Ready for review: ${ready.length} (${Object.entries(counts.ready).map(([k, v]) => `${k} ${v}`).join(', ')}). Held back: ${held.length}. Already in the library: ${already.length}.`;
console.log(line);
console.log('Held back because:', reasons);
if (report.asaYears) console.log('ASA by year (listed / read):', report.asaYears.map(y => `${y.year} ${y.listed}/${y.read}`).join(', '));
if (process.env.GITHUB_STEP_SUMMARY) {
  const sample = ready.filter((_, i) => i % Math.max(1, Math.floor(ready.length / 15)) === 0).slice(0, 15);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Case import\n\n${line}\n\n| Held back because | Cases |\n|---|---|\n${Object.entries(reasons).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\n### Sample\n\n| Regulator | Case | Date | Outcome | Types |\n|---|---|---|---|---|\n${sample.map(c => `| ${c.regulator} | [${c.name.replace(/\|/g, '/')}](${c.url}) | ${c.date} | ${c.penalty ? '£' + c.penalty.toLocaleString('en-GB') : c.outcome} | ${c.types.join(', ')} |`).join('\n')}\n`);
}

// Temporary: prints how each regulator source is structured, so the
// importer can be written against the real pages. Run in CI only.
const UA = 'Mozilla/5.0 (compatible; SendwizeCaseImport/1.0; +https://sendwize.co.uk)';
const get = async (u, asJson) => { const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' }, redirect: 'follow' }); const t = await r.text(); return { status: r.status, url: r.url, type: r.headers.get('content-type'), text: t }; };
const strip = t => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
const tally = (rows, f) => { const m = {}; for (const x of rows) for (const v of [].concat(f(x) ?? '(none)')) m[v] = (m[v] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };

// ICO CSV: what the Nature and Sector columns hold
let r = await get('https://ico.org.uk/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv');
const lines = r.text.split(/\r?\n/).slice(1).filter(Boolean);
const cells = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c.trim()); c = ''; } else c += ch; } o.push(c.trim()); return o; };
const rows = lines.map(cells);
console.log('ICO rows', rows.length);
console.log('ICO Nature', JSON.stringify(tally(rows, x => x[2])));
console.log('ICO Sector', JSON.stringify(tally(rows, x => x[1])));
console.log('ICO with PECR fine', rows.filter(x => x[5]).length, 'with DPA fine', rows.filter(x => x[4]).length);
console.log('ICO Outcome', JSON.stringify(tally(rows, x => x[7]).slice(0, 15)));
console.log('ICO sample rows', JSON.stringify(rows.slice(0, 8)));

// CMA: every case's type, state and outcome
const all = [];
for (let start = 0; start < 3000; start += 1000) {
  r = await get(`https://www.gov.uk/api/search.json?filter_format=cma_case&count=1000&start=${start}&fields=title,link,case_type,case_state,outcome_type,opened_date,closed_date,market_sector`, true);
  const j = JSON.parse(r.text); all.push(...j.results); if (j.results.length < 1000) break;
}
console.log('CMA total', all.length);
console.log('CMA case_type', JSON.stringify(tally(all, x => x.case_type)));
console.log('CMA outcome_type', JSON.stringify(tally(all, x => x.outcome_type)));
const cons = all.filter(x => /consumer/.test(String(x.case_type)));
console.log('CMA consumer sample', JSON.stringify(cons.slice(0, 5)));
r = await get('https://www.gov.uk/api/search.json?filter_format=cma_case&filter_case_type=consumer-enforcement&count=2&fields=title,link', true);
console.log('CMA filter_case_type', r.status, r.text.slice(0, 400));

// ASA: the search form and a full ruling page
r = await get('https://www.asa.org.uk/codes-and-rulings/rulings.html');
console.log('ASA forms', JSON.stringify([...r.text.matchAll(/<form[^>]*>/gi)].map(m => m[0])));
console.log('ASA inputs', JSON.stringify([...new Set([...r.text.matchAll(/<(input|select)[^>]*name="([^"]+)"[^>]*>/gi)].map(m => m[0].slice(0, 200)))].slice(0, 40)));
console.log('ASA data-urls', JSON.stringify([...new Set([...r.text.matchAll(/(data-[a-z-]*url|data-endpoint|data-src)="([^"]+)"/gi)].map(m => m[0]))].slice(0, 20)));
for (const q of ['?q=&from_date=01/01/2024&to_date=31/12/2024', '?page=2', '?decision=Upheld']) {
  const x = await get('https://www.asa.org.uk/codes-and-rulings/rulings.html' + q);
  console.log('ASA', q, x.status, 'links', new Set([...x.text.matchAll(/href="([^"]*\/rulings\/[^"]+\.html)"/g)].map(m => m[1])).size, (x.text.match(/Rulings <span[^>]*>\((\d+)\)/) || [])[1]);
}
r = await get('https://www.asa.org.uk/rulings/john-lewis-plc-a26-1326172-john-lewis-plc.html');
const a = strip(r.text); const i = a.indexOf('Ad description');
console.log('ASA ruling text', a.slice(Math.max(0, i - 1500), i + 6000));
console.log('ASA ruling meta', JSON.stringify([...r.text.matchAll(/<meta[^>]+>/gi)].map(m => m[0]).slice(0, 30)));

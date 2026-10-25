// Temporary: prints how each regulator source is structured, so the
// importer can be written against the real pages. Run in CI only.
const UA = 'Mozilla/5.0 (compatible; SendwizeCaseImport/1.0; +https://sendwize.co.uk)';
const get = async (u, asJson) => { const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' }, redirect: 'follow' }); const t = await r.text(); return { status: r.status, url: r.url, type: r.headers.get('content-type'), text: t }; };
const show = (label, r, n = 3000) => { console.log(`\n===== ${label} [${r.status}] ${r.url} ${r.type} len=${r.text.length}`); console.log(r.text.slice(0, n)); };
const strip = t => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ');

// ICO: penalties CSV and the enforcement listing
let r = await get('https://ico.org.uk/media2/svrh3hyl/cmps-unpaid-paid-23-01425.csv'); show('ICO CSV', r, 2500);
console.log('ICO CSV lines:', r.text.split('\n').length);
r = await get('https://ico.org.uk/action-weve-taken/enforcement/?facet_type=Monetary+penalties'); 
const body = strip(r.text); const i = body.indexOf('enforcement/20');
show('ICO listing (around first entry)', { ...r, text: body.slice(Math.max(0, i - 1500), i + 3000) }, 4500);
console.log('ICO listing links:', [...r.text.matchAll(/href="([^"]*action-weve-taken\/enforcement\/20[^"]*)"/g)].slice(0, 15).map(m => m[1]));
console.log('ICO listing pagination:', [...r.text.matchAll(/href="([^"]*page=\d+[^"]*)"/g)].slice(0, 5).map(m => m[1]));
r = await get('https://ico.org.uk/action-weve-taken/enforcement/2024/01/grocery-delivery-e-services-uk-ltd-ta-hellofresh/');
const e = strip(r.text); const j = e.indexOf('HelloFresh');
show('ICO entry page', { ...r, text: e.slice(Math.max(0, j - 500), j + 3000) }, 3500);

// CMA: gov.uk search API
r = await get('https://www.gov.uk/api/search.json?filter_format=cma_case&count=3&fields=title,link,public_timestamp,description,case_type,case_state,market_sector,opened_date,closed_date,outcome_type', true); show('CMA search', r, 3000);
r = await get('https://www.gov.uk/api/search.json?filter_format=cma_case&count=0&facet_case_type=40&facet_outcome_type=60&facet_case_state=10', true); show('CMA facets', r, 6000);
r = await get('https://www.gov.uk/api/content/cma-cases/wayfair-consumer-protection-enforcement-case', true); show('CMA content', r, 4000);

// ASA: rulings listing and one ruling
r = await get('https://www.asa.org.uk/codes-and-rulings/rulings.html');
console.log('ASA listing status', r.status, 'len', r.text.length);
console.log('ASA ruling links:', [...new Set([...r.text.matchAll(/href="([^"]*\/rulings\/[^"]+\.html)"/g)].map(m => m[1]))].slice(0, 20));
console.log('ASA pagination/forms:', [...r.text.matchAll(/(href|action|data-[a-z-]+)="([^"]*(page|offset|start|load|ajax|json)[^"]*)"/gi)].slice(0, 20).map(m => m[0]));
const al = strip(r.text); const k = al.indexOf('Upheld');
show('ASA listing (around first "Upheld")', { ...r, text: al.slice(Math.max(0, k - 1500), k + 2500) }, 4000);
r = await get('https://www.asa.org.uk/rulings/john-lewis-plc-a26-1326172-john-lewis-plc.html');
const a = strip(r.text); const m = a.indexOf('John Lewis');
show('ASA ruling page', { ...r, text: a.slice(Math.max(0, m - 800), m + 5000) }, 6000);

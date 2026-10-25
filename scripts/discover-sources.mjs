// Temporary: prints how each regulator source is structured, so the
// importer can be written against the real pages. Run in CI only.
const UA = 'Mozilla/5.0 (compatible; SendwizeCaseImport/1.0; +https://sendwize.co.uk)';
const get = async u => { const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow' }); return { status: r.status, url: r.url, text: await r.text() }; };
const strip = t => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const L = 'https://www.asa.org.uk/codes-and-rulings/rulings.html';
const links = t => [...new Set([...t.matchAll(/href="([^"]*\/rulings\/[^"]+\.html)"/g)].map(m => m[1]))];
const q = '?q=&sort_order=recent&from_date=01/01/2024&to_date=31/12/2024';
for (const p of ['', '&page=2', '&start=20', '&offset=20', '&p=2', '&currentPage=2', '&from_date=01/01/2024&to_date=07/01/2024']) {
  const x = await get(L + q + p); const l = links(x.text);
  console.log('ASA', p || '(base)', x.status, (x.text.match(/Rulings <span[^>]*>\((\d+)\)/) || [])[1], (x.text.match(/Informally resolved <span[^>]*>\((\d+)\)/) || [])[1], l.length, l[0]);
}
let x = await get(L + q);
const s = strip(x.text); const i = s.indexOf('Rulings (');
console.log('ASA listing body', s.slice(i, i + 3000));
console.log('ASA load-more/paging bits', JSON.stringify([...x.text.matchAll(/<[^>]*(load-more|pagination|paging|next)[^>]*>/gi)].map(m => m[0]).slice(0, 10)));
const h = x.text.indexOf('/rulings/'); console.log('ASA first item html', x.text.slice(h - 1500, h + 1500));
for (const u of ['https://www.asa.org.uk/rulings/john-lewis-plc-a26-1326172-john-lewis-plc.html', 'https://www.asa.org.uk/rulings/dusk--retail--ltd-a25-1321807-dusk--retail--ltd.html']) {
  x = await get(u); const t = strip(x.text); const k = t.indexOf('Assessment');
  console.log('\nASA ruling end', x.status, u, t.slice(k, k + 200), ' ..... ', t.slice(t.indexOf('CAP Code') - 300, t.indexOf('CAP Code') + 600), ' ..... ', t.slice(t.indexOf('Action') , t.indexOf('Action') + 800));
}

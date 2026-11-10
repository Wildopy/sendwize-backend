// ─────────────────────────────────────────────────────────────
// SENDWIZE — _send-call.js
// The Go / Fix first / Hold answer for a piece of copy.
//
// This answer is about the copy only. The list, the landing pages and
// how the audience reacted to recent sends are separate tools, and a
// member may only have run this one, so the answer never claims more
// than it checked. COPY_NOT_CHECKED says what else to run before a send.
//
// Rules (the same as the old Send-day verdict used for its copy part):
//   Hold       any critical finding the marketer must change
//   Fix first  any high or medium finding, or any claim that needs
//              evidence on file (the marketer confirms they hold it)
//   Go         nothing above
// ─────────────────────────────────────────────────────────────

export const SEND_CALL_LABELS = { hold: 'Hold', fix_first: 'Fix first', go: 'Go' };

export const COPY_NOT_CHECKED = [
  { area: 'list',     tool: 'List health',      page: '/list-intelligence.html', text: 'Who it is going to: consent, opt-outs and bought data.' },
  { area: 'pages',    tool: 'Campaign defence', page: '/campaign-defence.html',  text: 'The landing pages it links to: prices, terms and offer details.' },
  { area: 'audience', tool: 'Audience read',    page: '/audience-read.html',     text: 'How this list reacted to recent sends: complaints and unsubscribes.' },
];

const sev = s => String(s || '').toLowerCase();

export function sendCall(violations = []) {
  const live = (violations || []).filter(v => sev(v.severity) !== 'low');
  const hold = live.filter(v => !v.requiresEvidence && sev(v.severity) === 'critical');
  const fix = live.filter(v => !hold.includes(v));
  const verdict = hold.length ? 'hold' : fix.length ? 'fix_first' : 'go';
  const n = (x, w) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const headline = verdict === 'hold'
    ? `Hold this copy. ${n(hold.length, 'item')} could put the campaign at risk.`
    : verdict === 'fix_first'
      ? `Fix ${n(fix.length, 'item')} in the copy first, then send.`
      : 'Go on the copy. Nothing in the wording needs review.';
  return { verdict, label: SEND_CALL_LABELS[verdict], headline, hold: hold.length, fix: fix.length, scope: 'copy', notChecked: COPY_NOT_CHECKED };
}

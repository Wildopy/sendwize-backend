// api/generate-reconsent-email.js
// Internal utility — called by audit-database-v2.js (reconsent-draft action only).
// Generates a PECR-compliant re-consent draft (email or SMS) via Claude.
// Does NOT send anything. Returns draft text for the user to copy into their own ESP.
// No streak call — this is not a user-facing tool completion.

const APP_URL = 'https://sendwize-backend.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Parameter validation ────────────────────────────────────────────────────
  const {
    userId,
    senderName,
    segmentDescription,
    channel,
    consentStatement,
    optInMechanism,
    contactCount,
  } = req.body ?? {};

  if (!userId)             return res.status(400).json({ error: 'Missing userId' });
  if (!senderName)         return res.status(400).json({ error: 'Missing senderName' });
  if (!segmentDescription) return res.status(400).json({ error: 'Missing segmentDescription' });
  if (!channel)            return res.status(400).json({ error: 'Missing channel' });
  if (!consentStatement)   return res.status(400).json({ error: 'Missing consentStatement' });
  if (!optInMechanism)     return res.status(400).json({ error: 'Missing optInMechanism' });

  if (channel !== 'email' && channel !== 'sms') {
    return res.status(400).json({ error: 'channel must be "email" or "sms"' });
  }

  // ── Build Claude prompt ─────────────────────────────────────────────────────
  const contactNote = contactCount != null
    ? `This draft will be sent to approximately ${contactCount} contacts.`
    : '';

  const channelRules = channel === 'sms'
    ? `
SMS-SPECIFIC RULES (mandatory):
- Keep the entire message under 160 characters where possible. If you must exceed 160 characters, stay under 320 (two SMS segments) and note the length at the end.
- Include the STOP opt-out keyword explicitly — e.g. "Reply STOP to opt out".
- No HTML whatsoever — plain text only.
- No subject line.
- Identify the sender by name at the start of the message (e.g. "Hi, this is [Sender Name]").
- Output format: plain text SMS copy only. On the final line, add: [Character count: N]`
    : `
EMAIL-SPECIFIC RULES (mandatory):
- Begin with a subject line on its own line, prefixed exactly: Subject: 
- Write in plain, professional English — no HTML markup in your output.
- Identify the sender by name clearly in the opening line or greeting.
- Include a dedicated unsubscribe / opt-out paragraph near the end.
- Do not use fake urgency, countdown language, or scarcity framing.
- Output format: subject line first, then a blank line, then the email body.`;

  const systemPrompt = `You are a UK marketing compliance specialist writing PECR-compliant re-consent drafts. You produce copy only — no commentary, no preamble, no sign-off notes. Your output is the draft itself, ready to copy and paste.`;

  const userPrompt = `Write a PECR-compliant re-consent ${channel === 'sms' ? 'SMS message' : 'email'} on behalf of ${senderName}.

CONTEXT:
- Sender name: ${senderName}
- Segment: ${segmentDescription}
- ${contactNote}
- Channel: ${channel.toUpperCase()}
- Consent wording to use: ${consentStatement}
- Opt-in mechanism: ${optInMechanism}

PECR COMPLIANCE REQUIREMENTS (all mandatory — do not omit any):
1. Clearly identify the sender by name — "${senderName}" must appear prominently.
2. Explain exactly what the recipient is being asked to consent to — reference "${consentStatement}" explicitly.
3. Name the specific channel ("${channel}") so the recipient knows what they are consenting to receive.
4. Describe the opt-in mechanism ("${optInMechanism}") clearly — consent must be active, not assumed or pre-ticked.
5. Include an unsubscribe / opt-out option — this is mandatory under PECR.
6. No dark patterns, fake urgency, misleading language, or pressure tactics of any kind.
7. Tone: respectful, transparent, and plain English.
${channelRules}

Produce the draft now. Output the draft copy only — nothing else.`;

  // ── Call Claude ─────────────────────────────────────────────────────────────
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!claudeRes.ok) {
      console.error('Claude API error:', claudeRes.status, await claudeRes.text());
      return res.status(500).json({ error: 'Failed to generate draft' });
    }

    const claudeData = await claudeRes.json();
    const draft = claudeData?.content?.[0]?.text?.trim();

    if (!draft) {
      console.error('Claude returned empty content:', JSON.stringify(claudeData));
      return res.status(500).json({ error: 'Failed to generate draft' });
    }

    // ── Return draft payload ──────────────────────────────────────────────────
    return res.status(200).json({
      draft,
      channel,
      senderName,
      generatedAt: new Date().toISOString(),
      disclaimer:
        'This draft is generated for informational purposes. You are responsible for reviewing it and sending it through your own systems. Information only — not legal advice.',
    });

  } catch (err) {
    console.error('generate-reconsent-email error:', err);
    return res.status(500).json({ error: 'Failed to generate draft' });
  }
}

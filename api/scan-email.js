export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { subject, html, userId } = req.body;
    
    if (!subject || !html) {
      return res.status(400).json({ error: 'Subject and HTML required' });
    }
    
    console.log(`Scanning email for user ${userId}`);
    
    const checks = [];
    let score = 100;
    
    // ============================================
    // CRITICAL CHECKS (10 points each)
    // ============================================
    
    // 1. Unsubscribe link
    const hasUnsubscribe = /unsubscribe|opt-out|opt out/i.test(html);
    const unsubLink = html.match(/<a[^>]*href=["']([^"']*unsubscribe[^"']*)["']/i);
    const unsubBroken = unsubLink && (unsubLink[1] === '#' || unsubLink[1] === 'javascript:void');
    
    if (!hasUnsubscribe) {
      checks.push({ status: 'fail', title: 'No Unsubscribe Link', description: 'PECR Regulation 22 requires clear unsubscribe mechanism. Add unsubscribe link immediately.' });
      score -= 10;
    } else if (unsubBroken) {
      checks.push({ status: 'fail', title: 'Broken Unsubscribe Link', description: 'Unsubscribe link goes nowhere. This violates PECR and traps users.' });
      score -= 10;
    } else {
      checks.push({ status: 'pass', title: 'Unsubscribe Link Present', description: 'Valid unsubscribe mechanism found.' });
    }
    
    // 2. Postal address (UK postcode)
    const ukPostcode = /[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}/i.test(html);
    const hasAddress = /address|registered office/i.test(html);
    
    if (!ukPostcode && !hasAddress) {
      checks.push({ status: 'fail', title: 'No Postal Address in Footer', description: 'PECR requires company postal address. This is a legal violation - add your registered address.' });
      score -= 10;
    } else {
      checks.push({ status: 'pass', title: 'Postal Address Found', description: 'Company address included in email.' });
    }
    
    // 3. Privacy policy
    const hasPrivacy = /privacy|data protection|gdpr/i.test(html);
    if (!hasPrivacy) {
      checks.push({ status: 'warning', title: 'No Privacy Policy Link', description: 'Best practice: Link to privacy policy to show transparency.' });
      score -= 5;
    } else {
      checks.push({ status: 'pass', title: 'Privacy Policy Linked', description: 'Privacy information provided.' });
    }
    
    // 4. Valid HTML structure
    const hasHtmlTag = /<html/i.test(html);
    const hasBodyTag = /<body/i.test(html);
    if (!hasHtmlTag || !hasBodyTag) {
      checks.push({ status: 'fail', title: 'Invalid HTML Structure', description: 'Missing basic HTML tags. Email may not render correctly.' });
      score -= 10;
    } else {
      checks.push({ status: 'pass', title: 'Valid HTML Structure', description: 'Proper HTML document structure.' });
    }
    
    // ============================================
    // SUBJECT LINE CHECKS (5 points each)
    // ============================================
    
    // Spam trigger words
    const spamWords = ['free', 'winner', 'claim', 'act now', 'urgent', 'limited time', 'click here', 'buy now', 'guarantee', 'cash', '$$$', '100%', 'risk-free', 'no obligation', 'order now'];
    const foundSpamWords = spamWords.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(subject));
    
    if (foundSpamWords.length > 2) {
      checks.push({ status: 'fail', title: 'High Spam Score in Subject', description: `Found ${foundSpamWords.length} spam trigger words: ${foundSpamWords.join(', ')}. Remove these to improve deliverability.` });
      score -= 10;
    } else if (foundSpamWords.length > 0) {
      checks.push({ status: 'warning', title: 'Spam Words in Subject', description: `Found: ${foundSpamWords.join(', ')}. Consider rewording.` });
      score -= 5;
    } else {
      checks.push({ status: 'pass', title: 'Clean Subject Line', description: 'No obvious spam trigger words detected.' });
    }
    
    // All caps check
    const capsCount = (subject.match(/[A-Z]/g) || []).length;
    const totalChars = subject.replace(/\s/g, '').length;
    const capsPercent = (capsCount / totalChars) * 100;
    
    if (capsPercent > 50) {
      checks.push({ status: 'warning', title: 'Excessive Caps in Subject', description: 'More than 50% uppercase. Looks like shouting and triggers spam filters.' });
      score -= 5;
    }
    
    // Excessive punctuation
    if (/[!?]{2,}/.test(subject)) {
      checks.push({ status: 'warning', title: 'Excessive Punctuation', description: 'Multiple exclamation or question marks look unprofessional and spammy.' });
      score -= 3;
    }
    
    // Subject length
    if (subject.length > 70) {
      checks.push({ status: 'warning', title: 'Subject Line Too Long', description: `${subject.length} characters. Mobile devices truncate at ~40 chars. Shorten for better open rates.` });
      score -= 3;
    } else if (subject.length < 20) {
      checks.push({ status: 'warning', title: 'Subject Line Too Short', description: 'Very short subjects often underperform. Aim for 40-50 characters.' });
      score -= 2;
    }
    
    // ============================================
    // EMAIL BODY CHECKS (5 points each)
    // ============================================
    
    // Text to image ratio
    const textContent = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const imageCount = (html.match(/<img/gi) || []).length;
    const textLength = textContent.length;
    
    if (imageCount > 0 && textLength < 100) {
      checks.push({ status: 'fail', title: 'Image-Only Email', description: 'Less than 100 chars of text. Spam filters block image-only emails. Add more text content.' });
      score -= 10;
    } else if (imageCount > textLength / 50) {
      checks.push({ status: 'warning', title: 'Low Text-to-Image Ratio', description: 'Too many images vs text. Aim for 60% text, 40% images.' });
      score -= 5;
    }
    
    // Alt text on images
    const imagesWithoutAlt = (html.match(/<img(?![^>]*alt=)/gi) || []).length;
    if (imagesWithoutAlt > 0) {
      checks.push({ status: 'warning', title: 'Missing Alt Text on Images', description: `${imagesWithoutAlt} images missing alt text. Required for accessibility and helps deliverability.` });
      score -= 5;
    }
    
    // Link validation
    const allLinks = html.match(/<a[^>]*href=["']([^"']*)["']/gi) || [];
    const httpLinks = allLinks.filter(link => /href=["']http:/i.test(link));
    const shortLinks = allLinks.filter(link => /bit\.ly|tinyurl|t\.co/i.test(link));
    
    if (httpLinks.length > 0) {
      checks.push({ status: 'warning', title: 'Insecure HTTP Links', description: `${httpLinks.length} links use HTTP instead of HTTPS. Modern email clients may block these.` });
      score -= 5;
    }
    
    if (shortLinks.length > 0) {
      checks.push({ status: 'warning', title: 'URL Shorteners Detected', description: 'Shortened URLs (bit.ly, etc) trigger spam filters. Use full URLs.' });
      score -= 3;
    }
    
    // Excessive links
    if (allLinks.length > 15) {
      checks.push({ status: 'warning', title: 'Too Many Links', description: `${allLinks.length} links found. More than 15 looks spammy. Focus on 1-3 main CTAs.` });
      score -= 5;
    }
    
    // Hidden text
    const hiddenText = /display:\s*none|visibility:\s*hidden|font-size:\s*0/i.test(html);
    if (hiddenText) {
      checks.push({ status: 'fail', title: 'Hidden Text Detected', description: 'CSS hiding text is a spam technique. Remove display:none, visibility:hidden, or font-size:0.' });
      score -= 10;
    }
    
    // JavaScript in email
    if (/<script/i.test(html)) {
      checks.push({ status: 'fail', title: 'JavaScript in Email', description: 'Email clients block JavaScript. Remove all <script> tags - they will not work.' });
      score -= 10;
    }
    
    // Forms in email
    if (/<form/i.test(html)) {
      checks.push({ status: 'warning', title: 'Form in Email', description: 'Most email clients do not support forms. Link to a landing page instead.' });
      score -= 5;
    }
    
    // ============================================
    // COMPLIANCE CHECKS (5 points each)
    // ============================================
    
    // "Free" without T&Cs
    if (/\bfree\b/i.test(subject) && !/terms|conditions|t&c/i.test(html)) {
      checks.push({ status: 'warning', title: '"Free" Claim Without T&Cs', description: 'ASA CAP Code requires terms when claiming "free". Add link to terms & conditions.' });
      score -= 5;
    }
    
    // Time-limited without date
    if (/limited time|ends soon|last chance|today only/i.test(html) && !/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(html)) {
      checks.push({ status: 'warning', title: 'Vague Time Limit', description: 'Claims like "limited time" must specify exact end date/time (CAP Code 3.7).' });
      score -= 5;
    }
    
    // "Limited stock" claim
    if (/limited stock|while supplies last|only \d+ left/i.test(html)) {
      checks.push({ status: 'warning', title: 'Limited Stock Claim', description: 'Must be able to prove stock levels if challenged. Ensure this is accurate.' });
      score -= 3;
    }
    
    // ============================================
    // BEST PRACTICES (2-3 points each)
    // ============================================
    
    // Preheader text
    const hasPreheader = /<div[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>[^<]{20,}/i.test(html);
    if (!hasPreheader) {
      checks.push({ status: 'warning', title: 'No Preheader Text', description: 'Add hidden preheader text for better inbox preview.' });
      score -= 2;
    }
    
    // Mobile responsive
    const hasViewport = /<meta[^>]*viewport/i.test(html);
    if (!hasViewport) {
      checks.push({ status: 'warning', title: 'Not Mobile Optimized', description: 'Missing viewport meta tag. 60%+ of emails are opened on mobile.' });
      score -= 3;
    }
    
    // Email size
    const emailSize = new Blob([html]).size;
    if (emailSize > 102000) {
      checks.push({ status: 'warning', title: 'Email Too Large', description: `${Math.round(emailSize/1000)}KB. Gmail clips emails over 102KB. Optimize images and reduce HTML.` });
      score -= 5;
    }
    
    // Template placeholders left in
    if (/\{\{|\[\[|lorem ipsum|test|draft|todo/i.test(html)) {
      checks.push({ status: 'fail', title: 'Template Placeholders Found', description: 'Unfinished template detected. Replace all {{placeholders}}, Lorem ipsum, or TODO items.' });
      score -= 10;
    }
    
    // ============================================
    // CALCULATE FINAL SCORE
    // ============================================
    
    score = Math.max(0, Math.min(100, score));
    
    // Save to Airtable
    if (userId) {
      try {
        const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
        const BASE_ID = process.env.BASE_ID;
        
        await fetch(`https://api.airtable.com/v0/${BASE_ID}/Email_Scans`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID: userId,
                ScanDate: new Date().toISOString().split('T')[0],
                Subject: subject,
                Score: score,
                ChecksPassed: checks.filter(c => c.status === 'pass').length,
                Warnings: checks.filter(c => c.status === 'warning').length,
                CriticalIssues: checks.filter(c => c.status === 'fail').length,
                Results: JSON.stringify({ checks })
              }
            }]
          })
        });
        
        console.log('Saved email scan to Airtable');
      } catch (e) {
        console.error('Airtable save failed:', e);
      }
    }
    
    res.json({
      score,
      checks,
      summary: {
        passed: checks.filter(c => c.status === 'pass').length,
        warnings: checks.filter(c => c.status === 'warning').length,
        failed: checks.filter(c => c.status === 'fail').length
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Scan failed' });
  }
}

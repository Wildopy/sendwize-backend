export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { contacts, customerType, productType, emailType, userId } = req.body;
    
    const consumerDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'me.com', 'googlemail.com'];
    const today = new Date();
    
    const results = {
      total: contacts.length,
      safe: [],
      probably: [],
      risky: [],
      danger: [],
      expiryTimeline: { labels: [], data: [] },
      sourceQuality: []
    };
    
    // Analyze each contact
    contacts.forEach(contact => {
      let score = 100;
      let category = '';
      let reasons = [];
      
      const email = contact.email.toLowerCase();
      const domain = email.split('@')[1] || '';
      const isB2B = emailType === 'b2b' || (emailType === 'mixed' && !consumerDomains.includes(domain));
      const isPersonalLooking = email.includes('.') && !consumerDomains.includes(domain); // john.smith@company.com
      
      // Check 1: No consent date
      if (!contact.consentDate) {
        score = 0;
        category = 'No consent date - CRITICAL';
        results.danger.push({ ...contact, score, category });
        return;
      }
      
      // Parse date
      let consentDate;
      try {
        consentDate = new Date(contact.consentDate);
        if (isNaN(consentDate.getTime())) throw new Error();
      } catch (e) {
        score = 0;
        category = 'Invalid date - CRITICAL';
        results.danger.push({ ...contact, score, category });
        return;
      }
      
      const ageYears = (today - consentDate) / (365 * 24 * 60 * 60 * 1000);
      
      // Check 2: Invalid methods
      const methodLower = (contact.consentMethod || '').toLowerCase();
      if (['pre-ticked', 'preticked', 'pre-tick', 'assumed', 'implied'].some(m => methodLower.includes(m))) {
        score = 0;
        category = 'Pre-ticked/Invalid method - PECR violation';
        results.danger.push({ ...contact, score, category });
        return;
      }
      
      // Check 3: Purchased lists
      const sourceLower = (contact.source || '').toLowerCase();
      if (['purchased', 'bought', 'third party', 'third-party', 'broker'].some(s => sourceLower.includes(s))) {
        score = 0;
        category = 'Purchased list - No valid consent';
        results.danger.push({ ...contact, score, category });
        return;
      }
      
      // Check 4: Age of consent
      if (ageYears > 3) {
        score -= 50;
        reasons.push('3+ years old');
      } else if (ageYears > 2) {
        score -= 30;
        reasons.push('2-3 years old');
      } else if (ageYears > 1) {
        score -= 10;
        reasons.push('1-2 years old');
      }
      
      // Check 5: Soft opt-in logic (PECR Reg 22(3))
      const isCustomer = customerType === 'all' || (customerType === 'some' && sourceLower.includes('purchase'));
      
      if (isCustomer) {
        // They're a customer - soft opt-in might apply
        if (productType === 'similar') {
          // Soft opt-in VALID
          score = Math.max(score, 85); // Boost score
          category = 'Soft opt-in (similar products)';
        } else if (productType === 'different') {
          // Soft opt-in INVALID for different products
          score = 30;
          category = 'Soft opt-in INVALID (different products) - Need express consent';
          reasons.push('Marketing different products');
        } else {
          // Mixed products
          score -= 20;
          category = 'Soft opt-in (verify product similarity)';
          reasons.push('Unclear if products similar');
        }
      }
      
      // Check 6: B2B emails
      if (isB2B) {
        if (isPersonalLooking) {
          score -= 15;
          reasons.push('Looks like personal email at work domain');
        } else {
          score = Math.max(score, 75); // B2B corporate emails are safer
          category = category || 'B2B corporate email';
        }
      }
      
      // Check 7: No consent method specified
      if (!contact.consentMethod || contact.consentMethod.trim() === '' || methodLower === 'n/a') {
        score -= 25;
        reasons.push('No consent method documented');
      }
      
      // Check 8: Unclear source
      if (!contact.source || contact.source.trim() === '') {
        score -= 15;
        reasons.push('Source not documented');
      }
      
      // Final categorization
      contact.score = Math.max(0, Math.min(100, score));
      contact.category = category || reasons.join(', ') || 'Express consent';
      
      if (contact.score >= 90) {
        results.safe.push(contact);
      } else if (contact.score >= 70) {
        results.probably.push(contact);
      } else if (contact.score >= 40) {
        results.risky.push(contact);
      } else {
        results.danger.push(contact);
      }
    });
    
    // Expiry timeline (next 12 months)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const expiryByMonth = {};
    
    for (let i = 0; i < 12; i++) {
      const d = new Date(today);
      d.setMonth(today.getMonth() + i);
      const key = `${months[d.getMonth()]} ${d.getFullYear()}`;
      expiryByMonth[key] = 0;
    }
    
    [...results.risky, ...results.probably].forEach(c => {
      try {
        const cd = new Date(c.consentDate);
        const expiry = new Date(cd);
        expiry.setFullYear(cd.getFullYear() + 2);
        
        if (expiry >= today) {
          const key = `${months[expiry.getMonth()]} ${expiry.getFullYear()}`;
          if (expiryByMonth[key] !== undefined) expiryByMonth[key]++;
        }
      } catch (e) {}
    });
    
    results.expiryTimeline.labels = Object.keys(expiryByMonth);
    results.expiryTimeline.data = Object.values(expiryByMonth);
    
    // Source quality
    const sourceStats = {};
    contacts.forEach(c => {
      const source = c.source || 'Unknown';
      if (!sourceStats[source]) {
        sourceStats[source] = { total: 0, scores: [] };
      }
      sourceStats[source].total++;
      sourceStats[source].scores.push(c.score || 0);
    });
    
    results.sourceQuality = Object.keys(sourceStats)
      .map(source => {
        const avg = Math.round(sourceStats[source].scores.reduce((a, b) => a + b, 0) / sourceStats[source].total);
        let rating = 'Critical';
        if (avg >= 85) rating = 'Excellent';
        else if (avg >= 70) rating = 'Good';
        else if (avg >= 50) rating = 'Poor';
        
        return { source, total: sourceStats[source].total, avgScore: avg, rating };
      })
      .sort((a, b) => b.avgScore - a.avgScore);
    
    // Save to Airtable
    if (userId) {
      try {
        await fetch(`https://api.airtable.com/v0/${process.env.BASE_ID}/Database_Audits`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID: userId,
                AuditDate: new Date().toISOString().split('T')[0],
                Total: results.total,
                Safe: results.safe.length,
                Probably: results.probably.length,
                Risky: results.risky.length,
                Danger: results.danger.length,
                Results: JSON.stringify(results)
              }
            }]
          })
        });
      } catch (e) {
        console.error('Airtable save failed:', e);
      }
    }
    
    res.json(results);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
}

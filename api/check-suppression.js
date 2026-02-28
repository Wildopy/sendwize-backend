export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { sendList, suppressionList, userId } = req.body;
    
    if (!sendList || !suppressionList || !Array.isArray(sendList) || !Array.isArray(suppressionList)) {
      return res.status(400).json({ error: 'Invalid lists provided' });
    }
    
    console.log(`Checking suppression for user ${userId}: ${sendList.length} send vs ${suppressionList.length} suppression`);
    
    // Email validation regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    // Normalize all emails (lowercase, trim)
    const normalizedSendList = sendList.map(email => email.toLowerCase().trim());
    const normalizedSuppressionList = suppressionList.map(email => email.toLowerCase().trim());
    
    // Convert to Sets for fast lookup
    const sendSet = new Set(normalizedSendList);
    const suppressionSet = new Set(normalizedSuppressionList);
    
    // Find matches (emails in both lists)
    const matches = normalizedSendList.filter(email => suppressionSet.has(email));
    
    // Find duplicates in send list
    const duplicates = normalizedSendList.filter((email, index, arr) => arr.indexOf(email) !== index);
    const uniqueDuplicates = [...new Set(duplicates)];
    
    // Validate email syntax
    const invalidEmails = normalizedSendList.filter(email => !emailRegex.test(email));
    
    // Detect role-based emails (info@, sales@, admin@, etc.)
    const roleEmails = normalizedSendList.filter(email => 
      /^(info|sales|admin|support|contact|hello|help|service|team|marketing|hr|office|reception)@/i.test(email)
    );
    
    // Clean list (remove matches, duplicates, invalid)
    const toRemove = new Set([...matches, ...duplicates, ...invalidEmails]);
    const cleanList = normalizedSendList.filter((email, index, arr) => 
      !toRemove.has(email) && arr.indexOf(email) === index && emailRegex.test(email)
    );
    
    // Create detailed analysis
    const analysis = {
      sendListCount: normalizedSendList.length,
      suppressionListCount: normalizedSuppressionList.length,
      matches: matches,
      matchCount: matches.length,
      duplicateCount: uniqueDuplicates.length,
      duplicates: uniqueDuplicates.slice(0, 20), // First 20 for display
      invalidCount: invalidEmails.length,
      invalidEmails: invalidEmails.slice(0, 10),
      roleEmailCount: roleEmails.length,
      roleEmails: roleEmails.slice(0, 10),
      cleanList: cleanList,
      cleanListCount: cleanList.length,
      removedCount: normalizedSendList.length - cleanList.length
    };
    
    // Generate warnings
    const warnings = [];
    
    if (analysis.matchCount > 0) {
      warnings.push({
        severity: 'critical',
        message: `${analysis.matchCount} emails found in suppression list. Sending to these could result in spam complaints and damage sender reputation.`
      });
    }
    
    if (analysis.duplicateCount > 0) {
      warnings.push({
        severity: 'warning',
        message: `${analysis.duplicateCount} duplicate emails found. Sending duplicates wastes resources and annoys recipients.`
      });
    }
    
    if (analysis.invalidCount > 0) {
      warnings.push({
        severity: 'warning',
        message: `${analysis.invalidCount} emails have invalid syntax (e.g., missing @, .com). These will hard bounce.`
      });
    }
    
    if (analysis.roleEmailCount > 0) {
      warnings.push({
        severity: 'info',
        message: `${analysis.roleEmailCount} role-based emails detected (info@, sales@). These typically have lower engagement rates.`
      });
    }
    
    // Save to Airtable
    if (userId) {
      try {
        const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
        const BASE_ID = process.env.BASE_ID;
        
        await fetch(`https://api.airtable.com/v0/${BASE_ID}/Suppression_Checks`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            records: [{
              fields: {
                UserID: userId,
                CheckDate: new Date().toISOString().split('T')[0],
                SendListSize: analysis.sendListCount,
                SuppressionListSize: analysis.suppressionListCount,
                MatchesFound: analysis.matchCount,
                DuplicatesFound: analysis.duplicateCount,
                InvalidEmailsFound: analysis.invalidCount,
                CleanListSize: analysis.cleanListCount,
                Results: JSON.stringify(analysis)
              }
            }]
          })
        });
        
        console.log('Saved suppression check to Airtable');
      } catch (e) {
        console.error('Airtable save failed:', e);
      }
    }
    
    res.json({
      ...analysis,
      warnings,
      recommendation: analysis.matchCount === 0 && analysis.duplicateCount === 0 && analysis.invalidCount === 0
        ? 'Your send list is clean! Safe to proceed.'
        : `Clean your list before sending. Remove ${analysis.removedCount} problematic emails.`
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Suppression check failed' });
  }
}

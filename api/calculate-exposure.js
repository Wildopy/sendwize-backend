export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    
    // Fetch all user's compliance data
    const [aiScans, dbAudits, pecrChecks] = await Promise.all([
      fetch(`https://api.airtable.com/v0/${BASE_ID}/AI_Compliance_Checks?filterByFormula={UserID}='${userId}'&sort[0][field]=CheckDate&sort[0][direction]=desc&maxRecords=30`, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      }).then(r => r.json()),
      
      fetch(`https://api.airtable.com/v0/${BASE_ID}/Database_Audits?filterByFormula={UserID}='${userId}'&sort[0][field]=AuditDate&sort[0][direction]=desc&maxRecords=10`, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      }).then(r => r.json()),
      
      fetch(`https://api.airtable.com/v0/${BASE_ID}/Submissions?filterByFormula={UserID}='${userId}'&sort[0][field]=SubmissionDate&sort[0][direction]=desc&maxRecords=20`, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      }).then(r => r.json())
    ]);
    
    const aiRecords = aiScans.records || [];
    const dbRecords = dbAudits.records || [];
    const pecrRecords = pecrChecks.records || [];
    
    // CALCULATE EXPOSURE FROM ACTIVE CAMPAIGNS
    const activeCampaigns = [];
    let campaignRisk = 0;
    
    // Get recent AI scans (last 30 days = likely active)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    aiRecords.forEach(record => {
      const checkDate = new Date(record.fields.CheckDate || '2000-01-01');
      if (checkDate < thirtyDaysAgo) return;
      
      const score = record.fields.RiskScore || 0;
      let risk = 0;
      
      // Calculate risk based on score and violations
      if (score < 40) risk = 15000; // Critical = £15k avg
      else if (score < 60) risk = 8000; // High = £8k avg
      else if (score < 80) risk = 3000; // Medium = £3k avg
      
      if (risk > 0) {
        const violations = JSON.parse(record.fields.Violations || '[]');
        const highSeverity = violations.filter(v => v.severity === 'high').length;
        
        activeCampaigns.push({
          name: record.fields.FileName || 'Marketing Campaign',
          score: score,
          risk: risk,
          issues: violations.slice(0, 2).map(v => v.issue),
          date: record.fields.CheckDate
        });
        
        campaignRisk += risk;
      }
    });
    
    // CALCULATE DATABASE EXPOSURE
    let databaseRisk = 0;
    const databaseIssues = [];
    
    if (dbRecords.length > 0) {
      const latestAudit = dbRecords[0].fields;
      const danger = latestAudit.Danger || 0;
      const warning = latestAudit.Warning || 0;
      
      // ICO fines average £100 per violation (based on real cases)
      // Critical issues (expired consent) = higher risk
      const expiredConsentRisk = danger * 150;
      const missingOptInRisk = warning * 50;
      
      if (danger > 0) {
        databaseIssues.push({
          type: 'Expired consents',
          count: danger,
          risk: expiredConsentRisk,
          severity: 'critical'
        });
        databaseRisk += expiredConsentRisk;
      }
      
      if (warning > 0) {
        databaseIssues.push({
          type: 'Missing opt-in proof',
          count: warning,
          risk: missingOptInRisk,
          severity: 'high'
        });
        databaseRisk += missingOptInRisk;
      }
    }
    
    // CALCULATE PECR EXPOSURE
    let pecrRisk = 0;
    const pecrIssues = [];
    
    pecrRecords.forEach(record => {
      const result = record.fields.Result || '';
      if (result === "DON'T SEND THIS CAMPAIGN") {
        pecrIssues.push({
          campaign: record.fields.CampaignName || 'Campaign',
          risk: 12000, // Average PECR fine
          date: record.fields.SubmissionDate
        });
        pecrRisk += 12000;
      }
    });
    
    // TOTAL EXPOSURE
    const totalExposure = campaignRisk + databaseRisk + pecrRisk;
    
    // PRIORITIZED FIX LIST
    const fixes = [];
    
    // Add campaign fixes (highest risk first)
    activeCampaigns
      .sort((a, b) => b.risk - a.risk)
      .forEach(c => {
        fixes.push({
          priority: c.risk > 10000 ? 'critical' : c.risk > 5000 ? 'high' : 'medium',
          action: `Fix campaign: ${c.name}`,
          risk: c.risk,
          impact: `Reduce exposure by £${c.risk.toLocaleString()}`,
          quickFix: 'Run AI Auto-Fix',
          link: '/ai-checker.html'
        });
      });
    
    // Add database fixes
    databaseIssues.forEach(issue => {
      fixes.push({
        priority: issue.severity,
        action: `Clean ${issue.count} contacts with ${issue.type}`,
        risk: issue.risk,
        impact: `Reduce exposure by £${issue.risk.toLocaleString()}`,
        quickFix: 'Run Consent Manager',
        link: '/consent-manager.html'
      });
    });
    
    // Sort by risk
    fixes.sort((a, b) => b.risk - a.risk);
    
    res.json({
      totalExposure,
      breakdown: {
        campaigns: campaignRisk,
        database: databaseRisk,
        pecr: pecrRisk
      },
      activeCampaigns: activeCampaigns.slice(0, 5),
      databaseIssues,
      pecrIssues,
      fixes: fixes.slice(0, 10),
      summary: {
        criticalIssues: fixes.filter(f => f.priority === 'critical').length,
        highIssues: fixes.filter(f => f.priority === 'high').length,
        mediumIssues: fixes.filter(f => f.priority === 'medium').length
      }
    });
    
  } catch (error) {
    console.error('Error calculating exposure:', error);
    res.status(500).json({ error: error.message });
  }
}

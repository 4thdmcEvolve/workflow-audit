const ipRequests = new Map();
const RATE_LIMIT = 15;
const WINDOW_MS = 60 * 60 * 1000;

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipRequests.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    ipRequests.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIP(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in an hour.' });
  }

  const { answers, contact } = req.body;

  if (!answers || !contact) {
    return res.status(400).json({ error: 'Missing answers or contact data' });
  }

  const prompt = `You are a senior business workflow consultant for 4THDMC | EVOLVE LLC. Analyze these intake answers and return ONLY valid JSON — no markdown fences, no preamble, no extra text.

Business type: ${answers.s0}
Team size: ${answers.s1}
Weekly leads: ${answers.s2}
Lead follow-up speed: ${answers.s3}
Biggest time drains: ${answers.s4}
Current tech setup: ${answers.s5}
Revenue situation: ${answers.s6}
90-day goal: ${answers.s7 || 'Not specified'}
Name: ${contact.name}

Return exactly this structure:
{"greeting":"One warm direct sentence using their name and acknowledging their specific business type and revenue situation.","summary":"2-3 sentences identifying their core workflow problem. Be specific to their actual answers. Reference their lead volume, team size, and revenue situation. No generic filler.","gaps":[{"rank":1,"title":"4-6 word gap title","description":"2 sentences specific to their situation explaining the revenue or time cost of this gap. Reference details from their answers.","impact":"e.g. High revenue leak"},{"rank":2,"title":"4-6 word gap title","description":"2 sentences specific to their situation.","impact":"e.g. Medium time drain"},{"rank":3,"title":"4-6 word gap title","description":"2 sentences specific to their situation.","impact":"e.g. Growth bottleneck"}],"next_step":"One direct actionable sentence — the single most important thing they should do first based on everything they told you.","begin_hook":"One sentence explaining specifically what the Begin engagement would do for this particular business owner. Make it feel personal to their situation, not templated."}`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const anthropicData = await anthropicRes.json();
    const raw = (anthropicData.content || [])
      .map(b => b.text || '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    const report = JSON.parse(raw);

    await addToBrevo(contact, answers, report);

    return res.status(200).json({ report });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: 'Failed to generate report' });
  }
}

async function addToBrevo(contact, answers, report) {
  const nameParts = contact.name.trim().split(' ');
  const firstName = nameParts[0] || contact.name;
  const lastName = nameParts.slice(1).join(' ') || '';

  const notes = [
    'Business: ' + contact.businessName,
    'Lead Source: Workflow Audit Tool',
    'Date: ' + new Date().toISOString().split('T')[0],
    '--- AUDIT ANSWERS ---',
    'Business Type: ' + answers.s0,
    'Team Size: ' + answers.s1,
    'Weekly Leads: ' + answers.s2,
    'Follow-up Speed: ' + answers.s3,
    'Time Drains: ' + answers.s4,
    'Tech Setup: ' + answers.s5,
    'Revenue Situation: ' + answers.s6,
    '90-Day Goal: ' + (answers.s7 || 'Not specified'),
    '--- AUDIT RESULTS ---',
    'Gap 1: ' + (report.gaps[0] ? report.gaps[0].title : ''),
    'Gap 2: ' + (report.gaps[1] ? report.gaps[1].title : ''),
    'Gap 3: ' + (report.gaps[2] ? report.gaps[2].title : ''),
    'Next Step: ' + (report.next_step || '')
  ].join('\n');

  const brevoPayload = {
    email: contact.email,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME: lastName,
      SMS: contact.phone,
      NOTES: notes
    },
    listIds: [13],
    updateEnabled: true
  };

  const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify(brevoPayload)
  });

  if (!brevoRes.ok) {
    const errText = await brevoRes.text();
    console.error('Brevo error:', errText);
  }
}

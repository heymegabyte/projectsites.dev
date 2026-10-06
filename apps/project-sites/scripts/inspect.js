#!/usr/bin/env node
/**
 * GPT-4o visual inspection script for container builds.
 * Pre-baked into Docker image at /home/cuser/inspect.js
 *
 * Usage: node inspect.js <html-file-path>
 * Requires: OPENAI_API_KEY env var
 * Outputs: JSON critique to stdout
 *
 * PROVIDER POLICY (category-B PRODUCT, PRESERVED — rules/agent-provider-policy.md
 * § Product-runtime boundary + ADR-0057): GPT-4o VISION QA of a generated CUSTOMER site.
 * Vision has no DeepSeek equivalent, so OpenAI stays — this is product delivery, not internal
 * dev orchestration. (A Workers-AI-vision rung is a possible FUTURE enhancement, not a policy fix.)
 */
const https = require('https');
const fs = require('fs');

const htmlPath = process.argv[2];
if (!htmlPath || !fs.existsSync(htmlPath)) process.exit(0);
if (!process.env.OPENAI_API_KEY) process.exit(0);

const html = fs.readFileSync(htmlPath, 'utf-8').slice(0, 14000);

const body = JSON.stringify({
  model: 'gpt-4o',
  messages: [{
    role: 'user',
    content: `You are a senior web designer at Stripe reviewing website code. Analyze this HTML/CSS/React code and provide a detailed design critique.

Score 1-10 on visual quality. Identify the top 5 most impactful issues to fix. Be specific about CSS properties, colors, spacing, and layout.

Focus on:
1. Color contrast and palette consistency
2. Typography hierarchy and readability
3. Layout, spacing, and alignment
4. Animation and interaction quality
5. Image placement and relevance
6. Mobile responsiveness indicators
7. Brand consistency
8. Overall visual polish vs. generic AI look

Return ONLY valid JSON (no markdown fences):
{"score":number,"issues":["specific issue 1","specific issue 2",...],"recommendations":["actionable fix 1","actionable fix 2",...]}

CODE:
${html}`
  }],
  max_tokens: 800,
  temperature: 0.2,
});

const opts = {
  hostname: 'api.openai.com',
  port: 443,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = https.request(opts, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(data);
      const content = r.choices?.[0]?.message?.content || '';
      process.stdout.write(content);
    } catch (e) {
      process.stderr.write('Parse error: ' + e.message + '\n');
    }
  });
});
req.on('error', (e) => process.stderr.write('Request error: ' + e.message + '\n'));
req.setTimeout(25000, () => { req.destroy(); process.stderr.write('Timeout\n'); });
req.write(body);
req.end();

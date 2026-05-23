const express = require('express');
const cors    = require('cors');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Netlify / GitHub Pages site
// Replace with your actual frontend URL(s) or keep * for open access
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// ── Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'session-proof-scraper' }));

// ── Main scrape endpoint
// GET /scrape?username=0xTowhid
app.get('/scrape', async (req, res) => {
  const username = (req.query.username || '').trim().replace(/^@/, '').toLowerCase();

  if (!username || !/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ]
    });

    const ids = new Set();
    const page = await browser.newPage();

    // Block images/fonts/css to load faster
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['image','font','stylesheet','media'].includes(r.resourceType())) r.abort();
      else r.continue();
    });

    // Intercept XHR/fetch responses — X embeds tweet JSON in network responses
    page.on('response', async response => {
      const url = response.url();
      // X's GraphQL timeline endpoints return rich JSON with tweet data
      if (url.includes('UserTweets') || url.includes('UserTweetsAndReplies') || url.includes('TweetDetail')) {
        try {
          const json = await response.json();
          const text = JSON.stringify(json);
          // Extract all in_reply_to_status_id_str values
          const m1 = [...text.matchAll(/"in_reply_to_status_id_str"\s*:\s*"(\d{10,20})"/g)];
          m1.forEach(m => ids.add(m[1]));
          // Extract all rest_id / tweet_id values (broad)
          const m2 = [...text.matchAll(/"rest_id"\s*:\s*"(\d{10,20})"/g)];
          m2.forEach(m => ids.add(m[1]));
          const m3 = [...text.matchAll(/\/status\/(\d{10,20})/g)];
          m3.forEach(m => ids.add(m[1]));
        } catch {}
      }
    });

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to with_replies page
    await page.goto(`https://x.com/${username}/with_replies`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait a bit for XHR responses to complete
    await new Promise(r => setTimeout(r, 3000));

    // Also extract from rendered HTML as backup
    const html = await page.content();
    const m4 = [...html.matchAll(/\/status\/(\d{10,20})/g)];
    m4.forEach(m => ids.add(m[1]));
    const m5 = [...html.matchAll(/"in_reply_to_status_id_str"\s*:\s*"(\d{10,20})"/g)];
    m5.forEach(m => ids.add(m[1]));

    // Scroll down to load more tweets
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await new Promise(r => setTimeout(r, 2000));
      const moreHtml = await page.content();
      [...moreHtml.matchAll(/\/status\/(\d{10,20})/g)].forEach(m => ids.add(m[1]));
      [...moreHtml.matchAll(/"in_reply_to_status_id_str"\s*:\s*"(\d{10,20})"/g)].forEach(m => ids.add(m[1]));
    }

    await browser.close();

    return res.json({
      username,
      ids: [...ids],
      count: ids.size,
      source: 'puppeteer'
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Session Proof Scraper running on port ${PORT}`));

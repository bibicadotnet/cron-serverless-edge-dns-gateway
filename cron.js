// ================= CONFIGURATION =================
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID_HERE';

const CF_API_TOKEN = "YOUR_CLOUDFLARE_MASTER_API_TOKEN";
const CF_ZONE_ID = "YOUR_CLOUDFLARE_ZONE_ID";
const CF_RECORD_ID = "YOUR_CLOUDFLARE_RECORD_ID";

const WARNING_LIMIT = 80_000;

// --- Practical Limits (Cloudflare Workers free tier) --------------------------
//
//   Brand NEW tokens (not yet in D1):
//     Each cron run processes up to 205 new tokens.
//     -> 400 new tokens: completed after 2 cron runs.
//     -> 1000 new tokens: completed after 5 cron runs.
//     Unprocessed tokens are automatically deferred and handled in the next run.
//
//   WARM tokens (already in D1):
//     Each cron run processes up to 2009 tokens.
//     -> Under 2009 warm tokens: processed entirely in a single run.
// -----------------------------------------------------------------------------
const PARENT_BUDGET = 50;
const PARENT_OVERHEAD = 9;
const MAX_FANOUT = PARENT_BUDGET - PARENT_OVERHEAD; // 41

const CHILD_BUDGET = 49;
const COLD_COST = 9;
const WARM_COST = 1;
const COLD_PER_BATCH = Math.floor(CHILD_BUDGET / COLD_COST); // 5  -> max 205 new tokens/run
const WARM_PER_BATCH = Math.floor(CHILD_BUDGET / WARM_COST); // 49 -> max 2009 warm tokens/run

// D1 key to track whether the daily report has been sent for the current UTC date.
const REPORTED_KEY = "last_daily_report_date";

const TOKENS = `
// Paste your child account tokens here (one per line)
// Example:
// cfut_xxxxx_1
// cfut_xxxxx_2
// cfut_xxxxx_3
`;
// =================================================

// Required bindings (dashboard -> Settings -> Variables):
//   DB    : D1 database binding
//   SELF  : Service Binding pointing to THIS same Worker
// Then disable workers.dev subdomain (Settings -> Triggers) so /batch
// is unreachable from the public internet.

const tokens = TOKENS
    .split('\n').map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('//') && !s.startsWith('#'));



// Fetch JSON with 1 retry on non-2xx or non-JSON body.
async function fetchJsonSafe(url, options, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            const text = await res.text();
            if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); }
            else {
                try { return { ok: true, json: JSON.parse(text) }; }
                catch { lastErr = new Error(`HTTP ${res.status} non-JSON`); }
            }
        } catch (e) { lastErr = e; }
        if (attempt < retries) await new Promise(r => setTimeout(r, 1000));
    }
    return { ok: false, error: lastErr.message };
}

async function notify(msg) {
    try {
        const truncated = msg.length > 4000 ? msg.slice(0, 4000) + '\n... (truncated)' : msg;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: truncated, parse_mode: 'HTML' }),
        });
    } catch (e) {
        console.error('Telegram notify failed:', e.message);
    }
}

async function getAllCachedHashes(env) {
    // Tên cột giữ nguyên "token_hash" để không cần migrate schema.
    const { results } = await env.DB.prepare('SELECT token_hash FROM token_meta').all();
    return new Set(results.map(r => r.token_hash));
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);

        if (url.pathname === '/init-db') {
            try {
                await env.DB.prepare('CREATE TABLE IF NOT EXISTS token_meta (token_hash TEXT PRIMARY KEY, email TEXT, account_tag TEXT, url TEXT)').run();
                await env.DB.prepare('CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT)').run();
                return new Response('Database tables created.', { status: 200 });
            } catch (e) {
                return new Response(`DB init failed: ${e.message}`, { status: 500 });
            }
        }

        if (url.pathname === '/batch') {
            try {
                await env.DB.prepare('CREATE TABLE IF NOT EXISTS token_meta (token_hash TEXT PRIMARY KEY, email TEXT, account_tag TEXT, url TEXT)').run();
                await env.DB.prepare('CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT)').run();
            } catch (e) {
                console.error('Batch DB init failed:', e.message);
            }

            const indicesParam = url.searchParams.get('indices') || '';
            const indices = indicesParam.split(',')
                .map(Number)
                .filter(n => !isNaN(n) && n >= 0 && n < tokens.length);
            const slice = indices.map(i => tokens[i]);
            const results = await processBatch(slice, env);
            return Response.json(results);
        }

        return new Response("Cron Worker is running.", { status: 200 });
    },

    async scheduled(event, env) {
        const t0 = Date.now();
        console.log(`scheduled() | tokens=${tokens.length} COLD_PER_BATCH=${COLD_PER_BATCH} WARM_PER_BATCH=${WARM_PER_BATCH} MAX_FANOUT=${MAX_FANOUT}`);

        if (tokens.length === 0) {
            await notify('Token list is empty.');
            return;
        }

        await env.DB.prepare('CREATE TABLE IF NOT EXISTS token_meta (token_hash TEXT PRIMARY KEY, email TEXT, account_tag TEXT, url TEXT)').run();
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT)').run();

        // Token dùng trực tiếp làm key D1 — không cần hash.
        const cachedKeys = await getAllCachedHashes(env);
        const warmPairs = [];
        const coldPairs = [];
        tokens.forEach((token, i) => {
            if (cachedKeys.has(token)) warmPairs.push({ idx: i, key: token });
            else coldPairs.push({ idx: i, key: token });
        });
        console.log(`Token split: ${warmPairs.length} warm, ${coldPairs.length} cold`);

        // 2. Build batches (cold first).
        const coldBatchCount = Math.min(
            coldPairs.length > 0 ? Math.ceil(coldPairs.length / COLD_PER_BATCH) : 0,
            MAX_FANOUT
        );
        const warmBatchCount = Math.min(
            warmPairs.length > 0 ? Math.ceil(warmPairs.length / WARM_PER_BATCH) : 0,
            MAX_FANOUT - coldBatchCount
        );
        console.log(`Fan-out: ${coldBatchCount} cold batch(es) + ${warmBatchCount} warm batch(es)`);

        const batches = [];
        for (let i = 0; i < coldBatchCount; i++) {
            batches.push(coldPairs.slice(i * COLD_PER_BATCH, (i + 1) * COLD_PER_BATCH));
        }
        for (let i = 0; i < warmBatchCount; i++) {
            batches.push(warmPairs.slice(i * WARM_PER_BATCH, (i + 1) * WARM_PER_BATCH));
        }

        // 3. Current DNS record.
        const api = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${CF_RECORD_ID}`;
        const headers = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

        const dnsRes = await fetchJsonSafe(api, { headers });
        if (!dnsRes.ok) {
            await notify(`DNS API error: ${dnsRes.error}`);
            return;
        }
        const currentContent = dnsRes.json.result.content;
        console.log('Current DNS:', currentContent);

        // 4. Fan-out – truyền token index xuống child, child tự lấy token từ TOKENS[idx].
        const fanOut = batches.map(pairs => {
            const pairsStr = pairs.map(p => `${p.idx}`).join(',');
            return env.SELF.fetch(`https://self/batch?indices=${pairsStr}`)
                .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                .catch(e => [{ idx: pairs[0]?.idx, error: `fan-out fail: ${e.message}` }]);
        });
        const checked = (await Promise.all(fanOut)).flat();

        checked.forEach((e, i) => {
            if (e.error) console.log(`  [${i.toString().padStart(2, ' ')}] ERR  ${e.email || 'n/a'} -- ${e.error}`);
            else         console.log(`  [${i.toString().padStart(2, ' ')}] OK   ${e.email} ${e.url} req=${e.requests.toLocaleString()}`);
        });

        // 5. Aggregate alerts.
        const alerts = [];

        const skippedCold = Math.max(0, coldPairs.length - coldBatchCount * COLD_PER_BATCH);
        const skippedWarm = Math.max(0, warmPairs.length - warmBatchCount * WARM_PER_BATCH);
        if (skippedCold > 0 || skippedWarm > 0) {
            alerts.push(`${skippedCold} cold + ${skippedWarm} warm token(s) deferred to next run`);
        }

        for (const e of checked) {
            if (e.error) {
                alerts.push(`Token error (${e.email || 'unknown'}): ${e.error}`);
            } else if (e.requests >= WARNING_LIMIT) {
                alerts.push(`Warning: ${e.email || e.url} used ${e.requests.toLocaleString()} / 100,000`);
            }
        }

        const allUrls = checked.filter(e => !e.error).map(e => e.url);
        if (!allUrls.includes(currentContent)) {
            alerts.push(`CNAME ${currentContent} not found in account list!`);
        }

        // 6. Pick best candidate.
        const available = checked.filter(e => !e.error && typeof e.requests === 'number' && e.requests < WARNING_LIMIT);
        if (available.length === 0) {
            alerts.push(`All accounts errored or exceeded ${WARNING_LIMIT.toLocaleString()} requests.`);
            if (alerts.length) await notify(alerts.join('\n'));
            return;
        }
        const best = available.reduce((a, b) => a.requests <= b.requests ? a : b);
        console.log(`Best: ${best.email} / ${best.url} (${best.requests.toLocaleString()} req)`);

        if (best.url !== currentContent) {
            const patchRes = await fetchJsonSafe(api, { method: "PATCH", headers, body: JSON.stringify({ content: best.url }) });
            if (!patchRes.ok) {
                alerts.push(`DNS PATCH failed: ${patchRes.error}`);
            } else {
                console.log(`DNS updated: [${currentContent}] -> [${best.url}]`);
            }
        } else {
            console.log(`DNS unchanged: [${best.url}]`);
        }

        if (alerts.length) {
            await notify(alerts.join('\n'));
        }

        // 7. Daily report at 23:00 UTC.
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        if (now.getUTCHours() === 23) {
            let alreadySent = false;
            try {
                const result = await env.DB.prepare('SELECT value FROM cron_state WHERE key = ?').bind(REPORTED_KEY).first();
                alreadySent = result && result.value === todayStr;
            } catch { }

            if (!alreadySent) {
                const valid = checked.filter(e => !e.error);
                const totalRequests = valid.reduce((s, e) => s + (e.requests || 0), 0);
                const totalCapacity = valid.length * 100000;
                const totalPercent = totalCapacity > 0 ? ((totalRequests / totalCapacity) * 100).toFixed(2) : 0;

                await notify([
                    `Daily Report (UTC)`,
                    `Total requests today: ${totalRequests.toLocaleString()} (${totalPercent}% of ${valid.length} accounts)`,
                    `Current DNS: ${best.url}`,
                    ``,
                    `Reset at 00:00 UTC`,
                ].join('\n'));

                try {
                    await env.DB.prepare('INSERT OR REPLACE INTO cron_state (key, value) VALUES (?, ?)').bind(REPORTED_KEY, todayStr).run();
                } catch (e) {
                    console.error('Failed to save reported date:', e.message);
                }
            }
        }

        console.log(`scheduled() done in ${Date.now() - t0}ms`);
    }
};

// ---------- Child batch ----------
async function processBatch(tokenList, env) {
    // Dùng token trực tiếp làm key D1 — không hash.
    const placeholders = tokenList.map(() => '?').join(',');
    const { results: dbResults } = await env.DB
        .prepare(`SELECT token_hash, email, account_tag, url FROM token_meta WHERE token_hash IN (${placeholders})`)
        .bind(...tokenList).all();

    const cache = {};
    dbResults.forEach(row => {
        cache[row.token_hash] = { email: row.email, accountTag: row.account_tag, url: row.url };
    });
    console.log(`  D1: sent ${tokenList.length} keys, got ${dbResults.length} hit(s)`);

    const dbStats = { inserts: 0, insertErrors: 0, deletes: 0, deleteErrors: 0 };

    const batchResults = await Promise.all(tokenList.map(async (token) => {
        const tokenTail = token.slice(-8);
        const meta = cache[token] || null;

        if (!meta) {
            // ── COLD path ──
            console.log(`  ...${tokenTail} => COLD`);
            const newMeta = await resolveMeta(token);
            if (newMeta.error) {
                return { email: newMeta.email || null, url: null, error: newMeta.error };
            }

            try {
                await env.DB.prepare(
                    'INSERT OR REPLACE INTO token_meta (token_hash, email, account_tag, url) VALUES (?, ?, ?, ?)'
                ).bind(token, newMeta.email, newMeta.accountTag, newMeta.url).run();
                dbStats.inserts++;
            } catch (e) {
                dbStats.insertErrors++;
                console.error(`  ...${tokenTail} DB insert failed: ${e.message}`);
            }

            const usage = await resolveUsage(token, newMeta.accountTag);
            if (usage.error) {
                if (!usage.transient) {
                    try { await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(token).run(); dbStats.deletes++; }
                    catch (e) { dbStats.deleteErrors++; }
                }
                return { email: newMeta.email, url: newMeta.url, error: usage.error };
            }

            return { email: newMeta.email, url: newMeta.url, requests: usage.requests, error: null };

        } else {
            // ── WARM path ──
            console.log(`  ...${tokenTail} => WARM ${meta.email}`);

            const usage = await resolveUsage(token, meta.accountTag);
            if (usage.error) {
                if (!usage.transient) {
                    try { await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(token).run(); dbStats.deletes++; }
                    catch (e) { dbStats.deleteErrors++; }
                }
                return { email: meta.email, url: meta.url, error: usage.error };
            }

            return { email: meta.email, url: meta.url, requests: usage.requests, error: null };
        }
    }));

    console.log(`  batch done — results=${batchResults.length} D1: +${dbStats.inserts}(err=${dbStats.insertErrors}) -${dbStats.deletes}(err=${dbStats.deleteErrors})`);

    if (dbStats.insertErrors > 0 || dbStats.deleteErrors > 0) {
        await notify(`Batch DB errors — inserts: ${dbStats.insertErrors}, deletes: ${dbStats.deleteErrors}`);
    }

    return batchResults;
}

async function resolveMeta(token) {
    const auth = { Authorization: `Bearer ${token}` };
    const [userRes, accRes] = await Promise.all([
        fetchJsonSafe('https://api.cloudflare.com/client/v4/user', { headers: auth }),
        fetchJsonSafe('https://api.cloudflare.com/client/v4/accounts?per_page=1', { headers: auth }),
    ]);
    if (!userRes.ok && !accRes.ok) return { error: `meta fetch failed: ${accRes.error}` };

    const email      = userRes.ok ? (userRes.json?.result?.email || null) : null;
    const accountTag = accRes.ok  ? accRes.json?.result?.[0]?.id : null;
    if (!accountTag) return { email, error: 'Missing Account:Read permission' };

    const pagesRes = await fetchJsonSafe(
        `https://api.cloudflare.com/client/v4/accounts/${accountTag}/pages/projects?per_page=1`,
        { headers: auth }
    );
    if (!pagesRes.ok) return { email, error: `pages fetch failed: ${pagesRes.error}` };
    const project = pagesRes.json?.result?.[0];
    if (!project) return { email, error: 'Missing Pages:Read permission or no Pages project' };

    return { email, accountTag, url: project.subdomain };
}

async function resolveUsage(token, accountTag) {
    const now = new Date();

    // ------------------------------------------------------------------
    // FIX 3: Query ONLY today's date instead of the entire month.
    //         Original: date_geq=monthStart → up to 30 rows per query type per token.
    //         Fixed:    date_geq=today      → at most 1 row per query type per token.
    //         With 25 warm tokens × 2 arrays × 30 rows = 1500 objects parsed.
    //         Fixed:    25 × 2 × 1          = 50 objects.  ~30× less JSON work.
    // ------------------------------------------------------------------
    const today = now.toISOString().slice(0, 10);

    const gqlQuery = `
        query($accountTag: String!, $date: Date!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    workersInvocationsAdaptive(
                        limit: 10 filter: { date_geq: $date, date_leq: $date }
                    ) { sum { requests } }
                    pagesFunctionsInvocationsAdaptiveGroups(
                        limit: 10 filter: { date_geq: $date, date_leq: $date }
                    ) { sum { requests } }
                }
            }
        }
    `;

    const gql = await fetchJsonSafe('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gqlQuery, variables: { accountTag, date: today } }),
    });
    if (!gql.ok) return { error: `graphql ${gql.error}`, transient: true };
    if (gql.json.errors) return {
        error: `GraphQL error: ${gql.json.errors.map(e => e.message).join('; ')}`,
        transient: false,
    };

    const acc = gql.json.data?.viewer?.accounts?.[0];
    if (!acc) return { error: 'Missing Account Analytics:Read permission' };

    const sum = (rows) => (rows || []).reduce((s, r) => s + (r.sum?.requests || 0), 0);

    return {
        requests: sum(acc.workersInvocationsAdaptive) + sum(acc.pagesFunctionsInvocationsAdaptiveGroups),
    };
}

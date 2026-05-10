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

async function sha256Hex(str) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fetch JSON with 1 retry on non-2xx or non-JSON body (handles transient CF 502/503).
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
        // Telegram has a 4096-char message limit. Truncate and add ellipsis if needed.
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

// Returns a Set of all token_hash values currently in D1 (1 subreq).
async function getAllCachedHashes(env) {
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
            // Defensive: ensure tables exist for the case where /batch is called
            // directly (e.g. manual testing) outside of a scheduled() invocation.
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
        console.log(`scheduled() start | tokens=${tokens.length} | COLD_PER_BATCH=${COLD_PER_BATCH} | WARM_PER_BATCH=${WARM_PER_BATCH} | MAX_FANOUT=${MAX_FANOUT}`);

        if (tokens.length === 0) {
            console.log('Token list empty.');
            await notify('Token list is empty.');
            return;
        }

        // Ensure D1 tables exist (blocking before fan-out).
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS token_meta (token_hash TEXT PRIMARY KEY, email TEXT, account_tag TEXT, url TEXT)').run();
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT)').run();
        console.log('D1 tables verified.');

        // 1. Pre-fetch all cached hashes to split tokens into warm / cold.
        //    This single D1 query determines batch sizing — no manual config needed.
        const cachedHashes = await getAllCachedHashes(env);
        const allTokenHashes = await Promise.all(tokens.map(t => sha256Hex(t)));
        const warmIndices = [];
        const coldIndices = [];
        allTokenHashes.forEach((h, i) => {
            if (cachedHashes.has(h)) warmIndices.push(i);
            else coldIndices.push(i);
        });
        console.log(`Token split: ${warmIndices.length} warm, ${coldIndices.length} cold`);

        // 2. Compute how many batches fit within the parent's subreq budget.
        //    Cold batches are processed first to populate D1 as fast as possible.
        //    After ~ceil(total / COLD_PER_BATCH) runs every token will be warm.
        const coldBatchCount = Math.min(
            coldIndices.length > 0 ? Math.ceil(coldIndices.length / COLD_PER_BATCH) : 0,
            MAX_FANOUT
        );
        const warmBatchCount = Math.min(
            warmIndices.length > 0 ? Math.ceil(warmIndices.length / WARM_PER_BATCH) : 0,
            MAX_FANOUT - coldBatchCount
        );
        console.log(`Fan-out: ${coldBatchCount} cold batch(es) + ${warmBatchCount} warm batch(es)`);

        // Build index slices for each child batch.
        const batches = [];
        for (let i = 0; i < coldBatchCount; i++) {
            batches.push(coldIndices.slice(i * COLD_PER_BATCH, (i + 1) * COLD_PER_BATCH));
        }
        for (let i = 0; i < warmBatchCount; i++) {
            batches.push(warmIndices.slice(i * WARM_PER_BATCH, (i + 1) * WARM_PER_BATCH));
        }

        // 3. Current DNS record.
        const api = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${CF_RECORD_ID}`;
        const headers = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

        const dnsRes = await fetchJsonSafe(api, { headers });
        if (!dnsRes.ok) {
            console.log('DNS GET failed:', dnsRes.error);
            await notify(`DNS API error: ${dnsRes.error}`);
            return;
        }
        const dnsBody = dnsRes.json;
        const currentContent = dnsBody.result.content;
        console.log('Current DNS:', currentContent);

        // 4. Fan-out parallel batches (each child = fresh 50-subreq budget).
        const fanOut = batches.map(indices =>
            env.SELF.fetch(`https://self/batch?indices=${indices.join(',')}`)
                .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                .catch(e => [{ idx: indices[0], error: `fan-out fail: ${e.message}` }])
        );
        const checked = (await Promise.all(fanOut)).flat();

        // Log every token result.
        console.log(`Per-token results (${checked.length}):`);
        checked.forEach((e, i) => {
            if (e.error) {
                console.log(`  [${i.toString().padStart(2, ' ')}] ERR  ${e.email || e.url || 'n/a'} -- ${e.error}`);
            } else {
                console.log(`  [${i.toString().padStart(2, ' ')}] OK   ${e.email} ${e.url} requests=${e.requests.toLocaleString()}`);
            }
        });

        // 5. Aggregate notifications into ONE message to minimise subrequests.
        const alerts = [];

        // Report tokens deferred due to parent budget (cold backlog on first runs).
        const skippedCold = Math.max(0, coldIndices.length - coldBatchCount * COLD_PER_BATCH);
        const skippedWarm = Math.max(0, warmIndices.length - warmBatchCount * WARM_PER_BATCH);
        if (skippedCold > 0 || skippedWarm > 0) {
            console.log(`Deferred: ${skippedCold} cold, ${skippedWarm} warm tokens (will retry next run)`);
            alerts.push(`${skippedCold} cold + ${skippedWarm} warm token(s) deferred to next run (D1 cache building...)`);
        }

        for (const e of checked) {
            if (e.error) {
                const id = e.email || (e.idx !== undefined ? `batch@${e.idx}` : 'unknown');
                alerts.push(`Token error (${id}): ${e.error}`);
            } else if (e.requests >= WARNING_LIMIT) {
                alerts.push(`Warning: ${e.email || e.url} used ${e.requests.toLocaleString()} / 100,000`);
            }
        }

        const allUrls = checked.filter(e => !e.error).map(e => e.url);
        if (!allUrls.includes(currentContent)) {
            alerts.push(`CNAME ${currentContent} not found in account list!`);
        }

        // 6. Pick best candidate (lowest request count, under WARNING_LIMIT).
        const available = checked.filter(e => !e.error && typeof e.requests === 'number' && e.requests < WARNING_LIMIT);
        if (available.length === 0) {
            console.log('No available accounts.');
            alerts.push(`All accounts errored or exceeded ${WARNING_LIMIT.toLocaleString()} requests.`);
            if (alerts.length) await notify(alerts.join('\n'));
            return;
        }
        const best = available.reduce((a, b) => a.requests <= b.requests ? a : b);
        console.log(`Best: ${best.email} / ${best.url} (${best.requests.toLocaleString()} requests)`);

        if (best.url !== currentContent) {
            // check PATCH response — a silent failure here means DNS never updates.
            const patchRes = await fetchJsonSafe(api, { method: "PATCH", headers, body: JSON.stringify({ content: best.url }) });
            if (!patchRes.ok) {
                console.error('DNS PATCH failed:', patchRes.error);
                alerts.push(`DNS PATCH failed: ${patchRes.error}`);
            } else {
                console.log(`DNS updated: [${currentContent}] -> [${best.url}]`);
            }
        } else {
            console.log(`DNS unchanged: [${best.url}]`);
        }

        // 7. Flush aggregated alerts as a single Telegram message.
        if (alerts.length) {
            console.log(`Sending ${alerts.length} alert(s) to Telegram.`);
            await notify(alerts.join('\n'));
        } else {
            console.log('No alerts.');
        }

        // 8. Daily report at 23:00 UTC, send only once per UTC date.
        // use a single `now` object to avoid a midnight race between two Date() calls.
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        if (now.getUTCHours() === 23) {
            let alreadySent = false;
            try {
                const result = await env.DB.prepare('SELECT value FROM cron_state WHERE key = ?')
                    .bind(REPORTED_KEY).first();
                alreadySent = result && result.value === todayStr;
            } catch { }

            if (!alreadySent) {
                const valid = checked.filter(e => !e.error);
                const totalRequests = valid.reduce((s, e) => s + (e.requests || 0), 0);
                const totalCapacity = valid.length * 100000;
                const totalPercent = totalCapacity > 0 ? ((totalRequests / totalCapacity) * 100).toFixed(2) : 0;

                const reportMsg = [
                    `Daily Report (UTC)`,
                    `Total requests today: ${totalRequests.toLocaleString()} (${totalPercent}% of ${valid.length} accounts)`,
                    `Current DNS: ${best.url}`,
                    ``,
                    `Reset at 00:00 UTC`,
                ].join('\n');

                await notify(reportMsg);
                try {
                    await env.DB.prepare('INSERT OR REPLACE INTO cron_state (key, value) VALUES (?, ?)')
                        .bind(REPORTED_KEY, todayStr).run();
                } catch (e) {
                    console.error('Failed to save reported date:', e.message);
                }
                console.log(`Daily report sent for ${todayStr}.`);
            } else {
                console.log(`Daily report already sent for ${todayStr}.`);
            }
        }

        console.log(`scheduled() done in ${Date.now() - t0}ms`);
    }
};

// ---------- Child batch (new invocation, fresh 50-subreq budget) ----------
async function processBatch(tokenList, env) {
    // 1. Hash all tokens, then batch-fetch cached metadata from D1 in one query.
    const tokenHashes = await Promise.all(tokenList.map(t => sha256Hex(t)));
    const placeholders = tokenHashes.map(() => '?').join(',');
    const { results: dbResults } = await env.DB
        .prepare(`SELECT token_hash, email, account_tag, url FROM token_meta WHERE token_hash IN (${placeholders})`)
        .bind(...tokenHashes).all();

    const cache = {};
    dbResults.forEach(row => {
        cache[row.token_hash] = { email: row.email, accountTag: row.account_tag, url: row.url };
    });
    console.log(`  D1 query: sent ${tokenHashes.length} hashes, returned ${dbResults.length} hit(s)`);

    const dbStats = { inserts: 0, insertErrors: 0, deletes: 0, deleteErrors: 0 };

    // 2. Process all tokens in parallel — parent already enforces batch-size budget.
    const batchResults = await Promise.all(tokenList.map(async (token, idx) => {
        const cacheKey = tokenHashes[idx];
        const tokenTail = token.slice(-8);
        const meta = cache[cacheKey] || null;

        if (!meta) {
            // ── COLD path: resolve metadata then fetch usage ──────────────
            console.log(`  ...${tokenTail} => COLD resolve`);

            const newMeta = await resolveMeta(token);
            if (newMeta.error) {
                console.error(`  ...${tokenTail} meta error: ${newMeta.error}`);
                return { email: newMeta.email || null, url: null, error: newMeta.error };
            }

            // Persist metadata so subsequent runs take the cheaper WARM path.
            try {
                await env.DB.prepare(
                    'INSERT OR REPLACE INTO token_meta (token_hash, email, account_tag, url) VALUES (?, ?, ?, ?)'
                ).bind(cacheKey, newMeta.email, newMeta.accountTag, newMeta.url).run();
                dbStats.inserts++;
                console.log(`  ...${tokenTail} cached: ${newMeta.email} => ${newMeta.url}`);
            } catch (e) {
                dbStats.insertErrors++;
                console.error(`  ...${tokenTail} DB insert failed: ${e.message}`);
                // Not fatal — metadata resolved successfully; proceed to usage check.
            }

            const usage = await resolveUsage(token, newMeta.accountTag);
            if (usage.error) {
                const keep = usage.transient ? '(transient, keeping cache)' : '(busting cache)';
                console.error(`  ...${tokenTail} usage error: ${usage.error} ${keep}`);
                if (!usage.transient) {
                    try {
                        await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(cacheKey).run();
                        dbStats.deletes++;
                    } catch (e) {
                        dbStats.deleteErrors++;
                        console.error(`  ...${tokenTail} DB delete failed: ${e.message}`);
                    }
                }
                return { email: newMeta.email, url: newMeta.url, error: usage.error };
            }

            console.log(`  ...${tokenTail} COLD ok: ${newMeta.email} requests=${usage.requests.toLocaleString()}`);
            return { email: newMeta.email, url: newMeta.url, requests: usage.requests, error: null };

        } else {
            // ── WARM path: metadata already cached, only fetch usage ──────
            console.log(`  ...${tokenTail} => WARM ${meta.email} ${meta.url}`);

            const usage = await resolveUsage(token, meta.accountTag);
            if (usage.error) {
                const keep = usage.transient ? '(transient, keeping cache)' : '(busting cache)';
                console.error(`  ...${tokenTail} usage error: ${usage.error} ${keep}`);
                if (!usage.transient) {
                    try {
                        await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(cacheKey).run();
                        dbStats.deletes++;
                    } catch (e) {
                        dbStats.deleteErrors++;
                        console.error(`  ...${tokenTail} DB delete failed: ${e.message}`);
                    }
                }
                return { email: meta.email, url: meta.url, error: usage.error };
            }

            console.log(`  ...${tokenTail} WARM ok: requests=${usage.requests.toLocaleString()}`);
            return { email: meta.email, url: meta.url, requests: usage.requests, error: null };
        }
    }));

    console.log(`  batch done — results=${batchResults.length}, D1: inserts=${dbStats.inserts}(err=${dbStats.insertErrors}) deletes=${dbStats.deletes}(err=${dbStats.deleteErrors})`);

    // 3. Surface DB-level errors to Telegram so they are never silently missed.
    if (dbStats.insertErrors > 0 || dbStats.deleteErrors > 0) {
        await notify(`Batch DB errors — insert failures: ${dbStats.insertErrors}, delete failures: ${dbStats.deleteErrors}. Check worker logs for details.`);
    }

    return batchResults;
}

async function resolveMeta(token) {
    const auth = { Authorization: `Bearer ${token}` };

    // fetch user and accounts in parallel — they are independent requests.
    const [userRes, accRes] = await Promise.all([
        fetchJsonSafe('https://api.cloudflare.com/client/v4/user', { headers: auth }),
        fetchJsonSafe('https://api.cloudflare.com/client/v4/accounts?per_page=1', { headers: auth }),
    ]);
    if (!userRes.ok && !accRes.ok) return { error: `meta fetch failed: ${accRes.error}` };

    const email = userRes.ok ? (userRes.json?.result?.email || null) : null;
    const accountTag = accRes.ok ? accRes.json?.result?.[0]?.id : null;
    if (!accountTag) return { email, error: 'Missing Account:Read permission' };

    const pagesRes = await fetchJsonSafe(
        `https://api.cloudflare.com/client/v4/accounts/${accountTag}/pages/projects?per_page=1`,
        { headers: auth }
    );
    if (!pagesRes.ok) return { email, error: `pages fetch failed: ${pagesRes.error}` };
    const project = pagesRes.json?.result?.[0];
    if (!project) return { email, error: 'Missing Pages:Read permission or no Pages project exists' };

    return { email, accountTag, url: project.subdomain };
}

async function resolveUsage(token, accountTag) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

    const gqlQuery = `
        query($accountTag: String!, $start: Date!, $end: Date!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    workersInvocationsAdaptive(
                        limit: 10000 filter: { date_geq: $start, date_leq: $end } orderBy: [date_ASC]
                    ) { dimensions { date } sum { requests } }
                    pagesFunctionsInvocationsAdaptiveGroups(
                        limit: 10000 filter: { date_geq: $start, date_leq: $end } orderBy: [date_ASC]
                    ) { dimensions { date } sum { requests } }
                }
            }
        }
    `;

    const gql = await fetchJsonSafe('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gqlQuery, variables: { accountTag, start: monthStart, end: today } }),
    });
    if (!gql.ok) return { error: `graphql ${gql.error}`, transient: true };

    // include the actual GraphQL error message instead of hardcoding "Missing permission".
    if (gql.json.errors) return {
        error: `GraphQL error: ${gql.json.errors.map(e => e.message).join('; ')}`,
        transient: false,
    };

    const acc = gql.json.data?.viewer?.accounts?.[0];
    if (!acc) return { error: 'Missing Account Analytics:Read permission' };

    const sumToday = (rows) =>
        (rows || []).filter(r => r.dimensions.date === today).reduce((s, r) => s + r.sum.requests, 0);

    return {
        requests: sumToday(acc.workersInvocationsAdaptive) + sumToday(acc.pagesFunctionsInvocationsAdaptiveGroups),
    };
}

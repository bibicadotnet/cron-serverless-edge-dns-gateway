// ================= CONFIGURATION =================
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID_HERE';

const CF_API_TOKEN = "YOUR_CLOUDFLARE_MASTER_API_TOKEN";
const CF_ZONE_ID = "YOUR_CLOUDFLARE_ZONE_ID";
const CF_RECORD_ID = "YOUR_CLOUDFLARE_RECORD_ID";

const WARNING_LIMIT = 80_000;

const TOKENS = `
// Paste your child account tokens here (one per line)
// cfut_xxxxx_1
// cfut_xxxxx_2
`;
// ==================================================

// ===================== NO NEED TO EDIT THIS SECTION =====================
// Automatic limit based on Cloudflare Workers free tier (50 subreqs/invocation)
const PARENT_BUDGET = 50;
const PARENT_OVERHEAD = 9;
const MAX_FANOUT = PARENT_BUDGET - PARENT_OVERHEAD; // 41

const CHILD_BUDGET = 50;
// CHILD_OVERHEAD breakdown:
//   1  D1 SELECT (batch meta lookup)
//   1  Telegram notify (on DB errors)
//   5  buffer for D1 DELETEs on non-transient errors
//   3  buffer for GraphQL retries on transient 502/503
const CHILD_OVERHEAD = 10;
const COLD_COST = 9;  // resolveMeta (3 fetches w/ retry) + D1 INSERT + GraphQL
const WARM_COST = 1;  // 1 GraphQL fetch (+ 1 retry on failure, covered by overhead)
const COLD_PER_BATCH = Math.floor((CHILD_BUDGET - CHILD_OVERHEAD) / COLD_COST); // 4
const WARM_PER_BATCH = Math.floor((CHILD_BUDGET - CHILD_OVERHEAD) / WARM_COST); // 40
const MAX_DELETES = 5; // Cap D1 DELETEs per child to stay within subrequest budget
// ========================================================================

const tokens = TOKENS
	.split('\n').map(s => s.trim())
	.filter(s => s.length > 0 && !s.startsWith('//') && !s.startsWith('#'));

// Fetch JSON with retries on non-2xx or non-JSON body.
async function fetchJsonSafe(url, options, retries = 1) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, options);
			const text = await res.text();
			if (!res.ok) {
				lastErr = new Error(`HTTP ${res.status}`);
			} else {
				try {
					return { ok: true, json: JSON.parse(text) };
				} catch {
					lastErr = new Error(`HTTP ${res.status} non-JSON`);
				}
			}
		} catch (e) {
			lastErr = e;
		}
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
	const { results } = await env.DB.prepare('SELECT token_hash FROM token_meta').all();
	return new Set(results.map(r => r.token_hash));
}

async function initDb(env) {
	await env.DB.prepare('CREATE TABLE IF NOT EXISTS token_meta (token_hash TEXT PRIMARY KEY, email TEXT, account_tag TEXT, url TEXT)').run();
	await env.DB.prepare('CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT)').run();
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);

		if (url.pathname === '/init-db') {
			try {
				await initDb(env);
				return new Response('Database tables created.', { status: 200 });
			} catch (e) {
				return new Response(`DB init failed: ${e.message}`, { status: 500 });
			}
		}

		if (url.pathname === '/batch') {
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

		// 1. Init DB + split tokens into warm/cold.
		await initDb(env);
		console.log('D1 tables verified.');

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

		// 3. Get current DNS record.
		const dnsApi = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${CF_RECORD_ID}`;
		const masterHeaders = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

		const dnsRes = await fetchJsonSafe(dnsApi, { headers: masterHeaders });
		if (!dnsRes.ok) {
			await notify(`DNS API error: ${dnsRes.error}`);
			return;
		}
		const currentContent = dnsRes.json.result.content;
		console.log('Current DNS:', currentContent);

		// 4. Fan-out child batches in parallel.
		const fanOutPromises = batches.map(pairs => {
			const indicesStr = pairs.map(p => p.idx).join(',');
			return env.SELF.fetch(`https://self/batch?indices=${indicesStr}`)
				.then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
				.catch(e => [{ idx: pairs[0]?.idx, error: `fan-out fail: ${e.message}` }]);
		});
		const checked = (await Promise.all(fanOutPromises)).flat();

		console.log(`Per-token results (${checked.length}):`);
		checked.forEach((e, i) => {
			if (e.error) console.log(`  [${i.toString().padStart(2, ' ')}] ERR  ${e.email || e.url || 'n/a'} -- ${e.error}`);
			else console.log(`  [${i.toString().padStart(2, ' ')}] OK   ${e.email} ${e.url} requests=${e.requests.toLocaleString()}`);
		});

		// 5. Aggregate alerts.
		const alerts = [];

		const skippedCold = Math.max(0, coldPairs.length - coldBatchCount * COLD_PER_BATCH);
		const skippedWarm = Math.max(0, warmPairs.length - warmBatchCount * WARM_PER_BATCH);
		if (skippedCold > 0 || skippedWarm > 0) {
			console.log(`Deferred: ${skippedCold} cold, ${skippedWarm} warm tokens (will retry next run)`);
			alerts.push(`${skippedCold} cold + ${skippedWarm} warm token(s) deferred to next run`);
		}

		// Dedup WARNING_LIMIT alerts: load tokens already warned today from D1.
		const todayStr = new Date().toISOString().slice(0, 10);
		let warnedToday = new Set();
		try {
			const { results: wRows } = await env.DB.prepare(
				"SELECT key FROM cron_state WHERE key LIKE 'warned_%' AND value = ?"
			).bind(todayStr).all();
			warnedToday = new Set(wRows.map(r => r.key));
		} catch (e) {
			console.error('Failed to load warned set:', e.message);
		}

		const newWarnings = [];
		for (const e of checked) {
			if (e.error && !e.transient) {
				alerts.push(`Token error (${e.email || 'unknown'}): ${e.error}`);
			} else if (e.requests >= WARNING_LIMIT) {
				const wKey = `warned_${e.email || e.url}`;
				if (!warnedToday.has(wKey)) {
					alerts.push(`Warning: ${e.email || e.url} used ${e.requests.toLocaleString()} / 100,000`);
					newWarnings.push(wKey);
				}
			}
		}

		const allUrls = checked.filter(e => !e.error).map(e => e.url);
		if (!allUrls.includes(currentContent)) {
			alerts.push(`CNAME ${currentContent} not found in account list!`);
		}

		// 6. Pick best candidate.
		const available = checked.filter(e => !e.error && typeof e.requests === 'number' && e.requests < WARNING_LIMIT);
		if (available.length === 0) {
			console.log('No available accounts.');
			alerts.push(`All accounts errored or exceeded ${WARNING_LIMIT.toLocaleString()} requests.`);
			if (alerts.length) await notify(alerts.join('\n'));
			return;
		}

		// Tie rotation: when multiple accounts share the same minimum requests value,
		// rotate sequentially by URL so all accounts get a turn instead of always
		// picking the first one (covers 0-req case and any other tie).
		const currentAccount = available.find(e => e.url === currentContent);
		const minRequests = available.reduce((min, e) => Math.min(min, e.requests), Infinity);
		const tiedAccounts = available.filter(e => e.requests === minRequests);
		let best;
		if (currentAccount && currentAccount.requests === minRequests && tiedAccounts.length > 1) {
			const sorted = tiedAccounts.slice().sort((a, b) => a.url < b.url ? -1 : 1);
			const idx = sorted.findIndex(e => e.url === currentContent);
			best = sorted[(idx + 1) % sorted.length];
			console.log(`Tie rotation (${minRequests} req): [${currentContent}] -> [${best.url}] (${tiedAccounts.length} tied, pos ${idx} -> ${(idx + 1) % sorted.length})`);
		} else {
			best = tiedAccounts[0];
		}
		console.log(`Best: ${best.email} / ${best.url} (${best.requests.toLocaleString()} req)`);

		// 7. Update DNS if needed.
		if (best.url !== currentContent) {
			const patchRes = await fetchJsonSafe(dnsApi, {
				method: "PATCH",
				headers: masterHeaders,
				body: JSON.stringify({ content: best.url }),
			});
			if (!patchRes.ok) {
				if (patchRes.error.includes('429')) {
					console.log(`DNS PATCH rate limited (429), skipping alert — will retry next run`);
				} else {
					alerts.push(`DNS PATCH failed: ${patchRes.error}`);
				}
			} else {
				console.log(`DNS updated: [${currentContent}] -> [${best.url}]`);
			}
		} else {
			console.log(`DNS unchanged: [${best.url}]`);
		}

		// 8. Send alerts.
		if (alerts.length) {
			console.log(`Sending ${alerts.length} alert(s) to Telegram.`);
			await notify(alerts.join('\n'));
		} else {
			console.log('No alerts.');
		}

		// 9. Persist WARNING_LIMIT dedup flags.
		for (const key of newWarnings) {
			try {
				await env.DB.prepare('INSERT OR REPLACE INTO cron_state (key, value) VALUES (?, ?)').bind(key, todayStr).run();
			} catch (e) {
				console.error(`Failed to save warn flag ${key}:`, e.message);
			}
		}

		// 10. Daily report at 23:00 UTC.
		const now = new Date();
		if (now.getUTCHours() === 23) {
			let alreadySent = false;
			try {
				const result = await env.DB.prepare('SELECT value FROM cron_state WHERE key = ?').bind('last_daily_report_date').first();
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
					await env.DB.prepare('INSERT OR REPLACE INTO cron_state (key, value) VALUES (?, ?)').bind('last_daily_report_date', todayStr).run();
				} catch (e) {
					console.error('Failed to save reported date:', e.message);
				}
				console.log(`Daily report sent for ${todayStr}.`);
			} else {
				console.log(`Daily report already sent for ${todayStr}.`);
			}
		}

		console.log(`scheduled() done in ${Date.now() - t0}ms`);
	},
};

// ---------- Child batch ----------
async function processBatch(tokenList, env) {
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
				console.error(`  ...${tokenTail} meta error: ${newMeta.error}`);
				return { email: newMeta.email || null, url: null, error: newMeta.error };
			}

			try {
				await env.DB.prepare(
					'INSERT OR REPLACE INTO token_meta (token_hash, email, account_tag, url) VALUES (?, ?, ?, ?)'
				).bind(token, newMeta.email, newMeta.accountTag, newMeta.url).run();
				dbStats.inserts++;
				console.log(`  ...${tokenTail} cached: ${newMeta.email} => ${newMeta.url}`);
			} catch (e) {
				dbStats.insertErrors++;
				console.error(`  ...${tokenTail} DB insert failed: ${e.message}`);
			}

			const usage = await resolveUsage(token, newMeta.accountTag);
			if (usage.error) {
				const keep = usage.transient ? '(transient, keeping cache)' : '(busting cache)';
				console.error(`  ...${tokenTail} usage error: ${usage.error} ${keep}`);
				if (!usage.transient && dbStats.deletes < MAX_DELETES) {
					try {
						await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(token).run();
						dbStats.deletes++;
					} catch (e) {
						dbStats.deleteErrors++;
						console.error(`  ...${tokenTail} DB delete failed: ${e.message}`);
					}
				}
				return { email: newMeta.email, url: newMeta.url, error: usage.error, transient: usage.transient };
			}

			console.log(`  ...${tokenTail} COLD ok: ${newMeta.email} requests=${usage.requests.toLocaleString()}`);
			return { email: newMeta.email, url: newMeta.url, requests: usage.requests, error: null };

		} else {
			// ── WARM path ──
			console.log(`  ...${tokenTail} => WARM ${meta.email} ${meta.url}`);

			const usage = await resolveUsage(token, meta.accountTag);
			if (usage.error) {
				const keep = usage.transient ? '(transient, keeping cache)' : '(busting cache)';
				console.error(`  ...${tokenTail} usage error: ${usage.error} ${keep}`);
				if (!usage.transient && dbStats.deletes < MAX_DELETES) {
					try {
						await env.DB.prepare('DELETE FROM token_meta WHERE token_hash = ?').bind(token).run();
						dbStats.deletes++;
					} catch (e) {
						dbStats.deleteErrors++;
						console.error(`  ...${tokenTail} DB delete failed: ${e.message}`);
					}
				}
				return { email: meta.email, url: meta.url, error: usage.error, transient: usage.transient };
			}

			console.log(`  ...${tokenTail} WARM ok: requests=${usage.requests.toLocaleString()}`);
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

	const email = userRes.ok ? (userRes.json?.result?.email || null) : null;
	const accountTag = accRes.ok ? accRes.json?.result?.[0]?.id : null;
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
	const today = new Date().toISOString().slice(0, 10);

	const gqlQuery = `
        query($accountTag: String!, $date: Date!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    workersInvocationsAdaptive(
                        limit: 1 filter: { date_geq: $date, date_leq: $date }
                    ) { sum { requests } }
                    pagesFunctionsInvocationsAdaptiveGroups(
                        limit: 1 filter: { date_geq: $date, date_leq: $date }
                    ) { sum { requests } }
                }
            }
        }
    `;

	const gql = await fetchJsonSafe('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: gqlQuery, variables: { accountTag, date: today } }),
	}, 1); // 1 retry for transient 502/503 errors

	if (!gql.ok) return { error: `graphql ${gql.error}`, transient: true };
	if (gql.json.errors) {
		const errMsg = gql.json.errors.map(e => e.message).join('; ');
		const isTransient = /internal server error|too many|rate limit|timeout/i.test(errMsg);
		return { error: `GraphQL error: ${errMsg}`, transient: isTransient };
	}

	const acc = gql.json.data?.viewer?.accounts?.[0];
	if (!acc) return { error: 'Missing Account Analytics:Read permission' };

	const sum = (rows) => (rows || []).reduce((s, r) => s + (r.sum?.requests || 0), 0);

	return {
		requests: sum(acc.workersInvocationsAdaptive) + sum(acc.pagesFunctionsInvocationsAdaptiveGroups),
	};
}

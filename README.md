# Cron DNS Gateway (Cloudflare Multi-Account Load Balancer)

[Tiếng Việt Version](README.VI.md)

Cloudflare Workers script designed to **optimize the 100,000 requests/day limit** of the Free plan by automatically rotating DNS records across multiple Cloudflare Pages accounts.

### How it works:
*   **Load Balancing**: Every 5 minutes, the system checks all sub-accounts and selects the one with the **lowest daily request count** to update the DNS. This ensures balanced usage across all accounts.
*   **Notifications & Reporting**: Sends Telegram alerts when an account nears the 80,000 requests limit and a daily summary report at 23:00 UTC.

### Configuration Guide (cron.js)

All configurations are located in `cron.js` under the `// ================= CONFIGURATION =================` section.

#### 1. Telegram Settings
*   **TELEGRAM_BOT_TOKEN**: Get from [@BotFather](https://t.me/botfather).
*   **TELEGRAM_CHAT_ID**: Get from [@userinfobot](https://t.me/userinfobot).

#### 2. Cloudflare (Domain Management Account)
This is the account that holds the DNS management rights for the domain.
*   **CF_API_TOKEN**: [API Tokens](https://dash.cloudflare.com/profile/api-tokens) > Create a token with **Zone.DNS** permissions.
*   **CF_ZONE_ID**: Found in the **Overview** section of your domain.
*   **CF_RECORD_ID**: Run the command below to get the ID for the subdomain you want to rotate (e.g., `serverless-edge-dns-gateway-v2.bibica.net`):

```bash
# Replace CF_ZONE_ID and CF_API_TOKEN with your information
curl -s -X GET "https://api.cloudflare.com/client/v4/zones/CF_ZONE_ID/dns_records?name=serverless-edge-dns-gateway-v2.bibica.net" \
     -H "Authorization: Bearer CF_API_TOKEN" \
     -H "Content-Type: application/json" | jq -r '.result[0].id'
```
*Result format: `b7f08f1db45f1abb23cc71c04bfc9782`*

#### 3. TOKENS List (Cloudflare Pages Sub-accounts)
The list of tokens for the sub-accounts you want to track daily requests for. The account with the lowest request count will be automatically selected.
*   Each sub-account should have 1 token with these permissions:
    1.  `Account.Account Analytics: Read`
    2.  `Account.Account Settings: Read`
    3.  `Cloudflare Pages: Read`
*   **Tip:** You can quickly create these using the **Read all resources** template.
*   Paste the list into the `TOKENS` variable in `cron.js` (one token per line).

#### 4. Warning Threshold
*   `WARNING_LIMIT`: Default is `80000`. When this limit is reached, the system will automatically remove the account from rotation and notify via Telegram.

---
### 5. Deployment (Synchronization)
This project is designed to sync automatically with Cloudflare Workers.
1.  Go to your Cloudflare Dashboard -> **Workers & Pages**.
2.  Select your Worker -> **Settings** -> **Deployment**.
3.  Connect your GitHub/GitLab repository.
4.  Once connected, any changes you make and push to the repository (especially in `cron.js`) will be automatically deployed.

---
> [!NOTE]
> The system is fully automated. After saving and syncing, the Worker will initialize the D1 Database and run every 5 minutes.

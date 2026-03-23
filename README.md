# Supabase Keep-Alive

GitHub Actions workflow to keep Supabase projects active by generating real database activity.

## Why

Supabase can pause free-tier projects after prolonged low activity. A shallow request to the API root may show that the project is reachable while still not producing meaningful database activity. This workflow supports a recommended RPC-based keepalive path that executes against Postgres through PostgREST.

## Features

- Schedule automated keepalive runs via cron
- Support multiple Supabase projects in one workflow
- Recommended RPC mode for real database-backed activity
- Legacy REST root fallback for reachability checks
- Manual trigger support
- Detailed per-project logging

## Setup

### 1. Configure projects

Default option:
- Edit `supabase-configs.json` in this repo.
- Commit changes when you add or remove projects.
- The repo ships with publishable keys, so no GitHub secret is required for the default setup.

Override option:
- Set `SUPABASE_CONFIGS` as a GitHub Actions secret or local env var.
- If `SUPABASE_CONFIGS` is present, it overrides `supabase-configs.json`.

**Single project, recommended:**
```json
[{"name":"Production","url":"https://xxx.supabase.co","key":"your_key","rpc":"keepalive_ping"}]
```

**Multiple projects:**
```json
[
  {"name":"Production","url":"https://xxx.supabase.co","key":"key_1","rpc":"keepalive_ping"},
  {"name":"Staging","url":"https://yyy.supabase.co","key":"key_2","rpc":"keepalive_ping"}
]
```

Get your credentials from Supabase Dashboard -> Settings -> API:
- `url` = Project URL
- `key` = publishable or anon key is enough if the RPC is granted to `anon` and `authenticated`
- `rpc` = Postgres-backed function name to invoke through `/rest/v1/rpc/<name>`

Optional:
- `rpcBody` = JSON object sent to the RPC if your function expects parameters
- `enabled` = set to `false` to keep a project in the secret but skip it during runs

Legacy fallback:
```json
[{"name":"Legacy","url":"https://xxx.supabase.co","key":"your_key"}]
```

Disabled example:
```json
[{"name":"Apollo Auctions","url":"https://old-project.supabase.co","key":"old_key","enabled":false}]
```

If `rpc` is omitted, the workflow only pings `/rest/v1/`. That verifies reachability, but it is not the recommended way to prevent pausing.

### 1a. Create the keepalive RPC in each Supabase project

Run this SQL in each project:

```sql
create table if not exists public.keepalive_log (
  key text primary key,
  touched_at timestamptz not null default now(),
  source text not null default 'github-actions'
);

create or replace function public.keepalive_ping()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.keepalive_log (key, touched_at, source)
  values ('github-actions', now(), 'github-actions')
  on conflict (key) do update
    set touched_at = excluded.touched_at,
        source = excluded.source;

  return json_build_object(
    'ok', true,
    'touched_at', now()
  );
end;
$$;

revoke all on function public.keepalive_ping() from public;
grant execute on function public.keepalive_ping() to anon, authenticated, service_role;
```

This grant model lets the workflow use the project's public publishable or anon key while the function itself performs the write as a definer.

### 2. Adjust Schedule (Optional)

Default: runs every 6 hours at minute 17.

Edit `.github/workflows/ping-supabase.yml`:
```yaml
schedule:
  - cron: '17 */6 * * *'
```

Common schedules:
- Daily: `0 9 * * *`
- Every 6 hours: `17 */6 * * *`
- Every 12 hours: `17 */12 * * *`

### 3. Test

Go to **Actions** -> select the workflow -> **Run workflow**.

## Local Testing

```bash
npm install
cp env.example .env
# Edit .env with your configs
npm run ping
```

Example output:
```text
Pinging 2 database(s)...
Timestamp: 2025-10-12T16:00:00.000Z
------------------------------------------------------------

[1/2] Production
URL: https://xxx.supabase.co
Mode: rpc (keepalive_ping)
Success! Status: 200 Response time: 245ms

[2/2] Staging
URL: https://yyy.supabase.co
Mode: rpc (keepalive_ping)
Success! Status: 200 Response time: 198ms

------------------------------------------------------------
Summary:
  Successful: 2
  Failed: 0
  Total: 2

All databases pinged successfully!
```

## How It Works

Recommended mode:
- The workflow invokes `{url}/rest/v1/rpc/<rpc>` with your configured key.
- That RPC executes against Postgres, which is a much stronger signal than a gateway health check.
- The sample function updates a single row in `public.keepalive_log`, so the project sees recurring database activity without generating unbounded data growth.

Legacy mode:
- If no `rpc` is configured, the workflow sends a `GET` to `{url}/rest/v1/`.
- This is kept for backwards compatibility only.

## FAQ

**Do I need to create anything in Supabase?**  
For the recommended setup, yes. Create the sample `keepalive_ping` RPC and point each config at it.

**Can I use multiple projects?**  
Yes. Add multiple objects to the `SUPABASE_CONFIGS` array.

**How do I remove or retire one project without editing everything else?**  
Set `"enabled": false` on that project or remove the object from `SUPABASE_CONFIGS`.

**Which API key should I use?**  
Use a key that can execute your RPC. `service_role` is the simplest default if the function is private.

**How often should I run this?**  
Every 6 to 12 hours gives you more margin against scheduler delays than a twice-weekly job.

**Will this guarantee a free project never pauses?**  
No. Supabase can change pause heuristics, and Pro is the only real guarantee against automatic pausing. This setup is materially stronger than a root endpoint ping, but it is still best effort on Free.

**Will this consume my API quota?**  
Minimal impact. The sample RPC updates a single row per run.

# Forecast storage

What the interruption forecast keeps in the database besides `forecast_demand` and `forecast_meta`. Both tables below exist in SQLite and PostgreSQL, on new installs and after an upgrade. They hold usage metadata only: no message text, no raw session id, no file name, path or tool name.

## `requests`: cache write split

Two nullable integer columns record how upstream split `cache_creation_input_tokens`:

| Column | Meaning |
|---|---|
| `cache_creation_5m_input_tokens` | Cache writes with the 5-minute lifetime (`usage.cache_creation.ephemeral_5m_input_tokens`). |
| `cache_creation_1h_input_tokens` | Cache writes with the 1-hour lifetime (`usage.cache_creation.ephemeral_1h_input_tokens`). |

Both are NULL when the response carried no split; a reported 0 is stored as 0. The usage collector writes them with the rest of the request's usage. A later save of the same request without a split keeps the stored values.

## `forecast_usage_tokens`

Token sums of one 5-minute bucket, account, source and model family. Key: `(bucket_start, account_id, source, family)`.

| Column | Meaning |
|---|---|
| `bucket_start` | Start of the 5-minute bucket, epoch ms. |
| `account_id` | Serving account; `''` for transcript rows. |
| `source` | `proxy` (from `requests`) or `transcript` (from the transcript backfill). |
| `family` | `opus`, `fable`, `sonnet`, `haiku` or `other`, from the model name. |
| `request_count` | Requests summed. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Sums of the four token categories. |
| `cache_write_5m_tokens`, `cache_write_1h_tokens` | Sums of the split, over requests that reported it. `cache_write_tokens` minus both is the part with unknown lifetime. |

## `forecast_session_requests`

One row per request of a session, in time order, so learners can derive idle gaps and cache transitions. Key: `(source, session_key, at, seq)`; indexed on `(source, at)`.

| Column | Meaning |
|---|---|
| `source` | `proxy` or `transcript`. |
| `session_key` | HMAC of the raw session identity under a per-install salt (`forecast_meta` key `usage_session_salt`). The raw identity is never stored or logged. Anyone with the database also has the salt, so the key is a pseudonym, not an anonymisation. |
| `account_id` | Serving account; `''` for transcript rows. |
| `at` | Request time, epoch ms. |
| `seq` | Orders requests of one session with the same `at` (0 first); proxy rows follow the request id. |
| `family` | Model family, as above. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | The request's tokens. |
| `cache_write_5m_tokens`, `cache_write_1h_tokens` | The request's split, NULL when not reported. |

Proxy requests without a client session id count in `forecast_usage_tokens` but get no session row.

## How proxy rows are kept

Each forecast run's demand sync reads the Claude OAuth requests of its window `[from, to)` once (the whole table on the first run, then from 60 minutes before the previous run through the current bucket) and rebuilds from the same rows the proxy demand, the proxy token sums and the proxy session rows of that window, each replaced in one transaction. Any sequence of syncs therefore leaves the same rows as one full recompute, for requests that change inside a sync window.

The usage detail keeps its own progress: `forecast_meta` key `proxy_usage_detail_through` holds the `to` of the last usage-detail rebuild that finished. Each sync rebuilds the usage detail of `[min(from, through), to)`, or of `[0, to)` while the key is absent. So the first sync that records usage detail rebuilds it from everything `requests` still holds, also on an install whose demand sync first ran long before and now covers only the rolling window. When the usage-detail window starts before the demand window, its request rows come from a separate read; otherwise it reuses the demand rows. A failing usage-detail rebuild never stops the demand sync: the demand rows, `proxy_demand_first_sync_at` and `proxy_demand_last_sync_at` are written as without usage detail, `proxy_usage_detail_through` stays where it was so the next sync reaches back over the missed window, and the service logs `forecast usage detail sync failed error=<name>` with the error name only. `forecast_meta` key `proxy_usage_detail_since` holds the time of the first sync that recorded usage detail.

## Retention

After each sync, token rows with `bucket_start` and session rows with `at` older than the first bucket of the history window (`historyLookbackDays`, default 56) are deleted. `forecast_demand` and `forecast_meta` are not pruned.

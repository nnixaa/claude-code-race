// What a race types: half code, half short notes in the style of developer docs. Each is
// one line of 140 to 200 characters, about 30 to 45 seconds at 50 words a minute, written
// for this game. Code has no space inside or between brackets (`}})`, `{id: u.id}`): one
// line is hard enough to type without spacing that only multi-line code would have.
export const CODE = [
  'const active = users.filter(u => u.lastSeen > Date.now() - 7 * DAY).map(u => ({id: u.id, name: u.name.trim()})).sort((a, b) => a.name.localeCompare(b.name));',
  "export async function getJson(url: string) {const res = await fetch(url, {headers: {Accept: 'application/json'}}); if (!res.ok) throw new Error(res.statusText); return res.json();}",
  `def top_words(text, n=10): counts = Counter(w.lower() for w in re.findall(r"[a-z']+", text, re.I)); return [w for w, _ in counts.most_common(n)]`,
  'for (const [key, value] of Object.entries(config)) {if (value === undefined) continue; params.set(key, String(value));} const query = params.toString();',
  'func retry(ctx context.Context, n int, fn func() error) error {var err error; for i := 0; i < n; i++ {if err = fn(); err == nil {return nil}; time.Sleep(time.Second << i)}; return err}',
  "SELECT u.id, u.email, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.created_at > NOW() - INTERVAL '30 days' GROUP BY u.id ORDER BY orders DESC LIMIT 20;",
  'for _, user := range users {if user.Active && user.LastSeen.After(cutoff) {active = append(active, user)}}; sort.Slice(active, func(i, j int) bool {return active[i].Name < active[j].Name})',
  'def chunks(items, size): return [items[i:i + size] for i in range(0, len(items), size)] # split one long list into lists of at most size items each',
  'git log --since="2 weeks ago" --pretty=format:"%h %an %s" -- src/ | grep -v "chore" | head -n 20 && git diff --stat main...HEAD -- src/ | tail -n 1',
  "const [query, setQuery] = useState(''); const results = useMemo(() => items.filter(i => i.title.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);",
  "app.get('/health', async (req, res) => {const ok = await db.ping().then(() => true).catch(() => false); res.status(ok ? 200 : 503).json({ok, uptime: process.uptime()});});",
  'async def fetch_all(client, urls): return await asyncio.gather(*(client.get(u, timeout=10) for u in urls), return_exceptions=True) # one bad url does not stop the rest',
  'const total = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0); const shipping = total > 50 ? 0 : 4.99; const due = Math.round((total + shipping) * 100) / 100;',
  '.card {display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);}',
  'docker run --rm -it -p 8080:8080 -e NODE_ENV=production -v "$(pwd)/data:/app/data" --name api --restart unless-stopped ghcr.io/acme/api:1.4.2 node dist/server.js',
  'config = {k.lower(): v for k, v in os.environ.items() if k.startswith("APP_")}; timeout = int(config.get("app_timeout", 30)); debug = config.get("app_debug") == "1"',
]

export const DOCS = [
  'A pull request should do one thing well: keep the diff small, explain why in the description, and link the issue so reviewers know what problem the change solves.',
  'Caching helps until it lies to you. Pick a key that changes when the data does, set a sensible expiry, and always keep a way to clear the cache in production.',
  'Write the test that fails first. When it turns green you know the code works, and when it breaks later you know exactly which promise the code stopped keeping.',
  'An HTTP 429 means you sent too many requests. Back off, read the Retry-After header if the server sends one, and retry with jitter so clients do not stampede.',
  'Feature flags let you merge unfinished work safely: ship the code dark, turn it on for a few users, watch the metrics, and delete the flag once the feature is rolled out.',
  'Logs are for humans and machines alike. Use structured fields, put a request id on every line, and never write secrets, tokens or personal data to them.',
  'Idempotent endpoints can be called twice without harm. Accept an idempotency key from the client and return the first result when the same key comes again.',
  'When a migration touches a large table, add the new column as nullable, backfill it in batches, and only then add the constraint, so the table is never locked for long.',
  'Semantic versioning is a promise: bump the major version for breaking changes, the minor for new features, and the patch for fixes that change nothing else.',
  'Code review is not about style; linters handle that. Look for missing edge cases, unclear names, and changes that will be hard to undo once users depend on them.',
  'Environment variables keep configuration out of the code. Validate them at startup and fail fast with a clear message when a required value is missing.',
  'A good error message says what happened, why it happened, and what to do next. Nobody should have to read a stack trace to learn that their file was too big.',
  'Put a timeout on every network call. Without one, a slow dependency quietly holds threads and connections until the whole service stops answering.',
  'Rebase keeps history linear but rewrites commits, so only rebase branches nobody else has pulled. On shared branches, merge instead so nobody has to fix their copy.',
  'Offset pagination gets slow on deep pages. A cursor points at the last item seen, so every page costs the same no matter how far into the list you go.',
  'Observability starts with three questions: is it up, is it fast, and is it right? Metrics answer the first two quickly; traces and logs help with the third.',
]

export const TEXTS = [...CODE, ...DOCS]

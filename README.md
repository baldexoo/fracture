# Fracture web panel

Statyczny front pod Cloudflare Pages (drag & drop folder `web/`).

## Lokalnie

Z katalogu `web/`:

```bash
npx --yes serve -p 5173
```

Albo w Chrome: nie otwieraj `file://` — WebHID i modules wymagają http(s).

1. `http://localhost:5173` → **preview ui** (dziś bez Pico) albo **login** (WebHID)
2. Panel → **share screen** → ustaw aimbot / detection

## Produkcja

Cloudflare Pages → Upload assets → wrzuć zawartość `web/` → dostaniesz `*.pages.dev` (HTTPS).

# 📍 IP Location - Noteva Plugin

Display commenter's IP geolocation (province/city) next to their name.

## Features

- 🌍 Auto IP geolocation lookup on comment creation
- 🏷️ Location badge displayed next to author name
- ⚙️ Configurable precision: province or city level
- 🔌 Customizable IP API endpoint
- 🌐 i18n ready (zh-CN / en)
- 💾 Per-article location cache via plugin storage

## How It Works

1. User posts a comment → backend hook captures their IP
2. WASM plugin calls IP geolocation API (default: ip-api.com)
3. Location stored in plugin storage, grouped by article
4. Frontend fetches location data and injects badges into comment DOM

> **Note:** Requires a reverse proxy (Nginx/Caddy) that sets `X-Forwarded-For` header. Direct localhost connections don't have IP info.

## Settings

| Key | Description | Default |
|-----|-------------|---------|
| `api_url` | IP API URL template (`{ip}` and `{lang}` placeholders) | `http://ip-api.com/json/{ip}?fields=status,regionName,city&lang={lang}` |
| `display_level` | `province` or `city` | `province` |
| `enabled` | Enable/disable | `true` |

## Requirements

- Noteva ≥ 0.2.0
- Permissions: `network`, `storage`
- Reverse proxy with `X-Forwarded-For` header

## License

MIT

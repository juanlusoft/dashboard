# Frontend Architecture

## Current State (v2.11.x)
`main.js` is a monolith (~16K lines). This is documented tech debt.

### Why it's one file
- Vanilla JS SPA with no build step or bundler
- Heavy cross-dependencies between views (shared state, authFetch, notifications)
- Splitting requires careful dependency injection to avoid circular imports

### Section Map (main.js)
| Lines | Section | Description |
|-------|---------|-------------|
| 1-40 | Imports & State | Global state, API_BASE, i18n |
| 41-335 | Notifications | Toast system, confirm modals, confetti |
| 336-1226 | Router & Core | URL routing, auth, polling, disk detection |
| 1227-5512 | Storage Wizard | Step-by-step pool configuration (biggest section) |
| 5513-5844 | Terminal | xterm.js terminal view |
| 5845-5937 | Shortcuts | Command shortcuts modal |
| 5938-5982 | Docker Logs | Container log viewer |
| 5983-6005 | Docker Notes | Container notes CRUD |
| 6006-6012 | Storage View | Enhanced storage dashboard |
| 6013-7501 | File Manager | File Station (browse, upload, download, rename) |
| 7502-8017 | Users & 2FA | User management, TOTP setup |
| 8018-8388 | Backup | Backup jobs & scheduler |
| 8389-8519 | Log Viewer | System log viewer |
| 8520-8711 | Samba | Samba share management |
| 8712-8784 | UPS Monitor | UPS status display |
| 8785-9070 | Notifications | Email/Telegram notification config |
| 9071-9233 | NFS | NFS share management |
| 9234-9440 | DDNS | Dynamic DNS configuration |
| 9441-9998 | VPN | WireGuard VPN server |
| 9999-11709 | Initialization | App bootstrap, render functions |
| 11710-12538 | Active Directory | Samba AD DC management |
| 12539-13377 | Cloud Sync | Syncthing integration |
| 13378-14164 | HomeStore | App marketplace |
| 14165-15956 | Docker Stacks | Docker Compose stack manager |

### Extracted Modules
- `modules/utils.js` — Pure helpers (escapeHtml, formatBytes, debounce, formatUptime)
- `i18n.js` — Internationalization
- `theme-init.js` — Theme initialization (runs before main.js)
- `pwa-init.js` — PWA service worker registration

### Migration Path
1. ✅ Extract pure utilities to modules/utils.js
2. [ ] Extract notification system (minimal state dependency)
3. [ ] Extract each view renderer as a module
4. [ ] Create shared state module (import/export state object)
5. [ ] Create shared API module (authFetch + API_BASE)
6. [ ] Migrate inline onclick handlers to addEventListener
7. [ ] Add bundler (esbuild/vite) for proper tree-shaking

### Shared Dependencies (cross-cutting)
These functions are called from almost every section:
- `state` — Global state object
- `authFetch()` — Authenticated fetch wrapper
- `API_BASE` — API base URL
- `showNotification()` — Toast notifications
- `escapeHtml()` — XSS prevention
- `t()` — i18n translation
- `switchView()` — View navigation

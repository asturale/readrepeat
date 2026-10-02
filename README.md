# ReadRepeat

Self-hosted, open-source Readwise alternative: one place for all your book highlights, with spaced-repetition review, automatic cover enrichment, and its own "Instagram mode" that replaces doomscrolling with something that actually sticks with you.

## Why ReadRepeat?

- **Self-hosted** — your highlights live on your own server, no subscription and no third party that can do whatever it wants with your reading data.
- **Open source** — full control over features and privacy, adapt it however you like.
- **Retention over collecting** — spaced repetition makes sure highlights actually stick with you, instead of sinking into an archive forever.
- **An Instagram mode that gives something back** — endless scrolling through your own highlights instead of someone else's content, and it still counts toward your review schedule.

## Features

**Dashboard**
- Daily Review card with today's highlights, a "done for today" indicator
- Streak counter + calendar (any day with at least 1 completed review counts)
- Highlights feed: recent / random / longest since seen, with a remembered preference

**Discover (Instagram mode)**
- Infinite scroll through random highlights from your review pool
- Scrolling past a card automatically counts toward spaced repetition

**Books**
- Overview with sorting (recently updated / title / author / highlight count)
- Merge books with automatic highlight dedup (from search results too)
- Edit metadata, delete books
- Automatic cover/author enrichment via Hardcover's API, with Open Library as a fallback

**Highlights**
- Edit, merge, add manually, delete
- Inline markdown (`__text__` = highlighter, `**bold**`, `*italic*`, `![alt](url)` = image)
- Readwise Action Tags (`.h1`/`.h2`/`.h3`/`.cN`) — chapter/paragraph context carried over automatically

**Review (spaced repetition)**
- Configurable session size + per-book review frequency
- 4-button model: next / more often / less often / never again
- Swipe gestures (left = next, right = previous)
- Web push reminders at a configurable time and frequency

**Sharing**
- Export a highlight as an image, background color automatically matched to the book's cover

**Importing**
- Classic Kindle "My Clippings.txt" format (also used by CrossPoint/CrossInk devices for their highlight export)
- Automatic sync from a [crosspoint-sync](https://github.com/crosspoint-reader/crosspoint-sync) server: fill in your server, username, password and a sync interval, and new highlights are pulled in automatically
- Direct Kobo import: upload your device's `KoboReader.sqlite` file and its highlights are imported straight from it
- One-time Readwise export import (see below)
- `POST /api/import` — token-authenticated endpoint for ongoing import from your own sync script

**Other**
- Search across books + highlights
- Installable as a PWA (phone/desktop)
- Multilingual (NL/EN, automatic from browser language, configurable per user)
- Strong account security: scrypt password hashing, enforced minimum length (12+) with a blocklist against common passwords, password change
- Single-user: one-time `/setup` (permanently closed afterwards), session login

## Installation

Requires Docker + Docker Compose, and a reverse proxy on the same Docker network (`compose.yaml` expects an external network called `caddy` — adjust this to your own proxy network, or temporarily add `ports: ["3000:3000"]` to test directly without a proxy).

```sh
git clone https://github.com/asturale/readrepeat.git
cd readrepeat
cp .env.example .env   # fill in SESSION_SECRET, everything else is optional
docker network create caddy   # if that network doesn't exist yet
docker compose up -d --build
```

First run: open the site and you'll automatically land on `/setup` to create your account.

### Environment variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | yes | a long random string for session cookies |
| `HARDCOVER_API_TOKEN` | no | cover/author enrichment; without a token, only the Open Library fallback is used |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | no | web push reminders; generate with `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | no | a `mailto:` address for the VAPID key |

## One-time Readwise import

```sh
docker compose exec app node scripts/import-from-readwise.mjs
```

Requires the env vars `READWISE_TOKEN` (your Readwise account token) and `READREPEAT_API_TOKEN` (created via Settings in the app itself).

## API

`POST /api/import`, header `Authorization: Bearer <token>` (token from Settings):

```json
{
  "book": { "title": "...", "author": "..." },
  "highlights": [
    { "text": "...", "note": "...", "location": "123", "color": "yellow", "source": "my-sync-script", "source_id": "unique-id", "created_at": "2026-01-01T12:00:00Z" }
  ]
}
```

`source`/`source_id` are optional but are used to recognize duplicate imports on repeated calls.

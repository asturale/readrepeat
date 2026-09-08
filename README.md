# ReadRepeat

Self-hosted, open-source alternative to Readwise: één overzicht van al je boek-highlights, met automatische cover/metadata-verrijking via Hardcover, bewerken/samenvoegen, spaced-repetition review, deelbare afbeeldingen en meertalige UI.

## Features

- Overzicht van boeken + highlights (importeer vanuit Readwise via `scripts/import-from-readwise.mjs`)
- Automatische cover/auteur-verrijking via Hardcover's API
- Readwise Action Tags (`.h1`/`.h2`/`.h3`/`.cN`/`.word`) — hoofdstuk/paragraaf-context automatisch overgenomen
- Inline markdown in highlight-tekst (`__tekst__` = highlighter, `**bold**`, `*italic*`)
- Highlights bewerken, samenvoegen, handmatig toevoegen, verwijderen
- Spaced-repetition review (instelbare sessiegrootte + per-boek frequentie), 4-knops-model (volgende/vaker/minder/nooit meer)
- Webpush-herinneringen op een instelbaar tijdstip + frequentie
- Highlight exporteren als deelbare afbeelding (met cover)
- Zoeken in boeken + highlights
- Meertalig (NL/EN, automatisch op browsertaal, instelbaar per gebruiker)
- `POST /api/import` — token-geauthenticeerd endpoint voor doorlopende import (bv. vanuit een eigen sync-script)
- Single-user: eenmalige `/setup` (daarna gesloten), login met sessie-cookie (1 jaar, "onthoud mij")

## Draaien

```sh
cp .env.example .env   # vul SESSION_SECRET + HARDCOVER_API_TOKEN in
docker compose up -d --build
```

Eerste keer: open de site, je krijgt automatisch `/setup` te zien.

## Eenmalige Readwise-import

```sh
docker compose exec app node scripts/import-from-readwise.mjs
```

Vereist env vars `READWISE_TOKEN` (je Readwise-account-token) en `READREPEAT_API_TOKEN` (aangemaakt via de Account-pagina in de app zelf).

## API

`POST /api/import`, header `Authorization: Bearer <token>` (token via Account-pagina):

```json
{
  "book": { "title": "...", "author": "..." },
  "highlights": [
    { "text": "...", "note": "...", "location": "123", "color": "yellow", "source": "mijn-sync-script", "source_id": "uniek-id", "created_at": "2026-01-01T12:00:00Z" }
  ]
}
```

`source`/`source_id` zijn optioneel maar worden gebruikt om dubbele imports te herkennen bij herhaald aanroepen.

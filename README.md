# ReadRepeat

Zelfgehoste, open-source Readwise-alternatief: één overzicht van al je boek-highlights, met spaced-repetition review, automatische cover-verrijking en een eigen "Instagram-modus" die doomscrollen vervangt door iets dat je bijblijft.

## Waarom ReadRepeat?

- **Zelf gehost** — je highlights staan op je eigen server, geen abonnement en geen derde partij die met je leesdata kan doen wat ze willen.
- **Open source** — volledige controle over features en privacy, aan te passen naar eigen inzicht.
- **Retentie in plaats van verzamelen** — spaced repetition zorgt dat highlights je echt bijblijven, in plaats van voorgoed weg te zakken in een archief.
- **Instagram-modus die wél iets oplevert** — oneindig scrollen door je eigen highlights in plaats van andermans content, en het telt nog mee voor je review-schema ook.

## Functies

**Dashboard**
- Daily Review-kaart met de highlights van vandaag, "klaar voor vandaag"-melding
- Streak-teller + kalender (elke dag met minstens 1 voltooide review telt mee)
- Feed van highlights: recent / willekeurig / langst geleden gezien, met onthouden voorkeur

**Discover (Instagram-modus)**
- Oneindige scroll door willekeurige highlights uit je review-pool
- Een kaart voorbij scrollen telt automatisch mee voor spaced repetition

**Boeken**
- Overzicht met sorteren (recent bijgewerkt / titel / auteur / aantal highlights)
- Boeken samenvoegen met automatische dedup van highlights (ook vanuit zoekresultaten)
- Metadata bewerken, boeken verwijderen
- Automatische cover/auteur-verrijking via Hardcover's API, met Open Library als fallback

**Highlights**
- Bewerken, samenvoegen, handmatig toevoegen, verwijderen
- Inline markdown (`__tekst__` = highlighter, `**bold**`, `*italic*`, `![alt](url)` = afbeelding)
- Readwise Action Tags (`.h1`/`.h2`/`.h3`/`.cN`) — hoofdstuk/paragraaf-context automatisch overgenomen

**Review (spaced repetition)**
- Instelbare sessiegrootte + per-boek review-frequentie
- 4-knops-model: volgende / vaker / minder / nooit meer
- Swipe-gestures (links = volgende, rechts = vorige)
- Webpush-herinneringen op een instelbaar tijdstip en frequentie

**Delen**
- Highlight exporteren als afbeelding, achtergrondkleur automatisch gematcht aan de boekcover

**Overig**
- Zoeken in boeken + highlights
- Installeerbaar als PWA (telefoon/desktop)
- Meertalig (NL/EN, automatisch op browsertaal, per gebruiker instelbaar)
- Sterke accountbeveiliging: scrypt-wachtwoordhashing, verplichte wachtwoordlengte (12+) met blocklist tegen veelvoorkomende wachtwoorden, wachtwoord wijzigen
- `POST /api/import` — token-geauthenticeerd endpoint voor doorlopende import vanuit een eigen sync-script
- Single-user: eenmalige `/setup` (daarna permanent gesloten), sessie-login

## Installatie

Vereist Docker + Docker Compose, en een reverse proxy op hetzelfde Docker-netwerk (`compose.yaml` verwacht een extern netwerk `caddy` — pas dit aan naar je eigen proxy-netwerk, of voeg tijdelijk `ports: ["3000:3000"]` toe om direct te testen zonder proxy).

```sh
git clone https://github.com/asturale/readrepeat.git
cd readrepeat
cp .env.example .env   # vul SESSION_SECRET in, de rest is optioneel
docker network create caddy   # als dat netwerk nog niet bestaat
docker compose up -d --build
```

Eerste keer: open de site, je krijgt automatisch `/setup` te zien om je account aan te maken.

### Env-variabelen (`.env`)

| Variabele | Verplicht | Omschrijving |
|---|---|---|
| `SESSION_SECRET` | ja | willekeurige lange string voor sessie-cookies |
| `HARDCOVER_API_TOKEN` | nee | cover/auteur-verrijking; zonder token alleen Open Library-fallback |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | nee | webpush-herinneringen; genereer met `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | nee | `mailto:` adres voor de VAPID-sleutel |

## Eenmalige Readwise-import

```sh
docker compose exec app node scripts/import-from-readwise.mjs
```

Vereist env vars `READWISE_TOKEN` (je Readwise-account-token) en `READREPEAT_API_TOKEN` (aangemaakt via Instellingen in de app zelf).

## API

`POST /api/import`, header `Authorization: Bearer <token>` (token via Instellingen):

```json
{
  "book": { "title": "...", "author": "..." },
  "highlights": [
    { "text": "...", "note": "...", "location": "123", "color": "yellow", "source": "mijn-sync-script", "source_id": "uniek-id", "created_at": "2026-01-01T12:00:00Z" }
  ]
}
```

`source`/`source_id` zijn optioneel maar worden gebruikt om dubbele imports te herkennen bij herhaald aanroepen.

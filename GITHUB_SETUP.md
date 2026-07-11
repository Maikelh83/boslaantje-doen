# Repo op GitHub zetten

Ik heb geen toegang tot je GitHub-account, dus dit deel doe je zelf — 5 minuten werk.

## 1. Nieuwe repository aanmaken

1. Ga naar https://github.com/new (log in als nodig).
2. Repository name: `boslaantje-doen` (of `boslaantjedoen-website`).
3. Zichtbaarheid: Private (aanbevolen, tenzij je de broncode publiek wilt delen — bijv. voor GitHub Pages op een gratis account moet de repo public zijn).
4. Laat "Initialize with README" UIT (deze repo heeft er al een).
5. Klik "Create repository".

## 2. Lokale map koppelen en pushen

Open een terminal in de map `Boslaantje-Doen` (deze map, met `index.html`, `catering.html`, etc.) en voer uit:

```bash
cd pad/naar/Boslaantje-Doen
git init
git add .
git commit -m "Initial commit: homepage en cateringpagina"
git branch -M main
git remote add origin https://github.com/JOUW-GEBRUIKERSNAAM/boslaantje-doen.git
git push -u origin main
```

Vervang `JOUW-GEBRUIKERSNAAM` door je eigen GitHub-gebruikersnaam.

Als git om inloggegevens vraagt: GitHub accepteert geen wachtwoord meer via de command line. Gebruik een Personal Access Token (Settings → Developer settings → Personal access tokens) als wachtwoord, of log in via de GitHub Desktop-app / `gh auth login` (GitHub CLI).

## 3. Optioneel: site live zetten via GitHub Pages

Als de repo public is:
1. Ga naar Settings → Pages in de repo.
2. Bij "Source" kies branch `main`, map `/ (root)`.
3. Save. Na een minuut is de site bereikbaar op `https://JOUW-GEBRUIKERSNAAM.github.io/boslaantje-doen/`.

(Voor het echte domein www.boslaantjedoen.nl blijft je huidige hosting/CDN-instelling gewoon leidend — GitHub Pages is hier vooral handig als backup/preview-omgeving.)

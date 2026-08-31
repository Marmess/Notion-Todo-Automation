# Notion Tasks Mailer

Envoie chaque jour (ou à la demande) un courriel listant les tâches non terminées
d'une base de données Notion.

## 1. Créer une intégration Notion

1. Va sur https://www.notion.so/my-integrations → **New integration**.
2. Donne-lui un nom, associe-la à ton workspace, sauvegarde.
3. Copie le **Internal Integration Secret** → ce sera `NOTION_API_KEY`.
4. Ouvre ta base de données de tâches dans Notion → menu **···** en haut à droite
   → **Connexions** (Connections) → ajoute ton intégration. **Sans cette étape,
   l'API renverra une erreur 404.**
5. Récupère l'ID de la base : dans l'URL de la base
   `https://www.notion.so/xxxxxx?v=yyyyyy`, la partie `xxxxxx` (32 caractères)
   est `NOTION_DATABASE_ID`.

## 2. Vérifier les noms de propriétés

Ouvre ta base et vérifie :
- Le nom de la colonne "titre" (souvent `Name` ou `Nom`) → `NOTION_TITLE_PROPERTY`.
- Le nom et le **type** de la colonne qui indique si une tâche est terminée
  (`Status` de type "Status", ou une case à cocher "Terminé") →
  `NOTION_STATUS_PROPERTY` et `NOTION_STATUS_PROPERTY_TYPE`.

## 3. Configurer l'envoi de courriel (Gmail)

1. Active la validation en 2 étapes sur ton compte Google.
2. Crée un "mot de passe d'application" : https://myaccount.google.com/apppasswords
3. Utilise-le comme `SMTP_PASS` (16 caractères sans espaces).

Tu peux aussi utiliser n'importe quel autre fournisseur SMTP (Outlook, Resend,
SendGrid, etc.) en ajustant `SMTP_HOST`/`SMTP_PORT`.

## 4. Tester en local

```bash
npm install
cp .env.example .env
# remplis .env avec tes vraies valeurs
npm start
```

Puis dans un autre terminal :
```bash
curl -X POST http://localhost:3000/send-tasks
```

## 5. Déployer sur Railway

1. Pousse ce dossier dans un dépôt GitHub.
2. Sur https://railway.app → **New Project** → **Deploy from GitHub repo**.
3. Sélectionne le dépôt. Railway détecte automatiquement Node.js
   (`npm install` puis `npm start`).
4. Dans l'onglet **Variables** du service Railway, ajoute toutes les variables
   listées dans `.env.example` (sans le fichier `.env` lui-même — il ne doit
   jamais être commité).
5. Railway attribue un domaine public automatiquement (onglet **Settings** →
   **Networking** → **Generate Domain**) si tu veux appeler `/send-tasks`
   depuis l'extérieur.
6. Le cron interne (`node-cron`) tourne tant que le service Railway est actif
   — assure-toi que le service n'est pas mis en veille (les plans payants
   Railway gardent le service actif 24/7).

## Endpoints

- `GET /health` — vérification que le service tourne.
- `POST /send-tasks` (ou `GET /send-tasks?secret=...`) — déclenche l'envoi
  immédiatement. Si `TRIGGER_SECRET` est défini, il faut fournir l'en-tête
  `x-trigger-secret` (POST) ou `?secret=` (GET).

## Personnaliser l'horaire

`CRON_SCHEDULE` suit la syntaxe cron standard. Par défaut `0 8 * * *` = tous
les jours à 8h00 (heure définie par `CRON_TIMEZONE`, ex: `America/Toronto`).

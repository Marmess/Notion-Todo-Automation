require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');

// ---------------------------------------------------------------------------
// Configuration (via variables d'environnement)
// ---------------------------------------------------------------------------
const {
  NOTION_API_KEY,
  // ID de la vue Notion à interroger (récupéré depuis l'URL: ?v=XXXXXXXX)
  NOTION_VIEW_ID,
  // Nom de la propriété "titre" de la tâche dans Notion (généralement "Name" ou "Nom")
  NOTION_TITLE_PROPERTY = 'Name',
  // Nom de la propriété "Priorité" (type Select) dans Notion
  NOTION_PRIORITY_PROPERTY = 'Priorité',
  // Niveaux de priorité (valeurs exactes de la colonne Select dans Notion),
  // séparés par des virgules, dans l'ordre d'affichage dans le courriel.
  // Les tâches sans priorité s'affichent d'abord sous "Non classé".
  NOTION_PRIORITY_ORDER = 'Urgent,Cette semaine,Non prioritaire',
  // Nom exact de la colonne date d'échéance dans Notion (pour le compte
  // à rebours affiché dans le courriel quotidien)
  NOTION_DUE_DATE_PROPERTY = 'Due Date',
  // Nom exact de la colonne "jour prévu pour faire la tâche" (utilisée par
  // ton filtre de vue). C'est celle-ci qu'on remplit avec la date du jour
  // quand une tâche est créée depuis un courriel.
  NOTION_TASK_DATE_PROPERTY = 'Dates',

  // Resend (envoi de courriel via HTTPS, contourne le blocage SMTP de Railway)
  RESEND_API_KEY,
  MAIL_FROM,
  MAIL_TO,

  // ID de la base de données Notion (requis pour CRÉER des pages/tâches;
  // la vue ne sert qu'à LIRE). Récupéré depuis l'URL de la base.
  NOTION_DATABASE_ID,
  // Secret du webhook Resend (fourni lors de la création du webhook,
  // commence par 'whsec_'), pour vérifier que les requêtes entrantes
  // proviennent bien de Resend.
  RESEND_WEBHOOK_SECRET,
  // Seule cette adresse peut créer des tâches par courriel entrant
  // (par défaut: ta propre adresse, MAIL_TO). Les autres sont ignorés.
  ALLOWED_SENDER_EMAIL = MAIL_TO,

  // ID de la base Notion "Réglages" (fuseau horaire, heure d'envoi, envoi
  // actif). Optionnel: sans cette variable, les valeurs ci-dessous sont
  // utilisées telles quelles.
  NOTION_SETTINGS_DATABASE_ID,
  // Tous les combien de secondes relire les réglages dans Notion (défaut:
  // 120, minimum 5). Sous 60, chaque vérification d'une minute relit Notion.
  SETTINGS_REFRESH_SECONDS = '120',

  // Liens des tâches dans les courriels. 'view' (défaut): la tâche s'ouvre
  // par-dessus une vue Notion (NOTION_VIEW_ID, ou TASK_LINK_VIEW_ID si tu
  // veux une autre vue). 'page': ouvre la page seule (ancien comportement).
  TASK_LINK_MODE = 'view',
  // Lien complet d'une vue Notion (copié avec "Copy link"). S'il est fourni,
  // chaque tâche s'ouvre par-dessus CETTE vue: c'est le réglage le plus simple.
  TASK_LINK_VIEW_URL,
  TASK_LINK_VIEW_ID,
  // 's' = panneau latéral, 'c' = fenêtre centrée
  TASK_LINK_PEEK = 's',

  // Courriel de mise à jour quand tu coches une tâche (webhooks Notion).
  // NOTION_WEBHOOK_SECRET: jeton de vérification fourni par Notion. Sans lui,
  // la fonction est inactive.
  NOTION_WEBHOOK_SECRET,
  // Colonne "Todo" (case ou statut): son changement, dans un sens ou l'autre,
  // déclenche aussi un courriel de mise à jour.
  NOTION_DONE_PROPERTY = 'Todo',
  // Délai (secondes) avant l'envoi, remis à zéro à chaque nouvelle case cochée:
  // cocher plusieurs tâches d'affilée ne donne qu'un seul courriel.
  CHECK_EMAIL_DELAY_SECONDS = '15',

  // Valeurs PAR DÉFAUT de l'envoi quotidien. Elles servent quand la base
  // Réglages n'est pas configurée ou est illisible.
  // CRON_SCHEDULE: seule l'heure compte (ex: '0 7 * * *' = 07:00).
  CRON_SCHEDULE = '0 8 * * *',
  CRON_TIMEZONE = 'America/Toronto',
  ENABLE_CRON = 'true',

  PORT = 3000,
  // Clé secrète optionnelle pour protéger l'endpoint manuel
  TRIGGER_SECRET,
} = process.env;

if (!NOTION_API_KEY || !NOTION_VIEW_ID) {
  console.error('❌ NOTION_API_KEY et NOTION_VIEW_ID sont requis.');
  process.exit(1);
}
if (!RESEND_API_KEY || !MAIL_TO) {
  console.error('❌ RESEND_API_KEY et MAIL_TO sont requis.');
  process.exit(1);
}

const NOTION_VERSION = '2026-03-11';
const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Réglages lus depuis Notion: fuseau horaire, heure d'envoi, envoi actif
// ---------------------------------------------------------------------------
// Fuseau actif: celui des réglages Notion (ou CRON_TIMEZONE par défaut).
// Il sert à la date du courriel, au "dans X jours" et à la date des tâches
// créées par courriel.
let activeTimezone = CRON_TIMEZONE;
function currentTimezone() {
  return activeTimezone;
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Accepte '7:00', '07:00', '7h00', '07h30'... et renvoie 'HH:MM', sinon null.
function parseSendTime(raw) {
  const m = /^\s*([01]?\d|2[0-3])\s*[:hH]\s*([0-5]\d)\s*$/.exec(raw || '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Heure par défaut déduite de CRON_SCHEDULE (ex: '0 7 * * *' => '07:00').
function defaultSendTime() {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(CRON_SCHEDULE);
  if (m) {
    const parsed = parseSendTime(`${m[2]}:${m[1].padStart(2, '0')}`);
    if (parsed) return parsed;
  }
  return '07:00';
}

function defaultSettings() {
  return {
    timezone: CRON_TIMEZONE,
    sendTime: defaultSendTime(),
    active: true,
    source: 'valeurs par défaut',
    warnings: [],
  };
}

function normalizeName(s) {
  return String(s || '').replace(/[’‘`´]/g, "'").trim().toLowerCase();
}

// Trouve une propriété par son nom, sans se soucier des majuscules ni du
// type d'apostrophe (' ou ’).
function findProperty(properties, wantedName) {
  const wanted = normalizeName(wantedName);
  const key = Object.keys(properties || {}).find((k) => normalizeName(k) === wanted);
  return key ? properties[key] : undefined;
}

function propText(prop) {
  if (!prop) return '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'rich_text') return (prop.rich_text || []).map((t) => t.plain_text).join('');
  if (prop.type === 'title') return (prop.title || []).map((t) => t.plain_text).join('');
  return '';
}

function parseSettingsPage(page) {
  const props = page.properties || {};
  const defaults = defaultSettings();
  const warnings = [];

  let timezone = defaults.timezone;
  const tzRaw = propText(findProperty(props, 'Fuseau horaire')).trim();
  if (tzRaw) {
    if (isValidTimezone(tzRaw)) {
      timezone = tzRaw;
    } else {
      warnings.push(`Fuseau horaire inconnu "${tzRaw}" (utilise un nom officiel comme Europe/Paris): ${timezone} conservé.`);
    }
  }

  let sendTime = defaults.sendTime;
  const timeRaw = propText(findProperty(props, "Heure d'envoi")).trim();
  if (timeRaw) {
    const parsed = parseSendTime(timeRaw);
    if (parsed) {
      sendTime = parsed;
    } else {
      warnings.push(`Heure d'envoi illisible "${timeRaw}" (écris par exemple 07:00): ${sendTime} conservée.`);
    }
  }

  // Case décochée = envoi suspendu. Si la propriété n'existe pas, on envoie.
  const activeProp = findProperty(props, 'Envoi actif');
  const active = activeProp?.type === 'checkbox' ? activeProp.checkbox === true : true;

  return { timezone, sendTime, active, source: 'Notion', warnings };
}

// Titre de la base Réglages, utilisé pour la retrouver si l'identifiant
// fourni n'est pas celui de la base (par exemple l'identifiant de la page qui
// la contient, quand le lien copié vient d'une vue).
const SETTINGS_DATABASE_TITLE = 'Réglages';
let resolvedSettingsDatabaseId = null;

const sameId = (a, b) => String(a).replace(/-/g, '').toLowerCase() === String(b).replace(/-/g, '').toLowerCase();

// Clé de comparaison de titres: sans majuscules, sans accents (quelle que soit
// la façon dont ils sont codés), espaces normalisés.
const titleKey = (s) =>
  normalizeName(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

// Liste toutes les bases visibles par l'intégration (sans dépendre de la
// recherche floue de Notion: on filtre nous-mêmes).
async function listAccessibleDatabases() {
  const all = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: { ...NOTION_HEADERS, 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: { property: 'object', value: 'database' },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`La recherche des bases a échoué (${res.status}).`);
    }
    const data = await res.json();
    all.push(...(data.results || []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all.map((db) => ({
    id: db.id,
    title: (db.title || []).map((t) => t.plain_text).join(''),
    propertyNames: Object.keys(db.properties || {}),
  }));
}

async function findSettingsDatabaseId() {
  const databases = await listAccessibleDatabases();

  // 1) Par les colonnes: la base qui a "Fuseau horaire" et "Heure d'envoi".
  //    C'est le plus fiable: ça marche même si la base n'a pas de titre.
  const needed = ['Fuseau horaire', "Heure d'envoi"].map(titleKey);
  const bySchema = databases.filter((db) => {
    const names = db.propertyNames.map(titleKey);
    return needed.every((n) => names.includes(n));
  });

  // 2) Sinon, par le titre.
  const wanted = titleKey(SETTINGS_DATABASE_TITLE);
  const exact = databases.filter((db) => titleKey(db.title) === wanted);
  const partial = databases.filter((db) => titleKey(db.title).includes(wanted));
  const byTitle = exact.length ? exact : partial.length === 1 ? partial : [];

  const matches = bySchema.length ? bySchema : byTitle;

  if (matches.length === 0) {
    const preview = (db) => {
      const cols = db.propertyNames.slice(0, 5).join(', ');
      const more = db.propertyNames.length > 5 ? `, +${db.propertyNames.length - 5}` : '';
      return `"${db.title || '(sans titre)'}" [${cols}${more}]`;
    };
    const seen = databases.length ? databases.slice(0, 10).map(preview).join(' ; ') : 'aucune';
    throw new Error(
      `Aucune base de réglages trouvée (colonnes "Fuseau horaire" et "Heure d'envoi", ou titre "${SETTINGS_DATABASE_TITLE}"). ` +
        `Bases visibles: ${seen}. (vérifie Settings > Connections > Manage page access)`
    );
  }
  if (matches.length > 1) {
    console.warn(`⚠️ ${matches.length} bases de réglages trouvées, la première est utilisée.`);
  }
  return matches[0].id;
}

function querySettingsDatabase(databaseId) {
  // L'ancienne version d'API (2022-06-28) est la plus simple pour lire la
  // première ligne d'une base ordinaire.
  return fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: { ...NOTION_HEADERS, 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ page_size: 1 }),
  });
}

async function loadSettingsFromNotion() {
  const id = resolvedSettingsDatabaseId || NOTION_SETTINGS_DATABASE_ID;
  let res = await querySettingsDatabase(id);

  // 404: l'identifiant n'est pas celui d'une base accessible. On cherche la
  // base par son titre plutôt que de laisser les réglages inutilisables.
  if (res.status === 404) {
    let foundId = null;
    let searchProblem = '';
    try {
      foundId = await findSettingsDatabaseId();
    } catch (err) {
      searchProblem = err.message;
    }
    if (!foundId) {
      throw new Error(`Base introuvable avec l'identifiant fourni (404). ${searchProblem}`);
    }
    if (!sameId(foundId, id)) {
      resolvedSettingsDatabaseId = foundId;
      console.log(
        `ℹ️ Base des réglages trouvée automatiquement (id: ${foundId}). Tu peux mettre cet identifiant dans NOTION_SETTINGS_DATABASE_ID.`
      );
      res = await querySettingsDatabase(foundId);
    }
  }

  if (!res.ok) {
    throw new Error(`Notion (réglages) a répondu ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error('La base Réglages est vide (ajoute une ligne).');
  }
  return parseSettingsPage(data.results[0]);
}

const refreshSeconds = Number(SETTINGS_REFRESH_SECONDS);
const SETTINGS_CACHE_MS =
  (Number.isFinite(refreshSeconds) && refreshSeconds >= 5 ? refreshSeconds : 120) * 1000;
const SETTINGS_RETRY_MS = Math.min(30 * 1000, SETTINGS_CACHE_MS); // nouvel essai après un échec
let settingsCache = { fetchedAt: 0, ttl: 0, value: null };
let lastGoodSettings = null;
let lastSettingsLog = '';
let lastSettingsError = '';

// Ne lance jamais d'erreur: en cas de problème, garde les derniers réglages
// connus (ou les valeurs par défaut si on n'en a jamais eu).
async function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.fetchedAt < settingsCache.ttl) {
    return settingsCache.value;
  }

  let value;
  let ttl = SETTINGS_CACHE_MS;
  if (!NOTION_SETTINGS_DATABASE_ID) {
    value = defaultSettings();
  } else {
    try {
      value = await loadSettingsFromNotion();
      lastGoodSettings = value;
      lastSettingsError = '';
    } catch (err) {
      value = lastGoodSettings || defaultSettings();
      ttl = SETTINGS_RETRY_MS;
      if (err.message !== lastSettingsError) {
        lastSettingsError = err.message;
        console.error(
          `⚠️ Réglages Notion illisibles (${lastGoodSettings ? 'derniers réglages connus conservés' : 'valeurs par défaut utilisées'}): ${err.message}`
        );
      }
    }
  }

  settingsCache = { fetchedAt: Date.now(), ttl, value };
  activeTimezone = value.timezone;

  // On n'écrit dans les logs que quand les réglages changent.
  const logKey = `${value.timezone}|${value.sendTime}|${value.active}|${value.warnings.join(';')}`;
  if (logKey !== lastSettingsLog) {
    lastSettingsLog = logKey;
    console.log(
      `⚙️ Réglages (${value.source}): fuseau=${value.timezone}, heure d'envoi=${value.sendTime}, envoi ${value.active ? 'actif' : 'SUSPENDU'}`
    );
    value.warnings.forEach((w) => console.warn(`⚠️ ${w}`));
  }
  return value;
}

// Heure (HH:MM) et date (YYYY-MM-DD) d'un instant, dans un fuseau donné.
function timeInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
function dateInZone(date, timeZone) {
  return date.toLocaleDateString('en-CA', { timeZone });
}

// Appelée chaque minute: envoie le résumé si l'heure et le fuseau des
// réglages correspondent, une seule fois par jour.
let lastSentKey = '';
async function schedulerTick() {
  const now = new Date();
  try {
    const settings = await getSettings();
    if (!settings.active) return;
    if (timeInZone(now, settings.timezone) !== settings.sendTime) return;

    const key = `${dateInZone(now, settings.timezone)} ${settings.sendTime} ${settings.timezone}`;
    if (key === lastSentKey) return;
    lastSentKey = key;

    console.log(`⏰ Envoi du résumé (${settings.sendTime}, ${settings.timezone})...`);
    await sendTasksEmail();
  } catch (err) {
    console.error('Erreur cron:', err);
  }
}

// ---------------------------------------------------------------------------
// Webhooks Notion: courriel de mise à jour quand une case "Todo" est cochée
// ---------------------------------------------------------------------------
// Signature: en-tête X-Notion-Signature = "sha256=" + HMAC-SHA256 du corps brut,
// avec le jeton de vérification comme clé.
function verifyNotionWebhook(rawBody, signature) {
  if (!NOTION_WEBHOOK_SECRET || !signature) return false;
  const expected = Buffer.from(
    'sha256=' + crypto.createHmac('sha256', NOTION_WEBHOOK_SECRET).update(rawBody).digest('hex')
  );
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// Cherche un "verification_token" n'importe où dans le corps (peu importe la
// version du format des événements).
function findVerificationToken(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === 'verification_token' && typeof value === 'string' && value) return value;
    const nested = findVerificationToken(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

// Aperçu court et sans danger d'une requête ignorée, pour les logs.
function previewRequest(req, rawBody) {
  const text = rawBody.toString('utf8').replace(/\s+/g, ' ');
  return `en-têtes=[${Object.keys(req.headers).join(', ')}] signature=${req.headers['x-notion-signature'] ? 'oui' : 'non'} corps=${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(String(s));
  } catch {
    return String(s);
  }
};
const sameNotionId = (a, b) =>
  String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase();

const checkDelaySeconds = Number(CHECK_EMAIL_DELAY_SECONDS);
const CHECK_EMAIL_DELAY_MS =
  (Number.isFinite(checkDelaySeconds) && checkDelaySeconds >= 0 && checkDelaySeconds <= 600
    ? checkDelaySeconds
    : 15) * 1000;

// Colonnes dont la modification déclenche un courriel de mise à jour: le titre
// de la tâche, ses dates, sa priorité et son état (case ou statut).
const WATCHED_PROPERTY_NAMES = [
  NOTION_TITLE_PROPERTY,
  NOTION_TASK_DATE_PROPERTY,
  NOTION_DUE_DATE_PROPERTY,
  NOTION_PRIORITY_PROPERTY,
  NOTION_DONE_PROPERTY,
];

function resolveWatchedProperty(properties, name) {
  const found = findProperty(properties, name);
  if (found) return found;
  // Le titre peut porter un autre nom que prévu: on prend la colonne de type titre.
  if (normalizeName(name) === normalizeName(NOTION_TITLE_PROPERTY)) {
    return Object.values(properties || {}).find((p) => p.type === 'title');
  }
  return undefined;
}

// Envoie la dernière version de la liste après un court délai, remis à zéro à
// chaque nouvelle modification: plusieurs modifications d'affilée ne donnent
// qu'un seul courriel.
let checkEmailTimer = null;
function scheduleCheckUpdateEmail() {
  clearTimeout(checkEmailTimer);
  checkEmailTimer = setTimeout(async () => {
    checkEmailTimer = null;
    try {
      const settings = await getSettings();
      if (!settings.active) {
        console.log('↪ Mise à jour non envoyée: envoi suspendu dans Réglages.');
        return;
      }
      // Seulement si la liste est différente du dernier courriel du jour:
      // modifier une tâche hors de la vue ne produit pas de courriel identique.
      const count = await sendTasksEmail({ onlyIfChanged: true });
      if (count !== null) console.log(`✅ Courriel de mise à jour envoyé (${count} tâche(s)).`);
    } catch (err) {
      console.error('Erreur lors de la mise à jour après modification:', err);
    }
  }, CHECK_EMAIL_DELAY_MS);
}

// Décide si un événement "page.properties_updated" concerne une colonne suivie
// d'une tâche de la base Todo. Journalise la raison de chaque rejet.
async function handleNotionEvent(event) {
  if (event.type !== 'page.properties_updated') {
    console.log(`↪ Événement Notion ignoré: type "${event.type}" (seul page.properties_updated est utilisé).`);
    return;
  }

  const pageId = event.entity?.id;
  const updated = event.data?.updated_properties;
  if (!pageId) return;
  if (!Array.isArray(updated)) {
    console.warn('↪ Événement Notion ignoré: pas de liste updated_properties.');
    return;
  }

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { ...NOTION_HEADERS, 'Notion-Version': '2022-06-28' },
  });
  if (!res.ok) {
    console.warn(`↪ Événement Notion ignoré: page illisible (${res.status}).`);
    return;
  }
  const page = await res.json();

  if (NOTION_DATABASE_ID && !sameNotionId(page.parent?.database_id, NOTION_DATABASE_ID)) {
    console.log("↪ Événement Notion ignoré: la page n'est pas dans la base Todo.");
    return;
  }

  const updatedIds = new Set(updated.map(safeDecode));
  const changed = [];
  for (const name of new Set(WATCHED_PROPERTY_NAMES)) {
    const prop = resolveWatchedProperty(page.properties, name);
    if (prop && updatedIds.has(safeDecode(prop.id))) changed.push(name);
  }
  if (changed.length === 0) {
    console.log(`↪ Événement Notion ignoré: aucune colonne suivie n'a changé (suivies: ${[...new Set(WATCHED_PROPERTY_NAMES)].join(', ')}).`);
    return;
  }

  console.log(`🔔 Colonne(s) modifiée(s): ${changed.map((n) => `"${n}"`).join(', ')}. Mise à jour dans ${CHECK_EMAIL_DELAY_MS / 1000} s.`);
  scheduleCheckUpdateEmail();
}

// ---------------------------------------------------------------------------
// Vérification de la signature des webhooks Resend (format Svix)
// ---------------------------------------------------------------------------
function verifyResendWebhook(rawBody, headers) {
  if (!RESEND_WEBHOOK_SECRET) return false;

  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretBytes = Buffer.from(RESEND_WEBHOOK_SECRET.split('_')[1], 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  return svixSignature
    .split(' ')
    .map((part) => part.split(',')[1])
    .some((sig) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature));
      } catch {
        return false;
      }
    });
}

// Extrait juste l'adresse courriel d'un champ "from", qu'il soit une simple
// chaîne ('a@b.com' ou 'Nom <a@b.com>') ou un objet { email, name }.
function extractSenderEmail(fromField) {
  if (!fromField) return '';
  if (typeof fromField === 'object' && fromField.email) {
    return fromField.email.trim().toLowerCase();
  }
  if (typeof fromField === 'string') {
    const match = /<(.+)>/.exec(fromField);
    return (match ? match[1] : fromField).trim().toLowerCase();
  }
  return '';
}

// Récupère le contenu complet d'un courriel reçu (le webhook ne transmet
// que les métadonnées — sujet/expéditeur — pas le corps).
async function fetchInboundEmailContent(emailId) {
  if (!emailId) return '';

  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) {
    console.error(`⚠️ Impossible de récupérer le contenu du courriel (${res.status}).`);
    return '';
  }

  const email = await res.json();
  if (email.text) return email.text.trim();
  if (email.html) {
    // Retrait grossier des balises HTML si seul le HTML est disponible
    return email.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Découpe un texte en blocs "paragraph" Notion (max ~1900 caractères
// chacun, limite imposée par l'API Notion sur le texte riche).
function textToNotionBlocks(text) {
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push(text.slice(i, i + 1900));
  }
  return chunks.map((chunk) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
  }));
}

// ---------------------------------------------------------------------------
// Crée une nouvelle page (tâche) dans la base Notion à partir d'un sujet
// de courriel.
// ---------------------------------------------------------------------------
async function createNotionTaskFromEmail(subject, bodyContent) {
  const title = (subject || '(sans sujet)').trim();
  await getSettings(); // fuseau à jour pour la date du jour

  // Date d'aujourd'hui (selon le fuseau configuré), au format YYYY-MM-DD
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: currentTimezone() });

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        [NOTION_TITLE_PROPERTY]: {
          title: [{ text: { content: title } }],
        },
        [NOTION_TASK_DATE_PROPERTY]: {
          date: { start: todayStr },
        },
      },
      children: textToNotionBlocks(bodyContent),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion (create page) a répondu ${res.status}: ${errText}`);
  }

  const page = await res.json();
  console.log(`✅ Tâche créée dans Notion: "${title}" (${page.id})`);
  return page;
}

// ---------------------------------------------------------------------------
// Extraction du texte du titre / de la date d'échéance d'une page Notion
// ---------------------------------------------------------------------------
// Lien d'une tâche pour les courriels. En mode 'view', la tâche s'ouvre par-dessus
// la vue choisie (plutôt que sur la page seule). Sans base ou sans identifiant
// de page, on garde le lien de la page.
// Lit un lien de vue Notion: garde l'adresse de base (avec son éventuel nom
// d'espace de travail) et l'identifiant de vue (?v=), et ignore le reste
// (source=copy_link, etc.). Renvoie null si le lien est inutilisable.
function parseViewUrl(raw) {
  const cleaned = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return null;
  try {
    const u = new URL(cleaned);
    const viewId = (u.searchParams.get('v') || '').replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(viewId)) return null;
    return { base: `${u.origin}${u.pathname}`, viewId };
  } catch {
    return null;
  }
}
const customViewLink = parseViewUrl(TASK_LINK_VIEW_URL);
if (TASK_LINK_VIEW_URL && !customViewLink) {
  console.warn('⚠️ TASK_LINK_VIEW_URL est illisible (il doit être un lien Notion contenant ?v=...): le lien par défaut est utilisé.');
}

function taskLink(page) {
  if (TASK_LINK_MODE !== 'view' || !page?.id) return page?.url;

  // Lien de vue fourni: la tâche s'ouvre par-dessus cette vue.
  if (customViewLink) {
    const peek = TASK_LINK_PEEK === 'c' ? 'c' : 's';
    return `${customViewLink.base}?v=${customViewLink.viewId}&p=${String(page.id).replace(/-/g, '')}&pm=${peek}`;
  }

  if (!NOTION_DATABASE_ID) return page.url;
  const viewId = String(TASK_LINK_VIEW_ID || NOTION_VIEW_ID).replace(/-/g, '');
  const peek = TASK_LINK_PEEK === 'c' ? 'c' : 's';

  // On reprend le même type d'adresse que celle renvoyée par Notion pour la
  // page (app.notion.com/p/... ou www.notion.so/...).
  let prefix = 'https://www.notion.so/';
  try {
    const u = new URL(page.url);
    prefix = u.pathname.startsWith('/p/') ? `${u.origin}/p/` : `${u.origin}/`;
  } catch {
    /* adresse illisible: on garde le préfixe par défaut */
  }
  const dbId = String(NOTION_DATABASE_ID).replace(/-/g, '');
  const pageId = String(page.id).replace(/-/g, '');
  return `${prefix}${dbId}?v=${viewId}&p=${pageId}&pm=${peek}`;
}

function extractTitle(page) {
  const props = page.properties || {};
  // Cherche la propriété configurée, sinon la première propriété de type "title"
  let prop = props[NOTION_TITLE_PROPERTY];
  if (!prop || prop.type !== 'title') {
    prop = Object.values(props).find((p) => p.type === 'title');
  }
  if (!prop || !prop.title) return '(sans titre)';
  return prop.title.map((t) => t.plain_text).join('') || '(sans titre)';
}

// Retourne le nom exact de la priorité choisie dans la colonne Select
// (ex: 'Urgent'), ou une chaîne vide si aucune priorité n'est définie.
function extractPriorityLabel(page) {
  const prop = page.properties?.[NOTION_PRIORITY_PROPERTY];
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select.name || '';
}

function extractDueDate(page) {
  const candidates = [NOTION_DUE_DATE_PROPERTY, 'Due', 'Due Date', 'Date', 'Dates', 'Échéance', 'Deadline'];
  for (const name of candidates) {
    const prop = page.properties?.[name];
    if (prop && prop.type === 'date' && prop.date?.start) {
      return prop.date.start;
    }
  }
  return null;
}

// Extrait l'année/mois/jour d'une date ISO Notion, selon le fuseau configuré
// si une heure est présente (pour éviter le décalage UTC).
function extractCalendarDate(isoDate) {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return { year: Number(year), month: Number(month), day: Number(day) };
  }
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  // 'en-CA' donne le format YYYY-MM-DD, pratique à re-découper
  const parts = d.toLocaleDateString('en-CA', { timeZone: currentTimezone() }).split('-');
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

// Calcule le nombre de jours de calendrier entre aujourd'hui (selon le
// fuseau configuré) et la date d'échéance. Positif = futur, négatif = passé.
function daysUntilDue(isoDate) {
  const due = extractCalendarDate(isoDate);
  if (!due) return null;

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: currentTimezone() });
  const [ty, tm, td] = todayStr.split('-').map(Number);

  const dueUTC = Date.UTC(due.year, due.month - 1, due.day);
  const todayUTC = Date.UTC(ty, tm - 1, td);

  return Math.round((dueUTC - todayUTC) / 86400000);
}

// Formate le nombre de jours en texte lisible: 'aujourd'hui', 'demain',
// 'dans 3 jours', 'en retard de 2 jours', etc.
function formatDaysUntil(isoDate) {
  const diff = daysUntilDue(isoDate);
  if (diff === null) return '';
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return 'demain';
  if (diff === -1) return 'en retard de 1 jour';
  if (diff > 1) return `dans ${diff} jours`;
  return `en retard de ${Math.abs(diff)} jours`;
}

// Formate une date ISO Notion ('2026-10-15' ou '2026-10-15T14:30:00...')
// en court format lisible, ex: '15 oct.'
function formatDueDate(isoDate) {
  if (!isoDate) return '';

  // Date seule (pas d'heure, ex: '2026-10-15'): on parse les chiffres
  // directement pour éviter que le fuseau horaire décale le jour.
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // Date avec heure: on convertit normalement selon le fuseau configuré.
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-CA', {
    day: 'numeric',
    month: 'short',
    timeZone: currentTimezone(),
  });
}

// ---------------------------------------------------------------------------
// Récupère les tâches via l'API des vues Notion (reproduit le filtre/tri
// exact configuré sur la vue choisie dans Notion, sans logique de filtre
// dupliquée dans ce code).
// ---------------------------------------------------------------------------
async function fetchViewTasks() {
  // Étape 1: créer la requête sur la vue
  const createRes = await fetch(`https://api.notion.com/v1/views/${NOTION_VIEW_ID}/queries`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({ page_size: 100 }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Notion (create query) a répondu ${createRes.status}: ${errText}`);
  }
  const queryData = await createRes.json();

  const queryId = queryData.id;
  let allPages = [...(queryData.results || [])];
  let cursor = queryData.next_cursor;
  let hasMore = queryData.has_more;

  // Étape 2: paginer si nécessaire
  while (hasMore && cursor) {
    const pageRes = await fetch(
      `https://api.notion.com/v1/views/${NOTION_VIEW_ID}/queries/${queryId}?start_cursor=${cursor}&page_size=100`,
      { headers: NOTION_HEADERS }
    );
    if (!pageRes.ok) break;
    const pageData = await pageRes.json();
    allPages = allPages.concat(pageData.results || []);
    cursor = pageData.next_cursor;
    hasMore = pageData.has_more;
  }

  // Étape 3: nettoyer la requête côté Notion (bonne pratique)
  fetch(`https://api.notion.com/v1/views/${NOTION_VIEW_ID}/queries/${queryId}`, {
    method: 'DELETE',
    headers: NOTION_HEADERS,
  }).catch(() => {});

  // Étape 4: si les résultats n'incluent pas déjà les propriétés complètes,
  // aller chercher chaque page individuellement.
  const fullPages = await Promise.all(
    allPages.map(async (stub) => {
      if (stub.properties) return stub;
      const res = await fetch(`https://api.notion.com/v1/pages/${stub.id}`, {
        headers: NOTION_HEADERS,
      });
      if (!res.ok) return stub;
      return res.json();
    })
  );

  return fullPages.map((page) => ({
    title: extractTitle(page),
    url: taskLink(page),
    due: extractDueDate(page),
    priorityLabel: extractPriorityLabel(page),
  }));
}

// ---------------------------------------------------------------------------
// Construit et envoie le courriel
// ---------------------------------------------------------------------------
function buildEmailContent(tasks) {
  const dateStr = new Date().toLocaleDateString('fr-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: currentTimezone(),
  });

  if (tasks.length === 0) {
    return {
      subject: `Tâches à faire — ${dateStr}`,
      text: 'Aucune tâche à faire pour le moment.',
      html: '<p>Aucune tâche à faire pour le moment.</p>',
    };
  }

  // Ordre des sections: "Non classé" d'abord, puis chaque niveau configuré,
  // puis (par sécurité) toute valeur inattendue rencontrée — ainsi aucune
  // tâche ne disparaît du courriel si une valeur n'est pas dans la liste.
  const configuredLevels = NOTION_PRIORITY_ORDER.split(',').map((s) => s.trim()).filter(Boolean);
  const unexpectedLevels = [...new Set(tasks.map((t) => t.priorityLabel))].filter(
    (label) => label && !configuredLevels.includes(label)
  );
  const sections = [
    { label: 'Non classé', tasks: tasks.filter((t) => !t.priorityLabel) },
    ...[...configuredLevels, ...unexpectedLevels].map((label) => ({
      label,
      tasks: tasks.filter((t) => t.priorityLabel === label),
    })),
  ];

  const textSection = (label, list) => {
    if (list.length === 0) return '';
    const lines = list.map((t, i) => {
      const daysLabel = formatDaysUntil(t.due) || formatDueDate(t.due);
      return `${i + 1}. ${t.title}${daysLabel ? ` (${daysLabel})` : ''}`;
    });
    return `${label}\n${lines.join('\n')}`;
  };
  const textParts = sections.map((s) => textSection(s.label, s.tasks)).filter(Boolean);

  const htmlSection = (label, list) => {
    if (list.length === 0) return '';
    const items = list
      .map((t) => {
        const daysLabel = formatDaysUntil(t.due) || formatDueDate(t.due);
        const dueHtml = daysLabel
          ? ` <span style="color:#888;font-size:12px;">(${daysLabel})</span>`
          : '';
        return `<li><a href="${t.url}" style="text-decoration:none;color:#111;">${t.title}</a>${dueHtml}</li>`;
      })
      .join('\n');
    return `
      <h3 style="margin-bottom:4px;">${label}</h3>
      <ul style="line-height:1.8;margin-top:0;">${items}</ul>
    `;
  };
  const htmlParts = sections.map((s) => htmlSection(s.label, s.tasks)).filter(Boolean);

  return {
    subject: `Tâches à faire — ${dateStr}`,
    text: `Tâches à faire:\n\n${textParts.join('\n\n')}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2>TÂCHES À FAIRE</h2>
        ${htmlParts.join('\n')}
      </div>
    `,
  };
}

// ---------------------------------------------------------------------------
// Conversation du jour: le résumé du matin et les mises à jour d'une même
// journée sont regroupés dans une seule conversation. Ils ont le même objet,
// et chaque envoi suivant cite le premier (en-têtes In-Reply-To et References),
// dont on lit l'identifiant de message auprès de Resend.
// ---------------------------------------------------------------------------
const dailyThread = { key: '', messageId: '', lastText: '', warned: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSentMessageId(resendEmailId) {
  if (!resendEmailId) return '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.resend.com/emails/${resendEmailId}`, {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
      });
      if (res.ok) {
        const data = await res.json();
        const raw = String(data.message_id || data.messageId || '').trim();
        if (raw) return /^<.*>$/.test(raw) ? raw : `<${raw}>`;
      }
    } catch {
      /* on réessaie */
    }
    if (attempt < 3) await sleep(400 * attempt);
  }
  return '';
}

async function deliverTasksEmail({ onlyIfChanged = false } = {}) {
  await getSettings(); // fuseau à jour pour les dates du courriel
  const tasks = await fetchViewTasks();
  const { subject, text, html } = buildEmailContent(tasks);

  // Nouvelle journée (dans le fuseau choisi): nouvelle conversation.
  const dayKey = dateInZone(new Date(), currentTimezone());
  if (dailyThread.key !== dayKey) {
    Object.assign(dailyThread, { key: dayKey, messageId: '', lastText: '', warned: false });
  }

  if (onlyIfChanged && dailyThread.lastText === text) {
    console.log('↪ Liste inchangée depuis le dernier courriel: aucune mise à jour envoyée.');
    return null;
  }

  const threaded = Boolean(dailyThread.messageId);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM || 'onboarding@resend.dev',
      to: [MAIL_TO],
      subject,
      text,
      html,
      ...(threaded
        ? { headers: { 'In-Reply-To': dailyThread.messageId, References: dailyThread.messageId } }
        : {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend a répondu ${response.status}: ${errorBody}`);
  }
  dailyThread.lastText = text;

  // Premier courriel de la journée: on garde son identifiant de message pour
  // que les suivants s'y rattachent.
  if (!threaded) {
    const sent = await response.json().catch(() => ({}));
    const messageId = await fetchSentMessageId(sent.id);
    if (messageId) {
      dailyThread.messageId = messageId;
    } else if (!dailyThread.warned) {
      dailyThread.warned = true;
      console.warn("⚠️ Identifiant du courriel introuvable chez Resend: les courriels de la journée ne seront pas regroupés (la clé Resend doit avoir l'accès complet).");
    }
  }

  console.log(`✅ Courriel envoyé (${tasks.length} tâche(s)) à ${MAIL_TO}${threaded ? ' [même conversation]' : ''}`);
  return tasks.length;
}

// Les envois se font l'un après l'autre, pour que le premier courriel du jour
// soit enregistré avant que le suivant parte.
let sendLock = Promise.resolve();
function sendTasksEmail(options = {}) {
  const run = sendLock.then(() => deliverTasksEmail(options));
  sendLock = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Serveur Express
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'notion-tasks-mailer' });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// Endpoint appelé par Resend à chaque courriel reçu sur l'adresse dédiée
// (ex: todomartin@notion.14lieux.com). Utilise express.raw() pour garder
// le corps brut, nécessaire à la vérification de signature.
app.post('/inbound-email', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body.toString('utf8');

  if (!verifyResendWebhook(rawBody, req.headers)) {
    console.error('❌ Signature webhook invalide, requête ignorée.');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  // On répond tout de suite à Resend pour éviter un timeout/retry,
  // et on traite la création de la tâche ensuite.
  res.status(200).json({ received: true });

  if (event.type !== 'email.received') return;

  const senderEmail = extractSenderEmail(event.data?.from);
  if (senderEmail !== (ALLOWED_SENDER_EMAIL || '').trim().toLowerCase()) {
    console.log(`⚠️ Courriel ignoré, expéditeur non autorisé: ${senderEmail || '(inconnu)'}`);
    return;
  }

  try {
    const subject = event.data?.subject;
    const bodyContent = await fetchInboundEmailContent(event.data?.email_id);
    await createNotionTaskFromEmail(subject, bodyContent);
    // La nouvelle tâche (sans priorité) apparaît dans la liste sous "Non classé":
    // c'est la mise à jour de la liste qui sert de rappel.
    console.log(`🔔 Tâche créée par courriel: mise à jour de la liste dans ${CHECK_EMAIL_DELAY_MS / 1000} s.`);
    scheduleCheckUpdateEmail();
  } catch (err) {
    console.error('Erreur lors de la création de la tâche depuis le courriel:', err);
  }
});

// Webhooks Notion. Le premier appel (création de l'abonnement) n'est pas signé et
// contient le jeton de vérification, qu'on affiche dans les logs pour que tu le
// colles dans Notion (bouton Verify) et dans NOTION_WEBHOOK_SECRET.
app.post('/notion-webhook', express.raw({ type: () => true }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = req.headers['x-notion-signature'];

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  // Prise de contact de Notion: la requête contient le jeton de vérification
  // (elle peut être signée avec ce même jeton, donc on ne regarde pas la signature).
  const verificationToken = findVerificationToken(event);
  if (verificationToken) {
    console.log(`🔑 Jeton de vérification Notion reçu: ${verificationToken}`);
    console.log('   Colle-le dans Notion (bouton Verify) et dans la variable NOTION_WEBHOOK_SECRET.');
    return res.status(200).json({ received: true });
  }

  if (!NOTION_WEBHOOK_SECRET) {
    console.log(`↪ Événement Notion ignoré: NOTION_WEBHOOK_SECRET n'est pas défini. ${previewRequest(req, rawBody)}`);
    return res.status(200).json({ received: true });
  }
  if (!verifyNotionWebhook(rawBody, signature)) {
    console.error(`❌ Signature webhook Notion invalide, requête ignorée. ${previewRequest(req, rawBody)}`);
    return res.status(401).json({ error: 'Signature invalide' });
  }

  res.status(200).json({ received: true });
  try {
    await handleNotionEvent(event);
  } catch (err) {
    console.error('Erreur lors du traitement de l\'événement Notion:', err);
  }
});

// Endpoint pour déclencher l'envoi manuellement
app.post('/send-tasks', async (req, res) => {
  if (TRIGGER_SECRET) {
    const provided = req.headers['x-trigger-secret'];
    if (provided !== TRIGGER_SECRET) {
      return res.status(401).json({ error: 'Non autorisé' });
    }
  }

  try {
    const count = await sendTasksEmail();
    res.json({ success: true, tasksSent: count });
  } catch (err) {
    console.error('Erreur lors de l\'envoi:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Même chose en GET, pratique pour tester depuis un navigateur (si pas de secret)
app.get('/send-tasks', async (req, res) => {
  if (TRIGGER_SECRET) {
    const provided = req.query.secret;
    if (provided !== TRIGGER_SECRET) {
      return res.status(401).json({ error: 'Non autorisé' });
    }
  }

  try {
    const count = await sendTasksEmail();
    res.json({ success: true, tasksSent: count });
  } catch (err) {
    console.error('Erreur lors de l\'envoi:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Le serveur ne démarre que si le fichier est lancé directement
// (`node index.js`), ce qui permet aussi de le tester sans l'ouvrir au réseau.
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);

    if (ENABLE_CRON === 'true') {
      await getSettings(); // charge (et journalise) les réglages tout de suite
      cron.schedule('* * * * *', schedulerTick);
      console.log('🕐 Planificateur actif (vérification chaque minute)');
    } else {
      console.log('🕐 Cron désactivé (ENABLE_CRON=false)');
    }
  });
}

module.exports = {
  app,
  sendTasksEmail,
  verifyNotionWebhook,
  taskLink,
  parseSendTime,
  defaultSendTime,
  parseSettingsPage,
  getSettings,
  schedulerTick,
  timeInZone,
  dateInZone,
  currentTimezone,
  createNotionTaskFromEmail,
};

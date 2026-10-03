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
  // Valeur exacte qui indique qu'une tâche est prioritaire
  NOTION_PRIORITY_VALUE = 'Prioritaire',
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

  // Planification du cron (par défaut: tous les jours à 8h00)
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

// ---------------------------------------------------------------------------
// Crée une nouvelle page (tâche) dans la base Notion à partir d'un sujet
// de courriel.
// ---------------------------------------------------------------------------
async function createNotionTaskFromEmail(subject) {
  const title = (subject || '(sans sujet)').trim();

  // Date d'aujourd'hui (selon le fuseau configuré), au format YYYY-MM-DD
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: CRON_TIMEZONE });

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

// Envoie un petit courriel de rappel demandant de compléter la nouvelle
// tâche (échéance + priorité), avec un lien direct vers la page Notion.
async function sendTaskCreatedReminder(title, pageUrl) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM || 'onboarding@resend.dev',
      to: [MAIL_TO],
      subject: `🔴 Nouvelle tâche: ${title}`,
      text: `"${title}" a été ajoutée à Notion.\n\nN'oublie pas d'ajouter l'échéance (Due Date) et la priorité.\n\n${pageUrl}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <a href="${pageUrl}" style="text-decoration:none;color:#111;display:block;">
            <p><strong>"${title}"</strong> a été ajoutée à Notion.</p>
            <p>N'oublie pas d'ajouter l'échéance (<em>Due Date</em>) et la priorité.</p>
          </a>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend (reminder) a répondu ${response.status}: ${errorBody}`);
  }
}

// ---------------------------------------------------------------------------
// Extraction du texte du titre / de la date d'échéance d'une page Notion
// ---------------------------------------------------------------------------
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

// Retourne 'priority', 'regular' ou 'unclassified' selon la valeur de la colonne Priorité
function extractPriorityStatus(page) {
  const prop = page.properties?.[NOTION_PRIORITY_PROPERTY];
  if (!prop || prop.type !== 'select' || !prop.select) return 'unclassified';
  return prop.select.name === NOTION_PRIORITY_VALUE ? 'priority' : 'regular';
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
  const parts = d.toLocaleDateString('en-CA', { timeZone: CRON_TIMEZONE }).split('-');
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

// Calcule le nombre de jours de calendrier entre aujourd'hui (selon le
// fuseau configuré) et la date d'échéance. Positif = futur, négatif = passé.
function daysUntilDue(isoDate) {
  const due = extractCalendarDate(isoDate);
  if (!due) return null;

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: CRON_TIMEZONE });
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
    timeZone: CRON_TIMEZONE,
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
    url: page.url,
    due: extractDueDate(page),
    priorityStatus: extractPriorityStatus(page),
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
    timeZone: CRON_TIMEZONE,
  });

  if (tasks.length === 0) {
    return {
      subject: `Aucune tâche en attente — ${dateStr}`,
      text: 'Aucune tâche à faire pour le moment.',
      html: '<p>Aucune tâche à faire pour le moment.</p>',
    };
  }

  const unclassifiedTasks = tasks.filter((t) => t.priorityStatus === 'unclassified');
  const priorityTasks = tasks.filter((t) => t.priorityStatus === 'priority');
  const regularTasks = tasks.filter((t) => t.priorityStatus === 'regular');

  const textSection = (label, list) => {
    if (list.length === 0) return '';
    const lines = list.map((t, i) => {
      const daysLabel = formatDaysUntil(t.due) || formatDueDate(t.due);
      return `${i + 1}. ${t.title}${daysLabel ? ` (${daysLabel})` : ''}`;
    });
    return `${label}\n${lines.join('\n')}`;
  };
  const textParts = [
    textSection('Non classé', unclassifiedTasks),
    textSection('Prioritaire', priorityTasks),
    textSection('Non prioritaire', regularTasks),
  ].filter(Boolean);

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
  const htmlParts = [
    htmlSection('Non classé', unclassifiedTasks),
    htmlSection('Prioritaire', priorityTasks),
    htmlSection('Non prioritaire', regularTasks),
  ].filter(Boolean);

  return {
    subject: `${tasks.length} tâche(s) à faire — ${dateStr}`,
    text: `Tâches à faire:\n\n${textParts.join('\n\n')}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2>TÂCHES À FAIRE</h2>
        ${htmlParts.join('\n')}
      </div>
    `,
  };
}

async function sendTasksEmail() {
  const tasks = await fetchViewTasks();
  const { subject, text, html } = buildEmailContent(tasks);

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
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend a répondu ${response.status}: ${errorBody}`);
  }

  console.log(`✅ Courriel envoyé (${tasks.length} tâche(s)) à ${MAIL_TO}`);
  return tasks.length;
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

  try {
    const subject = event.data?.subject;
    const page = await createNotionTaskFromEmail(subject);
    await sendTaskCreatedReminder((subject || '(sans sujet)').trim(), page.url);
    console.log('✅ Courriel de rappel envoyé.');
  } catch (err) {
    console.error('Erreur lors de la création de la tâche depuis le courriel:', err);
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

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);

  if (ENABLE_CRON === 'true') {
    cron.schedule(CRON_SCHEDULE, () => {
      console.log('⏰ Déclenchement du cron quotidien...');
      sendTasksEmail().catch((err) => console.error('Erreur cron:', err));
    }, { timezone: CRON_TIMEZONE });
    console.log(`🕐 Cron activé: "${CRON_SCHEDULE}" (${CRON_TIMEZONE})`);
  } else {
    console.log('🕐 Cron désactivé (ENABLE_CRON=false)');
  }
});

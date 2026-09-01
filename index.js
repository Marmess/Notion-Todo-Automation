require('dotenv').config();

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

  // Resend (envoi de courriel via HTTPS, contourne le blocage SMTP de Railway)
  RESEND_API_KEY,
  MAIL_FROM,
  MAIL_TO,

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

function extractDueDate(page) {
  const candidates = ['Due', 'Date', 'Dates', 'Échéance', 'Deadline'];
  for (const name of candidates) {
    const prop = page.properties?.[name];
    if (prop && prop.type === 'date' && prop.date?.start) {
      return prop.date.start;
    }
  }
  return null;
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
  });

  if (tasks.length === 0) {
    return {
      subject: `✅ Aucune tâche en attente — ${dateStr}`,
      text: 'Aucune tâche à faire pour le moment. 🎉',
      html: '<p>Aucune tâche à faire pour le moment. 🎉</p>',
    };
  }

  const textLines = tasks.map((t, i) => `${i + 1}. ${t.title}`);

  const htmlItems = tasks
    .map((t) => `<li><a href="${t.url}" style="text-decoration:none;color:#111;">${t.title}</a></li>`)
    .join('\n');

  return {
    subject: `📋 ${tasks.length} tâche(s) à faire — ${dateStr}`,
    text: `Tâches à faire (${dateStr}):\n\n${textLines.join('\n')}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2>📋 Tâches à faire — ${dateStr}</h2>
        <ul style="line-height:1.8;">${htmlItems}</ul>
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
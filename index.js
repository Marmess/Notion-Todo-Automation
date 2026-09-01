require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const { Client } = require('@notionhq/client');

// ---------------------------------------------------------------------------
// Configuration (via variables d'environnement)
// ---------------------------------------------------------------------------
const {
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  // Nom de la propriété "titre" de la tâche dans Notion (généralement "Name" ou "Nom")
  NOTION_TITLE_PROPERTY = 'Name',
  // Nom de la propriété qui indique si la tâche est terminée
  NOTION_STATUS_PROPERTY = 'Status',
  // Type de la propriété de statut: "status", "select" ou "checkbox"
  NOTION_STATUS_PROPERTY_TYPE = 'status',
  // Valeur(s) considérée(s) comme "terminé" pour les types status/select (séparées par des virgules)
  NOTION_DONE_VALUES = 'Done,Terminé,Terminée',

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

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error('❌ NOTION_API_KEY et NOTION_DATABASE_ID sont requis.');
  process.exit(1);
}
if (!RESEND_API_KEY || !MAIL_TO) {
  console.error('❌ RESEND_API_KEY et MAIL_TO sont requis.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

const doneValues = NOTION_DONE_VALUES.split(',').map((v) => v.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Extraction du texte du titre d'une page Notion
// ---------------------------------------------------------------------------
function extractTitle(page) {
  const prop = page.properties?.[NOTION_TITLE_PROPERTY];
  if (!prop || prop.type !== 'title') return '(sans titre)';
  return prop.title.map((t) => t.plain_text).join('') || '(sans titre)';
}

// Détermine si une tâche est "terminée" selon le type de propriété configuré
function isDone(page) {
  const prop = page.properties?.[NOTION_STATUS_PROPERTY];
  if (!prop) return false;

  if (NOTION_STATUS_PROPERTY_TYPE === 'checkbox' && prop.type === 'checkbox') {
    return prop.checkbox === true;
  }
  if (NOTION_STATUS_PROPERTY_TYPE === 'status' && prop.type === 'status') {
    return doneValues.includes((prop.status?.name || '').toLowerCase());
  }
  if (NOTION_STATUS_PROPERTY_TYPE === 'select' && prop.type === 'select') {
    return doneValues.includes((prop.select?.name || '').toLowerCase());
  }
  return false;
}

function extractDueDate(page) {
  // Cherche une propriété de type "date" nommée "Due", "Date" ou "Échéance"
  const candidates = ['Due', 'Date', 'Échéance', 'Deadline'];
  for (const name of candidates) {
    const prop = page.properties?.[name];
    if (prop && prop.type === 'date' && prop.date?.start) {
      return prop.date.start;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Récupère toutes les tâches non terminées de la base Notion (avec pagination)
// ---------------------------------------------------------------------------
async function fetchOpenTasks() {
  const tasks = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (!isDone(page)) {
        tasks.push({
          title: extractTitle(page),
          url: page.url,
          due: extractDueDate(page),
        });
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  // Trie par date d'échéance (les tâches sans date à la fin)
  tasks.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  return tasks;
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

  const textLines = tasks.map((t, i) => {
    const due = t.due ? ` (échéance: ${t.due})` : '';
    return `${i + 1}. ${t.title}${due}`;
  });

  const htmlItems = tasks
    .map((t) => {
      const due = t.due
        ? ` <span style="color:#888;font-size:12px;">(échéance: ${t.due})</span>`
        : '';
      return `<li><a href="${t.url}" style="text-decoration:none;color:#111;">${t.title}</a>${due}</li>`;
    })
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
  const tasks = await fetchOpenTasks();
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

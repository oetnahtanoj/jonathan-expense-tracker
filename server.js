require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Expenses';

const CATEGORIES = [
  'food',
  'travel',
  'car',
  'transport',
  'shopping',
  'others',
];

const BREAKDOWN_GROUPS = [...CATEGORIES, 'jonlia'];
const HEADERS = ['Date', 'Item', 'Category', 'Amount (SGD)', 'Notes', 'Jonlia'];

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

function getAuthClient() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getAuthClient();
  const authClient = await auth.getClient();

  return google.sheets({
    version: 'v4',
    auth: authClient,
  });
}

async function ensureSheetHeaders() {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [HEADERS],
    },
  });
}

function sgtToday() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })
  ).toLocaleDateString('en-CA');
}

function formatDateForReply(dateStr) {
  if (!dateStr || typeof dateStr !== 'string' || !dateStr.includes('-')) {
    return dateStr || '';
  }

  const [year, month, day] = dateStr.split('-');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  return `${parseInt(day, 10)} ${months[parseInt(month, 10) - 1]} ${year}`;
}

function normaliseCategory(rawCategory) {
  const input = String(rawCategory || '').trim().toLowerCase();

  return CATEGORIES.find(category => category === input) || '';
}

function normaliseJonlia(value) {
  const input = String(value || '').trim().toLowerCase();

  if (['jonlia', 'yes', 'y', 'true', '1'].includes(input)) {
    return 'jonlia';
  }

  return '';
}

function parseAmount(value) {
  const cleaned = String(value ?? '').replace('$', '').trim();
  const amount = Number.parseFloat(cleaned);

  return Number.isFinite(amount) ? amount : NaN;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normaliseRow(row) {
  return [
    row[0] || '',
    row[1] || '',
    row[2] || '',
    row[3] || '',
    row[4] || '',
    row[5] || '',
  ];
}

function isAllowedChat(chatId) {
  if (!ALLOWED_CHAT_IDS.length) {
    return true;
  }

  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function displayGroupForRow(row) {
  const [, , category, , , jonlia] = normaliseRow(row);

  if (normaliseJonlia(jonlia)) {
    return 'jonlia';
  }

  return normaliseCategory(category) || 'others';
}

async function getAllRows() {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:F`,
  });

  return (res.data.values || []).map(normaliseRow);
}

async function appendExpense({ date, item, category, amount, notes = '', jonlia = '' }) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[date, item, category, amount, notes, normaliseJonlia(jonlia)]],
    },
  });

  const rows = await getAllRows();
  broadcastSSE(rows);

  return rows;
}

async function deleteExpenseByDataRowIndex(rowIndex) {
  const sheets = await getSheetsClient();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const sheet = meta.data.sheets.find(
    item => item.properties.title === SHEET_NAME
  );

  if (!sheet) {
    throw new Error(`Sheet tab "${SHEET_NAME}" not found.`);
  }

  const sheetId = sheet.properties.sheetId;
  const startIndex = rowIndex + 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex,
              endIndex: startIndex + 1,
            },
          },
        },
      ],
    },
  });

  const rows = await getAllRows();
  broadcastSSE(rows);

  return rows;
}

const sseClients = new Set();
let lastSnapshot = '';

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;

  for (const res of sseClients) {
    res.write(payload);
  }
}

setInterval(async () => {
  try {
    const rows = await getAllRows();
    const snapshot = JSON.stringify(rows);

    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      broadcastSSE(rows);
    }
  } catch (error) {
    console.error('SSE polling failed:', error.message);
  }
}, 10000);

app.get('/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.flushHeaders();
  sseClients.add(res);

  try {
    const rows = await getAllRows();
    res.write(`data: ${JSON.stringify(rows)}\n\n`);
  } catch (error) {
    console.error('Initial SSE send failed:', error.message);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'jonathan-expense-tracker',
    sheetConfigured: Boolean(SHEET_ID),
    telegramConfigured: Boolean(BOT_TOKEN),
    publicUrlConfigured: Boolean(PUBLIC_URL),
    categories: CATEGORIES,
    breakdownGroups: BREAKDOWN_GROUPS,
  });
});

app.get('/categories', (req, res) => {
  res.json(CATEGORIES);
});

app.get('/breakdown-groups', (req, res) => {
  res.json(BREAKDOWN_GROUPS);
});

app.get('/expenses', async (req, res) => {
  try {
    const rows = await getAllRows();
    res.json(rows);
  } catch (error) {
    console.error('GET /expenses failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/add-expense', async (req, res) => {
  const {
    date,
    item,
    category: rawCategory,
    amount: rawAmount,
    notes = '',
    jonlia = '',
  } = req.body || {};

  const category = normaliseCategory(rawCategory);
  const amount = parseAmount(rawAmount);
  const jonliaValue = normaliseJonlia(jonlia);

  if (!date || !item || !rawCategory || rawAmount === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: date, item, category, amount.',
    });
  }

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: 'Invalid date. Use YYYY-MM-DD.',
    });
  }

  if (!category) {
    return res.status(400).json({
      error: `Invalid category. Valid categories: ${CATEGORIES.join(', ')}`,
    });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid amount. Use a positive number.',
    });
  }

  try {
    await appendExpense({
      date,
      item: String(item).trim(),
      category,
      amount,
      notes: String(notes || '').trim(),
      jonlia: jonliaValue,
    });

    const groupLabel = jonliaValue ? 'jonlia' : category;

    res.json({
      success: true,
      message: `Added: ${item} | ${groupLabel} | $${amount.toFixed(2)}`,
    });
  } catch (error) {
    console.error('POST /add-expense failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/delete-expense', async (req, res) => {
  const { rowIndex } = req.body || {};
  const parsedIndex = Number.parseInt(rowIndex, 10);

  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({
      error: 'Missing or invalid rowIndex.',
    });
  }

  try {
    await deleteExpenseByDataRowIndex(parsedIndex);

    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /delete-expense failed:', error);
    res.status(500).json({ error: error.message });
  }
});

let bot;

const processedUpdateIds = new Set();
const processedUpdateQueue = [];
const MAX_PROCESSED_UPDATES = 1000;

function claimTelegramUpdate(updateId) {
  if (updateId === undefined || updateId === null) {
    return true;
  }

  const key = String(updateId);

  if (processedUpdateIds.has(key)) {
    return false;
  }

  processedUpdateIds.add(key);
  processedUpdateQueue.push(key);

  while (processedUpdateQueue.length > MAX_PROCESSED_UPDATES) {
    const oldKey = processedUpdateQueue.shift();
    processedUpdateIds.delete(oldKey);
  }

  return true;
}

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });

  app.post('/telegram-webhook', (req, res) => {
    res.sendStatus(200);

    try {
      const updateId = req.body && req.body.update_id;

      if (!claimTelegramUpdate(updateId)) {
        console.log('Duplicate Telegram update ignored:', updateId);
        return;
      }

      bot.processUpdate(req.body);
    } catch (error) {
      console.error('Telegram webhook processing failed:', error);
    }
  });

  bot.on('message', async msg => {
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();

    console.log('Telegram message received:', {
      chatId,
      text,
      allowedChatIds: ALLOWED_CHAT_IDS,
    });

    try {
      if (text === '/whoami') {
        await safeSendMessage(
          chatId,
          `Your Telegram chat ID is:\n${chatId}`
        );
        return;
      }

      if (!isAllowedChat(chatId)) {
        await safeSendMessage(
          chatId,
          `You are not authorised to use this expense bot.\n\nYour chat ID is: ${chatId}`
        );
        return;
      }

      if (text.startsWith('/')) {
        await handleCommand(chatId, text);
      } else {
        await handleExpenseMessage(chatId, text);
      }
    } catch (error) {
      console.error('Telegram message handling failed:', error);
      await safeSendMessage(chatId, `Error: ${error.message}`);
    }
  });
}

async function safeSendMessage(chatId, text, options = {}) {
  if (!bot) {
    return;
  }

  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error('Telegram sendMessage failed:', error.message);
  }
}

async function handleCommand(chatId, text) {
  const command = text.split(' ')[0].toLowerCase();

  if (command === '/start' || command === '/help') {
    await safeSendMessage(
      chatId,
      `💰 *Jonathan Expense Bot*\n\n` +
        `*Add expense:*\n` +
        `\`item, category, amount\`\n` +
        `e.g. \`Lunch, food, 12.50\`\n\n` +
        `*Mark as jonlia:*\n` +
        `\`item, category, amount, jonlia\`\n` +
        `e.g. \`Dinner, food, 45, jonlia\`\n\n` +
        `*Jonlia with notes:*\n` +
        `\`item, category, amount, jonlia, notes\`\n` +
        `e.g. \`Petrol, car, 80, jonlia, weekend trip\`\n\n` +
        `*Valid categories:*\n${CATEGORIES.join(', ')}\n\n` +
        `*Commands:*\n` +
        `/summary — this month's totals\n` +
        `/last5 — last 5 entries\n` +
        `/delete last — delete most recent entry\n` +
        `/whoami — show your Telegram chat ID`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (command === '/summary') {
    await sendMonthlySummary(chatId);
    return;
  }

  if (command === '/last5') {
    await sendLastFive(chatId);
    return;
  }

  if (text.toLowerCase() === '/delete last') {
    await deleteLastFromTelegram(chatId);
    return;
  }

  await safeSendMessage(chatId, 'Unknown command. Send /help for usage.');
}

async function sendMonthlySummary(chatId) {
  const rows = await getAllRows();
  const ym = sgtToday().slice(0, 7);

  const totals = {};
  let grandTotal = 0;

  BREAKDOWN_GROUPS.forEach(group => {
    totals[group] = 0;
  });

  for (const row of rows) {
    const [date, , , amount] = normaliseRow(row);

    if (date && date.startsWith(ym)) {
      const parsedAmount = parseAmount(amount);
      const group = displayGroupForRow(row);

      if (Number.isFinite(parsedAmount)) {
        totals[group] = (totals[group] || 0) + parsedAmount;
        grandTotal += parsedAmount;
      }
    }
  }

  const lines = BREAKDOWN_GROUPS
    .filter(group => totals[group])
    .map(group => `• ${group}: $${totals[group].toFixed(2)}`);

  if (!lines.length) {
    await safeSendMessage(chatId, 'No expenses recorded this month.');
    return;
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const monthName = now.toLocaleString('en-US', { month: 'long' });

  await safeSendMessage(
    chatId,
    `📊 *${monthName} Summary*\n\n` +
      lines.join('\n') +
      `\n\n*Total: $${grandTotal.toFixed(2)}*`,
    { parse_mode: 'Markdown' }
  );
}

async function sendLastFive(chatId) {
  const rows = await getAllRows();
  const lastRows = rows.slice(-5).reverse();

  if (!lastRows.length) {
    await safeSendMessage(chatId, 'No expenses yet.');
    return;
  }

  const lines = lastRows.map(row => {
    const [date, item, category, amount, notes, jonlia] = normaliseRow(row);
    const group = normaliseJonlia(jonlia) ? 'jonlia' : category;
    const noteSuffix = notes ? ` — ${notes}` : '';

    return `• ${item} | ${group} | $${parseAmount(amount).toFixed(2)} on ${formatDateForReply(date)}${noteSuffix}`;
  });

  await safeSendMessage(
    chatId,
    `🕐 *Last 5 Entries*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

async function deleteLastFromTelegram(chatId) {
  const rows = await getAllRows();

  if (!rows.length) {
    await safeSendMessage(chatId, 'No entries to delete.');
    return;
  }

  const last = normaliseRow(rows[rows.length - 1]);
  const rowIndex = rows.length - 1;
  const group = normaliseJonlia(last[5]) ? 'jonlia' : last[2];

  await deleteExpenseByDataRowIndex(rowIndex);

  await safeSendMessage(
    chatId,
    `🗑 Deleted: ${last[1]} | ${group} | $${parseAmount(last[3]).toFixed(2)} on ${formatDateForReply(last[0])}`
  );
}

async function handleExpenseMessage(chatId, text) {
  console.log('handleExpenseMessage started:', { chatId, text });

  const parts = text.split(',').map(part => part.trim());

  if (parts.length < 3) {
    await safeSendMessage(
      chatId,
      '❌ Invalid format.\n\nUse:\n`item, category, amount`\n\nExample:\n`Lunch, food, 12.50`\n\nMark as jonlia:\n`Dinner, food, 45, jonlia`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const [item, rawCategory, rawAmount, fourthPart, ...remainingParts] = parts;
  const category = normaliseCategory(rawCategory);
  const amount = parseAmount(rawAmount);

  let jonlia = '';
  let notes = '';

  if (normaliseJonlia(fourthPart)) {
    jonlia = 'jonlia';
    notes = remainingParts.join(', ').trim();
  } else {
    notes = [fourthPart, ...remainingParts].filter(Boolean).join(', ').trim();
  }

  if (!item) {
    await safeSendMessage(chatId, '❌ Item is required.');
    return;
  }

  if (!category) {
    await safeSendMessage(
      chatId,
      `❌ Invalid category: ${rawCategory}\n\nValid categories: ${CATEGORIES.join(', ')}`
    );
    return;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    await safeSendMessage(
      chatId,
      '❌ Invalid amount. Use a positive number, e.g. `12.50`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const date = sgtToday();

  console.log('Expense parsed successfully. Saving to sheet:', {
    date,
    item,
    category,
    amount,
    notes,
    jonlia,
  });

  await appendExpense({
    date,
    item,
    category,
    amount,
    notes,
    jonlia,
  });

  const groupLabel = jonlia ? 'jonlia' : category;

  console.log('Expense saved successfully.');

  await safeSendMessage(
    chatId,
    `✅ Added: ${item} | ${groupLabel} | $${amount.toFixed(2)} on ${formatDateForReply(date)}`
  );
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  if (!SHEET_ID) {
    console.warn('Missing GOOGLE_SHEET_ID.');
  }

  if (!BOT_TOKEN) {
    console.warn('Missing TELEGRAM_BOT_TOKEN. Telegram bot is disabled.');
  }

  try {
    if (SHEET_ID) {
      await ensureSheetHeaders();
      console.log('Sheet headers checked.');
    }
  } catch (error) {
    console.error('Failed to check sheet headers:', error.message);
  }

  if (bot && PUBLIC_URL) {
    try {
      const webhookUrl = `${PUBLIC_URL}/telegram-webhook`;

      await bot.setWebHook(webhookUrl, {
        drop_pending_updates: true,
      });

      console.log(`Telegram webhook set to ${webhookUrl}`);
    } catch (error) {
      console.error('Failed to set Telegram webhook:', error.message);
    }
  } else if (bot && !PUBLIC_URL) {
    console.warn('PUBLIC_URL or RENDER_EXTERNAL_URL missing. Webhook was not set automatically.');
  }
});

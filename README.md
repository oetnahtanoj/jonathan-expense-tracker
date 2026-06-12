# Jonathan Expense Tracker Render App

Telegram + dashboard expense tracker using Render, Express, and Google Sheets.

## Files to upload to GitHub

Upload these files:

- server.js
- package.json
- public/index.html
- .gitignore
- .env.example
- README.md

Do not upload:

- credentials.json
- .env
- node_modules/

## Google Sheet structure

Use a sheet tab named `Expenses` with these columns:

Date | Item | Category | Amount (SGD) | Notes | Jonlia

## Categories

food, travel, car, transport, shopping, others

## Telegram input format

Normal expense:

Lunch, food, 12.50

Normal expense with notes:

Lunch, food, 12.50, team lunch

Jonlia expense:

Dinner, food, 45, jonlia

Jonlia expense with notes:

Petrol, car, 80, jonlia, weekend trip

## Dashboard grouping

If the Jonlia column is marked as `jonlia`, the amount is grouped under `jonlia` in:

- Spending by Category
- Monthly Breakdown — This Year

Otherwise, it is grouped under its normal category.

## Render settings

Service type: Web Service

Build command:

npm install

Start command:

npm start

## Render environment variables

GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SHEET_NAME=Expenses
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_CHAT_IDS=your_telegram_chat_id
PUBLIC_URL=https://your-app-name.onrender.com
GOOGLE_CREDENTIALS_JSON=your_service_account_json_as_one_line

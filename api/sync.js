import { google } from "googleapis";
import axios from "axios";
import winston from "winston";
import fs from "fs";
import os from "os";
import path from "path";

const WORKIZ_API_TOKEN = process.env.WORKIZ_API_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

// Vercel environment variable storing the service account JSON as a string
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; 

// Setup logger to log in memory (console logs are captured by Vercel)
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf((info) => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`)
  ),
  transports: [new winston.transports.Console()],
});

if (!WORKIZ_API_TOKEN || !SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_KEY) {
  logger.error("Missing required environment variables.");
  // We handle this error in handler and return 500.
}

const sheets = google.sheets("v4");

// Write the Google service account JSON to a temp file, return the path
async function createTempGoogleCredsFile() {
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, `vercel-google-creds-${Date.now()}.json`);
  await fs.promises.writeFile(tempFilePath, GOOGLE_SERVICE_ACCOUNT_KEY);
  return tempFilePath;
}

// Authenticate Google Sheets API
async function authenticateGoogleSheets() {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error("Google service account key missing");
  }
  const keyFilePath = await createTempGoogleCredsFile();

  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  google.options({ auth: authClient });

  // Clean up temp file after auth client created
  fs.unlink(keyFilePath, (err) => {
    if (err) logger.warn(\`Failed to delete temp creds file: \${err.message}\`);
  });

  logger.info("Authenticated with Google Sheets API.");
}

// Fetch jobs from Workiz API for given start date (YYYY-MM-DD)
async function fetchJobs(startDate) {
  const baseURL = \`https://api.workiz.com/api/v1/\${WORKIZ_API_TOKEN}/job/all/\`;
  const params = {
    start_date: startDate,
    offset: 0,
    records: 100,
    only_open: false,
  };

  logger.info(\`Fetching jobs from Workiz API starting from \${startDate}\`);

  try {
    const response = await axios.get(baseURL, {
      params,
      timeout: 15000,
    });
    const jobs = response.data.data || [];
    logger.info(\`Fetched \${jobs.length} jobs from Workiz API.\`);
    return jobs;
  } catch (error) {
    if (error.response) {
      logger.error(\`Error fetching jobs from Workiz API: \${JSON.stringify(error.response.data)}\`);
    } else {
      logger.error(\`Error fetching jobs from Workiz API: \${error.message}\`);
    }
    throw error;
  }
}

// Get all rows from Google Sheet (excluding header)
async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: \`\${SHEET_NAME}!A2:Z\`,
  });
  const rows = res.data.values || [];
  logger.info(\`Retrieved \${rows.length} rows from Google Sheet.\`);
  return rows;
}

// Find row index by job UUID in sheet rows
function findRowIndex(rows, jobUUID) {
  for (let i = 0; i &lt; rows.length; i++) {
    if (rows[i][0] === jobUUID) {
      return i;
    }
  }
  return -1;
}

// Format job data fields for sheet row
function formatJobData(job) {
  const fields = [
    "UUID",
    "SerialId",
    "JobDateTime",
    "JobEndDateTime",
    "CreatedDate",
    "JobTotalPrice",
    "JobAmountDue",
    "SubTotal",
    "item_cost",
    "tech_cost",
    "ClientId",
    "Status",
    "SubStatus",
    "PaymentDueDate",
    "Phone",
    "SecondPhone",
    "PhoneExt",
    "SecondPhoneExt",
    "Email",
    "Comments",
    "FirstName",
    "LastName",
    "Company",
    "Address",
    "City",
    "State",
    "PostalCode",
    "Country",
    "Unit",
    "Latitude",
    "Longitude",
    "JobType",
    "ReferralCompany",
    "Timezone",
    "JobNotes",
    "JobSource",
    "CreatedBy",
    "ServiceArea",
    "LastStatusUpdate",
  ];

  return fields.map((field) =&gt; {
    let val = job[field];
    if (Array.isArray(val)) {
      if (field === "Tags") {
        val = val.map((tag) =&gt; (typeof tag === "object" ? tag.tag : tag)).join(",");
      } else if (field === "Team") {
        val = val.map((team) =&gt; (typeof team === "object" ? team.name : team)).join(",");
      } else {
        val = JSON.stringify(val);
      }
    }
    return val !== undefined &amp;&amp; val !== null ? String(val) : "";
  });
}

// Update a single row in sheet
async function updateSheetRow(rowNumber, rowValues) {
  const range = \`\${SHEET_NAME}!A\${rowNumber}:Z\${rowNumber}\`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] },
  });
  logger.info(\`Updated row #\${rowNumber} for job \${rowValues[0]}\`);
}

// Append a new row to sheet
async function appendSheetRow(rowValues) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: \`\${SHEET_NAME}!A1:Z1\`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
  logger.info(\`Appended new row for job \${rowValues[0]}\`);
}

// Main sync logic
async function syncJobsWithSheet(jobs) {
  const sheetRows = await getSheetRows();

  for (const job of jobs) {
    const jobUUID = job.UUID;
    if (!jobUUID) {
      logger.warn("Job without UUID found, skipping.");
      continue;
    }
    const formattedRow = formatJobData(job);
    const rowIndex = findRowIndex(sheetRows, jobUUID);

    if (rowIndex !== -1) {
      await updateSheetRow(rowIndex + 2, formattedRow);
      sheetRows[rowIndex] = formattedRow;
    } else {
      await appendSheetRow(formattedRow);
      sheetRows.push(formattedRow);
    }
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed, use POST" });
    return;
  }

  if (!WORKIZ_API_TOKEN || !SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    res.status(500).json({ error: "Missing required environment variables for sync" });
    return;
  }

  const { startDate } = req.body;
  let effectiveStartDate = startDate;

  // Validate startDate format YYYY-MM-DD
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    // Default to 7 days before today
    const today = new Date();
    const dayBefore = new Date(today);
    dayBefore.setDate(today.getDate() - 7);
    effectiveStartDate = dayBefore.toISOString().split('T')[0];
  }

  logger.info(\`API sync trigger received. Start date: \${effectiveStartDate}\`);

  try {
    await authenticateGoogleSheets();
    const jobs = await fetchJobs(effectiveStartDate);
    if (jobs.length &gt; 0) {
      await syncJobsWithSheet(jobs);
      logger.info("Sync completed successfully.");
      res.status(200).json({ message: "Sync completed successfully.", jobsSynced: jobs.length });
    } else {
      logger.info("No jobs retrieved to sync.");
      res.status(200).json({ message: "No jobs retrieved to sync." });
    }
  } catch (error) {
    logger.error(\`Sync failed: \${error.message}\`);
    res.status(500).json({ error: "Sync failed: " + error.message });
  }
}

export default handler;



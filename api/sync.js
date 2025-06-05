import { google } from "googleapis";
import axios from "axios";
import winston from "winston";
import fs from "fs";
import os from "os";
import path from "path";

const WORKIZ_API_TOKEN = process.env.WORKIZ_API_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      (info) =>
        `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

const sheets = google.sheets("v4");

async function createTempGoogleCredsFile() {
  const tempFilePath = path.join(
    os.tmpdir(),
    `vercel-google-creds-${Date.now()}.json`
  );
  await fs.promises.writeFile(tempFilePath, GOOGLE_SERVICE_ACCOUNT_KEY);
  return tempFilePath;
}

async function authenticateGoogleSheets() {
  const keyFilePath = await createTempGoogleCredsFile();

  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  google.options({ auth: authClient });

  fs.unlink(keyFilePath, (err) => {
    if (err) logger.warn(`Failed to delete temp creds file: ${err.message}`);
  });

  logger.info("Authenticated with Google Sheets API.");
}

async function fetchJobs(startDate) {
  const baseURL = `https://api.workiz.com/api/v1/${WORKIZ_API_TOKEN}/job/all/`;
  const params = {
    start_date: startDate,
    offset: 0,
    records: 100,
    only_open: false,
  };

  logger.info(`Fetching jobs from Workiz API starting from ${startDate}`);

  try {
    const response = await axios.get(baseURL, { params, timeout: 15000 });
    const jobs = response.data.data || [];
    logger.info(`Fetched ${jobs.length} jobs.`);
    return jobs;
  } catch (error) {
    if (error.response) {
      logger.error(`Workiz API error: ${JSON.stringify(error.response.data)}`);
    } else {
      logger.error(`Network or other error: ${error.message}`);
    }
    throw error;
  }
}

async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:Z`,
  });
  const rows = res.data.values || [];
  logger.info(`Retrieved ${rows.length} rows from sheet.`);
  return rows;
}

function findRowIndex(rows, jobUUID) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === jobUUID) return i;
  }
  return -1;
}

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
  return fields.map((field) => {
    let val = job[field];
    if (Array.isArray(val)) {
      if (field === "Tags") {
        val = val.map((t) => (typeof t === "object" ? t.tag : t)).join(",");
      } else if (field === "Team") {
        val = val.map((t) => (typeof t === "object" ? t.name : t)).join(",");
      } else {
        val = JSON.stringify(val);
      }
    }
    return val != null ? String(val) : "";
  });
}

async function updateSheetRow(rowNumber, rowValues) {
  const range = `${SHEET_NAME}!A${rowNumber}:Z${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] },
  });
  logger.info(`Updated row #${rowNumber} for job ${rowValues[0]}`);
}

async function appendSheetRow(rowValues) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:Z1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
  logger.info(`Appended new row for job ${rowValues[0]}`);
}

async function syncJobsWithSheet(jobs) {
  const sheetRows = await getSheetRows();

  for (const job of jobs) {
    const jobUUID = job.UUID;
    if (!jobUUID) {
      logger.warn("Job without UUID found, skipping.");
      continue;
    }
    const rowData = formatJobData(job);
    const rowIndex = findRowIndex(sheetRows, jobUUID);

    if (rowIndex !== -1) {
      await updateSheetRow(rowIndex + 2, rowData);
      sheetRows[rowIndex] = rowData;
    } else {
      await appendSheetRow(rowData);
      sheetRows.push(rowData);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed, use POST" });
  }

  if (!WORKIZ_API_TOKEN || !SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res
      .status(500)
      .json({ error: "Missing environment variables required for sync." });
  }

  const { startDate } = req.body;
  let effectiveStartDate = startDate;

  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const dayBefore = new Date();
    dayBefore.setDate(dayBefore.getDate() - 7);
    effectiveStartDate = dayBefore.toISOString().split("T")[0];
  }

  logger.info(`Received sync request with start date: ${effectiveStartDate}`);

  try {
    await authenticateGoogleSheets();
    const jobs = await fetchJobs(effectiveStartDate);

    if (jobs.length === 0) {
      logger.info("No jobs to sync.");
      return res.status(200).json({ message: "No jobs retrieved to sync." });
    }

    await syncJobsWithSheet(jobs);

    logger.info("Sync completed successfully.");
    res
      .status(200)
      .json({
        message: "Sync completed successfully.",
        jobsSynced: jobs.length,
      });
  } catch (error) {
    logger.error(`Sync failed: ${error.message}`);
    res.status(500).json({ error: `Sync failed: ${error.message}` });
  }
}
